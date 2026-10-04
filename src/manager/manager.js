/**
 * WebDAV 文件管理器主页面逻辑。
 *
 * 数据流：
 *   页面 —(chrome.runtime.sendMessage)--> Service Worker —(fetch)--> WebDAV 服务器
 *   页面 <--(原始状态行 + 响应头 + 响应正文)-- Service Worker
 *   页面把 207 Multi-Status XML 解析成文件列表并渲染成可操作的表格。
 */

import {
  PROPFIND_BODY,
  ensureTrailingSlash,
  extensionOf,
  formatBytes,
  formatDateTime,
  guessContentType,
  isUnder,
  joinUrl,
  kindIcon,
  kindLabel,
  fileKind,
  nameFromUrl,
  normalizeServerUrl,
  parentUrl,
  METHOD_HINTS,
  parseDavCapabilities,
  relativeSegments,
  sanitizeFilename,
  statusTextCN,
  canPreview,
} from '../lib/webdav.js';
import { parseMultistatus, findSelfEntry } from '../lib/xml.js';
import { arrayBufferToBase64, base64ToBlob } from '../lib/bytes.js';
import { buildBasicAuthorization } from '../lib/digest.js';
import { readAudioMetadata, describeReplayGain } from '../lib/tags.js';
import { AudioPlayer, SmfBackend, PlayerUI } from '../lib/audio-player.js';
import { MidiBridge, describeMessage } from '../lib/midi.js';
import { fetchAsBlob, DEFAULT_CHUNK_SIZE } from '../lib/blob-fetch.js';

const $ = (selector) => document.querySelector(selector);

const dom = {
  form: $('#connect-form'),
  url: $('#input-url'),
  user: $('#input-user'),
  pass: $('#input-pass'),
  auth: $('#input-auth'),
  connectBtn: $('#btn-connect'),
  saveBtn: $('#btn-save'),
  connectionList: $('#connection-list'),
  serverInfo: $('#server-info'),
  logList: $('#log-list'),
  clearLog: $('#btn-clear-log'),
  up: $('#btn-up'),
  refresh: $('#btn-refresh'),
  breadcrumb: $('#breadcrumb'),
  filter: $('#filter'),
  mkcol: $('#btn-mkcol'),
  upload: $('#btn-upload'),
  uploadDir: $('#btn-upload-dir'),
  downloadSelected: $('#btn-download-selected'),
  selectAll: $('#btn-select-all'),
  deleteSelected: $('#btn-delete-selected'),
  rawXml: $('#btn-raw-xml'),
  diagnose: $('#btn-diagnose'),
  permissionBanner: $('#permission-banner'),
  permissionDetail: $('#permission-detail'),
  grantPermission: $('#btn-grant'),
  retryConnect: $('#btn-retry-connect'),
  permissionHelp: $('#btn-permission-help'),
  selectionInfo: $('#selection-info'),
  status: $('#status'),
  queue: $('#queue'),
  dropzone: $('#dropzone'),
  tbody: $('#file-tbody'),
  checkAll: $('#check-all'),
  emptyHint: $('#empty-hint'),
  statusLeft: $('#status-left'),
  statusRight: $('#status-right'),
  fileInput: $('#file-input'),
  dirInput: $('#dir-input'),
  rawDialog: $('#raw-dialog'),
  rawMethod: $('#raw-method'),
  rawStatus: $('#raw-status'),
  rawUrl: $('#raw-url'),
  rawTabs: $('#raw-tabs'),
  rawPre: $('#raw-pre'),
  rawMeta: $('#raw-meta'),
  rawClose: $('#raw-close'),
  rawCopy: $('#raw-copy'),
  promptDialog: $('#prompt-dialog'),
  promptTitle: $('#prompt-title'),
  promptDesc: $('#prompt-desc'),
  promptInput: $('#prompt-input'),
  promptOk: $('#prompt-ok'),
  promptCancel: $('#prompt-cancel'),
  previewDialog: $('#preview-dialog'),
  previewTitle: $('#preview-title'),
  previewBody: $('#preview-body'),
  previewClose: $('#preview-close'),
  toast: $('#toast'),
};

const state = {
  playerSettings: { volume: 1, replayGainMode: 'track', preAmpDb: 0, bpm: 120, synthEnabled: true },
  baseUrl: null,
  currentUrl: null,
  auth: { mode: 'auto', username: '', password: '' },
  entries: [],
  self: null,
  capabilities: null,
  options: null,
  endpoints: [],
  connected: false,
  busy: false,
  filter: '',
  sort: { key: 'name', dir: 1 },
  selected: new Set(),
  log: [],
  lastPropfind: null,
  connections: [],
  /** 当前目标 origin 的访问权限状态：null=未知，true/false=已查 */
  permission: { pattern: '', granted: null },
  /** MIDI 桥与上次设置 */
  midi: { bridge: null, settings: null, status: null, restored: false },
  extensionId: '',
  extensionName: '',
  extensionVersion: '',
};

const MAX_LOG = 60;
/** 能交给音频播放器处理的扩展名 */
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'aac', 'aif', 'aiff', 'wma', 'ape', 'weba'];
/** 交给 MIDI 播放器的扩展名 */
const MIDI_EXTENSIONS = ['mid', 'midi', 'kar', 'rmi'];
/** 分块读取的块大小（配合 Range 请求，避免一条消息塞爆内存） */
const FETCH_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
const LOG_BODY_LIMIT = 200 * 1024;
/** 超过该大小就改用浏览器下载器直接落盘 */
const BROWSER_DOWNLOAD_THRESHOLD = 128 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.pathname).replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(url);
  }
}

let toastTimer = null;
function toast(message, kind = '') {
  dom.toast.textContent = message;
  dom.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.className = 'toast';
  }, kind === 'error' ? 6000 : 3000);
}

function setStatus(message, kind = '') {
  dom.status.textContent = message || '';
  dom.status.className = `status ${kind}`;
}

function setBusy(busy, label = '') {
  state.busy = busy;
  for (const btn of [dom.refresh, dom.mkcol, dom.upload, dom.uploadDir, dom.downloadSelected]) {
    btn.disabled = busy;
  }
  dom.connectBtn.disabled = busy;
  dom.connectBtn.textContent = busy ? '连接中…' : '连接';
  if (busy) {
    if (label) setStatus(label);
  } else {
    renderSelectionInfo();
  }
}

/** 统一的发送入口 */
async function send(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (err) {
    throw new Error(`与扩展后台通信失败：${err.message}`);
  }
  if (!response) throw new Error('扩展后台没有响应，请重试');
  return response;
}

/**
 * 发起一次原始 WebDAV 请求，并把完整报文塞进日志。
 * @returns {Promise<object>} davRequest 的结果对象
 */
