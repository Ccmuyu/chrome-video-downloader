// Web Crypto 的 AES-CBC 会做 PKCS#7 填充处理，和 HLS AES-128 分片一致。
// iv 先复制一份：subtle.decrypt 可能把传入的 BufferSource 转移走，下一段还要用同一个 IV。
export async function decryptAes128(data: ArrayBuffer, key: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer> {
  if (!key || key.byteLength !== 16) throw new Error("密钥长度不正确");
  if (!iv || iv.byteLength !== 16) throw new Error("IV 长度不正确");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  const ivCopy = new Uint8Array(iv);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivCopy }, cryptoKey, data);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
