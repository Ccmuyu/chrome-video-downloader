import { classifyMime, classifyUrl, contentLengthOf, headerValue, isHoverPreview, isPreviewSized, mergeDetection } from "../src/lib/sniff";
import { cancelJob, dismissJob, failInterruptedJobs, resolveMedia, startJob, attachDownloadListener } from "../src/lib/controller";
import { isEnabled, setEnabled } from "../src/lib/enabled";
import { pageIsGranted, patternMatches, grantedOriginPatterns } from "../src/lib/permissions";
import { clearOwnedSessionRules } from "../src/lib/referer-rules";
import { dropTab, forgetAllMedia, forgetMedia, readState, replaceTabPage, saveJob, setPageMeta, upsertMedia } from "../src/lib/store";
import type { DownloadJob, PopupState, SniffedMedia } from "../src/lib/types";
import { isHttpUrl, pathKeyOf } from "../src/lib/url";

// 这两个文件是 unlisted script，不走 WXT 的 content script 入口，避免构建期写上全站 host_permissions。
// 授权之后才用 scripting.registerContentScripts 按来源注册。
const CONTENT_FILES = ["page-hook.js"];
const HOOK_FILES = ["injected.js"];
const CONTENT_ID = "cvd-content";
const HOOK_ID = "cvd-hook";

let offscreenPort: chrome.runtime.Port | null = null;
const muxWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

export default defineBackground(() => {
  attachDownloadListener();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "offscreen") return;
    offscreenPort = port;
    port.onMessage.addListener((message) => {
      void onOffscreenMessage(message as OffscreenMessage);
    });
    port.onDisconnect.addListener(() => {
      if (offscreenPort === port) offscreenPort = null;
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void onMessage(message as Incoming, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : "扩展内部错误";
        sendResponse({ ok: false, error: text });
      });
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void onTabRemoved(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) void onTabUrl(tabId, info.url);
  });
  chrome.permissions.onAdded.addListener(() => {
    void syncInjections();
    void syncWebRequest();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void syncInjections();
    void syncWebRequest();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["cvd-enabled"]) void applyEnabledEffects();
  });
  void boot();
});

type Incoming =
  | { type: "GET_STATE"; tabId: number }
  | { type: "SET_ENABLED"; enabled: boolean }
  | { type: "INJECT" }
  | { type: "SNIFF"; pageUrl: string; pageTitle: string; url: string; mime?: string }
  | { type: "PAGE_META"; pageUrl: string; pageTitle: string }
  | { type: "RESOLVE"; mediaId: string }
  | { type: "START"; mediaId: string; variantUri?: string }
  | { type: "CANCEL"; jobId: string }
  | { type: "DISMISS"; jobId: string }
  | { type: "REMOVE_MEDIA"; mediaId: string }
  | { type: "CLEAR_MEDIA"; tabId: number };

type OffscreenMessage =
  | { type: "MUX_SAVING"; jobId: string }
  | { type: "MUX_DONE"; jobId: string }
  | { type: "MUX_ERROR"; jobId: string; error: string };

async function boot(): Promise<void> {
  // Service Worker 会被回收。上次的会话规则和进行中的任务都不能接着用。
  await clearOwnedSessionRules();
  await failInterruptedJobs();
  await syncInjections();
  await syncWebRequest();
  await chrome.action.setTitle({ title: (await isEnabled()) ? "视频下载" : "视频下载（已关闭）" });
}

let webRequestQueue: Promise<void> = Promise.resolve();