async function request(options) {
  const result = await send({ type: 'DAV_REQUEST', ...options });
  pushLog({
    method: options.method || 'GET',
    url: options.url,
    result,
    requestBody:
      options.bodyText ??
      (options.bodyBase64 ? `<二进制请求体 ${Math.round((options.bodyBase64.length * 3) / 4)} 字节>` : ''),
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* 原始报文日志                                                        */
/* ------------------------------------------------------------------ */

function pushLog({ method, url, result, requestBody = '', note = '' }) {
  const entry = {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    time: new Date(),
    method,
    url,
    status: result.status || 0,
    statusText: result.statusText || '',
    statusHint: result.statusHint || statusTextCN(result.status),
    ok: !result.error && result.status >= 200 && result.status < 300,
    error: result.error || null,
    elapsedMs: result.elapsedMs || 0,
    headers: result.headers || [],
    requestRaw: result.raw ? result.raw.request : '',
    responseRaw: result.raw ? result.raw.response : '',
    bodyText: result.bodyText ?? null,
    bodyBytes: result.bodyBase64 ? Math.round((result.bodyBase64.length * 3) / 4) : 0,
    bodyOmitted: Boolean(result.bodyOmitted),
    authUsed: result.authUsed,
    authChallenge: result.authChallenge,
    attempts: result.attempts || [],
    note,
  };
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
  renderLog();
  updateStatusRight();
  return entry;
}

function renderLog() {
  dom.logList.innerHTML = '';
  if (!state.log.length) {
    dom.logList.innerHTML = '<li class="muted" style="padding:6px 8px">还没有请求。连接后这里会显示每一次原始报文。</li>';
    return;
  }
  for (const entry of state.log) {
    const li = document.createElement('li');
    li.className = `log-item ${entry.ok ? 'ok' : 'bad'}`;
    li.dataset.logId = entry.id;
    li.title = '点击查看原始请求 / 响应';
    let path;
    try {
      path = decodeURIComponent(new URL(entry.url).pathname);
    } catch {
      path = entry.url;
    }
    li.innerHTML = `
      <span class="method">${esc(entry.method)}</span>
      <span class="grow">
        <span class="status-line">${entry.error ? 'ERR' : entry.status} ${esc(path)}</span>
        <div class="meta">${esc(entry.time.toLocaleTimeString())} · ${entry.elapsedMs}ms${
          entry.authUsed && entry.authUsed !== 'none' ? ` · ${esc(entry.authUsed)}` : ''
        }</div>
      </span>`;
    dom.logList.appendChild(li);
  }
}

dom.logList.addEventListener('click', (event) => {
  const item = event.target.closest('.log-item');
  if (!item) return;
  const entry = state.log.find((e) => e.id === item.dataset.logId);
  if (entry) showLogDialog(entry);
});

dom.clearLog.addEventListener('click', () => {
  state.log = [];
  renderLog();
});

/* ------------------------------------------------------------------ */
/* 网站访问权限自检                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把任意 URL 变成扩展权限用的 origin 匹配模式。
 * 例：http://192.168.1.50:8080/Volumes/ → http://192.168.1.50:8080/*
 */
function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/*`;
}

/**
 * 确保扩展对目标 origin 有访问权限。
 *
 * 为什么需要这个：如果浏览器没有真正把 host 权限授予扩展
 * （Edge/Chrome 的「站点访问权限」被设成「单击时」时就会这样），
 * 扩展发出的请求就会退化成普通跨域请求，撞上 CORS 预检，
 * 报错正是 “Response to preflight request doesn't pass access control check”。
 *
 * @param {string} url 目标地址
 * @param {{interactive?:boolean}} options interactive=true 表示调用发生在用户手势里，
 *        可以弹出授权询问（必须放在任何 await 之前，否则手势会被消耗掉）
 */
async function ensureHostPermission(url, { interactive = false } = {}) {
  let pattern;
  try {
    pattern = originPattern(normalizeServerUrl(url));
  } catch {
    return true;
  }
  state.permission.pattern = pattern;

  let granted = false;

  if (interactive) {
    // 已授权时不会弹窗，直接返回 true；只有确实缺权限才会询问
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch {
      granted = false;
    }
  }

  if (!granted) {
    try {
      const res = await send({ type: 'CHECK_PERMISSIONS', origins: [pattern] });
      granted = Boolean(res.granted && res.granted[pattern]);
      rememberExtensionInfo(res);
    } catch {
      granted = true; // 查不到就别挡着用户
    }
  }

  state.permission.granted = granted;
  renderPermissionBanner();
  return granted;
}

function rememberExtensionInfo(info) {
  if (!info) return;
  if (info.extensionId) state.extensionId = info.extensionId;
  if (info.extensionName) state.extensionName = info.extensionName;
  if (info.extensionVersion) state.extensionVersion = info.extensionVersion;
}

/** 缺权限时把提示条显示出来，并写清楚怎么修 */
function renderPermissionBanner() {
  if (!dom.permissionBanner) return;
  const missing = state.permission.granted === false;
  dom.permissionBanner.classList.toggle('hidden', !missing);
  if (!missing) return;
  dom.permissionDetail.textContent =
    `目标 ${state.permission.pattern}　扩展 ID ${state.extensionId || '（未知）'}。` +
    '在 edge://extensions → 找到本扩展 →「详细信息」→ 把「站点访问权限」改成「在所有网站上」即可；' +
    '也可以点「申请访问权限」当场授权。';
}

/** 把“Failed to fetch”这类原始报错翻译成能照着做的提示 */
function networkErrorHint(result) {
  const message = (result && result.error) || '';
  if (!/Failed to fetch|NetworkError|load failed|网络请求失败/i.test(message)) return '';
  if (state.permission.granted === false) {
    return '（浏览器没有把该网站的访问权限授予扩展，请求被 CORS 预检拦下了 —— 见上方黄色提示条，或点「🔍 诊断」）';
  }
  return '（请求没能发出去：可能是网络不通、端口不对、HTTPS 证书不受信任，或浏览器拦截了这个地址。可点「🔍 诊断」查看细节）';
}

/* ------------------------------------------------------------------ */
/* 连接与目录浏览                                                      */
/* ------------------------------------------------------------------ */

async function connect({ url, username, password, authMode }, { navigateTo = null } = {}) {
  let base;
  try {
    base = ensureTrailingSlash(normalizeServerUrl(url));
  } catch (err) {
    setStatus(err.message, 'error');
    toast(err.message, 'error');
    return false;
  }

  state.baseUrl = base;
  state.auth = { mode: authMode || 'auto', username: username || '', password: password || '' };
  state.connected = false;
  state.selected.clear();

  // 权限没到位的话，后面所有请求都会撞 CORS，先在这里说清楚
  if (state.permission.pattern !== originPattern(base)) {
    await ensureHostPermission(base);
  }

  setBusy(true, `正在向 ${base} 发送 OPTIONS 探测服务器能力…`);
  let options;
  try {
    options = await request({ method: 'OPTIONS', url: base, auth: state.auth, timeoutMs: 30000 });
  } catch (err) {
    setBusy(false);
    setStatus(err.message, 'error');
    toast(err.message, 'error');
    return false;
  }

  if (options.error) {
    setBusy(false);
    const hint = networkErrorHint(options);
    setStatus(`连接失败：${options.error}${hint}`, 'error');
    toast(`${options.error}${hint ? '（详见状态栏与 🔍 诊断）' : ''}`, 'error');
    return false;
  }

  if (options.status === 401 || options.status === 403) {
    const hint = options.authChallenge
      ? `服务器要求认证（${esc(options.authChallenge)}）`
      : '服务器要求认证，请填写用户名和密码';
    setBusy(false);
    setStatus(`${options.status} ${options.statusText}：${hint}`, 'error');
    toast('认证失败：请检查用户名 / 密码与认证方式', 'error');
    renderServerInfo(options);
    return false;
  }

  state.options = options;
  state.capabilities = parseDavCapabilities(options.headerMap['dav'], options.headerMap['allow']);
  renderServerInfo(options);

  setStatus(`已连接 ${base}（${options.status}）`, 'ok');
  const target = navigateTo || base;
  const ok = await navigate(target);
  setBusy(false);

  if (ok) {
    state.connected = true;
    dom.url.value = base;
    dom.user.value = state.auth.username;
    dom.pass.value = state.auth.password;
    dom.auth.value = state.auth.mode;
    chrome.storage.local.set({ lastConnection: { url: base, username: state.auth.username, password: state.auth.password, authMode: state.auth.mode } });
  }
  updateStatusRight();
  return ok;
}

/** 发送 PROPFIND 并把 207 XML 渲染成列表 */
async function navigate(url, { quiet = false } = {}) {
  if (!quiet) setBusy(true, `PROPFIND ${url} …`);
  let result;
  try {
    result = await request({
      method: 'PROPFIND',
      url,
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml, text/xml, */*',
      },
      bodyText: PROPFIND_BODY,
      auth: state.auth,
      timeoutMs: 120000,
    });
  } catch (err) {
    if (!quiet) setBusy(false);
    setStatus(err.message, 'error');
    return false;
  }

  if (result.error) {
    if (!quiet) setBusy(false);
    setStatus(`PROPFIND 失败：${result.error}${networkErrorHint(result)}`, 'error');
    return false;
  }

  if (result.status === 401) {
    setStatus('401 认证失败：请检查用户名 / 密码或认证方式', 'error');
    if (!quiet) setBusy(false);
    return false;
  }

  if (result.status !== 207 && result.status !== 200) {
    setStatus(
      `服务器返回 ${result.status} ${result.statusText}${result.statusHint ? `（${result.statusHint}）` : ''}，无法解析目录。可点右侧日志查看原始响应。`,
      'error',
    );
    if (!quiet) setBusy(false);
    return false;
  }

  const parsed = parseMultistatus(result.bodyText || '', url);
  state.lastPropfind = { url, result, parsed };

  if (parsed.parseError) {
    setStatus(`原始 XML 解析失败：${parsed.parseError}`, 'error');
    if (!quiet) setBusy(false);
    render();
    return false;
  }

  const selfKey = normalizeUrlKey(url);
  state.entries = parsed.entries.filter((entry) => normalizeUrlKey(entry.url) !== selfKey);
  state.self = findSelfEntry(parsed.entries, url);
  state.currentUrl = url;
  state.selected.clear();
  state.filter = '';
  dom.filter.value = '';
  state.connected = true;

  if (!quiet) setBusy(false);
  setStatus(
    `已列出 ${state.entries.length} 项 · 服务器返回 ${result.status} Multi-Status · 耗时 ${result.elapsedMs} ms`,
    'ok',
  );
  render();
  return true;
}

function renderServerInfo(options) {
  const caps = parseDavCapabilities(options.headerMap['dav'], options.headerMap['allow']);
  const rows = [];
  rows.push(`<div><span class="chip">HTTP ${options.status}</span>${esc(options.statusHint || '')}</div>`);
  if (caps.classes.length) {
    rows.push(
      `<div>WebDAV 级别：${caps.classes
        .map((c) => `<span class="chip">Class ${c}${c === 2 ? '（支持锁定）' : ''}</span>`)
        .join('')}</div>`,
    );
  } else if (options.headerMap['dav']) {
    rows.push(`<div>DAV 头：<code>${esc(options.headerMap['dav'])}</code></div>`);
  } else {
    rows.push('<div class="muted">服务器未返回 DAV 头（可能不是标准 WebDAV 实现）</div>');
  }
  if (caps.methods.length) {
    rows.push(`<div>允许的方法：<br />${caps.methods.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>`);
  }
  if (options.headerMap['server']) rows.push(`<div class="muted">Server：${esc(options.headerMap['server'])}</div>`);
  if (options.authUsed && options.authUsed !== 'none') {
    rows.push(`<div class="muted">当前认证：${esc(options.authUsed)}</div>`);
  }
  dom.serverInfo.innerHTML = rows.join('');
  dom.serverInfo.classList.remove('muted');
}

/* ------------------------------------------------------------------ */
/* 渲染文件表                                                          */
/* ------------------------------------------------------------------ */

function decorate(entry) {
  const kind = fileKind(entry.name, entry.isCollection, entry.contentType);
  return { ...entry, kind, icon: kindIcon(kind), kindLabel: kindLabel(kind) };
}

function visibleEntries() {
  const keyword = state.filter.trim().toLowerCase();
  let list = state.entries.map(decorate);
  if (keyword) list = list.filter((e) => e.name.toLowerCase().includes(keyword));
  const { key, dir } = state.sort;
  list.sort((a, b) => {
    if (a.isCollection !== b.isCollection) return a.isCollection ? -1 : 1;
    let result = 0;
    if (key === 'size') result = (a.size || 0) - (b.size || 0);
    else if (key === 'lastModified') result = new Date(a.lastModified || 0) - new Date(b.lastModified || 0);
    else if (key === 'kind') result = a.kindLabel.localeCompare(b.kindLabel);
    else result = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    return result * dir;
  });
  return list;
}

function render() {
  const list = visibleEntries();
  dom.tbody.innerHTML = '';
  dom.emptyHint.classList.toggle('hidden', list.length > 0);

  if (!state.connected) {
    dom.emptyHint.textContent = '尚未连接。填入 WebDAV 服务器地址后点击「连接」，扩展会直接读取服务器返回的原始 207 XML 并渲染成文件列表。';
  } else if (!list.length) {
    dom.emptyHint.textContent = state.filter ? '没有匹配的项目。' : '当前目录是空的。';
  }

  const fragment = document.createDocumentFragment();
  for (const entry of list) {
    const tr = document.createElement('tr');
    tr.dataset.url = entry.url;
    if (state.selected.has(entry.url)) tr.classList.add('selected');
    const actions = entry.isCollection
      ? `<button class="btn" data-action="open">打开</button>
         <button class="btn" data-action="rename">重命名</button>
         <button class="btn" data-action="move">移动</button>
         <button class="btn" data-action="props">属性</button>
         <button class="btn danger" data-action="delete">删除</button>`
      : `<button class="btn" data-action="download">下载</button>
         <button class="btn" data-action="rename">重命名</button>
         <button class="btn" data-action="move">移动</button>
         <button class="btn" data-action="copy">复制</button>
         <button class="btn" data-action="props">属性</button>
         <button class="btn danger" data-action="delete">删除</button>`;

    tr.innerHTML = `
      <td><input type="checkbox" ${state.selected.has(entry.url) ? 'checked' : ''} /></td>
      <td>
        <span class="name-cell">
          <span class="icon">${entry.icon}</span>
          <a class="name-link ${entry.isCollection ? 'dir' : ''}" title="${esc(entry.url)}">${esc(entry.name)}</a>
          ${entry.etag ? `<span class="tag">${esc(entry.etag.slice(0, 12))}</span>` : ''}
        </span>
      </td>
      <td>${entry.isCollection ? '—' : esc(formatBytes(entry.size))}</td>
      <td>${esc(formatDateTime(entry.lastModified))}</td>
      <td>${esc(entry.kindLabel)}</td>
      <td><span class="row-actions">${actions}</span></td>`;
    fragment.appendChild(tr);
  }
  dom.tbody.appendChild(fragment);
  renderBreadcrumb();
  renderSelectionInfo();
}

function renderBreadcrumb() {
  dom.breadcrumb.innerHTML = '';
  if (!state.baseUrl || !state.currentUrl) return;
  const segments = relativeSegments(state.currentUrl, state.baseUrl);

  const makeLink = (label, url, isCurrent) => {
    const el = document.createElement('a');
    el.textContent = label;
    el.href = '#';
    if (isCurrent) {
      el.className = 'current';
      el.removeAttribute('href');
    } else {
      el.addEventListener('click', (event) => {
        event.preventDefault();
        navigate(url);
      });
    }
    return el;
  };

  dom.breadcrumb.appendChild(makeLink(`🏠 ${nameFromUrl(state.baseUrl) || '根目录'}`, state.baseUrl, segments.length === 0));
  let accumulated = state.baseUrl;
  segments.forEach((segment, index) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    dom.breadcrumb.appendChild(sep);
    accumulated = `${ensureTrailingSlash(accumulated)}${encodeURIComponent(segment)}`;
    dom.breadcrumb.appendChild(makeLink(segment, ensureTrailingSlash(accumulated), index === segments.length - 1));
  });
}

function renderSelectionInfo() {
  const total = state.entries.length;
  const selected = state.selected.size;
  dom.selectionInfo.textContent = selected ? `已选 ${selected} 项 / 共 ${total} 项` : total ? `共 ${total} 项` : '';
  dom.checkAll.checked = selected > 0 && selected === total;
  dom.checkAll.indeterminate = selected > 0 && selected < total;
  dom.deleteSelected.disabled = selected === 0;
  dom.downloadSelected.disabled = selected === 0;
}

function updateStatusRight() {
  const last = state.log[0];
  const parts = [];
  if (state.connected && state.currentUrl) {
    try {
      parts.push(decodeURIComponent(new URL(state.currentUrl).pathname));
    } catch {
      parts.push(state.currentUrl);
    }
  }
  if (last) parts.push(`最近一次：${last.method} ${last.error ? 'ERR' : last.status} · ${last.elapsedMs}ms`);
  dom.statusRight.textContent = parts.join('　|　');
  dom.statusLeft.textContent = state.connected
    ? `${state.auth.mode === 'none' ? '匿名' : state.auth.username || '匿名'} @ ${state.baseUrl}`
    : '就绪';
}

/* ------------------------------------------------------------------ */
/* 表格交互                                                            */
/* ------------------------------------------------------------------ */

dom.tbody.addEventListener('click', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  const entry = state.entries.find((e) => e.url === row.dataset.url);
  if (!entry) return;

  if (event.target.matches('input[type=checkbox]')) {
    if (event.target.checked) state.selected.add(entry.url);
    else state.selected.delete(entry.url);
    row.classList.toggle('selected', event.target.checked);
    renderSelectionInfo();
    return;
  }

  if (event.target.matches('.name-link')) {
    event.preventDefault();
    openEntry(entry);
    return;
  }

  const action = event.target.closest('button[data-action]');
  if (!action) return;
  runAction(action.dataset.action, entry);
});

dom.tbody.addEventListener('dblclick', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  const entry = state.entries.find((e) => e.url === row.dataset.url);
  if (entry) openEntry(entry);
});

function openEntry(entry) {
  if (entry.isCollection) navigate(entry.url);
  else previewEntry(entry);
}

for (const th of document.querySelectorAll('th.sortable')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    for (const other of document.querySelectorAll('th.sortable')) other.classList.remove('asc', 'desc');
    th.classList.add(state.sort.dir === 1 ? 'asc' : 'desc');
    render();
  });
}

dom.checkAll.addEventListener('change', () => {
  const list = visibleEntries();
  if (dom.checkAll.checked) for (const e of list) state.selected.add(e.url);
  else state.selected.clear();
  render();
});

dom.filter.addEventListener('input', () => {
  state.filter = dom.filter.value;
  render();
});

dom.selectAll.addEventListener('click', () => {
  const list = visibleEntries();
  const allSelected = list.length > 0 && list.every((e) => state.selected.has(e.url));
  if (allSelected) state.selected.clear();
  else for (const e of list) state.selected.add(e.url);
  render();
});

dom.up.addEventListener('click', () => {
  if (!state.currentUrl) return;
  if (normalizeUrlKey(state.currentUrl) === normalizeUrlKey(state.baseUrl)) {
    toast('已经是根目录了');
    return;
  }
  navigate(parentUrl(state.currentUrl));
});

dom.refresh.addEventListener('click', () => {
  if (state.currentUrl) navigate(state.currentUrl);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'F5') {
    event.preventDefault();
    if (state.currentUrl) navigate(state.currentUrl);
  }
  if (event.key === 'Escape' && dom.rawDialog.open) dom.rawDialog.close();
});

/* ------------------------------------------------------------------ */
/* 具体操作                                                            */
/* ------------------------------------------------------------------ */

async function runAction(action, entry) {
  try {
    switch (action) {
      case 'open':
        return openEntry(entry);
      case 'download':
        return downloadEntry(entry);
      case 'rename':
        return renameEntry(entry);
      case 'move':
        return moveEntry(entry, 'MOVE');
      case 'copy':
        return moveEntry(entry, 'COPY');
      case 'props':
        return showEntryProps(entry);
      case 'delete':
        return deleteEntries([entry]);
      default:
        return undefined;
    }
  } catch (err) {
    toast(err.message, 'error');
    setStatus(err.message, 'error');
    return undefined;
  }
}

function collectionExistsError(result) {
  return result.status === 405 || result.status === 301 || result.status === 409;
}

async function ensureCollections(relativeDir) {
  if (!relativeDir) return true;
  const segments = relativeDir.split('/').filter(Boolean);
  let current = state.baseUrl;
  for (const segment of segments) {
    current = joinUrl(current, segment);
    const result = await request({ method: 'MKCOL', url: ensureTrailingSlash(current), auth: state.auth });
    if (!(result.status >= 200 && result.status < 300) && !collectionExistsError(result)) {
      throw new Error(`创建目录 ${segment} 失败：${result.status} ${result.statusText}`);
    }
  }
  return true;
}

async function mkcol() {
  if (!state.connected) return toast('请先连接服务器', 'error');
  const name = await askText({
    title: '新建文件夹',
    desc: `将在当前目录创建集合：${decodeURIComponent(new URL(state.currentUrl).pathname)}`,
    placeholder: '文件夹名称',
  });
  if (!name) return;
  const url = ensureTrailingSlash(joinUrl(state.currentUrl, name.trim()));
  const result = await request({ method: 'MKCOL', url, auth: state.auth });
  if (result.status >= 200 && result.status < 300) {
    toast(`已创建 ${name}`, 'ok');
    await navigate(state.currentUrl, { quiet: true });
  } else {
    toast(`创建失败：${result.status} ${result.statusText}${result.statusHint ? `（${result.statusHint}）` : ''}`, 'error');
  }
}

async function deleteEntries(entries, { skipConfirm = false } = {}) {
  if (!entries.length) return;
  const names = entries.map((e) => e.name).join('、');
  if (!skipConfirm) {
    const ok = await askConfirm({
      title: `删除 ${entries.length} 项？`,
      desc: `将向服务器发送 DELETE：${names}${entries.some((e) => e.isCollection) ? '（集合会被递归删除）' : ''}`,
      okLabel: '删除',
    });
    if (!ok) return;
  }

  let failed = 0;
  for (const entry of entries) {
    const result = await request({ method: 'DELETE', url: entry.url, auth: state.auth });
    if (!(result.status >= 200 && result.status < 300)) {
      failed++;
      setStatus(`删除 ${entry.name} 失败：${result.status} ${result.statusText}`, 'error');
    }
  }
  if (failed) toast(`${failed} 项删除失败，详见状态栏`, 'error');
  else toast(`已删除 ${entries.length} 项`, 'ok');
  state.selected.clear();
  if (state.currentUrl) await navigate(state.currentUrl, { quiet: true });
}

async function renameEntry(entry) {
  const name = await askText({
    title: '重命名',
    desc: `将发送 MOVE 请求（原路径：${decodeURIComponent(new URL(entry.url).pathname)}）`,
    value: entry.name,
    placeholder: '新名称',
  });
  if (!name || name === entry.name) return;
  const destination = joinUrl(parentUrl(entry.url), name.trim());
  const result = await request({
    method: 'MOVE',
    url: entry.url,
    headers: { Destination: destination, Overwrite: 'F' },
    auth: state.auth,
  });
  if (result.status >= 200 && result.status < 300) {
    toast(`已重命名为 ${name}`, 'ok');
    await navigate(state.currentUrl, { quiet: true });
  } else {
    toast(`重命名失败：${result.status} ${result.statusText}${result.statusHint ? `（${result.statusHint}）` : ''}`, 'error');
  }
}

async function moveEntry(entry, method) {
  const label = method === 'MOVE' ? '移动' : '复制';
  const target = await askText({
    title: `${label}到…`,
    desc: `目标可写相对路径（如 backup/2025/），也可写完整 URL。MOVE/COPY 的 Destination 头就是它。`,
    value: '',
    placeholder: 'backup/',
  });
  if (!target) return;
  let destination;
  const trimmed = target.trim();
  try {
    destination = /^https?:\/\//i.test(trimmed) ? trimmed : new URL(trimmed.replace(/^\.?\//, ''), ensureTrailingSlash(state.currentUrl)).href;
  } catch {
    return toast('目标路径不合法', 'error');
  }
  if (state.baseUrl && !isUnder(destination, state.baseUrl)) {
    const ok = await askConfirm({
      title: '目标位于当前根目录之外',
      desc: `${destination}\n确认继续？`,
      okLabel: '继续',
    });
    if (!ok) return;
  }
  const result = await request({
    method,
    url: entry.url,
    headers: { Destination: destination, Overwrite: 'F' },
    auth: state.auth,
  });
  if (result.status >= 200 && result.status < 300) {
    toast(`${label}完成`, 'ok');
    await navigate(state.currentUrl, { quiet: true });
  } else {
    toast(`${label}失败：${result.status} ${result.statusText}${result.statusHint ? `（${result.statusHint}）` : ''}`, 'error');
  }
}

/** 当前连接可用的 Basic 认证头（用于浏览器下载器） */
function basicAuthHeaderValue() {
  const { mode, username, password } = state.auth;
  if (!username || mode === 'none' || mode === 'digest') return null;
  return buildBasicAuthorization(username, password);
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadEntry(entry) {
  if (entry.isCollection) return toast('集合需要先打包，暂不支持整目录下载', 'error');
  const filename = sanitizeFilename(entry.name);

  // 大文件走浏览器下载器：流式落盘，不占内存（Digest 认证无法预生成头，只能走内存方式）
  const authHeader = basicAuthHeaderValue();
  if ((entry.size || 0) > BROWSER_DOWNLOAD_THRESHOLD && (authHeader || !state.auth.username)) {
    const result = await send({
      type: 'DAV_DOWNLOAD',
      url: entry.url,
      filename,
      authHeader,
    });
    if (result.ok) {
      toast(`已交给浏览器下载：${filename}`, 'ok');
    } else {
      toast(result.error, 'error');
    }
    return;
  }

  if ((entry.size || 0) > 512 * 1024 * 1024 && state.auth.mode === 'digest') {
    return toast('该文件超过 512 MB，且当前使用 Digest 认证，浏览器下载器无法携带摘要凭据。请改用 Basic 认证或命令行工具。', 'error');
  }

  const task = addQueueTask(`下载 ${entry.name}`);
  const result = await request({
    method: 'GET',
    url: entry.url,
    auth: state.auth,
    wantBase64: true,
    maxBytes: 1024 * 1024 * 1024,
    timeoutMs: 600000,
  });
  if (result.error || !(result.status >= 200 && result.status < 300)) {
    finishQueueTask(task, 'fail', result.error || `HTTP ${result.status}`);
    return toast(`下载失败：${result.error || `${result.status} ${result.statusText}`}`, 'error');
  }
  if (!result.bodyBase64) {
    finishQueueTask(task, 'fail', '正文为空或超过上限');
    return toast('下载失败：响应正文为空或超过大小上限', 'error');
  }
  const blob = base64ToBlob(result.bodyBase64, entry.contentType || guessContentType(entry.name));
  triggerBlobDownload(blob, filename);
  finishQueueTask(task, 'done', formatBytes(blob.size));
  toast(`已下载 ${filename}（${formatBytes(blob.size)}）`, 'ok');
}

async function downloadSelected() {
  const entries = state.entries.filter((e) => state.selected.has(e.url) && !e.isCollection);
  if (!entries.length) return toast('没有选中可下载的文件', 'error');
  for (const entry of entries) await downloadEntry(entry);
}

/* --------------------------- 上传 --------------------------- */

function addQueueTask(label) {
  const id = `task-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const el = document.createElement('div');
  el.className = 'queue-item';
  el.id = id;
  el.innerHTML = `<span class="label">${esc(label)}</span><span class="bar"><i></i></span><span class="state">进行中</span>`;
  dom.queue.appendChild(el);
  return { id, el };
}

function finishQueueTask(task, status, message = '') {
  if (!task || !task.el) return;
  task.el.classList.remove('done', 'fail');
  task.el.classList.add(status === 'done' ? 'done' : 'fail');
  task.el.querySelector('.state').textContent = message || (status === 'done' ? '完成' : '失败');
  setTimeout(() => task.el.remove(), status === 'done' ? 4000 : 12000);
}

async function uploadFiles(files) {
  if (!state.connected) return toast('请先连接服务器', 'error');
  if (!files.length) return;
  for (const file of files) {
    await uploadOne(file);
  }
  await navigate(state.currentUrl, { quiet: true });
}

async function uploadOne(file) {
  const relativePath = file.webkitRelativePath || '';
  const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
  const name = relativePath ? relativePath.split('/').pop() : file.name;

  const task = addQueueTask(`上传 ${relativePath || name}（${formatBytes(file.size)}）`);
  try {
    if (dirPart) await ensureCollections(dirPart);
    const targetDir = dirPart ? ensureTrailingSlash(new URL(dirPart.split('/').map(encodeURIComponent).join('/') + '/', ensureTrailingSlash(state.currentUrl)).href) : state.currentUrl;
    const url = joinUrl(targetDir, name);
    const buffer = await file.arrayBuffer();
    const result = await request({
      method: 'PUT',
      url,
      headers: { 'Content-Type': file.type || guessContentType(name) },
      bodyBase64: arrayBufferToBase64(buffer),
      auth: state.auth,
      timeoutMs: 600000,
    });
    if (result.error || !(result.status >= 200 && result.status < 300)) {
      finishQueueTask(task, 'fail', result.error || `HTTP ${result.status}`);
      toast(`上传 ${name} 失败：${result.error || `${result.status} ${result.statusText}`}`, 'error');
      return false;
    }
    finishQueueTask(task, 'done', '已完成');
    return true;
  } catch (err) {
    finishQueueTask(task, 'fail', err.message);
    toast(`上传 ${name} 失败：${err.message}`, 'error');
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 媒体预览：分块下载 + 播放器                                         */
/* ------------------------------------------------------------------ */

/**
 * 分块下载（用 Range 请求把文件读成 Blob）。
 *
 * 具体逻辑在 lib/blob-fetch.js —— 那边能在 Node 里单测；
 * 这里只负责把扩展的 request()（走 Service Worker）与当前认证注入进去。
 */
function fetchFileAsBlob(url, options = {}) {
  return fetchAsBlob({ url, request, auth: state.auth, chunkSize: FETCH_CHUNK_SIZE, ...options });
}

/** 当前正在预览的媒体会话 */
let mediaSession = null;

/**
 * 全局共享一个 AudioContext。
 * 早先每次都随会话新建，结果 MIDI 会话拿到的是 null，
 * 内置合成器根本没建起来（播放没有声音）。浏览器对上下文数量也有限制，
 * 全应用共用一个更稳妥。
 */
let sharedAudioContext = null;

function getAudioContext() {
  if (sharedAudioContext) return sharedAudioContext;
  try {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null;
    sharedAudioContext = Ctor ? new Ctor() : null;
  } catch {
    sharedAudioContext = null;
  }
  return sharedAudioContext;
}

function closeMediaSession() {
  if (!mediaSession) return;
  try {
    mediaSession.ui?.dispose();
    mediaSession.backend?.dispose();
  } catch {
    /* 忽略清理异常 */
  }
  mediaSession = null;
}

function audioPlaylist() {
  return state.entries
    .filter((entry) => !entry.isCollection && (fileKind(entry.name) === 'audio' || MIDI_EXTENSIONS.includes(extensionOf(entry.name))))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
}

/** 打开预览弹窗，播放上一首 / 下一首 */
function playSibling(direction) {
  if (!mediaSession) return false;
  const list = mediaSession.playlist;
  if (list.length < 2) return false;
  const next = (mediaSession.index + direction + list.length) % list.length;
  openMediaEntry(list[next], { playlist: list, index: next });
  return true;
}

function openMediaEntry(entry, { playlist = null, index = 0 } = {}) {
  if (mediaSession && mediaSession.backend) {
    // 复用同一个弹窗，只换内容（避免闪一下）
    return loadIntoSession(entry, playlist, index);
  }
  return previewEntry(entry);
}

/** 只解析标签需要的头部字节，MP4 例外（moov 可能在文件尾部） */
async function analyzeAudio(blob, entry) {
  const headSize = Math.min(blob.size, 8 * 1024 * 1024);
  const head = new Uint8Array(await blob.slice(0, headSize).arrayBuffer());
  let meta = readAudioMetadata(head, { name: entry.name, mimeType: entry.contentType });

  const isMp4 = ['ftyp', 'moov', 'free', 'mdat'].includes(String.fromCharCode(...head.subarray(4, 8)));
  const empty = !meta.pictures.length && !Object.keys(meta.tags).length;
  if (isMp4 && empty && blob.size > head.length) {
    meta = readAudioMetadata(new Uint8Array(await blob.arrayBuffer()), { name: entry.name, mimeType: entry.contentType });
  }
  return meta;
}

async function loadIntoSession(entry, playlist, index) {
  const session = mediaSession;
  const isMidi = MIDI_EXTENSIONS.includes(extensionOf(entry.name));

  dom.previewTitle.textContent = `${entry.name} · ${formatBytes(entry.size)}${playlist && playlist.length > 1 ? ` · ${index + 1}/${playlist.length}` : ''}`;
  session.playlist = playlist || audioPlaylist();
  session.index = playlist ? index : Math.max(0, session.playlist.findIndex((item) => item.url === entry.url));
  session.entry = entry;

  setStatus(`正在读取 ${entry.name} …`);
  try {
    const blob = await fetchFileAsBlob(entry.url, {
      onProgress: (got, total) => setStatus(`正在读取 ${entry.name} … ${formatBytes(got)}${total ? ` / ${formatBytes(total)}` : ''}`),
    });

    session.ui?.dispose();
    session.backend?.dispose();
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);

    if (isMidi) {
      const backend = new SmfBackend({
        audioContext: getAudioContext(),
        midiBridge: getMidiBridge(),
        // 内置合成器是否发声由用户开关决定（关掉后只送给外部 MIDI 输出设备）
        useSynth: state.playerSettings.synthEnabled !== false,
      });
      const smf = backend.load(new Uint8Array(await blob.arrayBuffer()), { name: entry.name });
      session.backend = backend;
      const ui = new PlayerUI(backend, {
        container: session.container,
        name: entry.name,
        metadata: {
          format: `midi (format ${smf.format})`,
          tags: { title: smf.title || entry.name },
          allTags: {
            轨道数: smf.trackCount,
            音符数: smf.noteCount,
            '每四分音符 tick': smf.division,
            使用通道: smf.channels.map((c) => c + 1).join(', '),
            速度: `${Math.round(60000000 / smf.tempoMap[0].usPerQuarter)} BPM`,
            轨道: smf.tracks.map((t) => t.name).filter(Boolean).join(' / '),
          },
          pictures: [],
          replayGain: { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null },
          audio: { duration: smf.durationMs / 1000 },
          warnings: smf.warnings,
        },
        midiBridge: getMidiBridge(),
        smfPlayer: backend.player,
        sendClock: state.midi.settings?.sendClock === true,
        onPrevNext: (direction) => playSibling(direction),
        onError: (message) => setStatus(message, 'error'),
        onClockChange: () => persistMidiSettings().catch(() => {}),
        onSynthChange: (enabled) => {
          state.playerSettings.synthEnabled = enabled;
          persistMidiSettings().catch(() => {});
          setStatus(`内置合成器已${enabled ? '打开' : '关闭'}${enabled ? '' : '，MIDI 消息仍会送给选中的输出设备'}`, 'ok');
        },
      });
      session.ui = ui;
      setStatus(`MIDI 已就绪：${smf.trackCount} 轨 · ${smf.noteCount} 个音符 · 内置合成器${backend.synthEnabled ? '开' : '关'}`, 'ok');
      return true;
    }

    session.objectUrl = URL.createObjectURL(blob);
    const meta = await analyzeAudio(blob, entry);
    const backend = new AudioPlayer({ audioContext: getAudioContext() });
    backend.load(session.objectUrl, { name: entry.name });
    backend.setReplayGain(meta.replayGain);
    backend.setReplayGainMode(state.playerSettings.replayGainMode);
    backend.setPreAmpDb(state.playerSettings.preAmpDb);
    backend.setVolume(state.playerSettings.volume);
    session.backend = backend;
    session.metadata = meta;

    session.ui = new PlayerUI(backend, {
      container: session.container,
      name: entry.name,
      metadata: meta,
      midiBridge: getMidiBridge(),
      sendClock: state.midi.settings?.sendClock === true,
      onPrevNext: (direction) => playSibling(direction),
      onError: (message) => setStatus(message, 'error'),
      onClockChange: () => persistMidiSettings().catch(() => {}),
      onState: (playerState) => {
        state.playerSettings.volume = playerState.volume;
        state.playerSettings.replayGainMode = playerState.replayGainMode;
        syncAudioMidiClock(playerState.playing);
      },
      onOutputChange: () => {
        syncAudioMidiClock(Boolean(mediaSession?.backend?.getState?.().playing));
        persistMidiSettings().catch(() => {});
      },
    });

    const rgText = describeReplayGain(meta.replayGain);
    setStatus(
      `已就绪：${meta.format.toUpperCase()}${meta.tags.title ? ` · ${meta.tags.title}` : ''}${
        meta.pictures.length ? ` · 封面 ${meta.pictures.length} 张` : ' · 无封面'
      } · ReplayGain ${rgText}`,
      'ok',
    );
    return true;
  } catch (err) {
    setStatus(`预览失败：${err.message}`, 'error');
    toast(`预览失败：${err.message}`, 'error');
    return false;
  }
}

/** MIDI 桥（全局一个，按需初始化） */
function getMidiBridge() {
  if (state.midi.bridge) return state.midi.bridge;
  state.midi.bridge = new MidiBridge({
    onStatus: (status) => {
      state.midi.status = status;
      mediaSession?.ui?.renderMidi();
      persistMidiSettings();
    },
    onAction: (event) => handleMidiAction(event),
    onMessage: (message) => mediaSession?.ui?.pushMidiMonitor(message, describeMessage(message)),
  });
  return state.midi.bridge;
}

/**
 * 音频文件播放时发送 MIDI 时钟与 Start/Stop 的旧路径。
 *
 * 注意：现在 MIDI 设置面板只在 MIDI 文件预览下出现（音频下整块隐藏，
 * 见 PlayerUI.renderMidi），音频预览里的时钟复选框用户根本够不着，
 * 所以这里实际上不会再启动时钟，只保留「停掉残留时钟」的兜底。
 */
function syncAudioMidiClock(playing) {
  const bridge = state.midi.bridge;
  if (!bridge) return;
  const wantsClock = Boolean(mediaSession?.ui?.el?.midiClock?.checked);
  const running = Boolean(bridge.clock.timer);
  const hasOutput = Boolean(bridge.getOutputPort && bridge.getOutputPort());

  if (playing && wantsClock && hasOutput && !running) {
    bridge.sendTransport('start');
    bridge.startClock(state.playerSettings.bpm || 120);
  } else if (!playing && running) {
    bridge.stopClock();
    bridge.sendTransport('stop');
  }
}

/** MIDI 设备送来的动作 → 播放器操作 */
function handleMidiAction({ action, value }) {
  const session = mediaSession;
  if (!session || !session.backend) return;
  const backend = session.backend;
  // MIDI 设置面板只在 MIDI 文件预览下出现。音频预览下不接受外部设备遥控，
  // 否则会出现「界面上看不到任何 MIDI 设置、播放器却被 MIDI 键盘操作」的怪事。
  if (backend.getState?.().backend !== 'midi') return;

  switch (action) {
    case 'play-pause':
      backend.toggle();
      break;
    case 'stop':
      backend.stop();
      break;
    case 'seek-back':
      backend.seekBy(-5000);
      break;
    case 'seek-forward':
      backend.seekBy(5000);
      break;
    case 'prev':
      playSibling(-1);
      break;
    case 'next':
      playSibling(1);
      break;
    case 'loop':
      backend.setLoop(!backend.getState().loop);
      break;
    case 'mute':
      backend.setMuted(!backend.getState().muted);
      break;
    case 'volume':
      backend.setVolume(value);
      break;
    case 'rate':
      backend.setRate(0.5 + value * 1.5);
      break;
    case 'seek':
      backend.seekBy(value * 10000);
      break;
    case 'replaygain-cycle': {
      const order = ['track', 'album', 'off'];
      const next = order[(order.indexOf(state.playerSettings.replayGainMode) + 1) % order.length];
      state.playerSettings.replayGainMode = next;
      backend.setReplayGainMode?.(next);
      toast(`ReplayGain：${next === 'track' ? '音轨' : next === 'album' ? '专辑' : '关闭'}`, 'ok');
      break;
    }
    case 'learned':
      toast('MIDI 映射已更新', 'ok');
      break;
    default:
      break;
  }
  mediaSession?.ui?.renderMidi();
}

async function persistMidiSettings() {
  const status = state.midi.status;
  // 合成器开关跟 MIDI 设备无关，即使桥还没就绪也要能存下来
  const settings = { ...(state.midi.settings || {}), synthEnabled: state.playerSettings.synthEnabled !== false };
  if (status) {
    settings.inputId = status.selectedInputId;
    settings.outputId = status.selectedOutputId;
    settings.bindings = (status.bindings || []).map(({ action, label, match, continuous, relative, range }) => ({ action, label, match, continuous, relative, range }));
    // 只有 MIDI 文件的界面上才有这个勾选框。音频预览下不动这个值，
    // 否则一边听 MP3 一边被别的回调触发保存，就把用户给 MIDI 文件设的偏好抹掉了。
    if (mediaSession?.ui?.isMidiFile) {
      settings.sendClock = Boolean(dom.previewDialog.open && mediaSession.ui.el.midiClock?.checked);
    }
  }
  state.midi.settings = settings;
  await chrome.storage.local.set({ midiSettings: settings }).catch(() => {});
}

async function restoreMidiSettings() {
  const { midiSettings } = await chrome.storage.local.get('midiSettings');
  const { playerSettings } = await chrome.storage.local.get('playerSettings');
  if (playerSettings) Object.assign(state.playerSettings, playerSettings);
  if (!midiSettings) return;
  state.midi.settings = midiSettings;
  if (midiSettings.synthEnabled !== undefined) state.playerSettings.synthEnabled = Boolean(midiSettings.synthEnabled);
  const bridge = getMidiBridge();
  if (midiSettings.bindings?.length) bridge.bindings = midiSettings.bindings;
}

/* ------------------------------------------------------------------ */
/* 原始报文弹窗                                                        */
/* ------------------------------------------------------------------ */

let rawSections = [];
let rawActiveKey = null;

function showRawDialog({ method, status, statusText, url, meta, sections }) {
  rawSections = sections.filter((s) => s && s.text != null);
  rawActiveKey = rawSections.length ? rawSections[0].key : null;

  dom.rawMethod.textContent = method || '';
  dom.rawStatus.textContent = status ? `${status} ${statusText || ''}`.trim() : '';
  dom.rawStatus.className = `status-badge ${status >= 200 && status < 300 ? 'ok' : 'bad'}`;
  dom.rawUrl.textContent = url || '';
  dom.rawMeta.textContent = meta || '';

  dom.rawTabs.innerHTML = '';
  for (const section of rawSections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab ${section.key === rawActiveKey ? 'active' : ''}`;
    button.dataset.tab = section.key;
    button.textContent = section.label;
    dom.rawTabs.appendChild(button);
  }
  paintRawSection();
  if (!dom.rawDialog.open) dom.rawDialog.showModal();
}

function paintRawSection() {
  const section = rawSections.find((s) => s.key === rawActiveKey) || rawSections[0];
  dom.rawPre.textContent = section ? section.text : '';
  for (const tab of dom.rawTabs.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === rawActiveKey);
  }
}

