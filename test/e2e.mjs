/**
 * 端到端测试：在真实的 Microsoft Edge（headless）里加载扩展，
 * 通过 CDP 驱动文件管理器页面，对一个真实的 WebDAV 服务器跑完整流程。
 *
 *   node test/e2e.mjs
 *
 * 覆盖：匿名 / Basic / Digest 三种认证、列目录、新建目录（走界面弹窗）、
 *       上传、下载读取、重命名、删除、进入子目录、过滤、原始报文弹窗、
 *       内容脚本自动识别 207 XML、popup 读取已保存连接。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../tools/webdav-server.mjs';
import { Cdp, httpJson, sleep, waitFor, unpackedExtensionId } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const tmpDir = resolve(projectRoot, '.tmp/e2e');
const profileDir = resolve(tmpDir, 'edge-profile');
const EDGE_BIN = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9333);
const BROWSER_URL = `http://127.0.0.1:${DEBUG_PORT}`;

const results = [];
let failures = 0;

/**
 * 读取弹窗的“真实可见性”。
 * 只看 dialog.open 是不够的：如果 CSS 里给非 [open] 的 dialog 写了 display，
 * 就会覆盖浏览器默认的 dialog:not([open]){display:none}，弹窗会一直在屏幕上且关不掉。
 */
const DIALOG_STATE_SNIPPET = `(() => {
  const read = (id) => {
    const el = document.getElementById(id);
    const style = getComputedStyle(el);
    return {
      exists: !!el,
      open: !!el.open,
      display: style.display,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && el.checkVisibility(),
    };
  };
  return { raw: read('raw-dialog'), preview: read('preview-dialog'), prompt: read('prompt-dialog') };
})()`;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? `  —  ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n▶ ${title}`);
}

/* --------------------------- 浏览器 --------------------------- */

let edgeProcess = null;
let edgeLogFd = null;

async function launchEdge(headlessFlag) {
  const args = [
    headlessFlag,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    // 测试运行在受限沙箱里，Chromium 自己的沙箱起不来（sandbox initialization failed），
    // 关掉它才能稳定跑完；这只影响自动化测试进程，与扩展本身无关。
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--user-data-dir=${profileDir}`,
    `--load-extension=${projectRoot}`,
    `--disable-extensions-except=${projectRoot}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-popup-blocking',
    '--autoplay-policy=no-user-gesture-required',
    // 后台标签页会被节流，媒体可能一直加载不出来（readyState 卡在 0）
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1400,900',
    'about:blank',
  ];
  edgeLogFd = openSync(resolve(tmpDir, 'edge.log'), 'a');
  edgeProcess = spawn(EDGE_BIN, args, { stdio: ['ignore', edgeLogFd, edgeLogFd], detached: true });
  edgeProcess.on('exit', (code) => {
    if (code !== null && code !== 0 && !shuttingDown) console.log(`  ! Edge 退出，code=${code}`);
  });
  return waitFor(
    async () => {
      const version = await httpJson(`${BROWSER_URL}/json/version`);
      return version && version.webSocketDebuggerUrl ? version : null;
    },
    { timeout: 25000, interval: 400, message: 'Edge 调试端口未就绪' },
  ).catch((err) => {
    console.log(`  ! ${err.message}（headless 参数：${headlessFlag}）`);
    return null;
  });
}

async function killEdge() {
  if (!edgeProcess) return;
  const pid = edgeProcess.pid;
  edgeProcess = null;
  try {
    // 负的 pid = 整个进程组；Edge 会 fork 出很多子进程，
    // 只杀父进程会留下孤儿，把 profile 目录锁住导致下次启动失败
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
  await sleep(700);
}

/** 确定扩展 ID：优先找我们自己 Service Worker 的目标，其次用路径哈希推算 */
async function resolveExtensionId() {
  const computed = unpackedExtensionId(projectRoot);
  const observed = await waitFor(
    async () => {
      const list = await httpJson(`${BROWSER_URL}/json/list`);
      const target = list.find((t) => String(t.url || '').includes('/src/background/service-worker.js'));
      if (!target) return null;
      return new URL(target.url).host;
    },
    { timeout: 20000, interval: 400, message: '未在浏览器里发现扩展的 Service Worker' },
  ).catch(() => null);

  if (!observed) {
    console.log('  ! 没抓到扩展目标，改用路径哈希推算的 ID');
    return computed;
  }
  if (observed !== computed) {
    console.log(`  ! 计算出的扩展 ID(${computed}) 与浏览器报告的(${observed}) 不一致，采用浏览器报告的`);
  } else {
    console.log('  （路径哈希推算的 ID 与浏览器一致）');
  }
  return observed;
}

/** 打开一个扩展页面，返回带 CDP 会话的对象 */
async function openPage(url) {
  const target = await httpJson(`${BROWSER_URL}/json/new`, 'PUT');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '未知异常');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  return { cdp, consoleErrors, targetId: target.id };
}

/* --------------------------- 主流程 --------------------------- */

let shuttingDown = false;

