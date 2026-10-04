/**
 * 原始 HTTP 报文抓取层。
 *
 * 这是整个扩展的“引擎”：它替浏览器发出真正的 WebDAV 请求（PROPFIND / PUT / MOVE ...），
 * 并把**发出去的原始请求**和**服务器返回的原始响应**（状态行、响应头、响应正文）
 * 一并记录下来，交给界面渲染成人类可读的内容。
 *
 * 认证策略：
 *   none   —— 不加认证头
 *   basic  —— 直接带上 Basic 头
 *   digest —— 先发一次裸请求，收到 401 挑战后按 RFC 7616 计算摘要重发
 *   auto   —— 有用户名时先带 Basic；若服务器要 Digest，再自动改走摘要流程（默认）
 */

import { buildBasicAuthorization, buildDigestAuthorization, pickSupportedChallenge } from './digest.js';
import { bytesToBase64, base64ToBytes } from './bytes.js';
import { statusTextCN } from './webdav.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export { bytesToBase64, base64ToBytes };

/** 日志里隐藏凭据，但保留认证方案方便排查 */
function redactAuthValue(value) {
  if (!value) return value;
  const scheme = String(value).split(/\s+/)[0];
  return `${scheme} <凭据已隐藏>`;
}

function headerLines(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${/^authorization$/i.test(k) ? redactAuthValue(v) : v}`)
    .join('\r\n');
}

function truncateBody(text, limit) {
  if (text == null) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\r\n\r\n... <已截断，共 ${text.length} 字符>`;
}

/**
 * 发起一次 WebDAV 请求并记录原始报文。
 *
 * @param {object} options
 * @param {string} options.method HTTP 方法
 * @param {string} options.url 绝对 URL
 * @param {Record<string,string>} [options.headers] 额外请求头
 * @param {string} [options.bodyText] 文本请求体（如 PROPFIND 的 XML）
 * @param {string} [options.bodyBase64] 二进制请求体（如上传文件内容）
 * @param {{mode?:string,username?:string,password?:string}} [options.auth]
 * @param {boolean} [options.wantBase64] 是否把响应体也转成 base64
 * @param {number} [options.maxBytes] 正文大小上限，超过则不读取
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>}
 */
