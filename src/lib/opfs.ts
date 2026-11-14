// 分片不进消息体。后台写入 jobs/<jobId>/，offscreen 再按 manifest.json 读出来封装。
const ROOT = "jobs";

export async function writeJobFile(jobId: string, relativePath: string, data: BufferSource): Promise<void> {
  const file = await fileHandle(jobId, relativePath, true);
  const writable = await file.createWritable();
  // 直接把 ArrayBuffer 视图交给 write()，有的环境下内部会去读一个已经空掉的 buffer。
  await writable.write(copyBytes(data));
  await writable.close();
}

export async function readJobFile(jobId: string, relativePath: string): Promise<ArrayBuffer> {
  const file = await fileHandle(jobId, relativePath, false);
  const blob = await file.getFile();
  return blob.arrayBuffer();
}

export async function jobFileSize(jobId: string, relativePath: string): Promise<number> {
  const file = await fileHandle(jobId, relativePath, false);
  const blob = await file.getFile();
  return blob.size;
}

export async function deleteJobFiles(jobId: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    const jobs = await root.getDirectoryHandle(ROOT);
    await jobs.removeEntry(jobId, { recursive: true });
  } catch {
    // already gone
  }
}

function copyBytes(data: BufferSource): Blob {
  if (data instanceof ArrayBuffer) return new Blob([data]);
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return new Blob([copy]);
}

async function fileHandle(jobId: string, relativePath: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error("空文件名");
  let dir = await navigator.storage.getDirectory();
  for (const name of [ROOT, jobId, ...parts]) {
    dir = await dir.getDirectoryHandle(name, { create });
  }
  return dir.getFileHandle(filename, { create });
}
