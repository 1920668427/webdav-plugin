/**
 * 分块下载：用 Range 请求把远端文件拼成一个 Blob。
 *
 * 单独成模块是为了能在 Node 里直接单测 —— manager 里那层只负责把扩展的
 * `request()`（走 Service Worker）注入进来。
 *
 * 关键点：**不能把 Content-Range 里的总长当作唯一的结束条件**。
 * RFC 7233 允许服务器回 `bytes 0-8388607/*`（总长未知），也有服务器干脆不带
 * Content-Range。以前遇到这两种响应，请求完第一块（默认 8MB）就再也不继续了，
 * 前端拿到一个被悄悄截断的 Blob —— 表现就是播到中途突然报
 * 「音频解码失败（错误码 2，网络错误）」：媒体元素读到了「资源提前结束」。
 * 96kHz/24bit 的 FLAC 大约 8MB ≈ 16 秒，正好对上「播到约 16 秒截断」。
 *
 * 因此结束条件只看「实际读到多少字节」：
 *   - 知道总长 → 读满总长即完成；
 *   - 不知道总长 → 出现短读或 416 即完成；
 *   - 拿到 0 字节又没到总长 → 说明服务器提前断了，**宁可报错也不把半截文件交给播放器**。
 */

import { formatBytes } from './webdav.js';

/** 每块大小：够大够快，又不会把一条扩展消息撑爆 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** 单次预览允许的最大体积 */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {(req: object) => Promise<object>} options.request 发一个请求并返回原始报文结果
 * @param {object|null} [options.auth]
 * @param {number} [options.chunkSize]
 * @param {number} [options.maxBytes]
 * @param {(offset: number, total: number|null) => void} [options.onProgress]
 * @returns {Promise<Blob>}
 */
export async function fetchAsBlob({
  url,
  request,
  auth = null,
  chunkSize = DEFAULT_CHUNK_SIZE,
  maxBytes = DEFAULT_MAX_BYTES,
  onProgress = null,
}) {
  const chunks = [];
  let offset = 0;
  let total = null;
  let supportsRange = null;
  let complete = false;

  for (;;) {
    const headers = supportsRange === false ? {} : { Range: `bytes=${offset}-${offset + chunkSize - 1}` };
    const result = await request({
      method: 'GET',
      url,
      headers,
      auth,
      wantBase64: true,
      maxBytes: chunkSize * 2,
      timeoutMs: 600000,
    });

    if (result.error) throw new Error(result.error);

    // 416：已经读到文件末尾了（有些服务器在越界时这么回）
    if (result.status === 416 && offset > 0) {
      complete = true;
      break;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`读取失败：HTTP ${result.status} ${result.statusText}`);
    }
    if (result.bodyOmitted) {
      // 服务器不支持 Range 一次给全，文件又超过了单次读取上限
      throw new Error(`文件超过单次读取上限 ${formatBytes(chunkSize * 2)}，且服务器不支持分段读取，无法完整预览`);
    }

    const bytes = result.bodyBase64 ? base64ToBytes(result.bodyBase64) : new Uint8Array(0);
    if (bytes.length) chunks.push(bytes);
    offset += bytes.length;

    if (supportsRange === null) {
      supportsRange = result.status === 206;
      if (supportsRange) {
        // 注意三个捕获组一个都不能少：以前这里少写了前两组却去取 match[3]，
        // 拿到 undefined → Number(undefined) = NaN → `offset < NaN` 永远为假，
        // 于是循环读完第一块（8MB）就退出，所有大于 8MB 的文件都被悄悄截断。
        const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(result.headerMap['content-range'] || '');
        total = match && match[3] !== '*' ? Number(match[3]) : null;
      } else {
        total = bytes.length; // 服务器忽略了 Range，一次就给全了
      }
    }

    onProgress?.(offset, total);

    if (total != null && offset >= total) {
      complete = true;
      break;
    }
    if (!bytes.length) break; // 没数据了又没到总长 → 不完整，下面会报错
    if (!supportsRange) {
      complete = true;
      break;
    }
    if (bytes.length < chunkSize) {
      complete = true; // 短读＝已经到文件末尾（总长未知时靠这个收尾）
      break;
    }
    if (offset > maxBytes) throw new Error(`文件超过 ${formatBytes(maxBytes)}，暂不支持在线预览`);
  }

  const blob = new Blob(chunks);
  if (!complete) {
    throw new Error(`读取中断：只拿到 ${formatBytes(blob.size)}${total ? ` / ${formatBytes(total)}` : ''}，文件没有下完，无法完整预览`);
  }
  return blob;
}

/** base64 → 字节（模块内小工具，避免为这一个函数牵进 manager 的依赖） */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
