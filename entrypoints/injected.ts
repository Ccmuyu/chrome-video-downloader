import { classifyMime, classifyUrl, isPlaylistText, mergeDetection, shouldPeekBody } from "../src/lib/sniff";

const FLAG = "__cvdHooked";

// MAIN world。只上报地址；分片字节留给页面播放器。
export default defineUnlistedScript(() => {
    const scoped = window as Window & { [FLAG]?: boolean };
    if (scoped[FLAG]) return;
    scoped[FLAG] = true;

    const report = (url: string, mime?: string | null) => {
      if (!url) return;
      window.postMessage({ source: "cvd-hook", url, mime: mime || undefined }, "*");
    };

    const absolute = (value: unknown): string => {
      try {
        if (value instanceof Request) return value.url;
        if (value instanceof URL) return value.href;
        return new URL(String(value), location.href).href;
      } catch {
        return "";
      }
    };

    const interesting = (url: string, mime?: string | null): boolean => {
      const detection = mergeDetection(classifyUrl(url), classifyMime(mime));
      return Boolean(detection?.listable);
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      try {
        const url = response.url || absolute(args[0]);
        const mime = response.headers.get("content-type");
        if (interesting(url, mime)) report(url, mime);
        else if (shouldPeekBody(url, mime) && response.body) {
          const copy = response.clone();
          void readPrefix(copy).then((text) => {
            if (isPlaylistText(text)) report(url, "application/vnd.apple.mpegurl");
          }).catch(() => undefined);
        }
      } catch {
        // 钩子不能影响页面播放
      }
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
      (this as XMLHttpRequest & { __cvdUrl?: string }).__cvdUrl = absolute(url);
      return originalOpen.call(this, method, url, async ?? true, username, password);
    };
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      this.addEventListener("load", () => {
        void inspectXhr(this as XMLHttpRequest & { __cvdUrl?: string });
      });
      return originalSend.call(this, body);
    };

    async function inspectXhr(xhr: XMLHttpRequest & { __cvdUrl?: string }) {
      try {
        const url = xhr.__cvdUrl || "";
        const mime = xhr.getResponseHeader("content-type");
        if (interesting(url, mime)) {
          report(url, mime);
          return;
        }
        if (!shouldPeekBody(url, mime)) return;
        const text = await xhrPrefix(xhr);
        if (isPlaylistText(text)) report(url, "application/vnd.apple.mpegurl");
      } catch {
        // 读不到响应体时只依赖地址和类型
      }
    }
});

async function readPrefix(response: Response): Promise<string> {
  // 无扩展名的 m3u8 只有正文能认出来。只读 256 字节后 cancel，避免把整段媒体缓冲进内存。
  // 调用方传入的是 clone()，取消这个 reader 不会动页面正在读的那一份。
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value?.slice(0, 256));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function xhrPrefix(xhr: XMLHttpRequest): Promise<string> {
  if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText.slice(0, 256);
  if (xhr.responseType === "arraybuffer" && xhr.response instanceof ArrayBuffer) {
    return new TextDecoder().decode(xhr.response.slice(0, 256));
  }
  if (xhr.responseType === "blob" && xhr.response instanceof Blob) {
    return new TextDecoder().decode(await xhr.response.slice(0, 256).arrayBuffer());
  }
  return "";
}