async function main() {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  console.log('启动测试用 WebDAV 服务器…');
  const servers = {
    anonymous: await startServer({ port: 0, root: resolve(tmpDir, 'dav-anonymous'), auth: 'none', quiet: true }),
    basic: await startServer({ port: 0, root: resolve(tmpDir, 'dav-basic'), auth: 'basic', username: 'demo', password: 'demo', quiet: true }),
    digest: await startServer({ port: 0, root: resolve(tmpDir, 'dav-digest'), auth: 'digest', username: 'demo', password: 'demo', quiet: true }),
  };
  for (const [name, server] of Object.entries(servers)) {
    console.log(`  ${name.padEnd(10)} ${server.baseUrl}`);
  }

  // 端口被占通常是上一次跑挂了留下的孤儿进程，先清干净
  try {
    const existing = await httpJson(`${BROWSER_URL}/json/version`);
    if (existing && existing.webSocketDebuggerUrl) {
      console.log(`  ! 调试端口 ${DEBUG_PORT} 上还有旧实例，等待它退出…`);
      await sleep(2000);
    }
  } catch {
    /* 端口空着，正常 */
  }

  console.log('\n启动 Microsoft Edge（headless，加载扩展）…');
  let version = await launchEdge('--headless=new');
  if (!version) {
    await killEdge();
    version = await launchEdge('--headless');
  }
  if (!version) throw new Error('无法启动 Edge');
  console.log(`  ${version.Browser}`);

  // 下载目录指到临时目录，别污染用户真实下载文件夹
  const downloadDir = resolve(tmpDir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  const browserSession = await Cdp.connect(version.webSocketDebuggerUrl);
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  const extensionId = await resolveExtensionId();
  console.log(`  扩展 ID：${extensionId}`);
  const managerBase = `chrome-extension://${extensionId}/src/manager/manager.html`;

  /* ---------------- 1. 匿名服务器 ---------------- */

  section('匿名 WebDAV 服务器：连接与列目录');
  const anonymousPage = await openPage(`${managerBase}?url=${encodeURIComponent(servers.anonymous.baseUrl)}`);
  await waitFor(() => anonymousPage.cdp.evaluate('!!window.__webdav'), { message: '管理页面没加载出来' });
  const anonReady = await anonymousPage.cdp.evaluate('window.__webdav.ready');
  check('匿名连接成功', anonReady === true);
  const anonEntries = await anonymousPage.cdp.evaluate('window.__webdav.state.entries.map(e => e.name)');
  check('列出根目录条目', anonEntries.length >= 5, `${anonEntries.length} 项：${anonEntries.join(', ')}`);
  check('识别出文件夹 docs', await anonymousPage.cdp.evaluate('window.__webdav.state.entries.some(e => e.name === "docs" && e.isCollection)'));
  check('中文文件名正确解码', anonEntries.includes('中文 文件.txt'));
  check('能力探测到 DAV class 1/2/3', await anonymousPage.cdp.evaluate('JSON.stringify(window.__webdav.state.capabilities.classes)') === '[1,2,3]');
  check('DOM 表格行数与条目一致', (await anonymousPage.cdp.evaluate('document.querySelectorAll("#file-tbody tr").length')) === anonEntries.length);

  const idleDialogs = await anonymousPage.cdp.evaluate(DIALOG_STATE_SNIPPET);
  check(
    '刚打开页面时三个弹窗都不可见',
    [idleDialogs.raw, idleDialogs.preview, idleDialogs.prompt].every((d) => d.exists && !d.visible),
    `raw=${idleDialogs.raw.display} / preview=${idleDialogs.preview.display} / prompt=${idleDialogs.prompt.display}`,
  );
  check(
    '未打开的弹窗 display 计算值是 none',
    [idleDialogs.raw, idleDialogs.preview, idleDialogs.prompt].every((d) => d.display === 'none'),
  );

  /* ---------------- 2. Basic 认证 ---------------- */

  section('Basic 认证服务器：完整文件管理流程');
  const page = await openPage(
    `${managerBase}?url=${encodeURIComponent(servers.basic.baseUrl)}&user=demo&pass=demo&auth=auto`,
  );
  await waitFor(() => page.cdp.evaluate('!!window.__webdav'), { message: '管理页面没加载出来' });
  const ready = await page.cdp.evaluate('window.__webdav.ready');
  check('Basic 连接成功', ready === true);
  check('显示已认证用户', (await page.cdp.evaluate('window.__webdav.state.auth.username')) === 'demo');

  const log0 = await page.cdp.evaluate('(() => { const l = window.__webdav.log()[0]; return { method: l.method, status: l.status, url: l.url, req: l.requestRaw, body: l.bodyText }; })()');
  check('最新日志是 PROPFIND', log0.method === 'PROPFIND', log0.method);
  check('服务器返回 207 Multi-Status', log0.status === 207, String(log0.status));
  check('原始请求里含有 PROPFIND 请求行与 Depth 头', /PROPFIND .* HTTP\/1\.1/.test(log0.req) && /Depth: 1/i.test(log0.req));
  check('原始请求里带 Basic 认证头（凭据已隐藏）', /Authorization: Basic <凭据已隐藏>/.test(log0.req));
  check('原始响应正文是 multistatus XML', typeof log0.body === 'string' && log0.body.includes('<D:multistatus'));

  // 新建目录：走真实界面弹窗
  const created = await page.cdp.evaluate(`(async () => {
    const promise = window.__webdav.mkcol();
    await new Promise(r => setTimeout(r, 120));
    const dialogOpen = document.querySelector('#prompt-dialog').open;
    document.querySelector('#prompt-input').value = 'UI 新建目录';
    document.querySelector('#prompt-ok').click();
    await promise;
    return { dialogOpen, names: window.__webdav.state.entries.map(e => e.name) };
  })()`);
  check('新建文件夹弹窗会弹出', created.dialogOpen === true);
  check('新建文件夹后列表出现新目录', created.names.includes('UI 新建目录'));

  // 上传
  const uploadResult = await page.cdp.evaluate(`(async () => {
    await window.__webdav.uploadText('上传测试.txt', 'Hello WebDAV 上传');
    const entry = window.__webdav.state.entries.find(e => e.name === '上传测试.txt');
    const put = window.__webdav.log().find(l => l.method === 'PUT');
    return { exists: !!entry, size: entry && entry.size, status: put && put.status, req: put && put.requestRaw, resp: put && put.responseRaw };
  })()`);
  check('上传（PUT）成功', uploadResult.exists && uploadResult.status < 300, `status=${uploadResult.status}`);
  check('PUT 原始请求带上 Content-Type', /Content-Type: text\/plain/.test(uploadResult.req || ''));
  check('PUT 原始响应是 201/204', /HTTP\/1\.1 (201|204)/.test(uploadResult.resp || ''), (uploadResult.resp || '').split('\r\n')[0]);
  check('上传后大小正确', uploadResult.size === Buffer.byteLength('Hello WebDAV 上传', 'utf8'), `${uploadResult.size} 字节`);

  // 读取回来验证内容
  const content = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === '上传测试.txt');
    const res = await chrome.runtime.sendMessage({ type: 'DAV_REQUEST', method: 'GET', url: entry.url, auth: window.__webdav.state.auth });
    return { status: res.status, text: res.bodyText };
  })()`);
  check('GET 回来的内容与上传一致', content.text === 'Hello WebDAV 上传', JSON.stringify(content.text));

  // 重命名（走真实弹窗交互）
  const renameDone = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === '上传测试.txt');
    const promise = window.__webdav.move(entry, 'MOVE');
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#prompt-input').value = '重命名后.txt';
    document.querySelector('#prompt-ok').click();
    await promise;
    const names = window.__webdav.state.entries.map(e => e.name);
    const move = window.__webdav.log().find(l => l.method === 'MOVE');
    return { names, status: move && move.status, req: move && move.requestRaw };
  })()`);
  check('MOVE 重命名成功', renameDone.names.includes('重命名后.txt') && renameDone.status < 300, `status=${renameDone.status}`);
  const destinationLine = (renameDone.req || '').split('\r\n').find((l) => l.startsWith('Destination')) || '';
  check(
    'MOVE 请求带 Destination 头',
    /^Destination: http:\/\/127\.0\.0\.1:\d+\/(%E9%87%8D%E5%91%BD%E5%90%8D%E5%90%8E\.txt|重命名后\.txt)$/.test(destinationLine),
    destinationLine || '没有 Destination',
  );

  // 进入子目录
  const docs = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === 'docs');
    await window.__webdav.navigate(entry.url);
    return {
      names: window.__webdav.state.entries.map(e => e.name),
      crumbs: [...document.querySelectorAll('#breadcrumb a, #breadcrumb .current')].map(e => e.textContent),
    };
  })()`);
  check('进入子目录 docs', docs.names.includes('guide.md') && docs.names.includes('data.json'));
  check('面包屑包含 docs', docs.crumbs.some((c) => c.includes('docs')), docs.crumbs.join(' / '));
  check('嵌套目录识别为集合', await page.cdp.evaluate('window.__webdav.state.entries.some(e => e.name === "子目录" && e.isCollection)'));

  // 过滤
  const filtered = await page.cdp.evaluate(`(() => {
    const input = document.querySelector('#filter');
    input.value = 'guide';
    input.dispatchEvent(new Event('input'));
    const rows = document.querySelectorAll('#file-tbody tr').length;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    return rows;
  })()`);
  check('列表过滤生效', filtered === 1, `匹配 ${filtered} 行`);

  // 原始报文弹窗
  const dialog = await page.cdp.evaluate(`(async () => {
    document.querySelector('#btn-raw-xml').click();
    await new Promise(r => setTimeout(r, 100));
    const open = document.querySelector('#raw-dialog').open;
    const tabs = [...document.querySelectorAll('#raw-tabs .tab')].map(t => t.textContent);
    document.querySelector('#raw-tabs .tab:nth-child(3)').click();
    const text = document.querySelector('#raw-pre').textContent;
    document.querySelector('#raw-close').click();
    return { open, tabs, hasXml: text.includes('<D:multistatus'), requestHasPropfind: text.length > 0 };
  })()`);
  const rawVisibility = await page.cdp.evaluate(`(async () => {
    const read = () => {
      const el = document.getElementById('raw-dialog');
      const style = getComputedStyle(el);
      return { open: !!el.open, display: style.display, visible: style.display !== 'none' && el.checkVisibility() };
    };
    document.querySelector('#btn-raw-xml').click();
    await new Promise((r) => setTimeout(r, 80));
    const opened = read();
    document.querySelector('#raw-close').click();
    await new Promise((r) => setTimeout(r, 80));
    const closed = read();
    return { opened, closed };
  })()`);
  check('原始报文弹窗打开后确实可见', rawVisibility.opened.visible === true && rawVisibility.opened.display !== 'none', `display=${rawVisibility.opened.display}`);
  check(
    '点关闭后原始报文弹窗彻底消失',
    rawVisibility.closed.open === false && rawVisibility.closed.display === 'none' && rawVisibility.closed.visible === false,
    `open=${rawVisibility.closed.open} display=${rawVisibility.closed.display}`,
  );

  check('原始报文弹窗可以打开', dialog.open === true);
  check('弹窗包含请求/响应/XML/解析 四个标签', dialog.tabs.length === 4, dialog.tabs.join(' | '));
  check('弹窗里能看到原始 XML', dialog.hasXml === true);

  // 删除（跳过确认框，直接调函数）
  const deleted = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === '重命名后.txt');
    if (!entry) return { skipped: true };
    await window.__webdav.remove([entry], { skipConfirm: true });
    return { names: window.__webdav.state.entries.map(e => e.name), method: window.__webdav.log()[0].method };
  })()`);
  check('删除（DELETE）成功', deleted.skipped || (!deleted.names.includes('重命名后.txt') && deleted.method === 'DELETE'));

  // 回到根目录，删除刚才新建的目录
  await page.cdp.evaluate(`(async () => {
    await window.__webdav.navigate(window.__webdav.state.baseUrl);
    const entry = window.__webdav.state.entries.find(e => e.name === 'UI 新建目录');
    if (entry) await window.__webdav.remove([entry], { skipConfirm: true });
  })()`);

  // 下载：内存方式（走 GET + Blob）
  const downloaded = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === 'readme.txt');
    if (!entry) return 'no entry';
    await window.__webdav.download(entry);
    return 'ok';
  })()`);
  const smallDownload = await waitFor(
    () => {
      const file = resolve(downloadDir, 'readme.txt');
      return existsSync(file) ? file : null;
    },
    { timeout: 12000, message: '小文件没有落盘' },
  ).catch(() => null);
  check('下载小文件（GET + Blob）成功', downloaded === 'ok' && Boolean(smallDownload), smallDownload ? String(readFileSync(smallDownload, 'utf8').length) + ' 字节' : '文件未出现');

  // 下载：浏览器下载器（走 chrome.downloads，大文件用它流式落盘）
  // 注意：headless 下 filename 参数可能被忽略，所以这里只断言“下载完成”，不断言文件名
  const viaDownloads = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === 'readme.txt');
    // Basic 认证服务器：浏览器下载器需要我们自己把认证头塞进请求
    const res = await chrome.runtime.sendMessage({
      type: 'DAV_DOWNLOAD',
      url: entry.url,
      filename: 'readme.txt',
      authHeader: 'Basic ' + btoa('demo:demo'),
    });
    if (!res.ok) return res;
    for (let i = 0; i < 40; i++) {
      const [item] = await chrome.downloads.search({ id: res.downloadId });
      if (item && item.state === 'complete') return { ok: true, state: item.state, filename: item.filename };
      if (item && item.error) return { ok: false, error: item.error };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, error: '下载未在超时时间内完成' };
  })()`);
  check(
    '浏览器下载器（chrome.downloads）下载完成',
    Boolean(viaDownloads.ok) && viaDownloads.state === 'complete',
    viaDownloads.filename ? String(viaDownloads.filename).split('/').pop() : viaDownloads.error,
  );
  check('下载目录里有文件', readdirSync(downloadDir).length >= 1, readdirSync(downloadDir).join(', '));

  const previewVisibility = await page.cdp.evaluate(`(async () => {
    const read = () => {
      const el = document.getElementById('preview-dialog');
      const style = getComputedStyle(el);
      return { open: !!el.open, display: style.display, visible: style.display !== 'none' && el.checkVisibility() };
    };
    const before = read();
    const entry = window.__webdav.state.entries.find((e) => e.name === 'readme.txt');
    await window.__webdav.preview(entry);
    await new Promise((r) => setTimeout(r, 120));
    const opened = { ...read(), text: document.querySelector('#preview-body').textContent.slice(0, 20) };
    document.querySelector('#preview-close').click();
    await new Promise((r) => setTimeout(r, 80));
    const closed = read();
    return { before, opened, closed };
  })()`);
  check('预览前预览弹窗是隐藏的', previewVisibility.before.visible === false && previewVisibility.before.display === 'none');
  check('预览时弹窗可见且渲染出内容', previewVisibility.opened.visible === true && previewVisibility.opened.text.length > 0, previewVisibility.opened.text);
  check(
    '点关闭后预览弹窗彻底消失',
    previewVisibility.closed.open === false && previewVisibility.closed.display === 'none' && previewVisibility.closed.visible === false,
    `open=${previewVisibility.closed.open} display=${previewVisibility.closed.display}`,
  );

  const finalDialogs = await page.cdp.evaluate(DIALOG_STATE_SNIPPET);
  check(
    '一轮操作结束后没有弹窗遗留在屏幕上',
    [finalDialogs.raw, finalDialogs.preview, finalDialogs.prompt].every((d) => !d.visible),
    `raw=${finalDialogs.raw.display} / preview=${finalDialogs.preview.display} / prompt=${finalDialogs.prompt.display}`,
  );

  /* ---------------- 权限自检与诊断 ---------------- */

  section('网站访问权限自检 / 诊断面板');
  const permissionState = await page.cdp.evaluate(`(async () => {
    const origin = new URL(window.__webdav.state.baseUrl).origin + '/*';
    const res = await window.__webdav.checkPermission(origin);
    return {
      origin,
      granted: !!(res.granted && res.granted[origin]),
      extensionId: res.extensionId,
      version: res.extensionVersion,
      allOrigins: res.allOrigins,
    };
  })()`);
  check('扩展确实持有该站点的访问权限', permissionState.granted === true, `${permissionState.origin} → ${permissionState.granted}`);
  check('权限查询返回扩展 ID 与版本', Boolean(permissionState.extensionId) && Boolean(permissionState.version), `${permissionState.extensionId} v${permissionState.version}`);
  check('权限范围包含 http/https 通配', String(permissionState.allOrigins).includes('http://*/*'));

  const bannerIdle = await page.cdp.evaluate(`(() => {
    const el = document.getElementById('permission-banner');
    return { hidden: el.classList.contains('hidden'), display: getComputedStyle(el).display };
  })()`);
  check('权限正常时不显示黄色提示条', bannerIdle.hidden === true && bannerIdle.display === 'none');

  // 模拟“权限被浏览器收回”的场景，验证提示条与文案
  const bannerMissing = await page.cdp.evaluate(`(() => {
    window.__webdav.state.permission = { pattern: 'http://192.168.1.50:8080/*', granted: false };
    window.__webdav.refreshPermissionBanner();
    const el = document.getElementById('permission-banner');
    const text = document.getElementById('permission-detail').textContent;
    return { hidden: el.classList.contains('hidden'), display: getComputedStyle(el).display, text };
  })()`);
  check('权限缺失时提示条会出现', bannerMissing.hidden === false && bannerMissing.display !== 'none');
  check('提示条写明了「站点访问权限」的修法', bannerMissing.text.includes('站点访问权限') && bannerMissing.text.includes('在所有网站上'), bannerMissing.text.slice(0, 60) + '…');

  const bannerRestored = await page.cdp.evaluate(`(() => {
    window.__webdav.state.permission = { pattern: '', granted: true };
    window.__webdav.refreshPermissionBanner();
    return document.getElementById('permission-banner').classList.contains('hidden');
  })()`);
  check('权限恢复后提示条自动收起', bannerRestored === true);

  const diagnoseReport = await page.cdp.evaluate(`(async () => {
    const report = await window.__webdav.diagnose();
    const open = document.getElementById('raw-dialog').open;
    const tabs = [...document.querySelectorAll('#raw-tabs .tab')].map((t) => t.textContent);
    document.querySelector('#raw-close').click();
    return { report, open, tabs };
  })()`);
  check('诊断面板可以打开', diagnoseReport.open === true);
  check('诊断报告包含扩展 ID 与权限结论', /扩展 ID：/.test(diagnoseReport.report) && /1\) 访问权限：✔ 已授予/.test(diagnoseReport.report));
  check('诊断报告包含 OPTIONS 探测结果', /2\) OPTIONS 探测：✔ HTTP 207|2\) OPTIONS 探测：✔ HTTP 200/.test(diagnoseReport.report));
  check('诊断报告的标签页是 报告/请求/响应', diagnoseReport.tabs.join('|').includes('诊断报告'), diagnoseReport.tabs.join(' | '));

  check('页面运行期间没有 JS 异常', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' ;; '));

  /* ---------------- 3. Digest 认证 ---------------- */

  section('Digest 认证服务器');
  const digestPage = await openPage(
    `${managerBase}?url=${encodeURIComponent(servers.digest.baseUrl)}&user=demo&pass=demo&auth=digest`,
  );
  await waitFor(() => digestPage.cdp.evaluate('!!window.__webdav'), { message: '管理页面没加载出来' });
  const digestReady = await digestPage.cdp.evaluate('window.__webdav.ready');
  check('Digest 连接成功', digestReady === true);
  check('实际上走了 digest 摘要认证', (await digestPage.cdp.evaluate('window.__webdav.log()[0].authUsed')) === 'digest');
  check('Digest 下也能列目录', (await digestPage.cdp.evaluate('window.__webdav.state.entries.length')) >= 5);
  check('Digest 的 401 挑战被记录下来', (await digestPage.cdp.evaluate('window.__webdav.log().map(l => l.authChallenge).filter(Boolean).length')) >= 1);

  const digestFlash = await digestPage.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find(e => e.name === 'readme.txt');
    const res = await chrome.runtime.sendMessage({ type: 'DAV_REQUEST', method: 'GET', url: entry.url, auth: window.__webdav.state.auth });
    return { status: res.status, authUsed: res.authUsed, text: (res.bodyText || '').slice(0, 20) };
  })()`);
  check('Digest 下 GET 文件成功', digestFlash.status === 200 && digestFlash.authUsed === 'digest', `status=${digestFlash.status}`);

  const digestWrong = await openPage(
    `${managerBase}?url=${encodeURIComponent(servers.digest.baseUrl)}&user=demo&pass=wrong&auth=digest`,
  );
  await waitFor(() => digestWrong.cdp.evaluate('!!window.__webdav'), { message: '管理页面没加载出来' });
  await digestWrong.cdp.evaluate('window.__webdav.ready');
  check('错误密码：没有连上', (await digestWrong.cdp.evaluate('window.__webdav.state.connected')) === false);
  check('错误密码：给出 401 提示', String(await digestWrong.cdp.evaluate('document.querySelector("#status").textContent')).includes('401'));

  /* ---------------- 4. 内容脚本识别 207 XML ---------------- */

  section('内容脚本：浏览器直接打开 WebDAV 报文时自动识别');
  const xmlPage = await openPage(`${servers.anonymous.baseUrl}__xml-demo`);
  await waitFor(
    () => xmlPage.cdp.evaluate('!!document.getElementById("webdav-manager-entry")'),
    { timeout: 15000, message: '内容脚本没有注入入口' },
  ).catch(() => null);
  const pill = await xmlPage.cdp.evaluate(`(() => {
    const host = document.getElementById('webdav-manager-entry');
    if (!host) return { mounted: false };
    const button = host.querySelector('button');
    return { mounted: true, label: button ? button.textContent : null, hostTag: host.tagName };
  })()`);
  check('识别到 207 XML 并注入悬浮入口', pill.mounted === true);
  check('入口按钮文案正确', String(pill.label).includes('文件管理器'), String(pill.label));

  const beforeTabs = (await httpJson(`${BROWSER_URL}/json/list`)).length;
  if (pill.mounted) {
    await xmlPage.cdp.evaluate(`document.getElementById('webdav-manager-entry').querySelector('button').click()`);
  }
  const newTab = await waitFor(
    async () => {
      const list = await httpJson(`${BROWSER_URL}/json/list`);
      return (
        list.find((t) => {
          const url = String(t.url || '');
          if (!url.startsWith('chrome-extension://') || !url.includes('manager.html')) return false;
          if (t.id === xmlPage.targetId) return false;
          return decodeURIComponent(url).includes('__xml-demo');
        }) || null
      );
    },
    { timeout: 15000, interval: 400, message: '点击入口后没有打开文件管理器' },
  ).catch(() => null);
  check('点击入口能打开文件管理器', Boolean(newTab), newTab ? decodeURIComponent(newTab.url).slice(0, 90) : `标签数 ${beforeTabs} → ?`);
  if (newTab && newTab.url.includes('url=')) {
    check('打开时带上了当前地址', decodeURIComponent(newTab.url).includes(servers.anonymous.baseUrl));
  }

  /* ---------------- 5. 音频播放器 / 封面 / ReplayGain / MIDI ---------------- */

  section('音频播放器：封面 + ReplayGain + 播放控制');
  await page.cdp.send('Page.bringToFront');
  await page.cdp.evaluate(`(async () => {
    await window.__webdav.navigate(window.__webdav.state.baseUrl);
  })()`);

  // 先塞一个假的 MIDI 设备环境，免得依赖真实硬件
  await page.cdp.evaluate(`(() => {
    window.__fakeMidi = { sent: [], input: null, output: null, calls: 0 };
    navigator.requestMIDIAccess = async () => {
      window.__fakeMidi.calls++;
      const inputs = new Map();
      const outputs = new Map();
      const input = { id: 'in-1', name: '测试键盘', manufacturer: 'E2E', state: 'connected', onmidimessage: null };
      const output = {
        id: 'out-1', name: '测试音源', manufacturer: 'E2E', state: 'connected',
        send: (data, ts) => window.__fakeMidi.sent.push({ data: Array.from(data), ts: ts || null }),
      };
      inputs.set(input.id, input);
      outputs.set(output.id, output);
      window.__fakeMidi.input = input;
      window.__fakeMidi.output = output;
      return { inputs, outputs, onstatechange: null };
    };
  })()`);

  // 点文件行打开预览（走真实界面路径）
  const clickResult = await Promise.race([
    page.cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#file-tbody tr')]
        .find((tr) => tr.textContent.includes('sample-tone.wav'));
      if (!row) return { error: '列表里没有 sample-tone.wav：' + window.__webdav.state.entries.map((e) => e.name).join(',') };
      row.querySelector('.name-link').click();
      return { clicked: true };
    })()`),
    sleep(8000).then(() => ({ error: '点击后 8 秒没返回' })),
  ]);

  // 分次短轮询，避免一个 evaluate 挂太久看不出问题
  const playerReady = clickResult.clicked
    ? await waitFor(
        async () => {
          const state = await page.cdp.evaluate(`(() => {
            const session = window.__webdav.mediaSession();
            return {
              hasPlayer: !!document.querySelector('.player'),
              duration: session && session.backend ? session.backend.getState().durationMs : 0,
              status: (document.querySelector('#status') || {}).textContent || '',
            };
          })()`);
          return state.hasPlayer && state.duration > 0 ? state : null;
        },
        { timeout: 30000, interval: 400, message: '播放器没准备好' },
      ).catch(async (err) => {
        // 超时了就把现场状态抓回来，方便定位
        const diag = await page.cdp.evaluate(`(() => {
          const session = window.__webdav.mediaSession();
          const el = session && session.backend && session.backend.element;
          return {
            status: (document.querySelector('#status') || {}).textContent || '',
            hasSession: !!session,
            hasBackend: !!(session && session.backend),
            hasPlayer: !!document.querySelector('.player'),
            element: el ? { src: String(el.src).slice(0, 24), readyState: el.readyState, networkState: el.networkState, duration: el.duration, error: el.error ? el.error.code : null } : null,
            objectUrl: session ? String(session.objectUrl).slice(0, 24) : null,
            pageErrors: window.__webdav.state.log.slice(0, 2).map((l) => l.method + ' ' + (l.error || l.status)),
          };
        })()`);
        return { error: `${err.message} :: ${JSON.stringify(diag)}` };
      })
    : clickResult;

  const openedPlayer = playerReady.error
    ? playerReady
    : await page.cdp.evaluate(`(() => {
        const session = window.__webdav.mediaSession();
        return {
          hasPlayer: !!document.querySelector('.player'),
          backend: session && session.backend ? session.backend.getState().backend : null,
          title: document.querySelector('[data-testid="player-title"]').textContent,
          sub: document.querySelector('[data-testid="player-sub"]').textContent,
          badges: document.querySelector('[data-testid="player-badges"]').textContent,
          time: document.querySelector('[data-testid="player-time"]').textContent,
          gain: document.querySelector('[data-testid="player-gain"]').textContent,
          synthDisabled: document.querySelector('[data-testid="midi-synth"]')?.disabled,
        };
      })()`);
  check('打开音频文件会出现播放器', openedPlayer.hasPlayer === true && openedPlayer.backend === 'audio', openedPlayer.error || openedPlayer.backend);
  check('播放器显示标签里的标题与艺术家', openedPlayer.title === '测试音轨' && openedPlayer.sub.includes('WebDAV 测试'), `${openedPlayer.title} / ${openedPlayer.sub}`);
  check('时长读到 2 秒左右', /^0:00 \/ 0:0[23]$/.test(openedPlayer.time || ''), openedPlayer.time);
  check('ReplayGain 已生效（-7.32 dB）', /-7\.32 dB/.test(openedPlayer.gain || ''), openedPlayer.gain);
  check('徽标里标出了容器格式与 ReplayGain', /WAV/.test(openedPlayer.badges) && /ReplayGain/.test(openedPlayer.badges), openedPlayer.badges);
  check('音频文件下内置合成器开关不可用（只有 MIDI 文件有）', openedPlayer.synthDisabled === true, String(openedPlayer.synthDisabled));

  const lazyMidi = await page.cdp.evaluate(`(() => ({
    calls: window.__fakeMidi.calls,
    status: document.querySelector('[data-testid="midi-status"]').textContent,
    button: document.querySelector('[data-testid="midi-refresh"]').textContent,
    inputDisabled: document.querySelector('[data-testid="midi-input"]').disabled,
  }))()`);
  check('打开预览不会自动申请 Web MIDI 权限', lazyMidi.calls === 0 && /未启用 Web MIDI/.test(lazyMidi.status), JSON.stringify(lazyMidi));
  check('面板给出「启用 Web MIDI」按钮，设备选择先禁用', lazyMidi.button === '启用 Web MIDI' && lazyMidi.inputDisabled === true, JSON.stringify(lazyMidi));

  // MIDI 设置（设备 / 映射 / 时钟 / 内置合成器）对音频文件没有意义，整块收起
  const audioMidiPanel = await page.cdp.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="player-midi-panel"]');
    if (!panel) return { exists: false };
    return { exists: true, hidden: panel.hidden, height: panel.getBoundingClientRect().height };
  })()`);
  check('音频预览下整个 MIDI 设置面板隐藏', audioMidiPanel.hidden === true && audioMidiPanel.height === 0, JSON.stringify(audioMidiPanel));

  const coverState = await page.cdp.evaluate(`(() => {
    const img = document.querySelector('[data-testid="player-cover-img"]');
    if (!img) return { hasCover: false };
    return { hasCover: true, src: img.src.slice(0, 12), loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth };
  })()`);
  check('内嵌封面解析出来并渲染成图片', coverState.hasCover && coverState.loaded && coverState.width > 0, JSON.stringify(coverState));

  const tagsPanel = await page.cdp.evaluate(`(() => {
    const text = document.querySelector('[data-testid="player-tags"]')?.textContent || '';
    return {
      hasRg: text.includes('ReplayGain 音轨增益') && text.includes('-7.32 dB'),
      hasPeak: text.includes('0.9880'),
      hasSource: text.includes('ID3 TXXX'),
      hasCoverLine: /封面 #1/.test(text),
      hasAlbum: text.includes('自动化测试专辑'),
    };
  })()`);
  check('标签面板列出 ReplayGain 数值与来源', tagsPanel.hasRg && tagsPanel.hasSource, JSON.stringify(tagsPanel));
  check('标签面板列出峰值与封面信息', tagsPanel.hasPeak && tagsPanel.hasCoverLine);

  // 播放 / 暂停
  const playback = await page.cdp.evaluate(`(async () => {
    document.querySelector('[data-testid="player-toggle"]').click();
    // 轮询等位置真的往前走（无头环境起播有延迟）
    let state = window.__webdav.mediaSession().backend.getState();
    for (let i = 0; i < 40 && state.positionMs < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = window.__webdav.mediaSession().backend.getState();
    }
    const session = window.__webdav.mediaSession();
    // 频谱要等音频真正流过分析器
    let nonEmpty = 0;
    const canvas = document.querySelector('[data-testid="player-visualizer"]');
    const ctx = canvas.getContext('2d');
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      nonEmpty = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) nonEmpty++;
      if (nonEmpty > 500) break;
    }
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      played: true,
      position: state.positionMs,
      playing: state.playing,
      paused: window.__webdav.mediaSession().backend.getState().playing,
      visualizerPixels: nonEmpty,
      graphReady: state.graphReady,
    };
  })()`);
  check('点播放后进度确实在推进', playback.position > 300, `${Math.round(playback.position)}ms`);
  check('Web Audio 图搭建成功（增益与频谱可用）', playback.graphReady === true);
  check('频谱可视化画出了内容', playback.visualizerPixels > 500, `${playback.visualizerPixels} 个像素`);
  check('再次点击会暂停', playback.paused === false);

  // 定位 / 音量 / 模式切换
  const controls = await page.cdp.evaluate(`(async () => {
    const session = window.__webdav.mediaSession();
    const seek = document.querySelector('[data-testid="player-seek"]');
    const duration = session.backend.getState().durationMs;
    seek.value = '700';
    seek.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    const afterSeek = session.backend.getState().positionMs;

    const volume = document.querySelector('[data-testid="player-volume"]');
    volume.value = '40';
    volume.dispatchEvent(new Event('input'));
    const volumeState = session.backend.getState().volume;

    const mute = document.querySelector('[data-testid="player-mute"]');
    mute.click();
    const mutedState = window.__webdav.mediaSession().backend.getState();
    mute.click();

    const mode = document.querySelector('[data-testid="player-rg-mode"]');
    mode.value = 'off';
    mode.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 100));
    const offText = document.querySelector('[data-testid="player-gain"]').textContent;
    mode.value = 'album';
    mode.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 100));
    const albumText = document.querySelector('[data-testid="player-gain"]').textContent;
    mode.value = 'track';
    mode.dispatchEvent(new Event('change'));
    return { afterSeek, volumeState, muted: mutedState.muted, offText, albumText };
  })()`);
  check('拖动进度条能定位', Math.abs(controls.afterSeek - 1400) < 400, `${Math.round(controls.afterSeek)}ms（2 秒曲目拖到 70%）`);
  check('音量滑块生效', Math.abs(controls.volumeState - 0.4) < 0.01, String(controls.volumeState));
  check('静音按钮生效', controls.muted === true);
  check('ReplayGain 切到「关闭」时不再应用增益', controls.offText.includes('RG 已关闭'), controls.offText);
  check('切到「专辑」模式会用专辑增益（-5.10 dB）', /-5\.10 dB/.test(controls.albumText), controls.albumText);

  section('Web MIDI：设备控制播放器 + 时钟同步');
  // MIDI 设置面板只在 MIDI 文件预览下出现（音频下整块隐藏），所以这一节改用 demo.mid。
  // 关预览后要等 dialog 的 close 事件派发完，否则它会在新会话建好之后才把会话清掉。
  const webMidiOpened = await page.cdp.evaluate(`(async () => {
    document.querySelector('#preview-close').click();
    await new Promise((r) => setTimeout(r, 300));
    const row = [...document.querySelectorAll('#file-tbody tr')].find((tr) => tr.textContent.includes('demo.mid'));
    if (!row) return { error: '列表里没有 demo.mid：' + window.__webdav.state.entries.map((e) => e.name).join(',') };
    row.querySelector('.name-link').click();
    for (let i = 0; i < 100; i++) {
      if (window.__webdav.mediaSession()?.backend?.getState().backend === 'midi') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const panel = document.querySelector('[data-testid="player-midi-panel"]');
    return {
      backend: window.__webdav.mediaSession()?.backend?.getState().backend ?? null,
      hidden: panel ? panel.hidden : null,
      height: panel ? panel.getBoundingClientRect().height : null,
    };
  })()`);
  check(
    'MIDI 文件预览下显示 MIDI 设置面板',
    webMidiOpened.backend === 'midi' && webMidiOpened.hidden === false && webMidiOpened.height > 0,
    JSON.stringify(webMidiOpened),
  );

  // 展开 MIDI 面板是用户明确「要用 MIDI」的信号，到这一步才该申请权限
  const midiEnable = await page.cdp.evaluate(`(async () => {
    const panel = document.querySelector('[data-testid="player-midi-panel"]');
    const before = window.__fakeMidi.calls;
    if (!panel.open) panel.open = true;
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = document.querySelector('[data-testid="midi-status"]').textContent;
      if (/输入 \\d+ 个/.test(status) || /❌/.test(status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { before, calls: window.__fakeMidi.calls, status };
  })()`);
  check(
    '展开面板后才申请权限并扫描到设备',
    midiEnable.before === 0 && midiEnable.calls >= 1 && /输入 1 个 \/ 输出 1 个/.test(midiEnable.status),
    JSON.stringify(midiEnable),
  );

  // 「不监听」时任何端口来的消息都不该驱动播放器：
  // 否则 IAC / DAW 回环回来的音符（默认映射里就是停止、快退）会让播放「跳回开头」
  const midiFilter = await page.cdp.evaluate(`(async () => {
    const backend = window.__webdav.mediaSession().backend;
    backend.pause();
    await new Promise((r) => setTimeout(r, 150));
    const select = document.querySelector('[data-testid="midi-input"]');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    const before = backend.getState().playing;
    window.__fakeMidi.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) }); // C2 = 播放/暂停
    await new Promise((r) => setTimeout(r, 350));
    const ignored = window.__webdav.mediaSession().backend.getState().playing;

    select.value = 'in-1';
    select.dispatchEvent(new Event('change'));
    window.__fakeMidi.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
    let toggled = false;
    for (let i = 0; i < 20 && !toggled; i++) {
      await new Promise((r) => setTimeout(r, 100));
      toggled = window.__webdav.mediaSession().backend.getState().playing;
    }
    window.__webdav.mediaSession().backend.pause();
    await new Promise((r) => setTimeout(r, 150));
    return { before, ignored, toggled };
  })()`);
  check('「不监听」时 MIDI 消息被忽略（回环劫持不了播放）', midiFilter.before === false && midiFilter.ignored === false, JSON.stringify(midiFilter));
  check('选中输入设备后 MIDI 消息才生效', midiFilter.toggled === true, JSON.stringify(midiFilter));

  const midiUi = await page.cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="midi-input"]');
    const output = document.querySelector('[data-testid="midi-output"]');
    const status = document.querySelector('[data-testid="midi-status"]').textContent;
    return {
      inputs: [...input.options].map((o) => o.textContent),
      outputs: [...output.options].map((o) => o.textContent),
      status,
      bound: window.__fakeMidi.input && typeof window.__fakeMidi.input.onmidimessage === 'function',
    };
  })()`);
  check('MIDI 面板发现假设备', midiUi.inputs.some((t) => t.includes('测试键盘')) && midiUi.outputs.some((t) => t.includes('测试音源')), midiUi.inputs.join(','));
  check('已挂上 MIDI 消息回调', midiUi.bound === true);

  const midiControl = await page.cdp.evaluate(`(async () => {
    const session = window.__webdav.mediaSession();
    session.backend.pause();
    await new Promise((r) => setTimeout(r, 150));
    const before = session.backend.getState().playing;
    // 出厂映射：音符 C2 = 播放/暂停
    window.__fakeMidi.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
    let afterToggle = false;
    for (let i = 0; i < 20 && !afterToggle; i++) {
      await new Promise((r) => setTimeout(r, 100));
      afterToggle = window.__webdav.mediaSession().backend.getState().playing;
    }
    window.__fakeMidi.input.onmidimessage({ data: new Uint8Array([0x90, 36, 0]) });
    await new Promise((r) => setTimeout(r, 200));
    const afterStop = window.__webdav.mediaSession().backend.getState().playing;

    // CC7 → 音量
    window.__fakeMidi.input.onmidimessage({ data: new Uint8Array([0xb0, 7, 127]) });
    const volume = window.__webdav.mediaSession().backend.getState().volume;

    const monitor = document.querySelector('[data-testid="midi-monitor"]').textContent;
    return { before, afterToggle, afterStop, volume, monitor };
  })()`);
  check('MIDI 音符能切换播放/暂停', midiControl.afterToggle !== midiControl.before, `${midiControl.before} → ${midiControl.afterToggle}`);
  check('MIDI 音符关闭后仍在播放（映射的是 noteon）', midiControl.afterStop === midiControl.afterToggle);
  check('MIDI CC7 控制音量', Math.abs(midiControl.volume - 1) < 0.01, String(midiControl.volume));
  check('MIDI 监视器记录了消息', /C2|音符/.test(midiControl.monitor), midiControl.monitor.slice(0, 60));

  const midiSync = await page.cdp.evaluate(`(async () => {
    const output = document.querySelector('[data-testid="midi-output"]');
    output.value = 'out-1';
    output.dispatchEvent(new Event('change'));
    document.querySelector('[data-testid="midi-clock"]').checked = true;
    document.querySelector('[data-testid="midi-clock"]').dispatchEvent(new Event('change'));
    // 先回到开头：MIDI 文件在中途恢复播放发的应该是 Continue，
    // 从 0 开始才是 Start（这也是 SmfPlayer 的真实语义）
    const backend = window.__webdav.mediaSession().backend;
    backend.pause();
    backend.seek(0);
    await new Promise((r) => setTimeout(r, 200));
    window.__fakeMidi.sent.length = 0;

    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const sent = window.__fakeMidi.sent.slice();
    const state = window.__webdav.mediaSession().backend.getState();
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 100));
    const afterStop = window.__fakeMidi.sent.slice();
    return {
      hasStart: sent.some((m) => m.data[0] === 0xfa),
      clocks: sent.filter((m) => m.data[0] === 0xf8).length,
      hasStop: afterStop.some((m) => m.data[0] === 0xfc),
      playing: state.playing,
    };
  })()`);
  check('播放时向 MIDI 输出发送 Start', midiSync.hasStart === true);
  check('播放时持续发送 MIDI 时钟', midiSync.clocks >= 5, `${midiSync.clocks} 个时钟 tick`);
  check('暂停时发送 Stop', midiSync.hasStop === true);

  const closed = await page.cdp.evaluate(`(async () => {
    document.querySelector('#preview-close').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      session: window.__webdav.mediaSession(),
      dialogOpen: document.getElementById('preview-dialog').open,
      clockTimer: Boolean(window.__webdav.midiBridge().clock.timer),
    };
  })()`);
  check('关闭预览会清理播放会话并停掉 MIDI 时钟', closed.session === null && closed.dialogOpen === false && closed.clockTimer === false);

  section('MIDI 文件：内置合成器 + 多轨解析');
  await page.cdp.send('Page.bringToFront');
  const midiFile = await page.cdp.evaluate(`(async () => {
    const row = [...document.querySelectorAll('#file-tbody tr')].find((tr) => tr.textContent.includes('demo.mid'));
    if (!row) return { error: '列表里没有 demo.mid' };
    row.querySelector('.name-link').click();
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('.player')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const session = window.__webdav.mediaSession();
    const state = session.backend.getState();
    return {
      backend: state.backend,
      duration: state.durationMs,
      notes: state.noteCount,
      title: document.querySelector('[data-testid="player-title"]')?.textContent,
      time: document.querySelector('[data-testid="player-time"]')?.textContent,
      rateDisabled: document.querySelector('[data-testid="player-rate"]').disabled,
      tagsText: document.querySelector('[data-testid="player-tags"]')?.textContent || '',
      clockChecked: document.querySelector('[data-testid="midi-clock"]').checked,
      playerSendClock: session.backend.player.sendClock,
    };
  })()`);
  check('MIDI 文件走 MIDI 后端', midiFile.backend === 'midi', midiFile.error || midiFile.backend);
  check('发送时钟开关与播放器内部状态一致（没勾就不该往外发）', midiFile.clockChecked === midiFile.playerSendClock, `${midiFile.clockChecked} / ${midiFile.playerSendClock}`);
  check('解析出 4 个音符、2 秒时长', midiFile.notes === 4 && Math.round(midiFile.duration) === 2000, `${midiFile.notes} 音符 / ${Math.round(midiFile.duration)}ms`);
  check('显示 MIDI 曲名与时长', midiFile.title === '夹具音轨' && /0:02/.test(midiFile.time), `${midiFile.title} ${midiFile.time}`);
  check('MIDI 模式下禁用变速', midiFile.rateDisabled === true);
  check('标签面板显示轨道与音符统计', /轨道数/.test(midiFile.tagsText) && /音符数/.test(midiFile.tagsText));

  const midiPlay = await page.cdp.evaluate(`(async () => {
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const session = window.__webdav.mediaSession();
    const state = session.backend.getState();
    document.querySelector('[data-testid="player-toggle"]').click();
    return { position: state.positionMs, voices: state.activeVoices, playing: state.playing };
  })()`);
  check('MIDI 播放推进', midiPlay.position > 200, `${Math.round(midiPlay.position)}ms`);
  check('内置合成器正在发声（有活动声部）', midiPlay.voices > 0, `${midiPlay.voices} 个声部`);

  const midiEnd = await page.cdp.evaluate(`(async () => {
    const backend = window.__webdav.mediaSession().backend;
    backend.seek(0);
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('[data-testid="player-toggle"]').click();
    let state = backend.getState();
    for (let i = 0; i < 40 && state.playing; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = backend.getState();
    }
    const atEnd = {
      playing: state.playing,
      position: state.positionMs,
      seek: document.querySelector('[data-testid="player-seek"]').value,
      time: document.querySelector('[data-testid="player-time"]').textContent,
    };
    // 再等一会儿：确认它不会自己跳回开头重播（这正是用户报告的「到第 2 秒跳回开头」）
    await new Promise((r) => setTimeout(r, 900));
    const later = backend.getState();
    return {
      duration: backend.getState().durationMs,
      atEnd,
      later: { playing: later.playing, position: later.positionMs },
    };
  })()`);
  check(
    'MIDI 播到结尾停在末尾并停住（不自动跳回开头）',
    midiEnd.atEnd.playing === false && Math.round(midiEnd.atEnd.position) === Math.round(midiEnd.duration) && midiEnd.later.playing === false && Math.round(midiEnd.later.position) === Math.round(midiEnd.duration),
    JSON.stringify(midiEnd),
  );
  check('播完后进度条停在最右端', midiEnd.atEnd.seek === '1000' && /0:02 \/ 0:02/.test(midiEnd.atEnd.time), JSON.stringify(midiEnd.atEnd));

  const synthSwitch = await page.cdp.evaluate(`(async () => {
    const findBox = () => document.querySelector('[data-testid="midi-synth"]');
    const box = findBox();
    if (!box) return { error: 'MIDI 面板里没有合成器开关' };
    const state = window.__webdav.mediaSession().backend.getState();
    const initial = { checked: box.checked, disabled: box.disabled, enabled: state.synthEnabled };
    // 关掉开关：进度照常推进，但不该再有本地声部
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 150));
    const offEnabled = window.__webdav.mediaSession().backend.getState().synthEnabled;
    let storedOff = 'unavailable';
    try {
      const stored = await chrome.storage.local.get('midiSettings');
      storedOff = stored?.midiSettings?.synthEnabled;
    } catch {
      /* 读不到就标记 unavailable */
    }
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const offPlaying = window.__webdav.mediaSession().backend.getState();
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const statusOff = document.querySelector('[data-testid="midi-status"]').textContent;

    // 关掉预览重新打开同一个文件：设置应该被记住
    document.querySelector('#preview-close').click();
    await new Promise((r) => setTimeout(r, 300));
    const row = [...document.querySelectorAll('#file-tbody tr')].find((tr) => tr.textContent.includes('demo.mid'));
    if (!row) return { error: '重新打开时列表里没有 demo.mid' };
    row.querySelector('.name-link').click();
    for (let i = 0; i < 60 && !findBox(); i++) await new Promise((r) => setTimeout(r, 100));
    const reopenedBox = findBox();
    const reopened = {
      checked: reopenedBox?.checked,
      disabled: reopenedBox?.disabled,
      enabled: window.__webdav.mediaSession().backend.getState().synthEnabled,
    };

    // 打开回来：回到开头再播，声部应重新出现
    reopenedBox.checked = true;
    reopenedBox.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 100));
    const onState = window.__webdav.mediaSession().backend.getState();
    window.__webdav.mediaSession().backend.seek(0);
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const onPlaying = window.__webdav.mediaSession().backend.getState();
    document.querySelector('[data-testid="player-toggle"]').click();
    await new Promise((r) => setTimeout(r, 150));
    return {
      error: null,
      initialChecked: initial.checked,
      initialDisabled: initial.disabled,
      initialEnabled: initial.enabled,
      offEnabled,
      storedOff,
      offVoices: offPlaying.activeVoices,
      offPosition: offPlaying.positionMs,
      reopenedChecked: reopened.checked,
      reopenedDisabled: reopened.disabled,
      reopenedEnabled: reopened.enabled,
      onEnabled: onState.synthEnabled,
      onVoices: onPlaying.activeVoices,
      statusOn: document.querySelector('[data-testid="midi-status"]').textContent,
      statusOff,
    };
  })()`);
  check('MIDI 面板里的合成器开关默认打开且可用', synthSwitch.initialChecked === true && synthSwitch.initialDisabled === false && synthSwitch.initialEnabled === true, synthSwitch.error || JSON.stringify(synthSwitch));
  check('关掉合成器后播放不再有活动声部（进度仍在走）', synthSwitch.offEnabled === false && synthSwitch.offVoices === 0 && synthSwitch.offPosition > 200, JSON.stringify(synthSwitch));
  check('开关状态写入 chrome.storage', synthSwitch.storedOff === false, String(synthSwitch.storedOff));
  check('重新打开文件后开关状态被记住（仍是关闭）', synthSwitch.reopenedChecked === false && synthSwitch.reopenedDisabled === false && synthSwitch.reopenedEnabled === false, JSON.stringify(synthSwitch));
  check('重新打开合成器后声部重新出现', synthSwitch.onEnabled === true && synthSwitch.onVoices > 0, `${synthSwitch.onVoices} 个声部`);
  check('状态栏实时显示合成器开关', /合成器开/.test(synthSwitch.statusOn || '') && /合成器关/.test(synthSwitch.statusOff || ''), `${synthSwitch.statusOn} / ${synthSwitch.statusOff}`);

  await page.cdp.evaluate(`document.querySelector('#preview-close').click()`);

  section('真实文件：MP3 的封面与 ReplayGain');
  await page.cdp.send('Page.bringToFront');
  const realMp3 = await page.cdp.evaluate(`(async () => {
    await window.__webdav.navigate(window.__webdav.state.baseUrl + '%E9%9F%B3%E4%B9%90/');
    const row = [...document.querySelectorAll('#file-tbody tr')].find((tr) => tr.textContent.includes('浮夸'));
    if (!row) return { error: '音乐目录里没找到示例 MP3：' + window.__webdav.state.entries.map((e) => e.name).join(',') };
    row.querySelector('.name-link').click();
    for (let i = 0; i < 200; i++) {
      if (document.querySelector('[data-testid="player-cover-img"]')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const img = document.querySelector('[data-testid="player-cover-img"]');
    const session = window.__webdav.mediaSession();
    return {
      title: document.querySelector('[data-testid="player-title"]')?.textContent,
      sub: document.querySelector('[data-testid="player-sub"]')?.textContent,
      gain: document.querySelector('[data-testid="player-gain"]')?.textContent,
      coverLoaded: img ? img.complete && img.naturalWidth > 0 : false,
      badges: document.querySelector('[data-testid="player-badges"]')?.textContent,
      time: document.querySelector('[data-testid="player-time"]')?.textContent,
      format: session?.metadata?.format,
    };
  })()`);
  if (realMp3.error) {
    check('真实 MP3 预览（未找到示例文件则跳过）', true, realMp3.error);
  } else {
    check('真实 MP3：GBK 标签正确显示', realMp3.title === '浮夸' && realMp3.sub.includes('陈奕迅'), `${realMp3.title} / ${realMp3.sub}`);
    check('真实 MP3：2.1MB 内嵌封面渲染成功', realMp3.coverLoaded === true);
    check('真实 MP3：ReplayGain -9.21 dB 已应用', /-9\.21 dB/.test(realMp3.gain || ''), realMp3.gain);
    check('真实 MP3：时长正常', /^0:0\d \/ \d+:\d\d$/.test(realMp3.time || ''), realMp3.time);
  }

  // 回归：GBK 曲名的 MIDI。
  // 「室内系的」的 GBK 字节全落在 0xA1–0xDF，而这正是 Shift-JIS 的单字节半角片假名区：
  // 按「能解通就用」的顺序猜（shift_jis 排在 gbk 前面），曲名会安静地变成
  // ﾊﾒﾄﾚﾏｵｵﾄTrackMaker —— 不抛异常，也没有替换字符。
  section('真实文件：GBK 曲名的 MIDI');
  const gbkMidi = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find((item) => item.name.includes('TrackMaker'));
    if (!entry) return { error: '音乐目录里没找到示例 MIDI：' + window.__webdav.state.entries.map((e) => e.name).join(',') };
    // 上次的预览还开着：先关掉，并等 dialog 的 close 事件派发完。
    // close 事件是异步的，不等它就会在新会话建好之后才触发 closeMediaSession，
    // 把刚建好的会话连同播放器 UI 一起清掉（真实用户点不了这么快，是测试专有的竞态）。
    document.querySelector('#preview-close').click();
    await new Promise((r) => setTimeout(r, 300));
    try {
      await window.__webdav.previewMedia(entry);
    } catch (err) {
      return { error: '预览失败：' + (err && err.message ? err.message : err) };
    }
    const state = window.__webdav.mediaSession()?.backend?.getState();
    return {
      title: document.querySelector('[data-testid="player-title"]')?.textContent,
      backend: state?.backend ?? null,
      noteCount: state?.noteCount,
      tagsText: document.querySelector('[data-testid="player-tags"]')?.textContent || '',
      status: document.querySelector('#status')?.textContent,
    };
  })()`);
  if (gbkMidi.error) {
    check('真实 GBK MIDI 预览（未找到示例文件则跳过）', true, gbkMidi.error);
  } else {
    check('真实 MIDI：GBK 曲名不被 Shift-JIS 抢走', gbkMidi.title === '室内系的TrackMaker', `${gbkMidi.title}（${gbkMidi.backend} / ${gbkMidi.status}）`);
    check('真实 MIDI：17 轨、5503 个音符解析正常', gbkMidi.backend === 'midi' && gbkMidi.noteCount === 5503 && /17/.test(gbkMidi.tagsText), `${gbkMidi.backend} / ${gbkMidi.noteCount} 音符 / ${gbkMidi.tagsText.slice(0, 40)}`);
  }
  await page.cdp.evaluate(`document.querySelector('#preview-close').click()`);

  // 回归：分块下载必须把整个文件读完。
  // 以前 Content-Range 的正则少写了两个捕获组，取到 undefined → NaN，
  // 于是读完第一块（8MB）就停，所有大于 8MB 的文件都被悄悄截断
  // （96kHz FLAC 大约 8MB ≈ 16 秒，表现为「播到 16 秒报错误码 2」）。
  const fullFetch = await page.cdp.evaluate(`(async () => {
    const entry = window.__webdav.state.entries.find((item) => item.name.includes('浮夸'));
    if (!entry) return { error: '音乐目录里没找到示例 MP3' };
    const blob = await window.__webdav.fetchFileAsBlob(entry.url);
    return { size: blob.size, expected: entry.size };
  })()`);
  if (fullFetch.error) {
    check('大文件分块下载完整（未找到示例文件则跳过）', true, fullFetch.error);
  } else {
    check('13.5MB 的 MP3 分块下载完整（回归：>8MB 被截断）', fullFetch.size === fullFetch.expected, `${fullFetch.size} / ${fullFetch.expected} 字节`);
  }
  await page.cdp.evaluate(`document.querySelector('#preview-close').click()`);
  await page.cdp.evaluate(`window.__webdav.navigate(window.__webdav.state.baseUrl)`);

  /* ---------------- 6. popup ---------------- */

  section('工具栏弹窗');
  const popupPage = await openPage(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await waitFor(() => popupPage.cdp.evaluate('document.readyState === "complete"'), { message: 'popup 没加载' });
  await sleep(600);
  const popupState = await popupPage.cdp.evaluate(`({
    url: document.querySelector('#url').value,
    options: [...document.querySelectorAll('#authMode option')].map(o => o.value),
  })`);
  check('popup 读取到上次连接的地址', popupState.url.startsWith('http'), popupState.url);
  check('popup 提供四种认证方式', popupState.options.length === 4, popupState.options.join(','));

  /* ---------------- 收尾 ---------------- */

  console.log('\n' + '─'.repeat(70));
  console.log(`通过 ${results.length - failures} / ${results.length}`);
  if (failures) {
    console.log('失败项：');
    for (const item of results.filter((r) => !r.ok)) console.log(`  ✖ ${item.name} ${item.detail}`);
  }
  const edgeErrors = [];
  if (existsSync(resolve(tmpDir, 'edge.log'))) {
    const log = (await import('node:fs')).readFileSync(resolve(tmpDir, 'edge.log'), 'utf8');
    for (const line of log.split('\n')) {
      if (/extension.*error|Failed to load extension|Manifest/i.test(line)) edgeErrors.push(line.trim());
    }
  }
  if (edgeErrors.length) {
    console.log('浏览器日志里的可疑行：');
    for (const line of edgeErrors.slice(0, 5)) console.log(`  ! ${line}`);
  }

  await killEdge();
  await Promise.all(Object.values(servers).map((s) => s.close()));
  return failures;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('\n测试执行失败：', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  shuttingDown = true;
  await killEdge().catch(() => {});
  if (edgeLogFd) {
    try {
      (await import('node:fs')).closeSync(edgeLogFd);
    } catch {
      /* 忽略 */
    }
  }
}

process.exit(failures === 0 && exitCode === 0 ? 0 : 1);
