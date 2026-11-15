import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

// 深灰底贴近 IINA：白底上底块本身就超过 3:1。近黑工具栏上底块会贴住背景，
// 认得出形状的是蓝紫符号，所以符号还要单独和深色工具栏比。
const tileTop = [62, 64, 78];
const tileBottom = [42, 44, 56];
const violet = [196, 104, 255];
const blue = [64, 156, 255];
const lightToolbar = [255, 255, 255];
const darkToolbar = [28, 28, 31];

for (const tile of [tileTop, tileBottom]) {
  if (contrast(tile, lightToolbar) < 3) {
    throw new Error(`浅色工具栏上底块对比不足：${contrast(tile, lightToolbar).toFixed(2)}`);
  }
  for (const ink of [violet, blue]) {
    if (contrast(ink, tile) < 3) throw new Error(`符号和底块对比不足：${contrast(ink, tile).toFixed(2)}`);
    if (contrast(ink, darkToolbar) < 3) throw new Error(`深色工具栏上符号对比不足：${contrast(ink, darkToolbar).toFixed(2)}`);
  }
}

const sizes = [16, 32, 48, 128];
await mkdir("public/icon", { recursive: true });
for (const size of sizes) {
  const bytes = png(size, (x, y) => sample(x, y, size));
  // 文件名换成 mark-，工具栏才会丢掉旧的青绿图标缓存，和弹层用到同一张图。
  await writeFile(`public/icon/mark-${size}.png`, bytes);
}

function sample(x, y, size) {
  const samples = size <= 16 ? 6 : 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let j = 0; j < samples; j += 1) {
    for (let i = 0; i < samples; i += 1) {
      const px = (x + (i + 0.5) / samples) / size;
      const py = (y + (j + 0.5) / samples) / size;
      const [sr, sg, sb, sa] = colorAt(px, py);
      const alpha = sa / 255;
      r += sr * alpha;
      g += sg * alpha;
      b += sb * alpha;
      a += alpha;
    }
  }
  const count = samples * samples;
  if (a === 0) return [0, 0, 0, 0];
  const coverage = a / count;
  return [
    Math.round(r / a),
    Math.round(g / a),
    Math.round(b / a),
    Math.round(coverage * 255),
  ];
}

function colorAt(px, py) {
  const x = px - 0.5;
  const y = py - 0.5;
  if (!inSquircle(x, y)) return [0, 0, 0, 0];
  const tile = mix(tileTop, tileBottom, smooth(py));
  const ink = glyphColor(py);
  if (inGlyph(px, py)) return [...ink.map((channel) => Math.round(channel)), 255];
  return [...tile.map((channel) => Math.round(channel)), 255];
}

function glyphColor(py) {
  return mix(violet, blue, smooth(py));
}

function inGlyph(px, py) {
  const play = sdTriangle([px, py], [0.46, 0.28], [0.46, 0.72], [0.8, 0.5]);
  if (play < -0.012) return true;
  const bars = [
    [0.2, 0.16],
    [0.29, 0.3],
    [0.38, 0.22],
  ];
  return bars.some(([cx, height]) => sdRoundBox(px, py, cx, 0.5, 0.032, height / 2, 0.028) < 0);
}

function sdRoundBox(px, py, cx, cy, hx, hy, rad) {
  const dx = Math.abs(px - cx) - (hx - rad);
  const dy = Math.abs(py - cy) - (hy - rad);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - rad;
}

function inSquircle(x, y) {
  const radius = 0.46;
  const power = 4;
  return (Math.abs(x) / radius) ** power + (Math.abs(y) / radius) ** power <= 1;
}

function sdTriangle(p, p0, p1, p2) {
  const e0 = sub(p1, p0);
  const e1 = sub(p2, p1);
  const e2 = sub(p0, p2);
  const v0 = sub(p, p0);
  const v1 = sub(p, p1);
  const v2 = sub(p, p2);
  const pq0 = sub(v0, mul(e0, clamp(dot(v0, e0) / dot(e0, e0), 0, 1)));
  const pq1 = sub(v1, mul(e1, clamp(dot(v1, e1) / dot(e1, e1), 0, 1)));
  const pq2 = sub(v2, mul(e2, clamp(dot(v2, e2) / dot(e2, e2), 0, 1)));
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const d0 = [dot(pq0, pq0), s * (v0[0] * e0[1] - v0[1] * e0[0])];
  const d1 = [dot(pq1, pq1), s * (v1[0] * e1[1] - v1[1] * e1[0])];
  const d2 = [dot(pq2, pq2), s * (v2[0] * e2[1] - v2[1] * e2[0])];
  const d = min2(min2(d0, d1), d2);
  return -Math.sqrt(d[0]) * Math.sign(d[1]);
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function mul(a, k) {
  return [a[0] * k, a[1] * k];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function min2(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smooth(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function mix(from, to, t) {
  return from.map((channel, index) => channel + (to[index] - channel) * t);
}

function contrast(a, b) {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(rgb) {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}
