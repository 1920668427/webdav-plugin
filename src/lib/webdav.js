/**
 * WebDAV 协议常量与通用工具：URL 处理、路径编码、大小/时间格式化、文件类型识别。
 */

/** 常用 WebDAV 方法说明，用于界面提示 */
export const METHOD_HINTS = {
  OPTIONS: '探测服务器能力（DAV 头 / Allow）',
  PROPFIND: '读取目录或文件的属性（返回 207 Multi-Status XML）',
  GET: '下载文件内容',
  HEAD: '仅取响应头',
  PUT: '上传或覆盖文件',
  DELETE: '删除文件或集合',
  MKCOL: '创建集合（文件夹）',
  MOVE: '重命名 / 移动',
  COPY: '复制',
  PROPPATCH: '修改属性',
  LOCK: '加锁',
  UNLOCK: '解锁',
};

/** PROPFIND 请求体：请求一组最常用的属性 */
export const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:creationdate/>
    <d:getetag/>
    <d:quota-available-bytes/>
    <d:quota-used-bytes/>
    <d:supportedlock/>
  </d:prop>
</d:propfind>`;

/** 规范化用户输入的服务器地址 */
export function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('请输入 WebDAV 服务器地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http / https 地址');
  }
  return url.href;
}

/** 保证以 / 结尾（集合 URL 的标准写法） */
export function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

/** 取父级集合 URL（总以 / 结尾） */
export function parentUrl(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  const cut = path.lastIndexOf('/');
  u.pathname = cut <= 0 ? '/' : `${path.slice(0, cut)}/`;
  u.search = '';
  u.hash = '';
  return u.href;
}

/** 取 URL 最后一段（已解码），忽略结尾斜杠 */
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/\/+$/, '').split('/');
    return safeDecodeURIComponent(segs[segs.length - 1] || '');
  } catch {
    return url;
  }
}

/** 把 href（可能是绝对路径或绝对 URL）解析成绝对 URL */
export function resolveHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** 拼接子项 URL，自动对名字做百分号编码 */
export function joinUrl(baseUrl, name) {
  const base = ensureTrailingSlash(baseUrl);
  return base + encodeURIComponent(String(name));
}

/** 当前 URL 是否位于某个根 URL 之下 */
export function isUnder(url, root) {
  const u = new URL(url);
  const r = new URL(ensureTrailingSlash(root));
  return u.origin === r.origin && u.pathname.startsWith(r.pathname);
}

/** 相对根路径，用于面包屑，例如 ['docs', '图片'] */
export function relativeSegments(url, root) {
  const u = new URL(url);
  const r = new URL(ensureTrailingSlash(root));
  if (u.origin !== r.origin || !u.pathname.startsWith(r.pathname)) return [];
  const rest = u.pathname.slice(r.pathname.length).replace(/\/+$/, '');
  if (!rest) return [];
  return rest.split('/').map(safeDecodeURIComponent);
}

export function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** HTTP 日期 / ISO 日期 → 本地可读时间 */
export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 字节数 → 人类可读 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '';
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

const EXT_KIND = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic', 'tif', 'tiff'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'dmg'],
  code: [
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'less',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift',
    'sh', 'bash', 'zsh', 'ps1', 'sql', 'yml', 'yaml', 'toml', 'ini', 'xml', 'vue', 'svelte',
  ],
  doc: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  sheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
  slide: ['ppt', 'pptx', 'odp', 'key'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'markdown', 'log', 'conf', 'cfg', 'env', 'nfo', 'srt', 'ass', 'vtt'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
  disk: ['exe', 'msi', 'apk', 'ipa', 'deb', 'rpm', 'pkg', 'appimage', 'bin'],
};

const KIND_ICON = {
  folder: '📁',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  archive: '🗜️',
  code: '⌨️',
  doc: '📘',
  sheet: '📊',
  slide: '📽️',
  pdf: '📕',
  text: '📄',
  font: '🔤',
  disk: '💿',
  file: '📄',
};

const KIND_LABEL = {
  folder: '文件夹',
  image: '图片',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  code: '代码',
  doc: '文档',
  sheet: '表格',
  slide: '演示文稿',
  pdf: 'PDF',
  text: '文本',
  font: '字体',
  disk: '安装包',
  file: '文件',
};

/** 扩展名 → 种类 */
export function fileKind(name, isCollection = false, contentType = '') {
  if (isCollection) return 'folder';
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (String(name).includes('.')) {
    for (const [kind, list] of Object.entries(EXT_KIND)) {
      if (list.includes(ext)) return kind;
    }
  }
  const type = String(contentType || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/pdf') return 'pdf';
  if (type.includes('zip') || type.includes('compressed')) return 'archive';
  return 'file';
}

export function kindIcon(kind) {
  return KIND_ICON[kind] || KIND_ICON.file;
}

export function kindLabel(kind) {
  return KIND_LABEL[kind] || KIND_LABEL.file;
}

/** 文件扩展名（小写，不含点） */
export function extensionOf(name) {
  const s = String(name || '');
  const idx = s.lastIndexOf('.');
  if (idx <= 0 || idx === s.length - 1) return '';
  return s.slice(idx + 1).toLowerCase();
}

/** 该类型是否可以直接在浏览器里预览 */
export function canPreview(kind) {
  return ['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(kind);
}

/** 常见类型 → Content-Type */
export function guessContentType(name) {
  const ext = extensionOf(name);
  const map = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}

/** 下载文件名净化，避免路径穿越 */
export function sanitizeFilename(name) {
  const cleaned = String(name || 'download')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'download';
}

/**
 * 解析 OPTIONS 响应的 DAV 头，得到服务器支持的协议级别。
 * 例：`DAV: 1, 2, 3, extended-mkcol`
 *  - 1 = 基础 WebDAV
 *  - 2 = 支持 LOCK/UNLOCK
 *  - 3 = 支持 RFC 4918（含带正文的 PROPFIND 等）
 */
export function parseDavCapabilities(davHeader, allowHeader) {
  const classes = [];
  const extras = [];
  for (const token of String(davHeader || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^\d+$/.test(token)) classes.push(Number(token));
    else extras.push(token);
  }
  const methods = String(allowHeader || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return { classes, extras, methods };
}


/** 状态码 → 简短中文说明 */
export function statusTextCN(status) {
  const map = {
    200: '成功',
    201: '已创建',
    204: '无内容（成功）',
    207: 'Multi-Status（多状态）',
    301: '永久重定向',
    302: '临时重定向',
    304: '未修改',
    400: '请求格式错误',
    401: '认证失败 / 需要登录',
    403: '没有权限',
    404: '不存在',
    405: '方法不被允许',
    409: '父集合不存在',
    412: '前置条件失败',
    415: '媒体类型不支持',
    423: '已被锁定',
    424: '依赖失败',
    507: '存储空间不足',
  };
  return map[status] || '';
}
