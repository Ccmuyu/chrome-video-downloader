import { fileExtensionFor, outputFilename } from "./filename";
import { downloadHls, inspectPlaylist, NeedOriginsError } from "./hls-runner";
import { publicError } from "./net";
import { deleteJobFiles } from "./opfs";
import { missingOriginPatterns } from "./permissions";
import { installRefererRule, removeRefererRule } from "./referer-rules";
import { readState, removeJob, saveJob } from "./store";
import type { DownloadJob, SniffedMedia, Variant } from "./types";

export type ResolveResult =
  | { ok: true; mode: "master"; variants: Variant[] }
  | { ok: true; mode: "media"; segmentCount: number }
  | { ok: true; mode: "file" }
  | { ok: false; error: string; needOrigins?: string[] };

type Muxer = (jobId: string, filename: string) => Promise<void>;

// 全局同时只跑一个任务。Service Worker 回收后这张表是空的，进行中的任务由 failInterruptedJobs 标失败。
const running = new Map<string, AbortController>();
const downloads = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

export function attachDownloadListener(): void {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;
    const pending = downloads.get(delta.id);
    if (!pending) return;
    if (delta.state.current === "complete") {
      downloads.delete(delta.id);
      pending.resolve();
    } else if (delta.state.current === "interrupted") {
      downloads.delete(delta.id);
      pending.reject(new Error("浏览器没能保存文件"));
    }
  });
}

export function hasActiveJob(): boolean {
  return running.size > 0;
}

export async function failInterruptedJobs(): Promise<void> {
  const state = await readState();
  for (const job of state.jobs) {
    if (job.state === "done" || job.state === "failed" || job.state === "cancelled") continue;
    job.state = "failed";
    job.error = "扩展中断了这次下载，请重新开始";
    await saveJob(job);
  }
}

export async function resolveMedia(media: SniffedMedia): Promise<ResolveResult> {
  if (media.kind === "dash" || media.unsupportedReason) {
    return { ok: false, error: media.unsupportedReason ?? "DASH 留到第二期" };
  }
  if (media.kind === "file") return { ok: true, mode: "file" };
  const controller = new AbortController();
  let ruleId: number | null = null;
  try {
    ruleId = await installRefererRule(media.referer, [media.url]);
    const inspected = await inspectPlaylist(media.url, controller.signal, (urls) => ensureOrigins(media.referer, urls, ruleId, (id) => {
      ruleId = id;
    }));
    return inspected.mode === "master"
      ? { ok: true, mode: "master", variants: inspected.variants }
      : { ok: true, mode: "media", segmentCount: inspected.segmentCount };
  } catch (error) {
    if (error instanceof NeedOriginsError) return { ok: false, error: error.message, needOrigins: error.origins };
    return { ok: false, error: publicError(error) };
  } finally {
    await removeRefererRule(ruleId);
  }
}

export function startJob(media: SniffedMedia, variantUri: string | undefined, mux: Muxer): DownloadJob | { error: string } {
  if (running.size > 0) return { error: "已有下载在进行" };
  if (media.unsupportedReason) return { error: media.unsupportedReason };
  const job: DownloadJob = {
    id: crypto.randomUUID(),
    mediaId: media.id,
    tabId: media.tabId,
    state: "queued",
    kind: media.kind,
    progress: { done: 0, total: 0 },
    bytesDone: 0,
    createdAt: Date.now(),
  };
  const controller = new AbortController();
  running.set(job.id, controller);
  void run(job, media, variantUri, controller, mux).finally(() => {
    running.delete(job.id);
  });
  return job;
}

export async function cancelJob(jobId: string): Promise<void> {
  const controller = running.get(jobId);
  if (controller) {
    controller.abort();
    return;
  }
  const state = await readState();
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || job.state === "done") return;
  job.state = "cancelled";
  job.error = undefined;
  await saveJob(job);
  await deleteJobFiles(jobId);
}

export async function dismissJob(jobId: string): Promise<void> {
  running.get(jobId)?.abort();
  await deleteJobFiles(jobId);
  await removeJob(jobId);
}

