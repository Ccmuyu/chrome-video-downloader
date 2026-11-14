import type { AudioRendition, MasterPlaylistPlan, MediaPlaylistPlan, PlaylistPlan, SegmentKey, SegmentPlan, Variant } from "./types";
import { resolveUri } from "./url";

type KeyDirective = {
  method: string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
};

type MapDirective = {
  uri: string;
  byterange?: { length: number; offset?: number };
};

export function parsePlaylist(text: string, baseUrl: string): PlaylistPlan {
  if (typeof text !== "string") throw new Error("不是 HLS 播放列表");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const variants: Variant[] = [];
  const audio: AudioRendition[] = [];
  const segments: SegmentPlan[] = [];
  let mediaSequenceStart = 0;
  let targetDuration: number | undefined;
  let endList = false;
  let pendingVariant: Variant | null = null;
  let pendingDuration: number | null = null;
  let pendingRange: { length: number; offset?: number } | null = null;
  let currentKey: KeyDirective | null = null;
  let currentMap: MapDirective | null = null;
  let rangeCursor = 0;
  let sawExtM3u = false;

  const pushSegment = (uriLine: string) => {
    const sequence = mediaSequenceStart + segments.length;
    const byterange = materializeRange(pendingRange, rangeCursor);
    if (byterange) rangeCursor = byterange.offset + byterange.length;
    const mapRange = currentMap?.byterange
      ? materializeRange(currentMap.byterange, 0)
      : undefined;
    const key = segmentKey(currentKey, sequence, baseUrl);
    segments.push({
      uri: resolveUri(uriLine.trim(), baseUrl),
      duration: pendingDuration ?? targetDuration ?? 0,
      mediaSequence: sequence,
      byterange,
      key,
      mapUri: currentMap ? resolveUri(currentMap.uri, baseUrl) : undefined,
      mapByterange: mapRange ?? undefined,
    });
    pendingDuration = null;
    pendingRange = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (line === "#EXTM3U") {
        sawExtM3u = true;
        continue;
      }
      if (!line.startsWith("#EXT")) continue;
      const { name, rest } = splitTag(line);
      if (name === "EXT-X-STREAM-INF") {
        pendingVariant = parseVariant(rest);
        continue;
      }
      if (name === "EXT-X-MEDIA") {
        const rendition = parseAudio(rest);
        if (rendition) audio.push(rendition);
        continue;
      }
      if (name === "EXTINF") {
        const duration = Number(rest.split(",")[0]);
        pendingDuration = Number.isFinite(duration) ? duration : 0;
        continue;
      }
      if (name === "EXT-X-KEY") {
        currentKey = parseKey(rest);
        continue;
      }
      if (name === "EXT-X-MAP") {
        currentMap = parseMap(rest);
        continue;
      }
      if (name === "EXT-X-BYTERANGE") {
        pendingRange = parseByteRange(rest);
        continue;
      }
      if (name === "EXT-X-ENDLIST") {
        endList = true;
        continue;
      }
      if (name === "EXT-X-MEDIA-SEQUENCE") {
        const value = Number(rest);
        if (Number.isFinite(value)) mediaSequenceStart = value;
        continue;
      }
      if (name === "EXT-X-TARGETDURATION") {
        const value = Number(rest);
        if (Number.isFinite(value)) targetDuration = value;
        continue;
      }
      continue;
    }

    if (pendingVariant) {
      variants.push({ ...pendingVariant, uri: resolveUri(line, baseUrl) });
      pendingVariant = null;
      continue;
    }
    if (pendingDuration != null || segments.length > 0 || currentMap) {
      pushSegment(line);
    }
  }

  if (!sawExtM3u && variants.length === 0 && segments.length === 0) {
    throw new Error("不是 HLS 播放列表");
  }
  if (variants.length > 0) {
    variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    const master: MasterPlaylistPlan = { kind: "master", variants, audio };
    return master;
  }
  const media: MediaPlaylistPlan = {
    kind: "media",
    segments,
    endList,
    targetDuration,
    init: initFromSegments(segments),
  };
  return media;
}

export function mediaPlaylistError(plan: MediaPlaylistPlan): string | null {
  // 没有 ENDLIST 的是直播。第一期不轮询，避免下到一半列表被替换。
  if (!plan.endList) return "直播留到下一期";
  if (plan.segments.length === 0) return "播放列表里没有分片";
  for (const segment of plan.segments) {
    const reason = keyError(segment.key);
    if (reason) return reason;
  }
  return null;
}

export function selectAudio(audio: AudioRendition[], groupId: string | undefined): AudioRendition | null {
  if (!groupId) return null;
  const group = audio.filter((item) => item.groupId === groupId && item.uri);
  return group.find((item) => item.isDefault) ?? group.find((item) => item.autoselect) ?? group[0] ?? null;
}

export function codecsIncludeAudio(codecs: string | undefined): boolean {
  if (!codecs) return false;
  const parts = codecs.toLowerCase().split(",").map((part) => part.trim());
  return parts.some((part) => /^(mp4a|ac-3|ec-3|opus|vorbis|flac|alac)/.test(part));
}