function syncWebRequest(): Promise<void> {
  const run = webRequestQueue.then(applyWebRequestFilter);
  webRequestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function onCompleted(details: chrome.webRequest.OnCompletedDetails): void {
  void onRequest(details);
}

async function applyWebRequestFilter(): Promise<void> {
  // 安装时没有任何站点权限。这时若用 http://*/* 注册 webRequest，Chrome 会报错且收不到事件。
  // 只在已授权的来源上注册；授权变化时先卸掉再装上新的过滤条件。
  if (chrome.webRequest.onCompleted.hasListener(onCompleted)) {
    chrome.webRequest.onCompleted.removeListener(onCompleted);
  }
  if (!(await isEnabled())) return;
  const urls = await grantedOriginPatterns();
  if (urls.length === 0) return;
  try {
    chrome.webRequest.onCompleted.addListener(onCompleted, { urls }, ["responseHeaders"]);
  } catch {
    // 没有对应站点权限时 Chrome 会拒绝这次注册。开关本身仍然保持打开。
  }
}

let enabledQueue: Promise<void> = Promise.resolve();

function applyEnabledEffects(): Promise<void> {
  const run = enabledQueue.then(runEnabledEffects);
  enabledQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runEnabledEffects(): Promise<void> {
  const enabled = await isEnabled();
  try {
    await syncInjections();
    await syncWebRequest();
    if (enabled) await refreshAllBadges();
    else await clearBadges();
    await chrome.action.setTitle({ title: enabled ? "视频下载" : "视频下载（已关闭）" });
  } catch {
    // 页面脚本注册失败时，仍然保留开关状态。
  }
}

async function onMessage(message: Incoming, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "GET_STATE":
      return getPopupState(message.tabId);
    case "SET_ENABLED":
      await setEnabled(message.enabled);
      // 注入失败不能挡住响应，否则弹层会一直停在关闭。
      void applyEnabledEffects();
      return { ok: true, enabled: message.enabled };
    case "INJECT":
      await syncInjections();
      return { ok: true };
    case "SNIFF": {
      if (!(await isEnabled())) return { ok: false };
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false };
      const pageUrl = isHttpUrl(message.pageUrl) ? message.pageUrl : sender.tab?.url ?? "";
      if (!(await pageIsGranted(pageUrl))) return { ok: false };
      await remember({
        tabId,
        pageUrl,
        pageTitle: message.pageTitle,
        url: message.url,
        mime: message.mime,
      });
      return { ok: true };
    }
    case "PAGE_META": {
      if (!(await isEnabled())) return { ok: false };
      const tabId = sender.tab?.id;
      if (tabId == null || !isHttpUrl(message.pageUrl)) return { ok: false };
      if (!(await pageIsGranted(message.pageUrl))) return { ok: false };
      await setPageMeta(tabId, message.pageUrl, message.pageTitle);
      await refreshBadge(tabId);
      return { ok: true };
    }
    case "RESOLVE": {
      if (!(await isEnabled())) return { ok: false, error: "扩展已关闭" };
      const media = await findMedia(message.mediaId);
      if (!media) return { ok: false, error: "这条资源已经不在列表里" };
      return resolveMedia(media);
    }
    case "START": {
      if (!(await isEnabled())) return { ok: false, error: "扩展已关闭" };
      const media = await findMedia(message.mediaId);
      if (!media) return { ok: false, error: "这条资源已经不在列表里" };
      // startJob 自己把任务写成 resolving/fetching。这里再 saveJob 会把状态盖回 queued。
      const started = startJob(media, message.variantUri, muxJob);
      if ("error" in started) return { ok: false, error: started.error };
      return { ok: true, job: started };
    }
    case "CANCEL":
      await cancelJob(message.jobId);
      offscreenPort?.postMessage({ type: "MUX_CANCEL", jobId: message.jobId });
      return { ok: true };
    case "DISMISS":
      await dismissJob(message.jobId);
      return { ok: true };
    case "REMOVE_MEDIA":
      await removeMedia(message.mediaId);
      return { ok: true };
    case "CLEAR_MEDIA":
      await clearMedia(message.tabId);
      return { ok: true };
    default:
      return { ok: false };
  }
}

