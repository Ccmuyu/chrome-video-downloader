// 分片不进消息体。后台写入 jobs/<jobId>/，offscreen 再按 manifest.json 读出来封装。
const ROOT = "jobs";

export async function writeJobFile(jobId: string, relativePath: string, data: BufferSource): Promise<void> {
  const file = await fileHandle(jobId, relativePath, true);
  const writable = await file.createWritable();
  // 裸 ArrayBuffer 会被当成 WriteParams，data 字段是空的，读属性就抛
  // Cannot read properties of undefined。用视图并写明 type。
  await writable.write({ type: "write", data: ownedBytes(data) });
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

function ownedBytes(data: BufferSource): Uint8Array<ArrayBuffer> {
  const source = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const copy = new ArrayBuffer(source.byteLength);
  const view = new Uint8Array(copy);
  view.set(source);
  return view;
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
