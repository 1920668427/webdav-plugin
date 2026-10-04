/**
 * 一个零依赖的测试用 WebDAV 服务器。
 *
 *   node tools/webdav-server.mjs --port 8899 --root .tmp/davroot --auth basic --user demo --pass demo
 *
 * 支持：OPTIONS / PROPFIND(Depth 0,1) / GET / HEAD / PUT / DELETE / MKCOL /
 *       MOVE / COPY / PROPPATCH / LOCK / UNLOCK
 * 认证：none | basic | digest（Digest 用于验证扩展里的摘要实现）
 */

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTaggedWav, buildMidiFile } from '../test/fixtures.mjs';

const REALM = 'webdav-test';

/* --------------------------- 认证 --------------------------- */

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function makeDigestChallenge() {
  const nonce = randomBytes(12).toString('hex');
  return {
    header: `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${md5(nonce)}", algorithm=MD5`,
    nonce,
  };
}

function parseAuthHeader(header) {
  if (!header) return null;
  const scheme = header.split(/\s+/)[0];
  const params = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(header)) !== null) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return { scheme, params };
}

function checkBasic(header, user, pass) {
  const parsed = parseAuthHeader(header);
  if (!parsed || !/^basic$/i.test(parsed.scheme)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  return decoded === `${user}:${pass}`;
}

function checkDigest({ header, method, uri, user, pass, nonce }) {
  const parsed = parseAuthHeader(header);
  if (!parsed || !/^digest$/i.test(parsed.scheme)) return false;
  const p = parsed.params;
  if (p.nonce !== nonce) return false;
  const ha1 = md5(`${user}:${REALM}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  let expected;
  if (p.qop) {
    expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  } else {
    expected = md5(`${ha1}:${p.nonce}:${ha2}`);
  }
  return expected === p.response;
}

/* --------------------------- XML --------------------------- */

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** target 是否位于 root 内（避免前缀误判，如 /a/b 与 /a/bc） */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把路径编码成 href（保留 /，编码其余字符） */
function encodeHref(pathname) {
  return pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%2F/gi, '/'))
    .join('/');
}

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function escapeForXmlText(text) {
  return escapeXml(text);
}

async function buildResponseXml({ fsPath, hrefPath, stat, depth, isRoot }) {
  const parts = [];
  const entries = [{ fsPath, hrefPath, stat }];

  if (stat.isDirectory() && depth !== '0') {
    const children = await fsp.readdir(fsPath, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(fsPath, child.name);
      const childStat = await fsp.stat(childPath);
      entries.push({
        fsPath: childPath,
        hrefPath: `${hrefPath.replace(/\/$/, '')}/${child.name}`,
        stat: childStat,
      });
    }
  }

  for (const entry of entries) {
    const isDir = entry.stat.isDirectory();
    const href = isDir ? `${entry.hrefPath.replace(/\/$/, '')}/` : entry.hrefPath;
    const name = path.basename(entry.fsPath);
    const etag = `"${md5(`${entry.fsPath}:${entry.stat.mtimeMs}:${entry.stat.size}`)}"`;
    const props = [
      '<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>',
      `<D:displayname>${escapeForXmlText(name)}</D:displayname>`,
      `<D:getlastmodified>${entry.stat.mtime.toUTCString()}</D:getlastmodified>`,
      `<D:creationdate>${entry.stat.birthtime.toISOString()}</D:creationdate>`,
      `<D:getetag>${etag}</D:getetag>`,
      isDir
        ? '<D:getcontenttype>httpd/unix-directory</D:getcontenttype>'
        : `<D:getcontenttype>${escapeForXmlText(contentTypeFor(entry.fsPath))}</D:getcontenttype>`,
      isDir ? '' : `<D:getcontentlength>${entry.stat.size}</D:getcontentlength>`,
      '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
      '<D:quota-available-bytes>1073741824</D:quota-available-bytes>',
      '<D:quota-used-bytes>1024</D:quota-used-bytes>',
    ]
      .filter(Boolean)
      .join('\n        ');

    parts.push(`  <D:response>
    <D:href>${escapeXml(encodeHref(href))}</D:href>
    <D:propstat>
      <D:prop>
        ${props}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`);
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${parts.join('\n')}
</D:multistatus>
`;
}

/* --------------------------- 服务器 --------------------------- */

const METHODS = 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';

export async function startServer(options = {}) {
  const config = {
    port: options.port ?? 8899,
    host: options.host ?? '127.0.0.1',
    root: options.root ?? path.resolve(process.cwd(), '.tmp/davroot'),
    auth: options.auth ?? 'none', // none | basic | digest
    username: options.username ?? 'demo',
    password: options.password ?? 'demo',
    seed: options.seed ?? true,
    samplesDir: options.samplesDir ?? null,
    quiet: options.quiet ?? false,
  };

  await fsp.mkdir(config.root, { recursive: true });
  if (config.seed) {
    const copied = await seedTree(config.root, config.samplesDir);
    if (copied && !config.quiet) console.log(`已把 ${copied} 个真实媒体文件放进 /音乐/`);
  }

  let nonce = randomBytes(12).toString('hex');

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    // req.url 有可能是 '//' 这类协议相对路径，直接 new URL 会抛异常把整个服务打挂
    const hostHeader = req.headers.host || 'localhost';
    const rawUrl = req.url || '/';
    const safeUrl = rawUrl.startsWith('//') ? `/${rawUrl.replace(/^\/+/, '')}` : rawUrl;
    let url;
    try {
      url = new URL(safeUrl, `http://${hostHeader}/`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
      return;
    }
    const uri = decodeURIComponent(url.pathname);
    const method = req.method.toUpperCase();

    const log = (status) => {
      if (!config.quiet) {
        console.log(`[dav ${new Date().toISOString()}] ${method} ${uri} → ${status} (${Date.now() - started}ms)`);
      }
    };

    // CORS：方便用普通网页调试（扩展其实不需要）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', METHODS);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Depth, Destination, Overwrite, Content-Type, If, Lock-Token');
    res.setHeader('Access-Control-Expose-Headers', 'DAV, Allow, ETag, Content-Length');

    // ---------- 认证 ----------
    if (config.auth !== 'none') {
      const header = req.headers.authorization;
      let ok = false;
      if (config.auth === 'basic') {
        ok = checkBasic(header, config.username, config.password);
      } else {
        ok = checkDigest({
          header,
          method,
          uri: url.pathname + url.search,
          user: config.username,
          pass: config.password,
          nonce,
        });
      }
      if (!ok) {
        const challenge =
          config.auth === 'basic'
            ? `Basic realm="${REALM}", charset="UTF-8"`
            : makeDigestChallenge().header;
        if (config.auth === 'digest') {
          nonce = parseAuthHeader(challenge).params.nonce;
        }
        res.writeHead(401, {
          'WWW-Authenticate': challenge,
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('401 Unauthorized');
        log(401);
        return;
      }
    }

    // ---------- 路径解析 ----------
    const fsPath = path.join(config.root, uri);
    const resolvedRoot = path.resolve(config.root);
    if (!isInside(resolvedRoot, fsPath)) {
      res.writeHead(403).end('403 Forbidden');
      log(403);
      return;
    }

    // 演示入口：直接用 GET 返回一份 207 XML，用来验证内容脚本的自动识别
    if (uri === '/__xml-demo' && (method === 'GET' || method === 'HEAD')) {
      const demo = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/__xml-demo/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>
`;
      res.writeHead(200, {
        'Content-Type': 'application/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(demo),
      });
      res.end(method === 'HEAD' ? undefined : demo);
      log(200);
      return;
    }

    const readBody = () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

    try {
      const exists = fs.existsSync(fsPath);
      const stat = exists ? await fsp.stat(fsPath) : null;

      switch (method) {
        case 'OPTIONS': {
          res.writeHead(200, {
            DAV: '1, 2, 3',
            Allow: METHODS,
            'Content-Length': '0',
            'MS-Author-Via': 'DAV',
          });
          res.end();
          log(200);
          return;
        }

        case 'PROPFIND': {
          if (!stat) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
            log(404);
            return;
          }
          await readBody();
          const depth = req.headers.depth || '1';
          const hrefPath = uri.endsWith('/') || stat.isDirectory() ? `${uri.replace(/\/$/, '')}/` : uri;
          const xml = await buildResponseXml({
            fsPath,
            hrefPath,
            stat,
            depth: stat.isDirectory() ? depth : '0',
            isRoot: uri === '/',
          });
          res.writeHead(207, {
            'Content-Type': 'application/xml; charset="utf-8"',
            'Content-Length': Buffer.byteLength(xml),
          });
          res.end(xml);
          log(207);
          return;
        }

        case 'GET':
        case 'HEAD': {
          if (!stat) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
            log(404);
            return;
          }
          if (stat.isDirectory()) {
            // 目录用 GET 访问时返回一份 HTML 目录页（模拟部分服务器的行为）
            const children = await fsp.readdir(fsPath);
            const html = `<!doctype html><meta charset="utf-8"><title>Index of ${escapeXml(uri)}</title>
<h1>Index of ${escapeXml(uri)}</h1><ul>${children.map((c) => `<li><a href="${encodeURIComponent(c)}">${escapeXml(c)}</a></li>`).join('')}</ul>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(method === 'HEAD' ? undefined : html);
            log(200);
            return;
          }
          const range = req.headers.range;
          const size = stat.size;
          const headers = {
            'Content-Type': contentTypeFor(fsPath),
            'Last-Modified': stat.mtime.toUTCString(),
            ETag: `"${md5(`${fsPath}:${stat.mtimeMs}:${size}`)}"`,
            'Accept-Ranges': 'bytes',
          };
          if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
            const [, startRaw, endRaw] = /^bytes=(\d*)-(\d*)$/.exec(range);
            const start = startRaw ? Number(startRaw) : 0;
            /*
             * 关键：结束位置必须夹到文件长度以内。
             * 客户端常常请求 `bytes=0-8388607` 而文件只有几十 KB，
             * 如果照抄这个 end，我们就会声明一个巨大的 Content-Length
             * 却只发出少量字节，浏览器会一直等剩下的数据（表现为请求永久挂起）。
             */
            const end = Math.min(endRaw ? Number(endRaw) : size - 1, size - 1);
            if (Number.isNaN(start) || start >= size || end < start) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` });
              res.end();
              log(416);
              return;
            }
            headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            headers['Content-Length'] = String(end - start + 1);
            res.writeHead(206, headers);
            if (method === 'HEAD') res.end();
            else fs.createReadStream(fsPath, { start, end }).pipe(res);
            log(206);
            return;
          }
          headers['Content-Length'] = String(size);
          res.writeHead(200, headers);
          if (method === 'HEAD') res.end();
          else fs.createReadStream(fsPath).pipe(res);
          log(200);
          return;
        }

        case 'PUT': {
          const body = await readBody();
          await fsp.mkdir(path.dirname(fsPath), { recursive: true });
          const existed = fs.existsSync(fsPath);
          await fsp.writeFile(fsPath, body);
          res.writeHead(existed ? 204 : 201, { 'Content-Length': '0' });
          res.end();
          log(existed ? 204 : 201);
          return;
        }

        case 'DELETE': {
          if (!stat) {
            res.writeHead(404).end('404 Not Found');
            log(404);
            return;
          }
          await fsp.rm(fsPath, { recursive: true, force: true });
          res.writeHead(204).end();
          log(204);
          return;
        }

        case 'MKCOL': {
          if (stat) {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('405 Already exists');
            log(405);
            return;
          }
          const body = await readBody();
          if (body.length) {
            res.writeHead(415).end('415 Unsupported Media Type');
            log(415);
            return;
          }
          if (!fs.existsSync(path.dirname(fsPath))) {
            res.writeHead(409).end('409 Conflict (parent missing)');
            log(409);
            return;
          }
          await fsp.mkdir(fsPath);
          res.writeHead(201, { 'Content-Length': '0' }).end();
          log(201);
          return;
        }

        case 'MOVE':
        case 'COPY': {
          if (!stat) {
            res.writeHead(404).end('404 Not Found');
            log(404);
            return;
          }
          const destination = req.headers.destination;
          if (!destination) {
            res.writeHead(400).end('400 Missing Destination');
            log(400);
            return;
          }
          const destUrl = new URL(destination, `http://${req.headers.host}`);
          const destPath = path.join(config.root, decodeURIComponent(destUrl.pathname));
          if (!isInside(resolvedRoot, destPath)) {
            res.writeHead(403).end('403 Forbidden');
            log(403);
            return;
          }
          const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
          const destExists = fs.existsSync(destPath);
          if (destExists && !overwrite) {
            res.writeHead(412).end('412 Precondition Failed');
            log(412);
            return;
          }
          if (!fs.existsSync(path.dirname(destPath))) {
            res.writeHead(409).end('409 Conflict (destination parent missing)');
            log(409);
            return;
          }
          if (destExists) await fsp.rm(destPath, { recursive: true, force: true });
          if (method === 'MOVE') await fsp.rename(fsPath, destPath);
          else await fsp.cp(fsPath, destPath, { recursive: true });
          await readBody();
          res.writeHead(destExists ? 204 : 201, { 'Content-Length': '0' }).end();
          log(destExists ? 204 : 201);
          return;
        }

        case 'PROPPATCH': {
          await readBody();
          res.writeHead(207, { 'Content-Type': 'application/xml; charset="utf-8"' });
          res.end(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(encodeHref(uri))}</D:href>
<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
          log(207);
          return;
        }

        case 'LOCK': {
          await readBody();
          const token = `opaquelocktoken:${randomBytes(8).toString('hex')}`;
          res.writeHead(200, {
            'Content-Type': 'application/xml; charset="utf-8"',
            'Lock-Token': `<${token}>`,
          });
          res.end(`<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`);
          log(200);
          return;
        }

        case 'UNLOCK': {
          res.writeHead(204).end();
          log(204);
          return;
        }

        default: {
          res.writeHead(405, { Allow: METHODS }).end('405 Method Not Allowed');
          log(405);
          return;
        }
      }
    } catch (err) {
      if (!config.quiet) console.error('服务器内部错误：', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
      log(500);
    }
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const baseUrl = `http://${config.host}:${address.port}/`;

  return {
    config,
    port: address.port,
    baseUrl,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const MEDIA_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.mid', '.midi'];

/**
 * 把工作区根目录下的真实音频/MIDI 文件也放进测试服务器，
 * 这样用真实文件（大封面、GBK 标签、ReplayGain、多轨 MIDI）也能一键验证。
 */
async function seedRealMedia(root, samplesDir) {
  const target = path.join(root, '音乐');
  let copied = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(samplesDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MEDIA_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    const source = path.join(samplesDir, entry.name);
    try {
      const stat = await fsp.stat(source);
      if (stat.size > 300 * 1024 * 1024) continue;
      await fsp.mkdir(target, { recursive: true });
      await fsp.copyFile(source, path.join(target, entry.name));
      copied++;
    } catch {
      /* 拷不动就算了 */
    }
  }
  return copied;
}

async function seedTree(root, samplesDir) {
  const marker = path.join(root, '.seeded');
  if (fs.existsSync(marker)) return;
  await fsp.mkdir(path.join(root, 'docs', '子目录'), { recursive: true });
  await fsp.mkdir(path.join(root, 'images'), { recursive: true });
  await fsp.writeFile(path.join(root, 'readme.txt'), '这是 WebDAV 测试服务器的示例文件。\nhello webdav!\n');
  await fsp.writeFile(path.join(root, '中文 文件.txt'), '带空格和中文的文件名，用来测试百分号编码。\n');
  await fsp.writeFile(path.join(root, 'docs', 'guide.md'), '# 指南\n\n- PROPFIND 返回 207\n- 用 Depth: 1 列目录\n');
  await fsp.writeFile(path.join(root, 'docs', 'data.json'), JSON.stringify({ ok: true, items: [1, 2, 3] }, null, 2));
  await fsp.writeFile(path.join(root, 'docs', '子目录', 'nested.txt'), 'nested file\n');
  await fsp.writeFile(
    path.join(root, 'images', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2563eb"/><text x="12" y="38" fill="#fff" font-size="22">DAV</text></svg>\n',
  );
  // 合成一个「带封面 + ReplayGain + 完整标签」的 WAV，自动化测试全靠它
  await fsp.writeFile(path.join(root, 'sample-tone.wav'), buildTaggedWav());
  // 再合成一个确定性的小 MIDI 文件
  await fsp.writeFile(path.join(root, 'demo.mid'), buildMidiFile());

  // 真实文件（如果工作区里有）
  const copied = await seedRealMedia(root, samplesDir || process.cwd());

  await fsp.writeFile(path.join(root, '.seeded'), 'seeded\n');
  return copied;
}

/* --------------------------- CLI --------------------------- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    args.set(key, process.argv[i + 1]);
  }
  const { baseUrl, close } = await startServer({
    port: Number(args.get('port') || 8899),
    root: path.resolve(process.cwd(), args.get('root') || '.tmp/davroot'),
    samplesDir: path.resolve(process.cwd(), args.get('samples') || '.'),
    auth: args.get('auth') || 'none',
    username: args.get('user') || 'demo',
    password: args.get('pass') || 'demo',
    seed: true,
  });
  console.log(`WebDAV 测试服务器已启动：${baseUrl}`);
  console.log(`认证方式：${args.get('auth') || 'none'}　用户名：${args.get('user') || 'demo'}　密码：${args.get('pass') || 'demo'}`);
  console.log('按 Ctrl+C 停止。');
  process.on('SIGINT', async () => {
    await close();
    process.exit(0);
  });
}