async function onRequest(details: chrome.webRequest.OnCompletedDetails): Promise<void> {
  // tabId < 0 是扩展自己的请求（分片下载）。记进去会把正在下的分片再列成一条资源。
  if (details.tabId < 0) return;
  if (details.initiator?.startsWith("chrome-extension://")) return;
  const skipped = new Set(["image", "stylesheet", "script", "font", "ping", "csp_report", "object"]);
  if (skipped.has(details.type)) return;
  const mime = headerValue(details.responseHeaders, "content-type");
  const length = contentLengthOf(details.responseHeaders);
  // 运行时有 documentUrl，@types/chrome 的 OnCompletedDetails 没声明这个字段。
  const documentUrl = (details as chrome.webRequest.OnCompletedDetails & { documentUrl?: string }).documentUrl;
  const pageUrl = isHttpUrl(documentUrl ?? "") ? documentUrl! : details.initiator ?? "";
  if (!isHttpUrl(pageUrl)) return;
  if (!(await pageIsGranted(pageUrl))) return;
  let pageTitle = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    pageTitle = tab.title ?? "";
  } catch {
    pageTitle = "";
  }
  await remember({
    tabId: details.tabId,
    pageUrl,
    pageTitle,
    url: details.url,
    mime,
    contentLength: length,
  });
}

async function remember(input: {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  url: string;
  mime?: string;
  contentLength?: number | null;
}): Promise<void> {
  if (!isHttpUrl(input.url)) return;
  const detection = mergeDetection(classifyUrl(input.url), classifyMime(input.mime));
  if (!detection?.listable) return;
  if (isPreviewSized(detection.kind, input.contentLength ?? null)) return;
  const pathKey = pathKeyOf(input.url);
  const item: SniffedMedia = {
    id: `${input.tabId}:${pathKey}`,
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    pageTitle: typeof input.pageTitle === "string" ? input.pageTitle : "",
    url: input.url,
    pathKey,
    kind: detection.kind,
    mime: input.mime,
    referer: input.pageUrl,
    detectedAt: Date.now(),
    unsupportedReason: detection.kind === "dash" ? "DASH 留到第二期" : undefined,
  };
  await upsertMedia(item);
  await refreshBadge(input.tabId);
}

async function getPopupState(tabId: number): Promise<PopupState> {
  const state = await readState();
  let pageUrl = "";
  let pageTitle = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url ?? "";
    pageTitle = tab.title ?? "";
  } catch {
    pageUrl = "";
  }
  const bucket = state.tabs[String(tabId)];
  return {
    tabId,
    pageUrl: pageUrl || bucket?.pageUrl || "",
    pageTitle: pageTitle || bucket?.pageTitle || "",
    granted: pageUrl ? await pageIsGranted(pageUrl) : false,
    enabled: await isEnabled(),
    items: visibleItems(bucket?.items ?? []),
    jobs: state.jobs.filter((job) => job.tabId === tabId),
  };
}

async function removeMedia(mediaId: string): Promise<void> {
  const media = await findMedia(mediaId);
  if (!media) return;
  const state = await readState();
  const jobs = state.jobs.filter((job) => job.mediaId === media.id);
  await forgetMedia(media.tabId, media.id);
  for (const job of jobs) await stopJob(job);
  await refreshBadge(media.tabId);
}

async function clearMedia(tabId: number): Promise<void> {
  const state = await readState();
  const jobs = state.jobs.filter((job) => job.tabId === tabId);
  await forgetAllMedia(tabId);
  for (const job of jobs) await stopJob(job);
  await refreshBadge(tabId);
}

async function stopJob(job: DownloadJob): Promise<void> {
  if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
    await dismissJob(job.id);
    return;
  }
  await cancelJob(job.id);
  offscreenPort?.postMessage({ type: "MUX_CANCEL", jobId: job.id });
}

async function findMedia(mediaId: string): Promise<SniffedMedia | null> {
  const state = await readState();
  for (const bucket of Object.values(state.tabs)) {
    const found = bucket.items.find((item) => item.id === mediaId);
    if (found) return found;
  }
  return null;
}

async function onTabRemoved(tabId: number): Promise<void> {
  // 已经在拉分片或封装的任务不跟着标签页取消，文件还在写。只停还没开始取数据的任务。
  const state = await readState();
  for (const job of state.jobs) {
    if (job.tabId !== tabId) continue;
    if (job.state === "queued" || job.state === "resolving") await cancelJob(job.id);
  }
  await dropTab(tabId);
  await chrome.action.setBadgeText({ tabId, text: "" });
}

