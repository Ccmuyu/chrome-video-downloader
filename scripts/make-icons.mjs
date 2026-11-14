import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const sizes = [16, 32, 48, 128];
await mkdir("public/icon", { recursive: true });

for (const size of sizes) {
  await writeFile(`public/icon/${size}.png`, png(size, (x, y) => {
    const nx = x / (size - 1);
    const ny = y / (size - 1);
    const inRound = rounded(nx, ny, 0.16);
    if (!inRound) return [0, 0, 0, 0];
    const play = pointInTriangle(nx, ny, [0.38, 0.28], [0.38, 0.72], [0.74, 0.5]);
    if (play) return [255, 250, 244, 255];
    return [15, 110, 98, 255];
  }));
}

function rounded(nx, ny, radius) {
  const left = radius;
  const right = 1 - radius;
  const dx = nx < left ? left - nx : nx > right ? nx - right : 0;
  const dy = ny < left ? left - ny : ny > right ? ny - right : 0;
  return dx * dx + dy * dy <= radius * radius;
}

function pointInTriangle(px, py, a, b, c) {
  const area = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab = area(a, b, [px, py]);
  const bc = area(b, c, [px, py]);
  const ca = area(c, a, [px, py]);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
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