export async function davRequest(options) {
  const {
    method = 'GET',
    url,
    headers = {},
    bodyText = null,
    bodyBase64 = null,
    auth = null,
    wantBase64 = false,
    maxBytes = 32 * 1024 * 1024,
    timeoutMs = 60000,
    redirect = 'follow',
  } = options;

  const startedAt = Date.now();
  const result = {
    ok: false,
    status: 0,
    statusText: '',
    statusHint: '',
    headers: [],
    headerMap: {},
    finalUrl: url,
    bodyText: null,
    bodyBase64: null,
    bodyOmitted: false,
    elapsedMs: 0,
    authUsed: 'none',
    authChallenge: null,
    attempts: [],
    error: null,
    raw: { request: '', response: '' },
  };

  let target;
  try {
    target = new URL(url);
  } catch {
    result.error = `URL 不合法：${url}`;
    return result;
  }

  const requestUri = target.pathname + target.search;
  let bodyBytes = null;
  if (bodyBase64 != null) bodyBytes = base64ToBytes(bodyBase64);
  else if (typeof bodyText === 'string') bodyBytes = encoder.encode(bodyText);

  const baseHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null && value !== '') baseHeaders[key] = String(value);
  }

  const mode = (auth && auth.mode) || 'none';
  const username = (auth && auth.username) || '';
  const password = (auth && auth.password) || '';

  let attemptHeaders = { ...baseHeaders };
  if (username && (mode === 'basic' || mode === 'auto')) {
    attemptHeaders.Authorization = buildBasicAuthorization(username, password);
    result.authUsed = 'basic';
  }

  let response = null;
  let lastHeaderSnapshot = attemptHeaders;

  for (let attempt = 0; attempt < 2; attempt++) {
    lastHeaderSnapshot = { ...attemptHeaders };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: attemptHeaders,
        body: bodyBytes || undefined,
        redirect,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && err.name === 'AbortError';
      result.error = aborted
        ? `请求超时（${timeoutMs} ms）`
        : `网络请求失败：${err && err.message ? err.message : err}`;
      result.elapsedMs = Date.now() - startedAt;
      result.raw.request = buildRawRequest(method, requestUri, target, lastHeaderSnapshot, bodyBytes, bodyText);
      result.raw.response = `<!> ${result.error}`;
      result.attempts.push({ attempt: attempt + 1, auth: result.authUsed, error: result.error });
      return result;
    }
    clearTimeout(timer);

    response = res;
    result.attempts.push({ attempt: attempt + 1, auth: result.authUsed, status: res.status });

    if (res.status === 401 && attempt === 0 && mode !== 'none' && mode !== 'basic') {
      const wwwAuth = res.headers.get('www-authenticate');
      const challenge = pickSupportedChallenge(wwwAuth);
      result.authChallenge = challenge ? challenge.raw : wwwAuth;
      if (challenge && /^digest$/i.test(challenge.scheme)) {
        try {
          attemptHeaders = {
            ...baseHeaders,
            Authorization: await buildDigestAuthorization({
              params: challenge.params,
              method,
              requestUri,
              username,
              password,
              body: bodyText || '',
            }),
          };
          result.authUsed = 'digest';
          try {
            await res.body?.cancel();
          } catch {
            /* 忽略：丢弃第一次 401 的正文 */
          }
          continue;
        } catch (err) {
          result.error = `Digest 认证计算失败：${err.message}`;
        }
      } else if (challenge && /^basic$/i.test(challenge.scheme) && !username) {
        result.error = '服务器要求 Basic 认证，但未填写用户名 / 密码';
      }
    }
    break;
  }

  const res = response;
  result.ok = true;
  result.status = res.status;
  result.statusText = res.statusText || '';
  result.statusHint = statusTextCN(res.status);
  result.finalUrl = res.url || url;
  result.headers = [...res.headers.entries()];
  result.headerMap = Object.fromEntries(result.headers);

  const contentLength = Number(res.headers.get('content-length') || 0);
  const contentType = (result.headerMap['content-type'] || '').toLowerCase();
  const binaryish =
    /^(image|video|audio|font)\//.test(contentType) ||
    /application\/(octet-stream|zip|x-7z-compressed|x-rar-compressed|x-tar|gzip|pdf|vnd\.)/.test(contentType);
  const noBody = method === 'HEAD' || res.status === 204 || res.status === 304;

  if (!noBody) {
    if (contentLength > maxBytes) {
      result.bodyOmitted = true;
      try {
        await res.body?.cancel();
      } catch {
        /* 忽略 */
      }
    } else {
      let buffer;
      try {
        buffer = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        result.error = `读取响应正文失败：${err.message}`;
        buffer = new Uint8Array(0);
      }
      if (buffer.byteLength > maxBytes) {
        result.bodyOmitted = true;
      } else if (buffer.byteLength > 0) {
        if (!binaryish) {
          result.bodyText = decoder.decode(buffer);
        }
        if (wantBase64 || binaryish) {
          result.bodyBase64 = bytesToBase64(buffer);
        }
      }
    }
  }

  const bodyPreview = result.bodyOmitted
    ? '<正文超过大小上限，已跳过读取>'
    : result.bodyText != null
      ? result.bodyText
      : result.bodyBase64
        ? `<二进制正文 ${Math.round((result.bodyBase64.length * 3) / 4)} 字节（已转 base64）>`
        : '';

  result.raw.request = buildRawRequest(method, requestUri, target, lastHeaderSnapshot, bodyBytes, bodyText);
  result.raw.response = [
    `HTTP/1.1 ${result.status} ${result.statusText}`.trimEnd(),
    ...result.headers.map(
      ([k, v]) => `${k}: ${/^set-cookie$/i.test(k) ? '<已隐藏>' : v}`,
    ),
    '',
    truncateBody(bodyPreview, 128 * 1024),
  ].join('\r\n');

  result.elapsedMs = Date.now() - startedAt;
  return result;
}

function buildRawRequest(method, requestUri, target, headers, bodyBytes, bodyText) {
  const lines = [`${method} ${requestUri} HTTP/1.1`, `Host: ${target.host}`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${/^authorization$/i.test(k) ? redactAuthValue(v) : v}`);
  }
  if (bodyBytes) lines.push(`Content-Length: ${bodyBytes.byteLength} (由浏览器填充)`);

  const bodyPreview =
    bodyText != null
      ? truncateBody(bodyText, 64 * 1024)
      : bodyBytes
        ? `<二进制请求体 ${bodyBytes.byteLength} 字节>`
        : '';

  return `${lines.join('\r\n')}\r\n\r\n${bodyPreview}`;
}
