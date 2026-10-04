/**
 * HTTP 认证挑战解析与 Authorization 头构造。
 *
 * 支持：
 *  - Basic（直接拼 base64）
 *  - Digest（RFC 7616 / RFC 2617），算法 MD5、MD5-sess、SHA-256、SHA-256-sess，
 *    qop=auth / auth-int / 无 qop，含 opaque、nonce 计数 nc、cnonce。
 */

import { md5Hex, toHex, utf8Bytes } from './md5.js';

/**
 * 从 WWW-Authenticate 头中拆出所有认证方案。
 * 一个响应头里可能同时出现 `Basic realm="x", Digest realm="y", nonce="z"`。
 * @returns {{scheme: string, params: Record<string,string>, raw: string}[]}
 */
export function parseChallenges(headerValue) {
  if (!headerValue) return [];

  // 方案名的特征是：紧跟一段 `key=value`（Basic realm="..." / Digest nonce="..."）
  const schemeRe = /([A-Za-z][A-Za-z0-9_-]*)\s+(?=[A-Za-z][A-Za-z0-9_-]*\s*=)/g;
  const marks = [];
  let m;
  while ((m = schemeRe.exec(headerValue)) !== null) {
    marks.push({
      scheme: m[1],
      tokenStart: m.index, // 方案名起始位置
      valueStart: m.index + m[0].length, // 参数串起始位置
    });
  }
  if (marks.length === 0) return [];

  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].tokenStart : headerValue.length;
    const segment = headerValue
      .slice(marks[i].valueStart, end)
      .replace(/[,;]\s*$/, '')
      .trim();
    out.push({
      scheme: marks[i].scheme,
      params: parseAuthParams(segment),
      raw: `${marks[i].scheme} ${segment}`.trim(),
    });
  }
  return out;
}

/** 解析 `realm="x", nonce=y` 形式的参数串 */
export function parseAuthParams(str) {
  const params = {};
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const key = m[1].toLowerCase();
    params[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return params;
}

/** 生成随机 cnonce（十六进制） */
export function randomCnonce(bytes = 8) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/**
 * 按挑战要求计算摘要。
 * @param {string} algorithm 挑战里的 algorithm 值，缺省为 MD5
 * @param {string} text
 * @returns {Promise<string>} 十六进制摘要
 */
async function hashHex(algorithm, text) {
  const algo = (algorithm || 'MD5').toUpperCase();
  if (algo.startsWith('MD5')) return md5Hex(text);
  if (algo.startsWith('SHA-256')) {
    const buf = await crypto.subtle.digest('SHA-256', utf8Bytes(text));
    return toHex(new Uint8Array(buf));
  }
  if (algo.startsWith('SHA-512-256')) {
    // WebCrypto 没有 SHA-512/256，降级不可行，明确报错
    throw new Error(`不支持摘要算法 ${algorithm}（请改用 Basic 或 MD5/SHA-256）`);
  }
  throw new Error(`不支持摘要算法 ${algorithm}`);
}

/**
 * 构造 Digest Authorization 头的值。
 *
 * @param {object} o
 * @param {Record<string,string>} o.params 挑战参数
 * @param {string} o.method HTTP 方法
 * @param {string} o.requestUri 请求 URI（path + query）
 * @param {string} o.username
 * @param {string} o.password
 * @param {string} [o.body] qop=auth-int 时参与计算的实体
 * @param {number} [o.nc] nonce 计数
 * @param {string} [o.cnonce]
 * @returns {Promise<string>}
 */
export async function buildDigestAuthorization({
  params,
  method,
  requestUri,
  username,
  password,
  body = '',
  nc = 1,
  cnonce = randomCnonce(),
}) {
  const realm = params.realm || '';
  const nonce = params.nonce || '';
  const algorithm = params.algorithm || 'MD5';
  const isSess = /-sess$/i.test(algorithm);
  const opaque = params.opaque;

  const qopOffered = (params.qop || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qop = qopOffered.includes('auth') ? 'auth' : qopOffered[0] || '';
  const ncHex = nc.toString(16).padStart(8, '0');

  let ha1 = await hashHex(algorithm, `${username}:${realm}:${password}`);
  if (isSess) {
    ha1 = await hashHex(algorithm, `${ha1}:${nonce}:${cnonce}`);
  }

  let ha2;
  if (qop === 'auth-int') {
    const entityHash = await hashHex(algorithm, body);
    ha2 = await hashHex(algorithm, `${method}:${requestUri}:${entityHash}`);
  } else {
    ha2 = await hashHex(algorithm, `${method}:${requestUri}`);
  }

  const response = qop
    ? await hashHex(algorithm, `${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : await hashHex(algorithm, `${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${requestUri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  }
  if (opaque !== undefined) parts.push(`opaque="${opaque}"`);
  if (params.charset) parts.push(`charset=${params.charset}`);
  if (params.userhash === 'true') {
    const uh = await hashHex(algorithm, `${username}:${realm}`);
    parts.push(`userhash=true`);
    parts[0] = `username="${uh}"`;
  }

  return `Digest ${parts.join(', ')}`;
}

/** Basic 认证头 */
export function buildBasicAuthorization(username, password) {
  const raw = `${username}:${password}`;
  const bytes = utf8Bytes(raw);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `Basic ${btoa(bin)}`;
}

/**
 * 从 401 响应的 WWW-Authenticate 中挑一个我们能处理的挑战。
 * @returns {{scheme: string, params: Record<string,string>}|null}
 */
export function pickSupportedChallenge(headerValue) {
  const list = parseChallenges(headerValue);
  if (!list.length) return null;
  const digest = list.find((c) => /^digest$/i.test(c.scheme));
  if (digest) return digest;
  const basic = list.find((c) => /^basic$/i.test(c.scheme));
  if (basic) return basic;
  return list[0];
}