async function onTabUrl(tabId: number, url: string): Promise<void> {
  await replaceTabPage(tabId, url);
  if (!(await isEnabled())) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  await refreshBadge(tabId);
  if (await pageIsGranted(url)) await injectTab(tabId);
}

async function syncInjections(): Promise<void> {
  const matches = await grantedOriginPatterns();
  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID, HOOK_ID] }).catch(() => undefined);
  // 关闭时卸掉注册。已经打开的页面里脚本还在，后台会丢掉它们的上报。
  if (!(await isEnabled()) || matches.length === 0) return;
  const scripts: chrome.scripting.RegisteredContentScript[] = [
    {
      id: CONTENT_ID,
      js: CONTENT_FILES,
      matches,
      runAt: "document_start",
      persistAcrossSessions: true,
    },
    {
      id: HOOK_ID,
      js: HOOK_FILES,
      matches,
      runAt: "document_start",
      persistAcrossSessions: true,
      world: "MAIN",
    },
  ];
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch {
    // 上次的持久注册可能还在。再卸一次后重试，避免 Duplicate script ID 把打开开关的流程打断。
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID, HOOK_ID] }).catch(() => undefined);
    await chrome.scripting.registerContentScripts(scripts);
  }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null || !tab.url || !isHttpUrl(tab.url)) continue;
    if (!matches.some((pattern) => patternMatches(pattern, tab.url!))) continue;
    await injectTab(tab.id);
  }
}

async function injectTab(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }).catch(() => undefined);
  await chrome.scripting
    .executeScript({ target: { tabId }, files: HOOK_FILES, world: "MAIN" })
    .catch(() => undefined);
}

async function clearBadges(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (tab.id == null ? undefined : chrome.action.setBadgeText({ tabId: tab.id, text: "" }))));
}

async function refreshAllBadges(): Promise<void> {
  const state = await readState();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const count = visibleItems(state.tabs[String(tab.id)]?.items ?? []).length;
    await chrome.action.setBadgeText({ tabId: tab.id, text: count > 0 ? String(Math.min(count, 99)) : "" });
    if (count > 0) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#0f766e" });
  }
}

async function refreshBadge(tabId: number): Promise<void> {
  if (!(await isEnabled())) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const state = await readState();
  const count = visibleItems(state.tabs[String(tabId)]?.items ?? []).length;
  await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 99)) : "" });
  if (count > 0) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0f766e" });
}

function visibleItems(items: SniffedMedia[]): SniffedMedia[] {
  return items.filter((item) => !isHoverPreview(item.url));
}

async function muxJob(jobId: string, filename: string): Promise<void> {
  await ensureOffscreen();
  const port = await waitForPort();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      muxWaiters.delete(jobId);
      reject(new Error("封装超时"));
    }, 30 * 60 * 1000);
    muxWaiters.set(jobId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    port.postMessage({ type: "MUX", jobId, filename });
  });
}

async function onOffscreenMessage(message: OffscreenMessage): Promise<void> {
  if (message.type === "MUX_SAVING") {
    const state = await readState();
    const job = state.jobs.find((item) => item.id === message.jobId);
    if (!job) return;
    const next: DownloadJob = { ...job, state: "saving", progress: { done: 9, total: 10 } };
    await saveJob(next);
    return;
  }
  const waiter = muxWaiters.get(message.jobId);
  if (!waiter) return;
  muxWaiters.delete(message.jobId);
  if (message.type === "MUX_DONE") waiter.resolve();
  if (message.type === "MUX_ERROR") waiter.reject(new Error(message.error || "封装失败"));
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "把 HLS 分片封装成一个 MP4 文件",
  });
}

async function waitForPort(): Promise<chrome.runtime.Port> {
  if (offscreenPort) return offscreenPort;
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (offscreenPort) return offscreenPort;
  }
  throw new Error("封装页面没有连上");
}
