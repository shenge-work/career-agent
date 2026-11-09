/**
 * 生成桌面端图标（无第三方图像依赖，纯 Node 手写 PNG/ICO/ICNS 容器）。
 * 运行: npm run desktop:icons
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'build');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const GLYPHS = {
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
};

/** 圆角深色底 + 白色 CA 点阵字，按 size 独立绘制，避免缩放糊边。 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.225);
  const bg = [23, 24, 28, 255];

  const inRounded = (x, y) => {
    const r = radius;
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r ** 2;
    if (x >= size - r && y < r) return (x - (size - r)) ** 2 + (y - r) ** 2 <= r ** 2;
    if (x < r && y >= size - r) return (x - r) ** 2 + (y - (size - r)) ** 2 <= r ** 2;
    if (x >= size - r && y >= size - r) {
      return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r ** 2;
    }
    return true;
  };

  // 字母占画布约 52%，居中
  const cell = Math.max(1, Math.floor((size * 0.55) / 11));
  const glyphW = 11 * cell;
  const glyphH = 7 * cell;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);
  const pixels = (() => {
    const rows = [];
    for (let row = 0; row < 7; row++) {
      rows.push(GLYPHS.C[row] + '0' + GLYPHS.A[row]);
    }
    return rows;
  })();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x + 0.5, y + 0.5)) continue;
      const gx = Math.floor((x - ox) / cell);
      const gy = Math.floor((y - oy) / cell);
      const letter = gx >= 0 && gy >= 0 && gy < 7 && gx < 11 && pixels[gy][gx] === '1';
      const color = letter ? [255, 255, 255, 255] : bg;
      const i = (y * size + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
  return rgba;
}

function iconPng(size) {
  return encodePng(size, size, renderIcon(size));
}

function buildIco(sizes) {
  const images = sizes.map((s) => iconPng(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = [];
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e[2] = 0; // palette
    e[3] = 0;
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...images]);
}

function buildIcns(entries) {
  const parts = [];
  for (const [type, size] of entries) {
    const data = iconPng(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    parts.push(head, data);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), iconPng(1024));
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco([16, 32, 48, 64, 128, 256]));
fs.writeFileSync(
  path.join(outDir, 'icon.icns'),
  buildIcns([['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]])
);
console.log('图标已生成:', outDir);
