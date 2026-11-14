export const SEGMENT_CONCURRENCY = 4;
export const SEGMENT_RETRIES = 3;
export const SEGMENT_TIMEOUT_MS = 20_000;
export const RETRY_BACKOFF_MS = [300, 900, 2000] as const;
// 在 wasm 堆（约 2GB）耗尽之前停。封装时分片还要再拼进一份内存，所以阈值低于 2GB。
export const MUX_BYTE_LIMIT = Math.floor(1.5 * 1024 * 1024 * 1024);
export const PREVIEW_BYTE_LIMIT = 100 * 1024;

export const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
]);

export const DASH_MIME = new Set(["application/dash+xml"]);
