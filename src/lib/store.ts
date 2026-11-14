import type { DownloadJob, SniffedMedia } from "./types";
import { pageIdentity, preferMediaUrl } from "./url";

const KEY = "cvd-state";

export type TabBucket = {
  pageUrl: string;
  pageTitle: string;
  items: SniffedMedia[];
  // 用户删过的路径。同一页还在请求时不要再列回来。换页面时整桶重建，这份记录一起丢掉。
  hidden?: string[];
};

export type SessionState = {
  tabs: Record<string, TabBucket>;
  jobs: DownloadJob[];
};

// 嗅探会并发写同一份会话状态。串行化后，后一次读到的是前一次写完的结果。
let queue: Promise<unknown> = Promise.resolve();

export async function readState(): Promise<SessionState> {
  const stored = await chrome.storage.session.get(KEY);
  const value = stored[KEY] as SessionState | undefined;
  return {
    tabs: value?.tabs ?? {},
    jobs: value?.jobs ?? [],
  };
}

export function updateState(mutate: (state: SessionState) => boolean | void): Promise<SessionState> {
  const run = queue.then(async () => {
    const state = await readState();
    const changed = mutate(state);
    // 返回 false 表示内容没变。嗅探每两秒扫一次，不跳过的话会反复触发弹层重绘。
    if (changed !== false) await chrome.storage.session.set({ [KEY]: state });
    return state;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function upsertMedia(item: SniffedMedia): Promise<SessionState> {
  return updateState((state) => {
    const bucket = ensureTab(state, item.tabId, item.pageUrl, item.pageTitle);
    if (bucket.hidden?.includes(item.pathKey)) return false;
    if (item.pageTitle) bucket.pageTitle = item.pageTitle;
    if (item.pageUrl) bucket.pageUrl = item.pageUrl;
    const index = bucket.items.findIndex((existing) => existing.pathKey === item.pathKey);
    if (index >= 0) {
      const previous = bucket.items[index];
      if (!previous) return false;
      const url = preferMediaUrl(previous.url, item.url);
      const pageTitle = item.pageTitle || previous.pageTitle;
      if (
        previous.url === url &&
        previous.mime === item.mime &&
        previous.pageTitle === pageTitle &&
        previous.pageUrl === item.pageUrl
      ) {
        return false;
      }
      bucket.items[index] = {
        ...previous,
        ...item,
        id: previous.id,
        url,
        pageTitle,
      };
      return;
    }
    bucket.items.push(item);
  });
}

export function setPageMeta(tabId: number, pageUrl: string, pageTitle: string): Promise<SessionState> {
  return updateState((state) => {
    const existing = state.tabs[String(tabId)];
    if (existing && existing.pageUrl === pageUrl && existing.pageTitle === pageTitle) return false;
    const bucket = ensureTab(state, tabId, pageUrl, pageTitle);
    bucket.pageUrl = pageUrl || bucket.pageUrl;
    bucket.pageTitle = pageTitle || bucket.pageTitle;
    for (const item of bucket.items) {
      if (pageTitle) item.pageTitle = pageTitle;
      if (pageUrl) {
        item.pageUrl = pageUrl;
        item.referer = pageUrl;
      }
    }
  });
}

export function replaceTabPage(tabId: number, pageUrl: string): Promise<SessionState> {
  return updateState((state) => {
    const key = String(tabId);
    const current = state.tabs[key];
    if (!current) {
      state.tabs[key] = { pageUrl, pageTitle: "", items: [] };
      return;
    }
    // 只比 origin + pathname。查询参数变化（登录回跳、播放进度）不清列表。
    if (pageIdentity(current.pageUrl) !== pageIdentity(pageUrl)) {
      state.tabs[key] = { pageUrl, pageTitle: "", items: [] };
      return;
    }
    current.pageUrl = pageUrl;
  });
}

export function forgetMedia(tabId: number, mediaId: string): Promise<SessionState> {
  return updateState((state) => {
    const bucket = state.tabs[String(tabId)];
    if (!bucket) return false;
    const item = bucket.items.find((entry) => entry.id === mediaId);
    if (!item) return false;
    bucket.hidden = rememberHidden(bucket.hidden, [item.pathKey]);
    bucket.items = bucket.items.filter((entry) => entry.id !== mediaId);
    state.jobs = state.jobs.filter((job) => job.mediaId !== mediaId);
  });
}

export function forgetAllMedia(tabId: number): Promise<SessionState> {
  return updateState((state) => {
    const bucket = state.tabs[String(tabId)];
    if (!bucket || bucket.items.length === 0) return false;
    const ids = new Set(bucket.items.map((item) => item.id));
    bucket.hidden = rememberHidden(bucket.hidden, bucket.items.map((item) => item.pathKey));
    bucket.items = [];
    state.jobs = state.jobs.filter((job) => job.tabId !== tabId || !ids.has(job.mediaId));
  });
}

function rememberHidden(hidden: string[] | undefined, pathKeys: string[]): string[] {
  const next = new Set(hidden ?? []);
  for (const key of pathKeys) next.add(key);
  return [...next].slice(-300);
}

export function dropTab(tabId: number): Promise<SessionState> {
  return updateState((state) => {
    delete state.tabs[String(tabId)];
  });
}

export function saveJob(job: DownloadJob): Promise<SessionState> {
  return updateState((state) => {
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) state.jobs[index] = job;
    else state.jobs.push(job);
  });
}

export function removeJob(jobId: string): Promise<SessionState> {
  return updateState((state) => {
    state.jobs = state.jobs.filter((job) => job.id !== jobId);
  });
}

function ensureTab(state: SessionState, tabId: number, pageUrl: string, pageTitle: string): TabBucket {
  const key = String(tabId);
  const existing = state.tabs[key];
  if (existing) return existing;
  const created: TabBucket = { pageUrl, pageTitle, items: [] };
  state.tabs[key] = created;
  return created;
}
