import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { HlsManifest } from "../../src/lib/hls-runner";
import { splitInitGroups } from "../../src/lib/m3u8";
import { readJobFile } from "../../src/lib/opfs";

let port: chrome.runtime.Port;
let ffmpeg: FFmpeg | null = null;
let logs: string[] = [];
let activeJobId: string | null = null;
let activeDownloadId: number | null = null;

function connect(): void {
  port = chrome.runtime.connect({ name: "offscreen" });
  port.onMessage.addListener((message: { type?: string; jobId?: string; filename?: string }) => {
    if (message.type === "MUX" && message.jobId) void runMux(message.jobId, message.filename);
    if (message.type === "MUX_CANCEL" && message.jobId === activeJobId) void cancelActive();
  });
  port.onDisconnect.addListener(() => {
    window.setTimeout(connect, 200);
  });
}

function tell(message: object): void {
  try {
    port.postMessage(message);
  } catch {
    // 后台会在超时后把任务标成失败
  }
}

connect();

async function runMux(jobId: string, filename: string | undefined): Promise<void> {
  activeJobId = jobId;
  logs = [];
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await readJobFile(jobId, "manifest.json"))) as HlsManifest;
    if (!manifest.video?.length) throw new Error("没有可封装的视频分片");
    const engine = await loadEngine();
    const videoName = await materialize(engine, jobId, manifest.video ?? [], manifest.videoKind, "video");
    const audioName = manifest.audio && manifest.audio.length > 0
      ? await materialize(engine, jobId, manifest.audio, manifest.audioKind ?? "ts", "audio")
      : undefined;
    // MPEG-TS 里的 AAC 要先变成 MP4 能装的格式。有的流加了 bsf 反而失败，再试一次不带滤镜的复制。
    const useBsf = videoName.endsWith(".ts") || Boolean(audioName?.endsWith(".ts"));
    let code = await engine.exec(muxArgs(videoName, audioName, useBsf));
    if (code !== 0 && useBsf) code = await engine.exec(muxArgs(videoName, audioName, false));
    if (code !== 0) throw new Error(tailError());
    const output = await engine.readFile("out.mp4");
    if (typeof output === "string") throw new Error("封装没有生成文件");
    const bytes = new Uint8Array(output);
    engine.terminate();
    ffmpeg = null;
    tell({ type: "MUX_SAVING", jobId });
    await saveFile(filename || manifest.filename, bytes);
    tell({ type: "MUX_DONE", jobId });
  } catch (error) {
    tell({ type: "MUX_ERROR", jobId, error: errorText(error).slice(0, 80) });
    ffmpeg?.terminate();
    ffmpeg = null;
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}

async function loadEngine(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  const engine = new FFmpeg();
  engine.on("log", (payload: { message?: string }) => {
    const message = typeof payload?.message === "string" ? payload.message : "";
    const line = message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 180);
    if (!line.trim()) return;
    logs.push(line);
    if (logs.length > 40) logs.shift();
  });
  await engine.load({
    coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
    classWorkerURL: chrome.runtime.getURL("ffmpeg/worker.js"),
  });
  ffmpeg = engine;
  return engine;
}

async function materialize(
  engine: FFmpeg,
  jobId: string,
  paths: string[],
  kind: "ts" | "fmp4",
  prefix: string,
): Promise<string> {
  // 不要把整条片子先拼成一个 Uint8Array。长视频会在这里把 wasm 堆撑坏，
  // 抛出 Cannot read properties of undefined，看起来像下载到一半失败。
  const groups = splitInitGroups(paths);
  const partNames: string[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? [];
    const hasMap = group.some((path) => (path.split("/").pop() ?? "").startsWith("map-"));
    const flat = await importGroup(engine, jobId, group, `${prefix}${index}`);
    const asTs = groups.length === 1 && !hasMap && kind === "ts";
    const output = asTs ? `${prefix}.ts` : `${prefix}-part-${index}.mp4`;
    await joinCopied(engine, flat, output, !asTs && !hasMap);
    for (const name of flat) await engine.deleteFile(name).catch(() => undefined);
    partNames.push(output);
  }
  const only = partNames[0];
  if (partNames.length === 1 && only) return only;
  return concatMp4(engine, partNames, `${prefix}.mp4`);
}

async function importGroup(engine: FFmpeg, jobId: string, paths: string[], prefix: string): Promise<string[]> {
  const names: string[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const source = paths[index];
    if (!source) continue;
    const ext = source.split(".").pop() || "bin";
    const name = `${prefix}-${String(index).padStart(5, "0")}.${ext}`;
    const bytes = standalone(new Uint8Array(await readJobFile(jobId, source)));
    await engine.writeFile(name, bytes);
    names.push(name);
  }
  if (names.length === 0) throw new Error("没有可封装的分片");
  return names;
}

async function joinCopied(engine: FFmpeg, files: string[], output: string, useBsf: boolean): Promise<void> {
  const input = files.length === 1 ? files[0]! : `concat:${files.join("|")}`;
  const args = ["-i", input, "-c", "copy"];
  if (useBsf) args.push("-bsf:a", "aac_adtstoasc");
  args.push(output);
  let code = await engine.exec(args);
  if (code !== 0 && useBsf) code = await engine.exec(["-i", input, "-c", "copy", output]);
  if (code !== 0) throw new Error(tailError());
}

async function concatMp4(engine: FFmpeg, files: string[], output: string): Promise<string> {
  const listName = `${output}.txt`;
  const text = new TextEncoder().encode(files.map((name) => `file ${name}`).join("\n"));
  await engine.writeFile(listName, standalone(text));
  const code = await engine.exec(["-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", output]);
  if (code !== 0) throw new Error(tailError());
  return output;
}

function standalone(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  return bytes.slice();
}

// 只复制码流，不转码。解密已经在写入 OPFS 之前做完。
function muxArgs(videoName: string, audioName: string | undefined, bsf: boolean, output = "out.mp4"): string[] {
  const args = ["-i", videoName];
  if (audioName) args.push("-i", audioName, "-map", "0:v:0", "-map", "1:a:0");
  args.push("-c", "copy");
  if (bsf) args.push("-bsf:a", "aac_adtstoasc");
  args.push("-movflags", "+faststart", output);
  return args;
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "封装失败";
}

async function saveFile(filename: string, bytes: Uint8Array): Promise<void> {
  // ffmpeg 读出的是 Uint8Array<ArrayBufferLike>，不能直接当 BlobPart。拷进一份新的 ArrayBuffer。
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const blob = new Blob([copy], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    activeDownloadId = downloadId;
    await waitForDownload(downloadId);
  } finally {
    activeDownloadId = null;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }
}

function waitForDownload(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("浏览器没能保存文件"));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function cancelActive(): Promise<void> {
  if (activeDownloadId != null) {
    await chrome.downloads.cancel(activeDownloadId).catch(() => undefined);
    activeDownloadId = null;
  }
  ffmpeg?.terminate();
  ffmpeg = null;
}

function tailError(): string {
  const tail = logs.slice(-3).join(" ");
  if (/out of memory|memory access out of bounds|allocation/i.test(tail)) {
    return "体积超过约 2GB 上限，无法在浏览器里封装";
  }
  return tail ? `封装失败：${tail.slice(0, 60)}` : "封装失败";
}
