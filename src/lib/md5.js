/**
 * 纯 JavaScript 的 MD5 实现（RFC 1321）。
 *
 * 为什么需要它：WebDAV 服务器（Apache mod_dav、Nextcloud、群晖等）默认使用
 * HTTP Digest 认证，而 Digest 要求 MD5。浏览器的 WebCrypto（crypto.subtle）
 * 出于安全考虑**不提供** MD5，所以这里自己实现一份。
 *
 * 仅用于摘要计算，不用于任何安全存储。
 */

/** 每轮左移位数 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return k;
})();

function rotl(x, c) {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

const encoder = new TextEncoder();

/** 字符串 → UTF-8 字节 */
export function utf8Bytes(str) {
  return encoder.encode(str);
}

/** 字节数组 → 小写十六进制字符串 */
export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 计算 MD5 摘要。
 * @param {string|Uint8Array} input 字符串按 UTF-8 处理
 * @returns {Uint8Array} 16 字节摘要
 */
export function md5Bytes(input) {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  const len = bytes.length;

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，末尾 8 字节写原始比特长度
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLen = len * 8;
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** 计算 MD5 并返回小写十六进制字符串 */
export function md5Hex(input) {
  return toHex(md5Bytes(input));
}
