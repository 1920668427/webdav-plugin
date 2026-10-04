/**
 * 工具栏弹窗：快速填写连接信息并打开文件管理器。
 */

const $ = (selector) => document.querySelector(selector);

const dom = {
  form: $('#form'),
  url: $('#url'),
  username: $('#username'),
  password: $('#password'),
  authMode: $('#authMode'),
  open: $('#open'),
  save: $('#save'),
  connections: $('#connections'),
};

let connections = [];

function openManager() {
  const url = dom.url.value.trim();
  if (!url) {
    dom.url.focus();
    return;
  }
  chrome.runtime.sendMessage({
    type: 'OPEN_MANAGER',
    query: {
      url,
      user: dom.username.value,
      pass: dom.password.value,
      auth: dom.authMode.value,
      autoconnect: '1',
    },
  });
  window.close();
}

function renderConnections() {
  dom.connections.innerHTML = '';
  if (!connections.length) {
    dom.connections.innerHTML = '<li class="empty">还没有保存的连接</li>';
    return;
  }
  for (const conn of connections) {
    const li = document.createElement('li');
    const grow = document.createElement('div');
    grow.className = 'grow';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = conn.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${conn.username || '匿名'} · ${conn.authMode || 'auto'}`;
    grow.append(url, meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      const res = await chrome.runtime.sendMessage({ type: 'DELETE_CONNECTION', url: conn.url });
      connections = res.connections || [];
      renderConnections();
    });

    li.append(grow, del);
    li.addEventListener('click', () => {
      dom.url.value = conn.url;
      dom.username.value = conn.username || '';
      dom.password.value = conn.password || '';
      dom.authMode.value = conn.authMode || 'auto';
      openManager();
    });
    dom.connections.appendChild(li);
  }
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONNECTIONS' });
  connections = (res && res.connections) || [];
  renderConnections();

  const { lastConnection } = await chrome.storage.local.get('lastConnection');
  if (lastConnection && lastConnection.url) {
    dom.url.value = lastConnection.url;
    dom.username.value = lastConnection.username || '';
    dom.password.value = lastConnection.password || '';
    dom.authMode.value = lastConnection.authMode || 'auto';
  } else {
    // 用当前标签页地址做个合理猜测
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && /^https?:/i.test(tab.url)) {
        const url = new URL(tab.url);
        dom.url.value = `${url.origin}/`;
      }
    } catch {
      /* 忽略 */
    }
  }
}

dom.form.addEventListener('submit', (event) => {
  event.preventDefault();
  openManager();
});

dom.save.addEventListener('click', async () => {
  const url = dom.url.value.trim();
  if (!url) return dom.url.focus();
  const res = await chrome.runtime.sendMessage({
    type: 'SAVE_CONNECTION',
    connection: {
      url,
      username: dom.username.value,
      password: dom.password.value,
      authMode: dom.authMode.value,
    },
  });
  connections = (res && res.connections) || [];
  renderConnections();
  dom.save.textContent = '已保存';
  setTimeout(() => {
    dom.save.textContent = '保存';
  }, 1200);
});

init();