async function run(
  job: DownloadJob,
  media: SniffedMedia,
  variantUri: string | undefined,
  controller: AbortController,
  mux: Muxer,
): Promise<void> {
  let ruleId: number | null = null;
  try {
    await saveJob({ ...job, state: media.kind === "file" ? "fetching" : "resolving" });
    if (media.kind === "file") {
      ruleId = await installRefererRule(media.referer, [media.url]);
      await ensureOrigins(media.referer, [media.url], ruleId, (id) => {
        ruleId = id;
      });
      const filename = outputFilename(media.pageTitle, undefined, fileExtensionFor(media.url, media.mime));
      job.filename = filename;
      job.state = "saving";
      await saveJob(job);
      await saveDirect(media.url, filename, controller.signal);
      job.state = "done";
      job.progress = { done: 1, total: 1 };
      await saveJob(job);
      return;
    }
    const manifest = await downloadHls({
      jobId: job.id,
      mediaUrl: media.url,
      referer: media.referer,
      pageTitle: media.pageTitle,
      variantUri,
      signal: controller.signal,
      ensureOrigins: (urls) => ensureOrigins(media.referer, urls, ruleId, (id) => {
        ruleId = id;
      }),
      onProgress: (progress) => {
        job.state = progress.phase === "resolving" ? "resolving" : "fetching";
        job.progress = { done: progress.done, total: progress.total };
        job.bytesDone = progress.bytesDone;
        if (progress.variant) job.variant = progress.variant;
        void saveJob(job);
      },
    });
    if (controller.signal.aborted) throw abortError();
    job.filename = manifest.filename;
    job.state = "muxing";
    job.progress = { done: 9, total: 10 };
    await saveJob(job);
    await mux(job.id, manifest.filename);
    job.state = "done";
    job.progress = { done: 10, total: 10 };
    job.error = undefined;
    await saveJob(job);
    await deleteJobFiles(job.id);
  } catch (error) {
    if (isAbort(error) || controller.signal.aborted) {
      job.state = "cancelled";
      job.error = undefined;
      await saveJob(job);
      await deleteJobFiles(job.id);
      return;
    }
    job.state = "failed";
    job.error = publicError(error);
    if (error instanceof NeedOriginsError) job.needOrigins = error.origins;
    // 失败留下 OPFS，方便看是哪一步断的；用户点清除才删。成功和取消在上面已经删过。
    await saveJob(job);
  } finally {
    await removeRefererRule(ruleId);
  }
}

// 每次拿到新的 URL 批次就换成一条新规则。旧规则只覆盖上一批域名，分片域名可能不同。
async function ensureOrigins(
  referer: string,
  urls: string[],
  currentRule: number | null,
  setRule: (id: number | null) => void,
): Promise<void> {
  const missing = await missingOriginPatterns(urls);
  if (missing.length > 0) throw new NeedOriginsError(missing);
  if (currentRule != null) await removeRefererRule(currentRule);
  setRule(await installRefererRule(referer, urls));
}

async function saveDirect(url: string, filename: string, signal: AbortSignal): Promise<void> {
  // chrome.downloads 不一定带上上面的声明式 Referer。失败后再由扩展自己 fetch，凭据和规则都能生效。
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    await waitForDownload(downloadId, signal);
  } catch (error) {
    if (isAbort(error) || signal.aborted) throw error;
    const response = await fetch(url, { credentials: "include", signal });
    if (response.status === 403 || response.status === 410) {
      throw new Error("链接可能已过期，请重新播放后再试");
    }
    if (!response.ok) throw new Error(`下载失败（${response.status}）`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      await waitForDownload(downloadId, signal);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
  }
}

function waitForDownload(id: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      downloads.delete(id);
      void chrome.downloads.cancel(id);
      finish(abortError());
    };
    signal.addEventListener("abort", onAbort);
    downloads.set(id, {
      resolve: () => finish(),
      reject: (error) => finish(error),
    });
    void chrome.downloads.search({ id }).then((items) => {
      const item = items[0];
      if (!item || !downloads.has(id)) return;
      if (item.state === "complete") {
        downloads.delete(id);
        finish();
      } else if (item.state === "interrupted") {
        downloads.delete(id);
        finish(new Error("浏览器没能保存文件"));
      }
    });
  });
}

function abortError(): Error {
  const error = new Error("已取消");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