dom.rawTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  rawActiveKey = tab.dataset.tab;
  paintRawSection();
});

dom.rawClose.addEventListener('click', () => dom.rawDialog.close());

dom.rawCopy.addEventListener('click', async () => {
  const section = rawSections.find((s) => s.key === rawActiveKey);
  try {
    await navigator.clipboard.writeText(section ? section.text : '');
    toast('已复制到剪贴板', 'ok');
  } catch (err) {
    toast(`复制失败：${err.message}`, 'error');
  }
});

function showLogDialog(entry) {
  const parsed =
    entry.method === 'PROPFIND' && entry.bodyText ? parseMultistatus(entry.bodyText, entry.url) : null;
  showRawDialog({
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    url: entry.url,
    meta: `${entry.time.toLocaleTimeString()} · 耗时 ${entry.elapsedMs}ms${
      entry.authUsed && entry.authUsed !== 'none' ? ` · 认证 ${entry.authUsed}` : ''
    }${entry.authChallenge ? ` · 挑战 ${entry.authChallenge}` : ''}${
      METHOD_HINTS[entry.method] ? ` · ${METHOD_HINTS[entry.method]}` : ''
    }`,
    sections: [
      { key: 'request', label: '原始请求', text: entry.requestRaw },
      { key: 'response', label: '原始响应', text: entry.responseRaw },
      {
        key: 'body',
        label: '响应正文',
        text: entry.bodyOmitted
          ? '<正文超过大小上限，未读取>'
          : entry.bodyText != null
            ? entry.bodyText
            : entry.bodyBytes
              ? `<二进制正文 ${formatBytes(entry.bodyBytes)}（未在日志中保存内容，避免占用内存）>`
              : '<空>',
      },
      {
        key: 'parsed',
        label: '解析结果',
        text: parsed
          ? JSON.stringify(
              {
                请求: entry.url,
                状态: `${entry.status} ${entry.statusText}`,
                条目数: parsed.entries.length,
                子项: parsed.entries.map((e) => ({
                  名称: e.name,
                  类型: e.isCollection ? '集合' : '文件',
                  大小: e.size,
                  修改时间: e.lastModified,
                  内容类型: e.contentType,
                  URL: e.url,
                })),
              },
              null,
              2,
            )
          : `原始请求体会在「原始请求」标签页中显示。\n\n请求头（解析后）：\n${JSON.stringify(
              Object.fromEntries(
                entry.requestRaw
                  .split('\r\n')
                  .slice(1)
                  .filter((line) => line.includes(': '))
                  .map((line) => {
                    const idx = line.indexOf(': ');
                    return [line.slice(0, idx), line.slice(idx + 2)];
                  }),
              ),
              null,
              2,
            )}`,
      },
    ],
  });
}

