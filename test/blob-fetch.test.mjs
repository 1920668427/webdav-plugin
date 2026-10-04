/**
 * 分块下载（src/lib/blob-fetch.js）的单元测试。
 *
 *   node --test test/blob-fetch.test.mjs
 *
 * 重点之一是回归：服务器回 `Content-Range: bytes a-b/*`（RFC 7233 允许总长未知）
 * 或者干脆不带 Content-Range 时，也必须把文件读完。以前只认总长，会在第一块
 * （默认 8MB）之后停下，把截断的 Blob 交给播放器 —— 96kHz/24bit 的 FLAC 大约
 * 8MB ≈ 16 秒，于是表现为「播到约 16 秒报音频解码失败（错误码 2）」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAsBlob } from '../src/lib/blob-fetch.js';

const CHUNK = 64 * 1024; // 测试里用小块，行为与默认 8MB 一致
const SIZE = 300 * 1024; // 300KB → 4 个满块 + 1 个短块

const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/**
 * 造一个「虚拟文件服务器」。
 *   mode: 'full'  → `bytes a-b/total`（正常服务器）
 *         'star'  → `bytes a-b/*`（总长未知，合法）
 *         'none'  → 不带 Content-Range
 *   ignoreRange → 直接回 200 全量正文
 */
function makeServer({ size = SIZE, mode = 'full', ignoreRange = false, stopAfterChunks = Infinity, failStatus = null, omitBody = false } = {}) {
  const calls = [];
  const request = async (req) => {
    const range = req.headers?.Range || null;
    calls.push({ range, method: req.method, auth: req.auth, maxBytes: req.maxBytes });

    if (failStatus) return { status: failStatus, statusText: 'Server Error', headerMap: {} };
    if (omitBody) return { status: 200, statusText: 'OK', headerMap: { 'content-length': String(size) }, bodyOmitted: true };

    if (ignoreRange || !range) {
      return { status: 200, statusText: 'OK', headerMap: { 'content-length': String(size) }, bodyBase64: toBase64(new Uint8Array(size)) };
    }

    const match = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(match[1]);
    let end = Math.min(Number(match[2]), size - 1);

    if (start >= size) return { status: 416, statusText: 'Range Not Satisfiable', headerMap: { 'content-range': `bytes */${size}` } };
    if (calls.length > stopAfterChunks) return { status: 206, statusText: 'Partial Content', headerMap: {}, bodyBase64: '' };

    const length = end - start + 1;
    const headerMap = {};
    if (mode === 'full') headerMap['content-range'] = `bytes ${start}-${end}/${size}`;
    if (mode === 'star') headerMap['content-range'] = `bytes ${start}-${end}/*`;

    return { status: 206, statusText: 'Partial Content', headerMap, bodyBase64: toBase64(new Uint8Array(length)) };
  };
  return { request, calls };
}

test('分块下载：正常服务器（带总长）读到完整文件', async () => {
  const server = makeServer({ mode: 'full' });
  const progress = [];
  const blob = await fetchAsBlob({
    url: 'http://dav/big.flac',
    request: server.request,
    chunkSize: CHUNK,
    onProgress: (offset, total) => progress.push([offset, total]),
  });

  assert.equal(blob.size, SIZE);
  assert.equal(server.calls.length, 5, '4 个满块 + 1 个短块');
  assert.equal(progress.at(-1)[0], SIZE);
  assert.equal(progress.at(-1)[1], SIZE);
  assert.match(server.calls[0].range, /^bytes=0-65535$/);
  assert.match(server.calls[1].range, /^bytes=65536-131071$/);
  assert.equal(server.calls[0].method, 'GET');
});

test('分块下载：Content-Range 的总长是 *（回归：播到 16 秒被截断）', async () => {
  const server = makeServer({ mode: 'star' });
  const blob = await fetchAsBlob({ url: 'http://dav/96k.flac', request: server.request, chunkSize: CHUNK });

  assert.equal(blob.size, SIZE, '总长未知也必须读完整，不能只拿第一块');
  assert.equal(server.calls.length, 5, '短读之后才知道到底了');
});

test('分块下载：服务器不带 Content-Range 时也要读完', async () => {
  const server = makeServer({ mode: 'none' });
  const blob = await fetchAsBlob({ url: 'http://dav/a.flac', request: server.request, chunkSize: CHUNK });
  assert.equal(blob.size, SIZE);
});

test('分块下载：服务器忽略 Range（200 一次给全）', async () => {
  const server = makeServer({ mode: 'none', ignoreRange: true });
  const blob = await fetchAsBlob({ url: 'http://dav/small.mp3', request: server.request, chunkSize: CHUNK });
  assert.equal(blob.size, SIZE);
  assert.equal(server.calls.length, 1, '既然一次给全了就不该再发第二次请求');
});

test('分块下载：文件大小正好是块大小的整数倍（末尾用 416 收尾）', async () => {
  const server = makeServer({ mode: 'star', size: CHUNK * 3 });
  const blob = await fetchAsBlob({ url: 'http://dav/exact.flac', request: server.request, chunkSize: CHUNK });
  assert.equal(blob.size, CHUNK * 3);
  assert.equal(server.calls.length, 4, '3 块 + 一次 416 探测');
});

test('分块下载：已知总长时不会多发一次越界请求', async () => {
  const server = makeServer({ mode: 'full', size: CHUNK * 3 });
  const blob = await fetchAsBlob({ url: 'http://dav/exact.flac', request: server.request, chunkSize: CHUNK });
  assert.equal(blob.size, CHUNK * 3);
  assert.equal(server.calls.length, 3);
});

test('分块下载：服务器中途断开时报错，而不是把半截文件交给播放器', async () => {
  const server = makeServer({ mode: 'star', stopAfterChunks: 2 });
  await assert.rejects(
    () => fetchAsBlob({ url: 'http://dav/half.flac', request: server.request, chunkSize: CHUNK }),
    /读取中断/,
  );
});

test('分块下载：服务器不支持 Range 且文件超过单次上限时给出可读错误', async () => {
  const server = makeServer({ omitBody: true });
  await assert.rejects(
    () => fetchAsBlob({ url: 'http://dav/huge.flac', request: server.request, chunkSize: CHUNK }),
    /单次读取上限/,
  );
});

test('分块下载：HTTP 错误直接抛出', async () => {
  const server = makeServer({ failStatus: 500 });
  await assert.rejects(() => fetchAsBlob({ url: 'http://dav/x.flac', request: server.request, chunkSize: CHUNK }), /HTTP 500/);
});

test('分块下载：超过 maxBytes 的文件拒绝预览', async () => {
  const server = makeServer({ mode: 'full' });
  await assert.rejects(
    () => fetchAsBlob({ url: 'http://dav/big.flac', request: server.request, chunkSize: CHUNK, maxBytes: CHUNK * 2 }),
    /暂不支持在线预览/,
  );
});

test('分块下载：认证信息与每块的大小上限透传给请求层', async () => {
  const server = makeServer({ mode: 'full' });
  await fetchAsBlob({
    url: 'http://dav/a.flac',
    request: server.request,
    auth: { mode: 'basic', username: 'demo', password: 'demo' },
    chunkSize: CHUNK,
  });
  assert.equal(server.calls[0].auth.username, 'demo');
  assert.equal(server.calls[0].maxBytes, CHUNK * 2);
});
