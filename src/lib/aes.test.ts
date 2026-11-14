import { describe, expect, it } from "vitest";
import { decryptAes128 } from "./aes";
import { ivFromSequence } from "./m3u8";

describe("ivFromSequence", () => {
  it("encodes the sequence as a 16-byte big-endian integer", () => {
    const iv = ivFromSequence(0);
    expect(iv).toHaveLength(16);
    expect(iv.every((byte) => byte === 0)).toBe(true);
    const nine = ivFromSequence(9);
    expect(nine[15]).toBe(9);
    expect(nine[14]).toBe(0);
    const big = ivFromSequence(0x100000001);
    expect(big[11]).toBe(1);
    expect(big[15]).toBe(1);
  });
});

describe("decryptAes128", () => {
  it("round-trips AES-CBC plaintext", async () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode("segment-bytes!!");
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, plain);
    const decrypted = await decryptAes128(encrypted, key.buffer, iv);
    expect(new TextDecoder().decode(decrypted)).toBe("segment-bytes!!");
  });
});