function showEntryProps(entry) {
  const propsText = Object.entries(entry.rawProps || {})
    .map(([name, xml]) => `<!-- ${name} -->\n${xml}`)
    .join('\n\n');
  showRawDialog({
    method: 'PROPFIND',
    status: entry.status,
    statusText: entry.statusOk ? 'OK' : '',
    url: entry.url,
    meta: '这是服务器针对该条目返回的原始 <D:response> 节点',
    sections: [
      {
        key: 'props',
        label: '解析后的属性',
        text: JSON.stringify(
          {
            名称: entry.name,
            类型: entry.isCollection ? '集合（文件夹）' : '文件',
            大小: entry.size,
            修改时间: entry.lastModified,
            创建时间: entry.created,
            内容类型: entry.contentType,
            ETag: entry.etag,
            配额可用: entry.quotaAvailable,
            配额已用: entry.quotaUsed,
            属性状态码: entry.status,
          },
          null,
          2,
        ),
      },
      { key: 'xml', label: '原始 XML 片段', text: entry.rawXml },
      { key: 'propXml', label: '各属性原始 XML', text: propsText || '<无属性>' },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 输入 / 确认弹窗                                                     */
/* ------------------------------------------------------------------ */

let promptResolve = null;

function askText({ title, desc = '', value = '', placeholder = '', okLabel = '确定' }) {
  dom.promptTitle.textContent = title;
  dom.promptDesc.textContent = desc;
  dom.promptDesc.style.display = desc ? '' : 'none';
  dom.promptInput.value = value;
  dom.promptInput.placeholder = placeholder;
  dom.promptInput.type = 'text';
  dom.promptInput.style.display = '';
  dom.promptOk.textContent = okLabel;
  dom.promptDialog.showModal();
  setTimeout(() => dom.promptInput.focus(), 30);
  return new Promise((resolve) => {
    promptResolve = resolve;
  });
}

function askConfirm({ title, desc = '', okLabel = '确定' }) {
  dom.promptTitle.textContent = title;
  dom.promptDesc.textContent = desc;
  dom.promptDesc.style.display = desc ? '' : 'none';
  dom.promptInput.style.display = 'none';
  dom.promptOk.textContent = okLabel;
  dom.promptDialog.showModal();
  return new Promise((resolve) => {
    promptResolve = (value) => resolve(value !== null);
  });
}

function closePrompt(value) {
  dom.promptDialog.close();
  if (promptResolve) {
    const resolve = promptResolve;
    promptResolve = null;
    resolve(value);
  }
}

dom.promptOk.addEventListener('click', () => {
  const value = dom.promptInput.style.display === 'none' ? '' : dom.promptInput.value.trim();
  closePrompt(value === '' && dom.promptInput.style.display !== 'none' ? null : value || 'ok');
});

dom.promptCancel.addEventListener('click', () => closePrompt(null));
dom.promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    dom.promptOk.click();
  }
});
dom.promptDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closePrompt(null);
});

