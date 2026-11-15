import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { HlsManifest } from "../../src/lib/hls-runner";
import { splitInitGroups } from "../../src/lib/m3u8";
import { readJobFile } from "../../src/lib/opfs";

let port: chrome.runtime.Port;
let ffmpeg: FFmpeg | null = null;
let logs: string[] = [];
let activeJobId: string | null = null;

function connect(): void {
  port = chrome.runtime.connect({ name: "offscreen" });
  port.onMessage.addListener((message: { type?: string; jobId?: string; filename?: string; url?: string }) => {
    if (message.type === "MUX" && message.jobId) void runMux(message.jobId, message.filename);
    if (message.type === "MUX_CANCEL" && message.jobId === activeJobId) void cancelActive();
    // 后台保存完再收回地址。这里没有 chrome.downloads，不能自己触发下载。
    if (message.type === "REVOKE_URL" && message.url?.startsWith("blob:")) URL.revokeObjectURL(message.url);
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
    // chrome.offscreen 创建的文档没有 chrome.downloads，直接调用会抛
    // Cannot read properties of undefined (reading 'download')。
    // 普通扩展页打开同一地址却有这个接口，不能用那种页面的结果判断这里。
    tell({
      type: "MUX_FILE",
      jobId,
      url: objectUrl(bytes),
      filename: filename || manifest.filename,
    });
  } catch (error) {
    tell({ type: "MUX_ERROR", jobId, error: errorText(error).slice(0, 80) });
    ffmpeg?.terminate();
    ffmpeg = null;
  } finally {
    // 封装器已经停了。取消正在保存的文件靠后台记下的下载号，不靠这里的任务号。
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

function objectUrl(bytes: Uint8Array): string {
  // ffmpeg 读出的是 Uint8Array<ArrayBufferLike>，不能直接当 BlobPart。拷进一份新的 ArrayBuffer。
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "video/mp4" }));
  // 下载完成前不能回收，否则浏览器还没把字节写进文件。后台会在结束后通知回收；这里只防它没通知。
  setTimeout(() => URL.revokeObjectURL(url), 30 * 60_000);
  return url;
}

function cancelActive(): void {
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
