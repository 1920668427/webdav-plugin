/**
 * 207 Multi-Status XML 解析器。
 *
 * WebDAV 服务器对 PROPFIND 的响应是一坨人类不可读的 XML，例如：
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <D:multistatus xmlns:D="DAV:">
 *     <D:response>
 *       <D:href>/dav/</D:href>
 *       <D:propstat>
 *         <D:prop>
 *           <D:resourcetype><D:collection/></D:resourcetype>
 *           <D:getlastmodified>Fri, 03 Oct 2025 10:00:00 GMT</D:getlastmodified>
 *         </D:prop>
 *         <D:status>HTTP/1.1 200 OK</D:status>
 *       </D:propstat>
 *     </D:response>
 *   </D:multistatus>
 *
 * 本模块把它转成结构化的条目数组，供文件管理界面直接渲染。
 * 使用 DOMParser（只解析、不执行脚本），因此对恶意 XML 是安全的。
 */

import { safeDecodeURIComponent } from './webdav.js';

const parser = new DOMParser();
const serializer = new XMLSerializer();

/** 取某个元素下指定 DAV 命名空间的直接子元素 */
function childNS(element, localName, ns = 'DAV:') {
  if (!element) return null;
  for (const child of element.children) {
    if (child.localName === localName && (child.namespaceURI === ns || !child.namespaceURI)) {
      return child;
    }
  }
  return null;
}

/** 取所有指定 localName 的直接子元素 */
function childrenNS(element, localName, ns = 'DAV:') {
  const out = [];
  if (!element) return out;
  for (const child of element.children) {
    if (child.localName === localName && (child.namespaceURI === ns || !child.namespaceURI)) {
      out.push(child);
    }
  }
  return out;
}

/** "HTTP/1.1 200 OK" → 200 */
function parseStatusCode(statusLine) {
  const m = /\s(\d{3})\s/.exec(` ${String(statusLine || '').trim()} `);
  return m ? Number(m[1]) : 0;
}

/**
 * 解析 multistatus 响应。
 * @param {string} xmlText 原始 XML 文本
 * @param {string} requestUrl 发起 PROPFIND 的集合 URL（用于把相对 href 变成绝对 URL）
 * @returns {{entries: Array<object>, parseError: string|null, isMultistatus: boolean, raw: string}}
 */
export function parseMultistatus(xmlText, requestUrl) {
  const result = { entries: [], parseError: null, isMultistatus: false, raw: xmlText };
  if (!xmlText || !xmlText.trim()) {
    result.parseError = '响应正文为空';
    return result;
  }

  let doc;
  try {
    doc = parser.parseFromString(xmlText, 'application/xml');
  } catch (err) {
    result.parseError = `XML 解析异常：${err.message}`;
    return result;
  }

  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    result.parseError = `XML 格式错误：${parserError.textContent.slice(0, 200)}`;
    return result;
  }

  const root = doc.documentElement;
  if (!root || root.localName !== 'multistatus') {
    result.parseError = `响应根元素是 <${root ? root.nodeName : '空'}>，不是 <multistatus>，可能服务器返回了错误页面`;
    return result;
  }
  result.isMultistatus = true;

  const responses = [...doc.getElementsByTagNameNS('DAV:', 'response')];
  const fallbackResponses = responses.length ? responses : [...root.children].filter((el) => el.localName === 'response');

  for (const response of fallbackResponses) {
    const entry = parseResponse(response, requestUrl);
    if (entry) result.entries.push(entry);
  }

  return result;
}

function parseResponse(response, requestUrl) {
  const hrefEl = childNS(response, 'href') || response.getElementsByTagNameNS('DAV:', 'href')[0];
  if (!hrefEl) return null;
  const href = hrefEl.textContent.trim();

  let url = href;
  try {
    url = new URL(href, requestUrl).href;
  } catch {
    /* 保留原值 */
  }

  const propstats = childrenNS(response, 'propstat');
  const byStatus = [];
  const props = {};
  const propStatus = {};
  const propRawXml = {};

  for (const propstat of propstats) {
    const status = parseStatusCode((childNS(propstat, 'status') || {}).textContent);
    const prop = childNS(propstat, 'prop');
    if (!prop) continue;
    for (const el of prop.children) {
      const name = el.localName;
      props[name] = el;
      propStatus[name] = status;
      propRawXml[name] = serializer.serializeToString(el);
    }
    byStatus.push({ status, prop });
  }

  // 优先使用 2xx 的属性集合
  const good = byStatus.find((p) => p.status >= 200 && p.status < 300);
  const chosen = good || byStatus[0];
  const statusCode = chosen ? chosen.status : 0;

  const resourcetype = props.resourcetype;
  const isCollection = Boolean(
    resourcetype &&
      (resourcetype.getElementsByTagNameNS('DAV:', 'collection').length > 0 ||
        [...resourcetype.children].some((el) => el.localName === 'collection')),
  );

  const text = (name) => {
    const el = props[name];
    if (!el) return '';
    if (propStatus[name] && (propStatus[name] < 200 || propStatus[name] >= 300)) return '';
    return el.textContent.trim();
  };

  const displayName = text('displayname');
  const lastSegment = (() => {
    try {
      const segs = new URL(url).pathname.replace(/\/+$/, '').split('/');
      return safeDecodeURIComponent(segs[segs.length - 1] || '');
    } catch {
      return href;
    }
  })();

  const contentLengthRaw = text('getcontentlength');
  const contentLength = contentLengthRaw === '' ? null : Number(contentLengthRaw);

  const etag = (text('getetag') || '').replace(/^W\//, '').replace(/^"|"$/g, '');

  const quotaAvailable = text('quota-available-bytes');
  const quotaUsed = text('quota-used-bytes');

  return {
    href,
    url,
    name: displayName || lastSegment,
    isCollection,
    size: isCollection ? 0 : Number.isFinite(contentLength) ? contentLength : null,
    sizeRaw: contentLengthRaw,
    lastModified: text('getlastmodified'),
    created: text('creationdate'),
    contentType: text('getcontenttype'),
    etag,
    quotaAvailable: quotaAvailable ? Number(quotaAvailable) : null,
    quotaUsed: quotaUsed ? Number(quotaUsed) : null,
    status: statusCode,
    statusOk: statusCode >= 200 && statusCode < 300,
    /** 每个属性的原始 XML 片段，便于查看服务器到底返回了什么 */
    rawProps: propRawXml,
    /** 该 <D:response> 节点的原始 XML */
    rawXml: serializer.serializeToString(response),
  };
}

/**
 * 从 multistatus 中取出被请求集合自身（第一个 href，或与请求 URL 相同者）。
 */
export function findSelfEntry(entries, requestUrl) {
  const normalized = (u) => {
    try {
      const url = new URL(u);
      url.hash = '';
      return decodeURIComponent(url.pathname).replace(/\/+$/, '');
    } catch {
      return String(u);
    }
  };
  const target = normalized(requestUrl);
  return entries.find((e) => normalized(e.url) === target) || entries[0] || null;
}