/* ------------------------------------------------------------------ */
/* 文件预览                                                            */
/* ------------------------------------------------------------------ */

async function openMediaPreview(entry) {
  const playlist = audioPlaylist();
  const index = Math.max(0, playlist.findIndex((item) => item.url === entry.url));

  closeMediaSession();
  dom.previewTitle.textContent = `${entry.name} · ${formatBytes(entry.size)}`;
  dom.previewBody.innerHTML = '<div class="player-loading muted">正在读取文件…</div>';
  if (!dom.previewDialog.open) dom.previewDialog.showModal();

  mediaSession = {
    container: dom.previewBody,
    objectUrl: null,
    audioContext: null,
    playlist,
    index,
    entry,
  };

  // 先把 MIDI 设置准备好。
  //
  // 注意这里**不**调用 bridge.init()：navigator.requestMIDIAccess 会触发浏览器的
  // MIDI 权限提示（Chrome 124+ / Edge 同源实现），即使已经授权过，控制台也会留一条
  // 「Web MIDI 将请求使用权限」的警告。预览一个音频 / MIDI 文件并不代表用户要用 MIDI 硬件，
  // 所以权限申请推迟到用户明确操作时（展开 MIDI 面板、点「启用 Web MIDI」、
  // 勾选发送时钟、或点某个映射按钮去学），见 PlayerUI.enableMidi()。
  // 内置合成器与 MIDI 文件播放完全不需要 Web MIDI，因此不受影响。
  if (!state.midi.restored) {
    state.midi.restored = true;
    await restoreMidiSettings().catch(() => {});
  }
  const bridge = getMidiBridge();
  // 上次选过的设备先记下来，等用户启用 MIDI 后会自动恢复选择
  if (state.midi.settings?.inputId) bridge.selectInput(state.midi.settings.inputId);
  if (state.midi.settings?.outputId) bridge.selectOutput(state.midi.settings.outputId);

  return loadIntoSession(entry, playlist, index);
}

