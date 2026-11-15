import { kindLabel } from "../../src/lib/labels";
import type { DownloadJob, PopupState, SniffedMedia, Variant } from "../../src/lib/types";
import { originPattern } from "../../src/lib/url";

type Picker = {
  mediaId: string;
  variants: Variant[];
};

type Notice = { mediaId: string; text: string; origins?: string[] };

let picker: Picker | null = null;
let notice: Notice | null = null;
let busyMedia: string | null = null;
let listScroll = 0;

const ENABLED_KEY = "cvd-enabled";
const app = document.querySelector<HTMLElement>("#app");

const ICONS = {
  download: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15 7.5 10.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 4h6M5 7h14M8 7l.8 12h6.4L16 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 5 6v6c0 4.2 2.8 7.4 7 8.5 4.2-1.1 7-4.3 7-8.5V6l-7-3Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.2 2.2 4.8-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" || (area === "local" && changes[ENABLED_KEY])) void refresh();
});

app?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".power")) return;
  event.preventDefault();
  void togglePower();
});

void refresh();

async function readEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] !== false;
}

let powerLock = false;

async function togglePower(): Promise<void> {
  if (powerLock) return;
  powerLock = true;
  const button = app?.querySelector(".power");
  const enabled = button?.getAttribute("aria-checked") !== "true";
  button?.setAttribute("aria-checked", enabled ? "true" : "false");
  try {
    // 先写在弹层里。后台若在重新注入脚本时失败，也不能把这次打开丢掉。
    await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
    await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled }).catch(() => undefined);
  } finally {
    powerLock = false;
    await refresh();
  }
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  if (!app) return;
  const enabled = await readEnabled();
  const state = (await chrome.runtime.sendMessage({ type: "GET_STATE", tabId: tab?.id ?? -1 }).catch(() => null)) as PopupState | null;
  if (!enabled) {
    paint(shell({
      title: "视频下载",
      host: "已关闭",
      enabled: false,
      body: emptyState("play", "嗅探已关闭", "打开右上角的开关后，才会在已授权的网页上寻找视频和音频。", ""),
    }));
    return;
  }
  if (!state || typeof state.pageUrl !== "string") {
    paint(shell({
      title: "视频下载",
      host: tab?.url ? safeHost(tab.url) : "当前页面",
      enabled: true,
      body: emptyState("shield", "暂时读不到页面", "开关已经打开。若列表没有出现，到扩展管理页刷新一次再试。", ""),
    }));
    return;
  }
  if (!tab?.id || !tab.url) {
    paint(shell({
      title: "视频下载",
      host: "没有可读取的标签页",
      enabled: true,
      body: emptyState("shield", "打开一个网页", "在普通网页上点扩展图标。浏览器内部页不能嗅探。", ""),
    }));
    return;
  }
  render(state, tab.favIconUrl);
}

function render(state: PopupState, favicon?: string): void {
  if (!app) return;
  const host = state.pageUrl ? safeHost(state.pageUrl) : "";
  const title = state.pageTitle || host || "视频下载";
  if (!state.pageUrl.startsWith("http://") && !state.pageUrl.startsWith("https://")) {
    paint(shell({
      title,
      host: host || "当前页面",
      favicon,
      enabled: true,
      body: emptyState("shield", "这个页面不能嗅探", "打开 http 或 https 页面。扩展不读取浏览器内部页。", ""),
    }));
    return;
  }
  if (!state.granted) {
    paint(shell({
      title,
      host,
      favicon,
      enabled: true,
      body: emptyState(
        "shield",
        "授权此站点",
        "授权后才会寻找视频和音频地址。地址只留在本机，不会上传。",
        `<button class="btn primary" id="grant" type="button">允许访问 ${escapeHtml(host)}</button>`,
      ),
    }));
    document.querySelector("#grant")?.addEventListener("click", () => void grant(state.pageUrl));
    return;
  }
  const items = [...state.items].sort((a, b) => b.detectedAt - a.detectedAt);
  const body = items.length === 0
    ? emptyState("play", "还没有发现媒体", "先播放视频。很多站点必须点播放，地址才会出现。", "")
    : `<div class="list">${items.map((item) => card(item, state.jobs)).join("")}</div>`;
  paint(shell({
    title,
    host,
    favicon,
    enabled: true,
    count: items.length || undefined,
    clearable: items.length > 0,
    body,
  }));
  const scroller = app.querySelector<HTMLElement>(".body");
  if (scroller) scroller.scrollTop = listScroll;
  bind(state);
}

