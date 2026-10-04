/**
 * 后台 Service Worker：扩展里唯一有“跨域特权”的地方。
 *
 * 普通网页发 WebDAV 请求会被 CORS 拦死（服务器通常不会给 PROPFIND 返回 CORS 头），
 * 而扩展在 host_permissions 授权下可以拿到完整的响应头和响应体。
 * 所以所有网络动作都放在这里，页面只通过消息传递拿结果。
 */

import { davRequest } from '../lib/http.js';

const MENU_ID = 'webdav-open-manager';

/** 统一的扩展页面入口 */
function managerUrl(query = {}) {
  const url = new URL(chrome.runtime.getURL('src/manager/manager.html'));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.href;
}

async function openManager(query = {}) {
  const url = managerUrl(query);
  const base = chrome.runtime.getURL('src/manager/manager.html');
  // 不带 tabs 权限时无法用 url 过滤查询，这里改成自己筛选（扩展自己的页面总是可见的）
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url && tab.url.startsWith(base));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return { tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id, reused: false };
}

/** 把当前页面里选中的地址规范化，方便直接连接 */
function guessServerUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    // 去掉文件名，只保留目录
    if (!url.pathname.endsWith('/')) {
      const last = url.pathname.split('/').pop();
      if (last.includes('.')) url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
      else url.pathname += '/';
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 WebDAV 文件管理器打开',
      contexts: ['link', 'page', 'selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenu();
  chrome.storage.local.get(['connections']).then(({ connections }) => {
    if (!connections) chrome.storage.local.set({ connections: [] });
  });
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenu();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const raw = info.linkUrl || info.selectionText || info.pageUrl;
  if (!raw) return;
  await openManager({ url: guessServerUrl(raw), autoconnect: '1' });
});

/**
 * 页面加载完成后，主动探测一次“这页是不是 WebDAV 的 207 报文”。
 *
 * 为什么要用编程式注入兜底：浏览器直接把 application/xml 渲染成自带的 XML 查看器，
 * 声明式内容脚本有可能被注入到“被替换掉的那份文档”里，拿到的 DOM 已经是废弃的。
 * 等页面加载完成后再注入，看到的才是最终的查看器 DOM。
 */
function probeDavDocument() {
  const readText = () => {
    try {
      const viewerSource = document.getElementById('webkit-xml-viewer-source-xml');
      const raw = viewerSource
        ? viewerSource.innerHTML
        : document.documentElement
          ? document.documentElement.outerHTML
          : '';
      return String(raw || '').slice(0, 16384);
    } catch {
      return '';
    }
  };
  // 浏览器自带的 XML 查看器是“页面加载完成后”才把内容填进 DOM 的，
  // 所以这里必须等一会儿，不能一锤子买卖。
  return (async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (/<(?:[A-Za-z0-9_.-]+:)?multistatus[\s>]/i.test(readText())) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  })();
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = (tab && tab.url) || '';
  if (!/^https?:/i.test(url)) return;
  try {
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: probeDavDocument });
    if (probe && probe.result) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/detect.js'] });
    }
  } catch {
    /* 有些页面（浏览器内部页、商店页）不允许注入，忽略即可 */
  }
});

/**
 * 页面 → 后台 的消息协议。
 * 所有返回都是 { ok: boolean, ... }，出错时带 error 字段。
 */
const handlers = {
  /** 通用原始请求（页面自己决定方法、头和正文） */
  async DAV_REQUEST(msg) {
    const result = await davRequest({
      method: msg.method,
      url: msg.url,
      headers: msg.headers || {},
      bodyText: msg.bodyText ?? null,
      bodyBase64: msg.bodyBase64 ?? null,
      auth: msg.auth || null,
      wantBase64: Boolean(msg.wantBase64),
      maxBytes: msg.maxBytes || 32 * 1024 * 1024,
      timeoutMs: msg.timeoutMs || 120000,
    });
    return result;
  },

  /** 直接走浏览器下载器：能流式落盘，不受内存限制，也不会因 CORS 失败 */
  async DAV_DOWNLOAD(msg) {
    const headers = [];
    if (msg.authHeader) headers.push({ name: 'Authorization', value: msg.authHeader });
    const filename = msg.filename || undefined;
    try {
      const id = await chrome.downloads.download({
        url: msg.url,
        filename,
        headers: headers.length ? headers : undefined,
        saveAs: Boolean(msg.saveAs),
        conflictAction: 'uniquify',
      });
      return { ok: true, downloadId: id };
    } catch (err) {
      return { ok: false, error: `调用浏览器下载失败：${err.message}` };
    }
  },

  /** 打开文件管理器页面 */
  async OPEN_MANAGER(msg) {
    const info = await openManager(msg.query || {});
    return { ok: true, ...info };
  },

  /**
   * 查询扩展对某些 origin 是否真的有访问权限。
   * CORS 预检失败的根因通常就是这里返回 false（比如 Edge 把「站点访问权限」设成了「单击时」）。
   */
  async CHECK_PERMISSIONS(msg) {
    const origins = msg.origins || [];
    const granted = {};
    for (const origin of origins) {
      try {
        granted[origin] = await chrome.permissions.contains({ origins: [origin] });
      } catch {
        granted[origin] = false;
      }
    }
    const manifest = chrome.runtime.getManifest();
    return {
      ok: true,
      granted,
      extensionId: chrome.runtime.id,
      extensionName: manifest.name,
      extensionVersion: manifest.version,
      allOrigins: (await chrome.permissions.getAll()).origins || [],
    };
  },

  /** 读取保存的连接 */
  async GET_CONNECTIONS() {
    const { connections = [] } = await chrome.storage.local.get('connections');
    return { ok: true, connections };
  },

  async SAVE_CONNECTION(msg) {
    const { connections = [] } = await chrome.storage.local.get('connections');
    const entry = { ...msg.connection, updatedAt: Date.now() };
    const list = connections.filter((c) => c.url !== entry.url);
    list.unshift(entry);
    await chrome.storage.local.set({ connections: list.slice(0, 30) });
    return { ok: true, connections: list.slice(0, 30) };
  },

  async DELETE_CONNECTION(msg) {
    const { connections = [] } = await chrome.storage.local.get('connections');
    const list = connections.filter((c) => c.url !== msg.url);
    await chrome.storage.local.set({ connections: list });
    return { ok: true, connections: list };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && msg.type ? handlers[msg.type] : null;
  if (!handler) {
    // 不是我们的消息，交给其他监听者
    return false;
  }
  Promise.resolve(handler(msg, sender))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // 保持消息通道打开，异步回复
});