async function previewEntry(entry) {
  const kind = fileKind(entry.name, false, entry.contentType);
  const extension = extensionOf(entry.name);

  // 音频与 MIDI 走专门的播放器
  if (kind === 'audio' || AUDIO_EXTENSIONS.includes(extension) || MIDI_EXTENSIONS.includes(extension)) {
    return openMediaPreview(entry);
  }

  if (!canPreview(kind)) {
    return toast(`${kindLabel(kind)}暂不支持预览，请下载后查看`, 'error');
  }
  const binary = !['text', 'code'].includes(kind);
  setStatus(`正在读取 ${entry.name} …`);
  const result = await request({
    method: 'GET',
    url: entry.url,
    auth: state.auth,
    wantBase64: binary,
    maxBytes: 64 * 1024 * 1024,
    timeoutMs: 180000,
  });
  if (!(result.status >= 200 && result.status < 300)) {
    setStatus(`预览失败：${result.error || `${result.status} ${result.statusText}`}`, 'error');
    return;
  }
  setStatus('');

  dom.previewTitle.textContent = `${entry.name} · ${formatBytes(entry.size)}`;
  dom.previewBody.innerHTML = '';

  if (kind === 'text' || kind === 'code') {
    const pre = document.createElement('pre');
    pre.textContent = result.bodyText ?? '<响应正文不是文本>';
    dom.previewBody.appendChild(pre);
  } else {
    const blob = base64ToBlob(result.bodyBase64, entry.contentType || guessContentType(entry.name));
    const url = URL.createObjectURL(blob);
    let node;
    if (kind === 'image') {
      node = document.createElement('img');
      node.src = url;
    } else if (kind === 'video') {
      node = document.createElement('video');
      node.src = url;
      node.controls = true;
    } else if (kind === 'audio') {
      node = document.createElement('audio');
      node.src = url;
      node.controls = true;
    } else {
      node = document.createElement('iframe');
      node.src = url;
    }
    dom.previewBody.appendChild(node);
    dom.previewDialog.addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
  }
  if (!dom.previewDialog.open) dom.previewDialog.showModal();
}