function shell(options: { title: string; host: string; favicon?: string; count?: number; enabled: boolean; clearable?: boolean; body: string }): string {
  const logo = chrome.runtime.getURL("icon/32.png");
  const favicon = options.favicon
    ? `<img class="favicon" src="${escapeHtml(options.favicon)}" alt="">`
    : "";
  const count = options.enabled && options.count ? `<div class="count">${options.count}</div>` : "";
  const clear = options.clearable ? `<button class="clear" id="clear" type="button">清空</button>` : "";
  const checked = options.enabled ? "true" : "false";
  return `<div class="shell">
    <header class="top">
      <img class="logo" src="${logo}" alt="" width="28" height="28">
      <div class="brand">
        <div class="name">${escapeHtml(options.title)}</div>
        <div class="site">${favicon}<span>${escapeHtml(options.host)}</span></div>
      </div>
      ${count}
      ${clear}
      <button class="power" id="power" type="button" role="switch" aria-checked="${checked}" aria-label="${options.enabled ? "关闭嗅探" : "开启嗅探"}"><span></span></button>
    </header>
    <div class="body">${options.body}</div>
  </div>`;
}

function paint(html: string): void {
  if (!app) return;
  app.innerHTML = html;
}

function emptyState(icon: "play" | "shield", title: string, text: string, extra: string): string {
  return `<section class="empty">
    <div class="empty-mark">${ICONS[icon]}</div>
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(text)}</p>
    ${extra}
  </section>`;
}

function card(item: SniffedMedia, jobs: DownloadJob[]): string {
  const related = jobs.filter((entry) => entry.mediaId === item.id);
  const job = [...related].reverse().find((entry) => entry.state !== "done" && entry.state !== "cancelled") ?? related.at(-1);
  const line = subtitle(item, job);
  const disabled = Boolean(item.unsupportedReason) || Boolean(job && active(job));
  return `<article class="row${item.unsupportedReason ? " is-disabled" : ""}">
    <div class="row-main">
      <span class="badge badge-${item.kind}">${kindLabel(item.kind)}</span>
      <div class="meta">
        <div class="res-name" title="${escapeHtml(item.url)}">${escapeHtml(resourceName(item))}</div>
        <div class="res-sub ${line.klass}" title="${escapeHtml(line.text)}">${escapeHtml(line.text)}</div>
      </div>
      <div class="row-actions">${rowActions(item, job, disabled)}</div>
    </div>
    ${job && (job.state === "fetching" || job.state === "muxing" || job.state === "saving") ? progressBar(job) : ""}
    ${picker?.mediaId === item.id ? qualityPicker(item.id, picker.variants) : ""}
  </article>`;
}

