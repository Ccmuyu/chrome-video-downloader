import { decryptAes128 } from "./aes";
import { MUX_BYTE_LIMIT, SEGMENT_CONCURRENCY } from "./constants";
import { codecsIncludeAudio, keyError, mediaPlaylistError, parsePlaylist, selectAudio } from "./m3u8";
import { fetchBytesWithRetry, fetchText, mapPool, publicError } from "./net";
import { outputFilename } from "./filename";
import { writeJobFile } from "./opfs";
import type { MediaPlaylistPlan, SegmentKey, Variant } from "./types";
import { resolveUri } from "./url";

export class NeedOriginsError extends Error {
  origins: string[];

  constructor(origins: string[]) {
    super("需要授权 CDN");
    this.name = "NeedOriginsError";
    this.origins = origins;
  }
}

export type StoredPiece = {
  path: string;
  url: string;
  byterange?: { offset: number; length: number };
  key?: SegmentKey;
};

export type HlsManifest = {
  filename: string;
  video: string[];
  audio?: string[];
  videoKind: "ts" | "fmp4";
  audioKind?: "ts" | "fmp4";
};

export type HlsProgress = {
  done: number;
  total: number;
  bytesDone: number;
  phase: "resolving" | "fetching";
  resolution?: string;
  variant?: Variant;
};

export async function downloadHls(options: {
  jobId: string;
  mediaUrl: string;
  referer: string;
  pageTitle: string;
  variantUri?: string;
  signal: AbortSignal;
  ensureOrigins: (urls: string[]) => Promise<void>;
  onProgress: (progress: HlsProgress) => void;
}): Promise<HlsManifest> {
  options.onProgress({ done: 0, total: 0, bytesDone: 0, phase: "resolving" });
  await options.ensureOrigins([options.mediaUrl]);
  const rootText = await fetchText(options.mediaUrl, options.signal);
  const root = parsePlaylist(rootText, options.mediaUrl);

  let mediaUrl = options.mediaUrl;
  let media = root;
  let variant: Variant | undefined;
  let audioUrl: string | undefined;

  if (root.kind === "master") {
    variant = pickVariant(root.variants, options.variantUri);
    mediaUrl = variant.uri;
    await options.ensureOrigins([mediaUrl]);
    const mediaText = await fetchText(mediaUrl, options.signal);
    const parsed = parsePlaylist(mediaText, mediaUrl);
    if (parsed.kind !== "media") throw new Error("选中的清晰度不是媒体列表");
    media = parsed;
    const rendition = selectAudio(root.audio, variant.audioGroupId);
    if (variant.audioGroupId && rendition?.uri) {
      audioUrl = resolveUri(rendition.uri, options.mediaUrl);
    } else if (variant.audioGroupId && !codecsIncludeAudio(variant.codecs)) {
      // 视频轨不含音频，又没有可下的音频地址。继续封装会得到一个无声文件。
      throw new Error("音视频分轨，但播放列表没有音频地址");
    }
  }

  if (media.kind !== "media") throw new Error("没有可下载的分片");
  const mediaError = mediaPlaylistError(media);
  if (mediaError) throw new Error(mediaError);

  let audioPlan: MediaPlaylistPlan | null = null;
  if (audioUrl) {
    await options.ensureOrigins([audioUrl]);
    const audioText = await fetchText(audioUrl, options.signal);
    const parsed = parsePlaylist(audioText, audioUrl);
    if (parsed.kind !== "media") throw new Error("音频播放列表无法解析");
    const audioError = mediaPlaylistError(parsed);
    if (audioError) throw new Error(audioError);
    audioPlan = parsed;
  }

  const videoPieces = planPieces("v", media);
  const audioPieces = audioPlan ? planPieces("a", audioPlan) : [];
  const pieceUrls = [...videoPieces, ...audioPieces].flatMap((piece) =>
    piece.key?.uri ? [piece.url, piece.key.uri] : [piece.url],
  );
  await options.ensureOrigins(pieceUrls);

  const total = videoPieces.length + audioPieces.length;
  let done = 0;
  let bytesDone = 0;
  const tick = (bytes: number) => {
    done += 1;
    bytesDone += bytes;
    options.onProgress({
      done,
      total,
      bytesDone,
      phase: "fetching",
      resolution: variant?.resolution,
      variant,
    });
  };
  options.onProgress({ done: 0, total, bytesDone: 0, phase: "fetching", resolution: variant?.resolution, variant });

  await downloadPieces(options.jobId, videoPieces, options.signal, tick);
  if (audioPieces.length > 0) await downloadPieces(options.jobId, audioPieces, options.signal, tick);
  // ffmpeg.wasm 的内存大约 2GB。分片已经落在 OPFS 后再比一次，避免封装到一半才崩。
  if (bytesDone > MUX_BYTE_LIMIT) throw new Error("体积超过约 2GB 上限，无法在浏览器里封装");

  const manifest: HlsManifest = {
    filename: outputFilename(options.pageTitle || "video", variant?.resolution),
    video: videoPieces.map((piece) => piece.path),
    audio: audioPieces.length > 0 ? audioPieces.map((piece) => piece.path) : undefined,
    videoKind: media.init ? "fmp4" : "ts",
    audioKind: audioPlan ? (audioPlan.init ? "fmp4" : "ts") : undefined,
  };
  await writeJobFile(options.jobId, "manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  return manifest;
}

export async function inspectPlaylist(mediaUrl: string, signal: AbortSignal, ensureOrigins: (urls: string[]) => Promise<void>) {
  await ensureOrigins([mediaUrl]);
  const text = await fetchText(mediaUrl, signal);
  const plan = parsePlaylist(text, mediaUrl);
  if (plan.kind === "master") {
    if (plan.variants.length === 0) throw new Error("主列表里没有清晰度");
    return { mode: "master" as const, variants: plan.variants };
  }
  const reason = mediaPlaylistError(plan);
  if (reason) throw new Error(reason);
  return { mode: "media" as const, segmentCount: plan.segments.length };
}

function pickVariant(variants: Variant[], variantUri: string | undefined): Variant {
  const fallback = variants.find((variant) => variant?.uri);
  if (!fallback) throw new Error("主列表里没有清晰度");
  if (!variantUri) return fallback;
  return variants.find((variant) => variant?.uri === variantUri) ?? fallback;
}

function planPieces(dir: string, plan: MediaPlaylistPlan): StoredPiece[] {
  const ext = plan.init ? "m4s" : "ts";
  const pieces: StoredPiece[] = [];
  let lastMap = "";
  for (let index = 0; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index];
    if (!segment) continue;
    if (segment.mapUri && segment.mapUri !== lastMap) {
      pieces.push({
        path: `${dir}/map-${String(index).padStart(5, "0")}.mp4`,
        url: segment.mapUri,
        byterange: segment.mapByterange,
      });
      lastMap = segment.mapUri;
    }
    const reason = keyError(segment.key);
    if (reason) throw new Error(reason);
    pieces.push({
      path: `${dir}/${String(index).padStart(5, "0")}.${ext}`,
      url: segment.uri,
      byterange: segment.byterange,
      key: segment.key,
    });
  }
  return pieces;
}

