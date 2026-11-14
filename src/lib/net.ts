import { SEGMENT_RETRIES, SEGMENT_TIMEOUT_MS, RETRY_BACKOFF_MS } from "./constants";

export class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

type FetchBytesOptions = {
  signal: AbortSignal;
  byterange?: { offset: number; length: number };
  timeoutMs?: number;
};

// credentials: "include" 带上该源的 Cookie。Referer / Origin 不在这里设，由声明式网络请求规则加到扩展请求上。
export async function fetchBytes(url: string, options: FetchBytesOptions): Promise<ArrayBuffer> {
  const headers = new Headers();
  if (options.byterange) {
    const start = options.byterange.offset;
    const end = start + options.byterange.length - 1;
    headers.set("Range", `bytes=${start}-${end}`);
  }
  const response = await fetchWithTimeout(
    url,
    { credentials: "include", headers, signal: options.signal },
    options.timeoutMs ?? SEGMENT_TIMEOUT_MS,
    options.signal,
  );
  if (response.status === 403 || response.status === 410) throw new HttpError(response.status);
  if (!response.ok) throw new HttpError(response.status);
  const buffer = await response.arrayBuffer();
  const range = options.byterange;
  // 有的 CDN 忽略 Range，用 200 把整文件返回。按请求的范围切开，避免每个分片都收下整条片子。
  if (range && response.status !== 206 && buffer.byteLength > range.length) {
    const end = range.offset + range.length;
    if (range.offset >= 0 && end <= buffer.byteLength) return buffer.slice(range.offset, end);
  }
  return buffer;
}

export async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(
    url,
    { credentials: "include", signal },
    SEGMENT_TIMEOUT_MS,
    signal,
  );
  if (response.status === 403 || response.status === 410) throw new HttpError(response.status);
  if (!response.ok) throw new HttpError(response.status);
  return response.text();
}

export async function fetchBytesWithRetry(url: string, options: FetchBytesOptions): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt += 1) {
    try {
      return await fetchBytes(url, options);
    } catch (error) {
      lastError = error;
      if (options.signal.aborted) throw error;
      // 403 / 410 多半是签名过期，重试同一地址不会变好。
      if (error instanceof HttpError && (error.status === 403 || error.status === 410)) throw error;
      if (attempt === SEGMENT_RETRIES) break;
      await delay(RETRY_BACKOFF_MS[attempt] ?? 2000, options.signal);
    }
  }
  throw lastError;
}

export function publicError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 403 || error.status === 410) return "链接可能已过期，请重新播放后再试";
    return `下载失败（${error.status}）`;
  }
  if (isAbort(error)) return "已取消";
  if (error instanceof Error) {
    const message = error.message.trim();
    if (
      message &&
      message.length <= 80 &&
      !message.includes("?") &&
      !/cookie|authorization|bearer/i.test(message)
    ) {
      return message;
    }
  }
  return "下载失败";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // 超时和用户取消都会变成 AbortError。父信号已中止才是取消，否则是这一次请求超时。
    if (parent.aborted) {
      const abort = new Error("已取消");
      abort.name = "AbortError";
      throw abort;
    }
    if (isAbort(error)) throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const abort = new Error("已取消");
      abort.name = "AbortError";
      reject(abort);
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  });
}

export async function mapPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });
  await Promise.all(runners);
}
