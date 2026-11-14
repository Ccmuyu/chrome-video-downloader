import { HLS_MIME, DASH_MIME, PREVIEW_BYTE_LIMIT } from "./constants";
import type { MediaKind } from "./types";
import { extensionOf, isHttpUrl } from "./url";

const FILE_EXTENSIONS = new Set([".mp4", ".webm", ".m4a", ".mp3", ".m4v", ".mov"]);
const SEGMENT_EXTENSIONS = new Set([".ts", ".m4s"]);
const SKIP_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".html",
  ".htm",
  ".json",
  ".map",
  ".wasm",
]);

export type Detection = {
  kind: MediaKind;
  listable: boolean;
};

export function classifyUrl(value: string): Detection | null {
  if (!isHttpUrl(value)) return null;
  const ext = extensionOf(value);
  if (ext === ".m3u8") return { kind: "hls", listable: true };
  if (ext === ".mpd") return { kind: "dash", listable: true };
  // 悬停动图也是 video/webm。必须在 MIME 合并之前标成不可列出，否则 video/* 会把它救回来。
  if (isHoverPreview(value)) return { kind: "file", listable: false };
  if (FILE_EXTENSIONS.has(ext)) return { kind: "file", listable: true };
  // 分片本身不是一条可下载资源。listable 为 false 时，后面的 MIME 也不能把它救进列表。
  if (SEGMENT_EXTENSIONS.has(ext)) return { kind: "file", listable: false };
  return null;
}

export function classifyMime(mime: string | null | undefined): Detection | null {
  if (!mime) return null;
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (HLS_MIME.has(type)) return { kind: "hls", listable: true };
  if (DASH_MIME.has(type)) return { kind: "dash", listable: true };
  if (type.startsWith("video/") || type.startsWith("audio/")) return { kind: "file", listable: true };
  return null;
}

// 地址已经判定为分片时，忽略 MIME。否则 video/mp2t 会把 .ts 列成一条直链。
export function mergeDetection(urlHit: Detection | null, mimeHit: Detection | null): Detection | null {
  if (urlHit && !urlHit.listable) return urlHit;
  return urlHit ?? mimeHit;
}

export function shouldPeekBody(value: string, mime: string | null | undefined): boolean {
  if (!isHttpUrl(value)) return false;
  const ext = extensionOf(value);
  if (SKIP_EXTENSIONS.has(ext) || SEGMENT_EXTENSIONS.has(ext) || FILE_EXTENSIONS.has(ext)) return false;
  if (ext === ".m3u8" || ext === ".mpd") return false;
  const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type) return true;
  if (HLS_MIME.has(type) || DASH_MIME.has(type)) return false;
  if (type.startsWith("video/") || type.startsWith("audio/") || type.startsWith("image/")) return false;
  return (
    type === "text/plain" ||
    type === "application/octet-stream" ||
    type === "application/text" ||
    type === "binary/octet-stream"
  );
}

export function isPlaylistText(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

// 列表悬停预览：180P_225K_123.webm 这种几秒动图，或者路径里带 preview / mediabook / thumb。
// 正片的 webm 文件名不会落在这么低的分辨率和码率上。
export function isHoverPreview(value: string): boolean {
  let path = "";
  let name = "";
  try {
    const url = new URL(value);
    path = decodeURIComponent(url.pathname).toLowerCase();
    name = path.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return false;
  }
  const ext = extensionOf(value);
  if (ext === ".m3u8" || ext === ".mpd") return false;
  if ((ext === ".webm" || ext === ".mp4") && /\/(preview|previews|mediabook|thumbs|thumbnails)\//.test(path)) {
    return true;
  }
  const match = name.match(/(\d{2,4})p_(\d+)k_\d+\.webm$/);
  if (!match) return false;
  const height = Number(match[1]);
  const kbps = Number(match[2]);
  return height <= 240 && kbps <= 300;
}

// 片头预览、封面短视频经常也是 video/*。小于 100KB 的直链不进列表。
export function isPreviewSized(kind: MediaKind, contentLength: number | null): boolean {
  if (kind !== "file") return false;
  if (contentLength == null || !Number.isFinite(contentLength)) return false;
  return contentLength >= 0 && contentLength < PREVIEW_BYTE_LIMIT;
}

export function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | undefined {
  const found = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return found?.value;
}

export function contentLengthOf(headers: Array<{ name?: string; value?: string }> | undefined): number | null {
  const raw = headerValue(headers, "content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
