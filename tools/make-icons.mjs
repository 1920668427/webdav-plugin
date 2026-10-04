/**
 * 图标生成器：不依赖任何第三方库，直接手写 PNG（zlib + CRC32）。
 * 画一个圆角方形底 + 白色文件夹，输出 16/32/48/128 四种尺寸。
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../icons');

/* ------------------------- PNG 编码 ------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** RGBA 像素数组 → PNG Buffer */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------- 绘制 ------------------------- */

const SS = 4; // 超采样倍数，用于抗锯齿

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(Math.max(px, x + r), x + w - r);
  const ry = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - rx;
  const dy = py - ry;
  return dx * dx + dy * dy <= r * r;
}

function clamp(value, min = 0, max = 255) {
  return Math.min(Math.max(value, min), max);
}

function mix(a, b, rawT) {
  const t = clamp(rawT, 0, 1);
  return [
    clamp(Math.round(a[0] + (b[0] - a[0]) * t)),
    clamp(Math.round(a[1] + (b[1] - a[1]) * t)),
    clamp(Math.round(a[2] + (b[2] - a[2]) * t)),
  ];
}

/** 单位坐标系 (0..1) 下判断某点属于哪个图层 */
function sample(u, v) {
  // 背景圆角方形
  if (!insideRoundRect(u, v, 0.02, 0.02, 0.96, 0.96, 0.22)) return null;

  // 文件夹：上半部分（带标签）与下半部分（主体）
  const inTab = insideRoundRect(u, v, 0.17, 0.24, 0.34, 0.16, 0.05);
  const inBody = insideRoundRect(u, v, 0.15, 0.32, 0.70, 0.44, 0.08);
  if (inTab || inBody) return 'folder';

  // 文件夹上的两条“内容线”，暗示这是文件目录
  if (v > 0.46 && v < 0.50 && u > 0.26 && u < 0.74) return 'line';
  if (v > 0.56 && v < 0.60 && u > 0.26 && u < 0.62) return 'line';

  return 'bg';
}

function renderIcon(size) {
  const big = size * SS;
  const rgba = Buffer.alloc(size * size * 4);

  const bgTop = [96, 165, 250];
  const bgBottom = [29, 78, 216];
  const folder = [255, 255, 255];
  const line = [37, 99, 235];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x * SS + sx + 0.5) / big;
          const v = (y * SS + sy + 0.5) / big;
          const layer = sample(u, v);
          if (!layer) continue;
          let color;
          if (layer === 'folder' || layer === 'line') {
            color = layer === 'line' ? line : folder;
            // 文件夹带一点点渐变，和背景呼应
            if (layer === 'folder') color = mix(folder, [219, 234, 254], (v - 0.32) / 0.44);
          } else {
            color = mix(bgTop, bgBottom, v);
          }
          r += color[0];
          g += color[1];
          b += color[2];
          hits += 1;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      if (hits === 0) {
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round((hits / samples) * 255);
      }
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(outDir, `icon${size}.png`);
  const png = renderIcon(size);
  writeFileSync(file, png);
  console.log(`生成 ${file} (${png.length} 字节)`);
}
