/**
 * 一个极简的 Chrome DevTools Protocol 客户端（零依赖，用 Node 内置的 WebSocket）。
 * 只实现测试需要的能力：连接目标、发命令、监听事件、执行脚本。
 */

import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function httpJson(url, method = 'GET') {
  const res = await fetch(url, { method, body: method === 'GET' ? undefined : '' });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
}

export async function waitFor(fn, { timeout = 30000, interval = 250, message = '等待超时' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`${message}${lastError ? `（最后一次错误：${lastError.message}）` : ''}`);
}

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      this.closed = true;
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`无法连接 ${webSocketUrl}`)), { once: true });
    });
    return new Cdp(socket);
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) || []) handler(message.params);
      for (const handler of this.handlers.get('*') || []) handler(message);
    }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, 60000);
    });
  }

  /** 在页面里执行一段表达式，默认等待 Promise 并返回值 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
      timeout: 60000,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text;
      throw new Error(`页面执行异常：${description}`);
    }
    return result.result?.value;
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 未打包扩展的 ID：Chrome 取扩展目录绝对路径的 SHA-256 前 16 字节，
 * 每个 nibble 映射成 a-p 的字母。这样不必等 Preferences 落盘也能拿到 ID。
 */
export function unpackedExtensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}