function rowActions(item: SniffedMedia, job: DownloadJob | undefined, disabled: boolean): string {
  const buttons: string[] = [iconButton(`data-remove="${item.id}"`, "移除", ICONS.trash, "ghost")];
  if (item.unsupportedReason) return buttons.join("");
  if (job && (job.state === "failed" || job.state === "cancelled" || job.state === "done")) {
    buttons.push(iconButton(`data-dismiss="${job.id}"`, "清除", ICONS.close, "ghost"));
  }
  if (job && active(job)) {
    buttons.push(iconButton(`data-cancel="${job.id}"`, "取消", ICONS.stop, "ghost"));
    return buttons.join("");
  }
  const busy = busyMedia === item.id;
  buttons.push(`<button class="icon-btn" type="button" data-download="${item.id}" aria-label="${busy ? "正在读取清晰度" : "下载"}" ${disabled || busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span>` : ICONS.download}</button>`);
  return buttons.join("");
}

function iconButton(attr: string, label: string, icon: string, kind = ""): string {
  return `<button class="icon-btn ${kind}" type="button" ${attr} aria-label="${escapeHtml(label)}">${icon}</button>`;
}

function qualityPicker(mediaId: string, variants: Variant[]): string {
  const chips = variants.map((variant, index) => {
    const resolution = shortResolution(variant.resolution) || `清晰度 ${index + 1}`;
    const rate = formatRate(variant.bandwidth);
    return `<button class="chip${index === 0 ? " is-best" : ""}" type="button" data-pick="${mediaId}" data-index="${index}">
      <strong>${escapeHtml(resolution)}${index === 0 ? "<em>最高</em>" : ""}</strong>
      <span>${escapeHtml(rate || (variant.fps ? `${Math.round(variant.fps)} fps` : "点此下载"))}</span>
    </button>`;
  }).join("");
  return `<div class="pick"><div class="pick-label">选择清晰度</div><div class="chips">${chips}</div></div>`;
}

function progressBar(job: DownloadJob): string {
  const pct = percent(job);
  return `<div class="track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
}

function bind(state: PopupState): void {
  app?.querySelector<HTMLElement>(".body")?.addEventListener("scroll", (event) => {
    listScroll = (event.currentTarget as HTMLElement).scrollTop;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-download]").forEach((button) => {
    button.addEventListener("click", () => {
      const media = state.items.find((item) => item.id === button.dataset.download);
      if (media) void begin(media, state.jobs);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const media = state.items.find((item) => item.id === button.dataset.pick);
      const current = picker;
      const variant = current && current.mediaId === media?.id ? current.variants[Number(button.dataset.index)] : undefined;
      if (media && variant) void start(media, variant.uri, state.jobs);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((button) => {
    button.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "CANCEL", jobId: button.dataset.cancel });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-dismiss]").forEach((button) => {
    button.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "DISMISS", jobId: button.dataset.dismiss });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const mediaId = button.dataset.remove;
      if (mediaId) void removeOne(mediaId);
    });
  });
  document.querySelector<HTMLButtonElement>("#clear")?.addEventListener("click", () => {
    if (state.tabId != null) void removeAll(state.tabId);
  });
}

// 直链立即开始。HLS 先解析：多档清晰度展开选项，再点某一档才 START。再点下载按钮收起选项。
// chrome.permissions.request 必须在这次点击的调用栈里发出。先 await 消息再申请，浏览器会直接拒绝，弹不出授权。
async function begin(media: SniffedMedia, jobs: DownloadJob[]): Promise<void> {
  if (picker?.mediaId === media.id) {
    picker = null;
    notice = null;
    await refresh();
    return;
  }
  const patterns = patternsFor(media, jobs);
  const grant = await askOrigins(patterns);
  notice = null;
  if (!grant.ok) {
    notice = { mediaId: media.id, text: accessHint(patterns, true), origins: patterns };
    await refresh();
    return;
  }
  if (grant.fresh) await chrome.runtime.sendMessage({ type: "INJECT" }).catch(() => undefined);
  if (media.kind === "file") {
    await start(media);
    return;
  }
  if (media.kind === "dash") return;
  await resolveAndStart(media, 0);
}

