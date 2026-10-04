/**
 * 内容脚本：当浏览器直接打开一个 WebDAV 响应（一堆 207 Multi-Status XML）时，
 * 在页面右下角浮出一个入口，一键把这份“原始报文”交给文件管理器渲染成文件列表。
 *
 * 踩过的坑（都体现在下面的写法里）：
 *  1. application/xml 会套一层浏览器自带的 XML 查看器，原始报文放在
 *     <div id="webkit-xml-viewer-source-xml"> 里；它是**页面加载完成后**才填充的，
 *     所以 document_idle 时可能还是空的 —— 必须轮询等待。
 *  2. 这个 div 要用 innerHTML 读：textContent 只有文本节点，看不到 <D:multistatus> 标签。
 *  3. 在 XML 文档里 document.createElement('div') 造出来的是**无命名空间**元素，
 *     既没有 .style 也不能 attachShadow，必须用 createElementNS(XHTML, ...) + setAttribute。
 *  4. 内容脚本绝不能影响宿主页面，所有异常都要吞掉。
 */

(() => {
  const PILL_ID = 'webdav-manager-entry';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 6000;
  const REMOUNT_DELAY_MS = 1000;
  const MAX_REMOUNT = 5;

  /** 创建一个一定能用的元素（XML 文档里也保持 HTML 语义） */
  function makeElement(tag, style, text) {
    const node = document.createElementNS(XHTML, tag);
    if (style) node.setAttribute('style', style);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 取出页面里最可能是“原始报文”的文本 */
  function sourceText() {
    try {
      const viewerSource = document.getElementById('webkit-xml-viewer-source-xml');
      if (viewerSource) return viewerSource.innerHTML.slice(0, 16384);

      const looksXml = /xml/i.test(document.contentType || '');
      if (looksXml || !document.body) {
        return document.documentElement ? document.documentElement.outerHTML.slice(0, 16384) : '';
      }
      const bodyText = document.body.textContent || '';
      if (/multistatus/i.test(bodyText)) return bodyText.slice(0, 16384);
      return document.documentElement ? document.documentElement.innerHTML.slice(0, 16384) : bodyText;
    } catch {
      return '';
    }
  }

  /** 页面内容看起来是不是 WebDAV 的 multistatus 报文 */
  function looksLikeWebdavDocument() {
    const text = sourceText();
    if (!text) return false;
    if (!/<(?:[A-Za-z0-9_.-]+:)?multistatus[\s>]/i.test(text)) return false;

    const hasDavNamespace = /xmlns(?::[A-Za-z0-9_.-]+)?=["']DAV:/i.test(text);
    const hasHref = /<(?:[A-Za-z0-9_.-]+:)?href[\s>]/i.test(text);
    const isXmlDocument = /xml/i.test(document.contentType || '');
    return hasDavNamespace || hasHref || isXmlDocument;
  }

  function guessCollectionUrl() {
    try {
      const url = new URL(location.href);
      url.hash = '';
      return url.href;
    } catch {
      return location.href;
    }
  }

  function mount(attempt = 0) {
    if (document.getElementById(PILL_ID)) return;

    const parent = document.body || document.documentElement;
    if (!parent) return;

    const host = makeElement('div', 'position:fixed;z-index:2147483647;right:18px;bottom:18px;');
    host.id = PILL_ID;

    const card = makeElement(
      'div',
      'display:flex;align-items:center;gap:10px;background:#1f2937;color:#f9fafb;' +
        'border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:380px;' +
        'font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
    );

    card.appendChild(makeElement('span', 'font-size:20px;line-height:1;', '🗄️'));

    const textWrap = makeElement('span', 'display:flex;flex-direction:column;min-width:0;');
    textWrap.appendChild(makeElement('strong', 'font-weight:600;', '检测到 WebDAV 响应'));
    textWrap.appendChild(makeElement('span', 'font-size:11px;opacity:.72;', '这是 207 Multi-Status 原始报文'));
    card.appendChild(textWrap);

    const buttonStyle =
      'font:inherit;cursor:pointer;border-radius:8px;padding:5px 10px;white-space:nowrap;' +
      'border:1px solid rgba(255,255,255,.2);background:#2563eb;color:#fff;';

    const openButton = makeElement('button', buttonStyle, '用文件管理器打开');
    openButton.setAttribute('type', 'button');
    openButton.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({
          type: 'OPEN_MANAGER',
          query: { url: guessCollectionUrl(), autoconnect: '1' },
        });
      } catch {
        /* 扩展被卸载时忽略 */
      }
    });

    const closeButton = makeElement(
      'button',
      'font:inherit;cursor:pointer;border-radius:8px;padding:5px 6px;border:1px solid transparent;background:transparent;color:#cbd5e1;',
      '✕',
    );
    closeButton.setAttribute('type', 'button');
    closeButton.setAttribute('title', '不再提示');
    closeButton.addEventListener('click', () => host.remove());

    card.append(openButton, closeButton);
    host.appendChild(card);
    parent.appendChild(host);

    // 浏览器有时会在查看器建好后重建文档，挂上去以后确认一下还在不在
    if (attempt < MAX_REMOUNT) {
      setTimeout(() => {
        try {
          if (!document.getElementById(PILL_ID) || !host.isConnected) mount(attempt + 1);
        } catch {
          /* 忽略 */
        }
      }, REMOUNT_DELAY_MS);
    }
  }

  let waited = 0;

  function tick() {
    let matched = false;
    try {
      matched = looksLikeWebdavDocument();
    } catch {
      return;
    }

    if (matched) {
      try {
        mount();
      } catch {
        /* 注入失败也不能影响页面 */
      }
      return;
    }

    waited += POLL_INTERVAL_MS;
    if (waited < POLL_TIMEOUT_MS) setTimeout(tick, POLL_INTERVAL_MS);
  }

  // 立即先跑一次：XML 文档被浏览器换成查看器 DOM 的过程中，
  // DOMContentLoaded 有可能在注册监听之前就已经过去了。
  document.addEventListener('DOMContentLoaded', tick, { once: true });
  tick();
})();