dom.previewClose.addEventListener('click', () => dom.previewDialog.close());

// 关掉弹窗必须停掉声音、断开 MIDI 时钟，否则会一直响
dom.previewDialog.addEventListener('close', () => {
  const bridge = state.midi.bridge;
  if (bridge && bridge.clock.timer) {
    bridge.stopClock();
    bridge.sendTransport('stop');
  }
  closeMediaSession();
  persistMidiSettings().catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 已保存的连接                                                        */
/* ------------------------------------------------------------------ */

async function loadConnections() {
  const response = await send({ type: 'GET_CONNECTIONS' });
  state.connections = response.connections || [];
  renderConnections();
}

function renderConnections() {
  dom.connectionList.innerHTML = '';
  if (!state.connections.length) {
    dom.connectionList.innerHTML = '<li class="muted" style="padding:6px 8px">还没有保存的连接。填写地址后点「保存」。</li>';
    return;
  }
  for (const conn of state.connections) {
    const li = document.createElement('li');
    li.className = 'conn-item';
    li.innerHTML = `<span class="grow">
        <div>${esc(conn.url)}</div>
        <div class="meta">${esc(conn.username || '匿名')} · ${esc(conn.authMode || 'auto')}</div>
      </span>
      <button class="mini" data-action="delete" title="删除这条记录">✕</button>`;
    li.addEventListener('click', (event) => {
      if (event.target.closest('[data-action=delete]')) {
        event.stopPropagation();
        send({ type: 'DELETE_CONNECTION', url: conn.url }).then((res) => {
          state.connections = res.connections || [];
          renderConnections();
        });
        return;
      }
      dom.url.value = conn.url;
      dom.user.value = conn.username || '';
      dom.pass.value = conn.password || '';
      dom.auth.value = conn.authMode || 'auto';
      ensureHostPermission(conn.url, { interactive: true }).then(() =>
        connect({ url: conn.url, username: conn.username, password: conn.password, authMode: conn.authMode }),
      );
    });
    dom.connectionList.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // 必须赶在任何 await 之前申请，否则用户手势会被消耗掉
  await ensureHostPermission(dom.url.value, { interactive: true });
  await connect({
    url: dom.url.value,
    username: dom.user.value,
    password: dom.pass.value,
    authMode: dom.auth.value,
  });
});

dom.saveBtn.addEventListener('click', async () => {
  if (!dom.url.value.trim()) return toast('请先填写服务器地址', 'error');
  let url;
  try {
    url = ensureTrailingSlash(normalizeServerUrl(dom.url.value));
  } catch (err) {
    return toast(err.message, 'error');
  }
  const response = await send({
    type: 'SAVE_CONNECTION',
    connection: {
      url,
      username: dom.user.value,
      password: dom.pass.value,
      authMode: dom.auth.value,
    },
  });
  state.connections = response.connections || [];
  renderConnections();
  chrome.storage.local.set({
    lastConnection: { url, username: dom.user.value, password: dom.pass.value, authMode: dom.auth.value },
  });
  toast('已保存连接（凭据存放在浏览器扩展存储中）', 'ok');
});

/**
 * 一键诊断：把「权限 / 连通性 / 认证 / 服务器能力」四件事一次问清楚。
 * 这类 CORS 报错的根因，九成能在第一项里看出来。
 */
async function runDiagnostics() {
  const url = state.currentUrl || state.baseUrl || (dom.url.value.trim() ? ensureTrailingSlash(normalizeServerUrl(dom.url.value)) : '');
  if (!url) return toast('先填一个服务器地址吧', 'error');

  let pattern = '';
  try {
    pattern = originPattern(url);
  } catch {
    pattern = '（地址不合法）';
  }

  const conclusions = [];
  const lines = [];
  lines.push(`扩展名称：${state.extensionName || 'WebDAV 文件管理器'}`);
  lines.push(`扩展 ID：${state.extensionId || '（未知）'}`);
  lines.push(`扩展版本：${state.extensionVersion || '（未知）'}`);
  lines.push(`目标地址：${url}`);
  lines.push(`权限范围：${pattern}`);
  lines.push(`认证方式：${state.auth.mode}${state.auth.username ? `（用户 ${state.auth.username}）` : '（匿名）'}`);
  lines.push('');

  // 1. 访问权限
  let granted = null;
  let info = null;
  try {
    info = await send({ type: 'CHECK_PERMISSIONS', origins: [pattern] });
    rememberExtensionInfo(info);
    granted = Boolean(info.granted && info.granted[pattern]);
  } catch (err) {
    lines.push(`1) 访问权限：查询失败（${err.message}）`);
  }
  if (granted !== null) {
    lines.push(`1) 访问权限：${granted ? '✔ 已授予' : '✗ 未授予'}`);
    if (granted) {
      conclusions.push('权限正常：扩展可以绕过 CORS 直接访问该服务器。');
    } else {
      conclusions.push(
        '权限缺失，这就是 CORS 预检失败的根因：浏览器把扩展的 host 权限收回了（Edge 的「站点访问权限」默认可能是「单击时」）。',
      );
      conclusions.push('修法一：edge://extensions → 本扩展 →「详细信息」→「站点访问权限」→ 改成「在所有网站上」。');
      conclusions.push('修法二：回到文件管理器点「申请访问权限」按钮当场授权。');
    }
    lines.push(`   扩展持有的权限范围：${(info.allOrigins || []).join(', ') || '（空）'}`);
    lines.push(`   扩展 ID 就是 edge://extensions 列表里那一串字母，可用它核对是不是同一个扩展。`);
    lines.push('');
    state.permission.pattern = pattern;
    state.permission.granted = granted;
    renderPermissionBanner();
  }

  // 2. 连通性 + 认证：直接发一次 OPTIONS
  let probe = null;
  try {
    probe = await request({ method: 'OPTIONS', url, auth: state.auth, timeoutMs: 20000 });
  } catch (err) {
    lines.push(`2) OPTIONS 探测：请求异常（${err.message}）`);
  }
  if (probe) {
    if (probe.error) {
      lines.push(`2) OPTIONS 探测：✗ ${probe.error}`);
      lines.push(`   ${networkErrorHint(probe).replace(/^（|）$/g, '')}`);
      conclusions.push(`OPTIONS 没成功：${probe.error}`);
    } else {
      lines.push(`2) OPTIONS 探测：✔ HTTP ${probe.status} ${probe.statusText}（${probe.elapsedMs} ms，认证 ${probe.authUsed}）`);
      const caps = parseDavCapabilities(probe.headerMap['dav'], probe.headerMap['allow']);
      lines.push(`   DAV 级别：${caps.classes.length ? caps.classes.map((c) => `Class ${c}`).join('、') : '未声明'}`);
      lines.push(`   允许的方法：${caps.methods.join(', ') || '未声明'}`);
      if (!caps.methods.includes('PROPFIND') && caps.methods.length) {
        conclusions.push('服务器没有声明支持 PROPFIND，可能不是标准 WebDAV 服务。');
      }
      if (probe.status === 401) {
        conclusions.push('服务器要求认证（401）：检查用户名 / 密码，很多服务需要「应用专用密码」。');
      }
    }
    lines.push('');
  }

  // 3. 结论
  lines.push('── 结论 ──');
  if (!conclusions.length) conclusions.push('各项检查都正常。如果仍然有问题，请把这份报告连同「原始响应」一起提供。');
  conclusions.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  showRawDialog({
    method: '诊断',
    status: granted === false ? 0 : probe && !probe.error ? probe.status : 0,
    statusText: granted === false ? '权限缺失' : '报告',
    url,
    meta: `生成于 ${new Date().toLocaleString()}`,
    sections: [
      { key: 'report', label: '诊断报告', text: lines.join('\n') },
      { key: 'request', label: '原始请求', text: (probe && probe.raw && probe.raw.request) || '（没有发出请求）' },
      { key: 'response', label: '原始响应', text: (probe && probe.raw && probe.raw.response) || '（没有收到响应）' },
    ],
  });
  return lines.join('\n');
}

dom.diagnose.addEventListener('click', () => {
  runDiagnostics().catch((err) => toast(err.message, 'error'));
});

dom.grantPermission.addEventListener('click', async () => {
  if (!state.permission.pattern && dom.url.value.trim()) {
    state.permission.pattern = originPattern(normalizeServerUrl(dom.url.value));
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [state.permission.pattern] });
  } catch (err) {
    granted = false;
    toast(`申请失败：${err.message}`, 'error');
  }
  state.permission.granted = granted;
  renderPermissionBanner();
  if (granted) {
    toast('已获得访问权限，正在重试连接…', 'ok');
    await connect({ url: dom.url.value, username: dom.user.value, password: dom.pass.value, authMode: dom.auth.value });
  } else {
    toast('仍未获得权限：请到 edge://extensions →「站点访问权限」改为「在所有网站上」', 'error');
  }
});