async function resolveAndStart(media: SniffedMedia, attempt: number): Promise<void> {
  busyMedia = media.id;
  await refresh();
  const result = (await chrome.runtime.sendMessage({ type: "RESOLVE", mediaId: media.id })) as {
    ok: boolean;
    mode?: string;
    variants?: Variant[];
    error?: string;
    needOrigins?: string[];
  };
  busyMedia = null;
  if (!result.ok) {
    // 播放列表里的分片可能在另一个域名。这次申请已经离开点击调用栈，经常弹不出来；
    // 弹不出来就只留一句提示，下次点击会把这些域名带上，那时才能弹出授权。最多再试三次，避免同一域名来回请求。
    if (result.needOrigins?.length && attempt < 3) {
      const grant = await askOrigins(result.needOrigins);
      if (grant.ok) {
        if (grant.fresh) await chrome.runtime.sendMessage({ type: "INJECT" }).catch(() => undefined);
        return resolveAndStart(media, attempt + 1);
      }
      notice = {
        mediaId: media.id,
        text: accessHint(result.needOrigins, false),
        origins: result.needOrigins,
      };
      await refresh();
      return;
    }
    notice = { mediaId: media.id, text: result.error || "无法读取播放列表" };
    await refresh();
    return;
  }
  if (result.mode === "master" && result.variants && result.variants.length > 1) {
    picker = { mediaId: media.id, variants: result.variants };
    await refresh();
    return;
  }
  const only = result.mode === "master" ? result.variants?.[0]?.uri : undefined;
  await start(media, only);
}

async function start(media: SniffedMedia, variantUri?: string, jobs?: DownloadJob[]): Promise<void> {
  if (jobs && variantUri) {
    const patterns = patternsFor(media, jobs, variantUri);
    const grant = await askOrigins(patterns);
    notice = null;
    if (!grant.ok) {
      notice = { mediaId: media.id, text: accessHint(patterns, true), origins: patterns };
      await refresh();
      return;
    }
    if (grant.fresh) await chrome.runtime.sendMessage({ type: "INJECT" }).catch(() => undefined);
  }
  notice = null;
  const result = (await chrome.runtime.sendMessage({ type: "START", mediaId: media.id, variantUri })) as {
    ok: boolean;
    error?: string;
  };
  if (!result.ok) notice = { mediaId: media.id, text: result.error || "没能开始下载" };
  else picker = null;
  await refresh();
}

// 必须在点击调用栈里同步调用，不能先 await。已经允许的来源不会再弹窗。
// contains 和 request 一起发出：先等 contains 再 request 会丢掉这次点击。
// fresh 表示这次是新允许的。只有那时才重新注入页面脚本，避免每次下载都把脚本再插一遍。
function askOrigins(patterns: Array<string | null | undefined>): Promise<{ ok: boolean; fresh: boolean }> {
  const origins = [...new Set(patterns.filter((item): item is string => Boolean(item)))];
  if (origins.length === 0) return Promise.resolve({ ok: true, fresh: false });
  const already = chrome.permissions.contains({ origins });
  const requested = chrome.permissions.request({ origins }).catch(() => false);
  return Promise.all([already, requested]).then(([hadAll, ok]) => ({ ok, fresh: ok && !hadAll }));
}

// 这次点击能确定的来源：当前地址、选中的清晰度，以及上次没允许的 CDN。后两类要带上，否则第二次点击仍不知道该问谁。
function patternsFor(media: SniffedMedia, jobs: DownloadJob[], extraUrl?: string): string[] {
  const remembered = notice?.mediaId === media.id ? notice.origins ?? [] : [];
  const pending = [...jobs].reverse().find((job) => job.mediaId === media.id && job.needOrigins?.length);
  const values = [extraUrl, media.url, ...remembered, ...(pending?.needOrigins ?? [])];
  const origins: string[] = [];
  for (const value of values) {
    const pattern = value ? originPattern(value) : null;
    if (pattern && !origins.includes(pattern)) origins.push(pattern);
  }
  return origins;
}

function accessHint(patterns: string[], denied: boolean): string {
  const hosts = patterns.map(prettyOrigin).filter(Boolean).join("、");
  if (!hosts) return denied ? "未允许访问，无法下载" : "再点一次下载，以允许访问";
  return denied ? `未允许访问 ${hosts}` : `再点一次下载，以允许访问 ${hosts}`;
}

