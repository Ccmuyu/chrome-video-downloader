// 隔离世界。MAIN world 不能用 chrome.runtime，地址经 postMessage 转到这里再发给后台。
export default defineUnlistedScript(() => {
  const flag = "__cvdContent";
  const scoped = globalThis as typeof globalThis & { [flag]?: boolean };
  if (scoped[flag]) return;
  scoped[flag] = true;

  const report = (url: string, mime?: string) => {
    void chrome.runtime.sendMessage({
      type: "SNIFF",
      pageUrl: location.href,
      pageTitle: document.title,
      url,
      mime,
    });
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; url?: string; mime?: string } | null;
    if (!data || data.source !== "cvd-hook" || typeof data.url !== "string") return;
    report(data.url, data.mime);
  });
  const scan = () => {
    void chrome.runtime.sendMessage({
      type: "PAGE_META",
      pageUrl: location.href,
      pageTitle: document.title,
    });
    for (const element of document.querySelectorAll("video, audio")) {
      const media = element as HTMLMediaElement;
      const src = media.currentSrc || media.src;
      if (src) report(src);
    }
  };
  const start = () => {
    scan();
    const root = document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(() => scan());
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
  document.addEventListener("loadedmetadata", scan, true);
  document.addEventListener("play", scan, true);
  window.setInterval(scan, 2000);
});