dom.retryConnect.addEventListener('click', () => {
  connect({ url: dom.url.value, username: dom.user.value, password: dom.pass.value, authMode: dom.auth.value });
});

dom.permissionHelp.addEventListener('click', () => {
  showRawDialog({
    method: '说明',
    status: 0,
    statusText: '',
    url: 'edge://extensions',
    meta: '为什么会看到 CORS 预检失败',
    sections: [
      {
        key: 'help',
        label: '原因与修法',
        text: [
          '现象：控制台出现',
          "  Access to fetch at 'http://…' from origin 'chrome-extension://…' has been blocked by CORS policy:",
          "  Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present…",
          '',
          '原因：扩展本来有 host 权限，可以直接发 PROPFIND 这类跨域请求、不经过 CORS；',
          '      但浏览器把这份权限「收回」了（Edge/Chrome 的「站点访问权限」被设成「单击时」就是这种情况）。',
          '      权限一旦失效，请求就退化成普通网页的跨域请求，先发 OPTIONS 预检，',
          '      而 WebDAV 服务器基本不会返回 Access-Control-Allow-* 头，于是预检失败。',
          '',
          '修法（任选其一）：',
          '  1. 地址栏打开 edge://extensions → 找到本扩展 → 「详细信息」 →',
          '     「站点访问权限」改成「在所有网站上」。',
          '  2. 回到文件管理器，点黄色提示条上的「申请访问权限」。',
          '  3. 不需要用扩展时，也可以让服务器自己返回 CORS 头（不推荐，等于对外开放）。',
          '',
          '提示：本扩展的 ID 是按安装目录算出来的，两台电脑上装同一份代码，ID 会不一样，',
          '      核对时以 edge://extensions 里显示的那串字母为准。',
        ].join('\n'),
      },
    ],
  });
});

dom.mkcol.addEventListener('click', mkcol);
dom.refresh.addEventListener('click', () => state.currentUrl && navigate(state.currentUrl));
dom.upload.addEventListener('click', () => dom.fileInput.click());
dom.uploadDir.addEventListener('click', () => dom.dirInput.click());
dom.fileInput.addEventListener('change', async () => {
  const files = [...dom.fileInput.files];
  dom.fileInput.value = '';
  await uploadFiles(files);
});
dom.dirInput.addEventListener('change', async () => {
  const files = [...dom.dirInput.files];
  dom.dirInput.value = '';
  await uploadFiles(files);
});

dom.deleteSelected.addEventListener('click', () => {
  const entries = state.entries.filter((e) => state.selected.has(e.url));
  deleteEntries(entries);
});
dom.downloadSelected.addEventListener('click', downloadSelected);

dom.rawXml.addEventListener('click', () => {
  if (!state.lastPropfind) return toast('还没有 PROPFIND 记录', 'error');
  const { url, result, parsed } = state.lastPropfind;
  showRawDialog({
    method: 'PROPFIND',
    status: result.status,
    statusText: result.statusText,
    url,
    meta: `${parsed.entries.length} 个 <D:response> 节点 · 耗时 ${result.elapsedMs}ms`,
    sections: [
      { key: 'request', label: '原始请求', text: result.raw.request },
      { key: 'response', label: '原始响应（含 XML）', text: result.raw.response },
      { key: 'xml', label: '响应正文 XML', text: result.bodyText || '<空>' },
      {
        key: 'parsed',
        label: '解析结果',
        text: JSON.stringify(
          parsed.entries.map((e) => ({
            名称: e.name,
            集合: e.isCollection,
            大小: e.size,
            修改时间: e.lastModified,
            ETag: e.etag,
            URL: e.url,
          })),
          null,
          2,
        ),
      },
    ],
  });
});

// 拖拽上传
for (const type of ['dragenter', 'dragover']) {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('hover');
  });
}
for (const type of ['dragleave', 'drop']) {
  dom.dropzone.addEventListener(type, () => dom.dropzone.classList.remove('hover'));
}
dom.dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) await uploadFiles(files);
});

document.body.addEventListener('dragover', (event) => event.preventDefault());
document.body.addEventListener('drop', async (event) => {
  if (event.target.closest('#dropzone')) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) await uploadFiles(files);
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/** 自动连接的启动流程，测试脚本会等待这个 Promise */
const ready = (async () => {
  await loadConnections().catch(() => {});
  // 顺便把扩展 ID / 版本记下来，诊断报告和提示条都要用
  try {
    rememberExtensionInfo(await send({ type: 'CHECK_PERMISSIONS', origins: [] }));
  } catch {
    /* 忽略 */
  }
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  const name = params.get('name');

  if (name && !url) {
    document.title = `${name} · WebDAV 文件管理器`;
  }

  if (url) {
    dom.url.value = url;
    dom.user.value = params.get('user') || '';
    dom.pass.value = params.get('pass') || '';
    dom.auth.value = params.get('auth') || 'auto';
    const ok = await connect({
      url,
      username: dom.user.value,
      password: dom.pass.value,
      authMode: dom.auth.value,
    });
    return ok;
  }

  const { lastConnection } = await chrome.storage.local.get('lastConnection');
  if (lastConnection && lastConnection.url) {
    dom.url.value = lastConnection.url;
    dom.user.value = lastConnection.username || '';
    dom.pass.value = lastConnection.password || '';
    dom.auth.value = lastConnection.authMode || 'auto';
    setStatus('已载入上次使用的连接，点击「连接」继续。');
  }
  return false;
})();

window.__webdav = {
  state,
  ready,
  connect,
  navigate,
  mkcol,
  uploadFiles,
  uploadText: async (name, text, dirUrl = null) => {
    const url = joinUrl(dirUrl || state.currentUrl, name);
    const result = await request({
      method: 'PUT',
      url,
      headers: { 'Content-Type': guessContentType(name) },
      bodyBase64: arrayBufferToBase64(new TextEncoder().encode(text).buffer),
      auth: state.auth,
    });
    await navigate(state.currentUrl, { quiet: true });
    return result;
  },
  remove: deleteEntries,
  rename: renameEntry,
  move: moveEntry,
  download: downloadEntry,
  preview: previewEntry,
  entries: () => visibleEntries(),
  log: () => state.log,
  diagnose: runDiagnostics,
  previewMedia: openMediaPreview,
  mediaSession: () => mediaSession,
  midiBridge: () => getMidiBridge(),
  fetchFileAsBlob,
  checkPermission: (pattern) => send({ type: 'CHECK_PERMISSIONS', origins: [pattern] }),
  ensureHostPermission,
  refreshPermissionBanner: renderPermissionBanner,
  showRaw: showLogDialog,
  showEntryProps,
  lastPropfind: () => state.lastPropfind,
};