function initFromSegments(segments: SegmentPlan[]): MediaPlaylistPlan["init"] {
  const first = segments.find((segment) => segment.mapUri);
  if (!first?.mapUri) return undefined;
  return { uri: first.mapUri, byterange: first.mapByterange };
}

// SAMPLE-AES 和带 KEYFORMAT 的密钥在 CDM 里，播放列表给不出能解密的字节。
export function keyError(key: SegmentKey | undefined): string | null {
  if (!key) return null;
  if (key.method !== "AES-128") return "这个播放列表使用了 DRM，无法下载";
  if (key.keyFormat && key.keyFormat !== "identity") return "这个播放列表使用了 DRM，无法下载";
  if (!key.uri || !/^https?:/i.test(key.uri)) return "缺少密钥地址，无法解密";
  return null;
}

function segmentKey(key: KeyDirective | null, sequence: number, baseUrl: string): SegmentKey | undefined {
  if (!key || key.method === "NONE") return undefined;
  let uri = "";
  if (key.uri) {
    try {
      uri = resolveUri(key.uri, baseUrl);
    } catch {
      uri = key.uri;
    }
  }
  return {
    method: key.method,
    uri,
    iv: key.iv ?? ivFromSequence(sequence),
    keyFormat: key.keyFormat,
  };
}

// HLS：没写 IV 时，用媒体序号的 16 字节大端整数。
export function ivFromSequence(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let index = 15; index >= 0; index -= 1) {
    iv[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

export function parseHexIv(value: string): Uint8Array | null {
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0 || hex.length > 32) return null;
  const padded = hex.padStart(32, "0");
  const iv = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    iv[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return iv;
}

function splitTag(line: string): { name: string; rest: string } {
  const body = line.slice(1);
  const colon = body.indexOf(":");
  if (colon < 0) return { name: body, rest: "" };
  return { name: body.slice(0, colon), rest: body.slice(colon + 1) };
}

function parseVariant(rest: string): Variant {
  const attrs = parseAttributes(rest);
  return {
    uri: "",
    bandwidth: numberAttr(attrs, "BANDWIDTH"),
    resolution: attrs.RESOLUTION,
    codecs: attrs.CODECS,
    audioGroupId: attrs.AUDIO,
    fps: numberAttr(attrs, "FRAME-RATE"),
  };
}

function parseAudio(rest: string): AudioRendition | null {
  const attrs = parseAttributes(rest);
  if ((attrs.TYPE ?? "AUDIO") !== "AUDIO") return null;
  if (!attrs["GROUP-ID"]) return null;
  return {
    groupId: attrs["GROUP-ID"],
    name: attrs.NAME ?? attrs["GROUP-ID"],
    uri: attrs.URI,
    language: attrs.LANGUAGE,
    isDefault: attrs.DEFAULT === "YES",
    autoselect: attrs.AUTOSELECT === "YES",
  };
}

function parseKey(rest: string): KeyDirective {
  const attrs = parseAttributes(rest);
  const iv = attrs.IV ? parseHexIv(attrs.IV) ?? undefined : undefined;
  return {
    method: attrs.METHOD ?? "NONE",
    uri: attrs.URI,
    iv,
    keyFormat: attrs.KEYFORMAT,
  };
}

function parseMap(rest: string): MapDirective | null {
  const attrs = parseAttributes(rest);
  if (!attrs.URI) return null;
  return {
    uri: attrs.URI,
    byterange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) ?? undefined : undefined,
  };
}

function parseByteRange(value: string): { length: number; offset?: number } | null {
  const [lengthRaw, offsetRaw] = value.split("@");
  const length = Number(lengthRaw);
  if (!Number.isFinite(length)) return null;
  if (offsetRaw == null || offsetRaw === "") return { length };
  const offset = Number(offsetRaw);
  if (!Number.isFinite(offset)) return { length };
  return { length, offset };
}

// EXT-X-BYTERANGE 可以省略 offset，规范要求接着上一个范围的末尾。
function materializeRange(
  range: { length: number; offset?: number } | null,
  cursor: number,
): { length: number; offset: number } | undefined {
  if (!range) return undefined;
  return { length: range.length, offset: range.offset ?? cursor };
}

export function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && (input[index] === "," || input[index] === " ")) index += 1;
    const eq = input.indexOf("=", index);
    if (eq < 0) break;
    const key = input.slice(index, eq).trim();
    index = eq + 1;
    if (input[index] === '"') {
      index += 1;
      let value = "";
      while (index < input.length && input[index] !== '"') {
        value += input[index];
        index += 1;
      }
      index += 1;
      attrs[key] = value;
    } else {
      const comma = input.indexOf(",", index);
      const end = comma < 0 ? input.length : comma;
      attrs[key] = input.slice(index, end).trim();
      index = end;
    }
  }
  return attrs;
}

// 贴片广告和正片接在同一条列表里时，初始化段会插在已经出现的分片后面。
// 每个 map-*.mp4 开头的是一段新的 fMP4，不能和前面的字节直接拼成一个文件。
export function splitInitGroups(paths: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const path of paths) {
    const name = path.split("/").pop() ?? "";
    if (name.startsWith("map-") && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(path);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function numberAttr(attrs: Record<string, string>, key: string): number | undefined {
  const value = attrs[key];
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