async function removeOne(mediaId: string): Promise<void> {
  if (picker?.mediaId === mediaId) picker = null;
  if (notice?.mediaId === mediaId) notice = null;
  if (busyMedia === mediaId) busyMedia = null;
  await chrome.runtime.sendMessage({ type: "REMOVE_MEDIA", mediaId });
  await refresh();
}

async function removeAll(tabId: number): Promise<void> {
  picker = null;
  notice = null;
  busyMedia = null;
  await chrome.runtime.sendMessage({ type: "CLEAR_MEDIA", tabId });
  await refresh();
}

async function grant(pageUrl: string): Promise<void> {
  const pattern = originPattern(pageUrl);
  if (!pattern) return;
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: "INJECT" });
  await refresh();
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function active(job: DownloadJob): boolean {
  return job.state === "queued" || job.state === "resolving" || job.state === "fetching" || job.state === "muxing" || job.state === "saving";
}

function percent(job: DownloadJob): number {
  if (job.state === "done") return 100;
  if (job.state === "muxing" || job.state === "saving") return 90;
  if (!job.progress.total) return job.state === "fetching" ? 5 : 0;
  return Math.min(90, Math.round((job.progress.done / job.progress.total) * 90));
}

function statusText(job: DownloadJob): string {
  if (job.state === "resolving") return "正在读取播放列表";
  const quality = shortResolution(job.variant?.resolution);
  const prefix = quality ? `${quality} · ` : "";
  if (job.state === "fetching") {
    const detail = job.progress.total ? `分片 ${job.progress.done}/${job.progress.total}` : "正在下载分片";
    const size = job.bytesDone > 0 ? ` · ${formatBytes(job.bytesDone)}` : "";
    return `${prefix}${detail}${size}`;
  }
  if (job.state === "muxing") return `${prefix}正在封装`;
  if (job.state === "saving") return `${prefix}正在保存`;
  if (job.state === "done") return job.filename ? `已保存 ${job.filename}` : "已保存";
  if (job.state === "cancelled") return "已取消";
  if (job.state === "failed") {
    if (job.needOrigins?.length) return `再点一次下载，以允许访问 ${job.needOrigins.map(prettyOrigin).join("、")}`;
    return job.error || "下载失败";
  }
  return "排队中";
}

function subtitle(item: SniffedMedia, job: DownloadJob | undefined): { text: string; klass: string } {
  if (job && active(job)) return { text: statusText(job), klass: "" };
  if (job?.state === "failed") return { text: statusText(job), klass: "bad" };
  if (job?.state === "done") return { text: job.filename ? `已保存 ${job.filename}` : "已保存", klass: "good" };
  if (job?.state === "cancelled") return { text: "已取消", klass: "" };
  if (item.unsupportedReason) return { text: item.unsupportedReason, klass: "bad" };
  const note = noticeText(item);
  if (note) return { text: note, klass: "bad" };
  return { text: safeHost(item.url), klass: "" };
}

function noticeText(item: SniffedMedia): string {
  return notice?.mediaId === item.id ? notice.text : "";
}

function resourceName(item: SniffedMedia): string {
  try {
    const base = decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() ?? "");
    if (base) return base;
  } catch {
    // 地址异常时退回类型名
  }
  if (item.kind === "hls") return "HLS 播放列表";
  if (item.kind === "dash") return "DASH 清单";
  return "媒体文件";
}

function shortResolution(resolution?: string): string {
  if (!resolution) return "";
  const height = Number(resolution.split("x")[1]);
  if ([2160, 1440, 1080, 720, 480, 360, 240].includes(height)) return `${height}p`;
  return resolution;
}

function formatRate(bps?: number): string {
  if (!bps) return "";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function prettyOrigin(pattern: string): string {
  return pattern.replace(/\/\*$/, "").replace(/^https?:\/\//, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
