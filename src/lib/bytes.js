/**
 * 二进制 / 文本转换小工具。
 * 扩展的消息传递只能传 JSON，二进制内容一律走 base64。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Uint8Array → base64（分块拼接，避免超长字符串导致栈溢出） */
export function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 文本 → base64（UTF-8） */
export function textToBase64(text) {
  return bytesToBase64(encoder.encode(text));
}

/** base64 → 文本（UTF-8） */
export function base64ToText(base64) {
  return decoder.decode(base64ToBytes(base64));
}

/** ArrayBuffer → base64 */
export function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

/** base64 → Blob */
export function base64ToBlob(base64, type = 'application/octet-stream') {
  return new Blob([base64ToBytes(base64)], { type });
}