async function downloadPieces(
  jobId: string,
  pieces: StoredPiece[],
  signal: AbortSignal,
  onPiece: (bytes: number) => void,
): Promise<void> {
  // 其中一个分片失败就取消其余在途请求，避免池子把错误吞掉后继续写半截文件。
  const child = new AbortController();
  const onAbort = () => child.abort();
  signal.addEventListener("abort", onAbort);
  const keys = new Map<string, Promise<ArrayBuffer>>();
  try {
    await mapPool(pieces, SEGMENT_CONCURRENCY, async (piece) => {
      if (child.signal.aborted) throw abortError();
      let data = await fetchBytesWithRetry(piece.url, { signal: child.signal, byterange: piece.byterange });
      if (piece.key) {
        // 先解密再写入。ffmpeg 只做 -c copy，看不到播放列表里的 AES-128。
        const key = await loadKey(keys, piece.key.uri, child.signal);
        data = await decryptAes128(data, key, piece.key.iv);
      }
      await writeJobFile(jobId, piece.path, data);
      onPiece(data.byteLength);
    });
  } catch (error) {
    child.abort();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function loadKey(cache: Map<string, Promise<ArrayBuffer>>, url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const existing = cache.get(url);
  if (existing) return existing;
  const pending = fetchBytesWithRetry(url, { signal });
  cache.set(url, pending);
  return pending;
}

function abortError(): Error {
  const error = new Error("已取消");
  error.name = "AbortError";
  return error;
}

export { publicError };
