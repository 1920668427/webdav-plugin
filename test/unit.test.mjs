/**
 * 单元测试：纯逻辑部分（不依赖浏览器 API 的模块）。
 *
 *   node --test test/
 *
 * 需要浏览器环境的解析器（src/lib/xml.js）由 test/e2e.mjs 在真实 Edge 里验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { md5Hex, toHex, utf8Bytes } from '../src/lib/md5.js';
import {
  parseChallenges,
  parseAuthParams,
  buildDigestAuthorization,
  buildBasicAuthorization,
  pickSupportedChallenge,
} from '../src/lib/digest.js';
import {
  parentUrl,
  joinUrl,
  relativeSegments,
  normalizeServerUrl,
  ensureTrailingSlash,
  formatBytes,
  formatDateTime,
  fileKind,
  sanitizeFilename,
  guessContentType,
  nameFromUrl,
  resolveHref,
  parseDavCapabilities,
  isUnder,
  canPreview,
} from '../src/lib/webdav.js';
import { bytesToBase64, base64ToBytes, textToBase64, base64ToText } from '../src/lib/bytes.js';

/* ------------------------------ MD5 ------------------------------ */

test('MD5：RFC 1321 标准测试向量', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('a'), '0cc175b9c0f1b6a831c399e269772661');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(md5Hex('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b');
  assert.equal(
    md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );
  assert.equal(
    md5Hex('The quick brown fox jumps over the lazy dog'),
    '9e107d9d372bb6826bd81d3542a419d6',
  );
});

test('MD5：中文按 UTF-8 计算', () => {
  assert.equal(md5Hex('中文'), 'a7bac2239fcdcb3a067903d8077c4a07');
  assert.equal(toHex(utf8Bytes('中')), 'e4b8ad');
});

test('MD5：跨分组边界（55/56/64 字节）', () => {
  const a = md5Hex('a'.repeat(55));
  const b = md5Hex('a'.repeat(56));
  const c = md5Hex('a'.repeat(64));
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  // 已知向量校验（通过独立实现复核）
  assert.equal(md5Hex('a'.repeat(64)), '014842d480b571495a4a0363793f7367');
});

/* ---------------------------- 认证解析 ---------------------------- */

test('认证：解析单个 Basic 挑战', () => {
  const [challenge] = parseChallenges('Basic realm="webdav-test", charset="UTF-8"');
  assert.equal(challenge.scheme, 'Basic');
  assert.equal(challenge.params.realm, 'webdav-test');
  assert.equal(challenge.params.charset, 'UTF-8');
});

test('认证：解析 Digest 挑战的全部参数', () => {
  const header =
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
  const [challenge] = parseChallenges(header);
  assert.equal(challenge.scheme, 'Digest');
  assert.equal(challenge.params.realm, 'testrealm@host.com');
  assert.equal(challenge.params.qop, 'auth,auth-int');
  assert.equal(challenge.params.nonce, 'dcd98b7102dd2f0e8b11d0f600bfb0c093');
  assert.equal(challenge.params.opaque, '5ccc069c403ebaf9f0171e9517f40e41');
});

test('认证：一个响应头里同时出现 Basic 和 Digest 时优先 Digest', () => {
  const header = 'Basic realm="simple", Digest realm="test", nonce="abc123", qop="auth"';
  const list = parseChallenges(header);
  assert.equal(list.length, 2);
  assert.equal(list[0].scheme, 'Basic');
  assert.equal(list[1].scheme, 'Digest');
  assert.equal(list[1].params.nonce, 'abc123');
  const picked = pickSupportedChallenge(header);
  assert.equal(picked.scheme, 'Digest');
});

test('认证：解析无引号参数', () => {
  const params = parseAuthParams('realm=test, nonce=abc, stale=false');
  assert.deepEqual(params, { realm: 'test', nonce: 'abc', stale: 'false' });
});

test('认证：Basic 头是 UTF-8 后的 base64', () => {
  assert.equal(buildBasicAuthorization('demo', 'demo'), `Basic ${Buffer.from('demo:demo').toString('base64')}`);
  assert.equal(buildBasicAuthorization('用户', '密码'), `Basic ${Buffer.from('用户:密码', 'utf8').toString('base64')}`);
});

test('认证：Digest 计算与 RFC 2617 示例一致', async () => {
  const header = await buildDigestAuthorization({
    params: {
      realm: 'testrealm@host.com',
      qop: 'auth,auth-int',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    },
    method: 'GET',
    requestUri: '/dir/index.html',
    username: 'Mufasa',
    password: 'Circle Of Life',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(header, /^Digest /);
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /qop=auth\b/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('认证：无 qop 的老式 Digest 也要能算', async () => {
  const header = await buildDigestAuthorization({
    params: { realm: 'test', nonce: 'n1' },
    method: 'PROPFIND',
    requestUri: '/dav/',
    username: 'u',
    password: 'p',
  });
  assert.match(header, /response="[0-9a-f]{32}"/);
  assert.doesNotMatch(header, /qop=/);
});

test('认证：SHA-256 摘要（RFC 7616 风格）', async () => {
  const header = await buildDigestAuthorization({
    params: { realm: 'r', nonce: 'n', algorithm: 'SHA-256', qop: 'auth' },
    method: 'GET',
    requestUri: '/',
    username: 'u',
    password: 'p',
    cnonce: 'abcdef',
  });
  assert.match(header, /algorithm=SHA-256/);
  assert.match(header, /response="[0-9a-f]{64}"/);
});

/* ---------------------------- URL / 路径 ---------------------------- */

test('URL：补全协议与结尾斜杠', () => {
  assert.equal(normalizeServerUrl('dav.example.com/dav'), 'http://dav.example.com/dav');
  assert.equal(ensureTrailingSlash('http://h/dav'), 'http://h/dav/');
  assert.equal(ensureTrailingSlash('http://h/dav/'), 'http://h/dav/');
  assert.throws(() => normalizeServerUrl('ftp://h/x'), /仅支持/);
});

test('URL：父级目录计算', () => {
  assert.equal(parentUrl('http://h/dav/a/b/'), 'http://h/dav/a/');
  assert.equal(parentUrl('http://h/dav/a/b.txt'), 'http://h/dav/a/');
  assert.equal(parentUrl('http://h/dav/'), 'http://h/');
  assert.equal(parentUrl('http://h/dav/中文 名/'), 'http://h/dav/');
});

test('URL：拼接子项时进行百分号编码', () => {
  assert.equal(joinUrl('http://h/dav/', '中文 名.txt'), 'http://h/dav/%E4%B8%AD%E6%96%87%20%E5%90%8D.txt');
  assert.equal(joinUrl('http://h/dav', 'a'), 'http://h/dav/a');
});

test('URL：解析服务器返回的 href', () => {
  assert.equal(resolveHref('/dav/docs/', 'http://h/dav/'), 'http://h/dav/docs/');
  assert.equal(resolveHref('http://other/x', 'http://h/dav/'), 'http://other/x');
  assert.equal(nameFromUrl('http://h/dav/%E4%B8%AD%E6%96%87.txt'), '中文.txt');
});

test('URL：相对根路径切分（面包屑）', () => {
  assert.deepEqual(relativeSegments('http://h/dav/a/b/', 'http://h/dav/'), ['a', 'b']);
  assert.deepEqual(relativeSegments('http://h/dav/', 'http://h/dav/'), []);
  assert.deepEqual(relativeSegments('http://h/%E4%B8%AD%E6%96%87/', 'http://h/'), ['中文']);
});

test('URL：isUnder 判断', () => {
  assert.equal(isUnder('http://h/dav/a/', 'http://h/dav/'), true);
  assert.equal(isUnder('http://h/other/', 'http://h/dav/'), false);
  assert.equal(isUnder('http://h2/dav/a/', 'http://h/dav/'), false);
});

/* ---------------------------- 展示格式 ---------------------------- */

test('格式化：字节数', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatBytes(''), '');
});

test('格式化：时间', () => {
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime('不是时间'), '不是时间');
  assert.match(formatDateTime('Fri, 03 Oct 2025 10:00:00 GMT'), /^2025-10-0[34] \d\d:00$/);
});

test('类型：扩展名识别', () => {
  assert.equal(fileKind('a.png'), 'image');
  assert.equal(fileKind('a.MP4'), 'video');
  assert.equal(fileKind('a.tar.gz'), 'archive');
  assert.equal(fileKind('a.md'), 'text');
  assert.equal(fileKind('a.js'), 'code');
  assert.equal(fileKind('目录', true), 'folder');
  assert.equal(fileKind('未知类型.qqq'), 'file');
  assert.equal(fileKind('无扩展名'), 'file');
  assert.equal(fileKind('x', false, 'image/jpeg'), 'image');
  assert.equal(canPreview('image'), true);
  assert.equal(canPreview('file'), false);
});

test('类型：Content-Type 猜测', () => {
  assert.equal(guessContentType('a.txt'), 'text/plain; charset=utf-8');
  assert.equal(guessContentType('a.png'), 'image/png');
  assert.equal(guessContentType('a.unknown'), 'application/octet-stream');
});

test('文件名净化：去掉路径穿越与非法字符', () => {
  // 斜杠先变成下划线，开头的连续点再被剥掉，结果一定是纯文件名
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('....//x'), '__x');
  assert.ok(!sanitizeFilename('../../etc/passwd').includes('/'));
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFilename(''), 'download');
});

test('能力解析：DAV 头', () => {
  assert.deepEqual(parseDavCapabilities('1, 2, 3', 'OPTIONS, GET, PROPFIND'), {
    classes: [1, 2, 3],
    extras: [],
    methods: ['OPTIONS', 'GET', 'PROPFIND'],
  });
  assert.deepEqual(parseDavCapabilities('1, extended-mkcol', ''), {
    classes: [1],
    extras: ['extended-mkcol'],
    methods: [],
  });
  assert.deepEqual(parseDavCapabilities('', ''), { classes: [], extras: [], methods: [] });
});

/* ---------------------------- base64 ---------------------------- */

test('base64：字节往返', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

test('base64：文本往返（含中文与 emoji）', () => {
  const text = '你好，WebDAV 🗄️\n第二行';
  assert.equal(base64ToText(textToBase64(text)), text);
});

test('base64：超过 32KB 的分块编码不出错', () => {
  const bytes = new Uint8Array(100_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const round = base64ToBytes(bytesToBase64(bytes));
  assert.equal(round.length, bytes.length);
  assert.equal(round[99_999], bytes[99_999]);
});
