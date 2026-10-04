/**
 * 静态检查：不依赖浏览器，快速验证扩展包结构是否完整。
 *
 *   node tools/check.mjs
 *
 * 检查项：
 *  - manifest.json 是合法 JSON，引用的文件都存在
 *  - 所有 JS 文件语法正确
 *  - manager.html 里的 id 与 manager.js 引用一一对应
 *  - 图标是合法 PNG（签名 + IHDR 尺寸 + IDAT 能 inflate）
 *  - 页面里没有留下 console.log 调试语句
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const rel = (p) => relative(root, p);

function check(condition, message) {
  if (condition) {
    console.log(`  ✔ ${message}`);
  } else {
    problems.push(message);
    console.log(`  ✖ ${message}`);
  }
}

/* ------------------------- manifest ------------------------- */

console.log('▶ manifest.json');
const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
check(manifest.manifest_version === 3, 'manifest_version = 3');
check(Boolean(manifest.name && manifest.version && manifest.description), 'name / version / description 齐全');

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
].filter(Boolean);

for (const file of new Set(referenced)) {
  check(existsSync(join(root, file)), `引用的文件存在：${file}`);
}

/* ------------------------- JS 语法 ------------------------- */

console.log('\n▶ JavaScript 语法');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const jsFiles = [...walk(join(root, 'src')), ...walk(join(root, 'tools')), ...walk(join(root, 'test'))];
let syntaxErrors = 0;
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    syntaxErrors++;
    const detail = String(err.stderr || err.message).split('\n').slice(0, 4).join(' ');
    problems.push(`语法错误：${rel(file)} → ${detail}`);
    console.log(`  ✖ 语法错误：${rel(file)} → ${detail}`);
  }
}
if (syntaxErrors === 0) console.log(`  ✔ ${jsFiles.length} 个 JS 文件语法解析通过`);

/* ------------------------- DOM id 对应 ------------------------- */

console.log('\n▶ DOM 元素对应关系');
const html = readFileSync(join(root, 'src/manager/manager.html'), 'utf8');
const managerJs = readFileSync(join(root, 'src/manager/manager.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...managerJs.matchAll(/\$\('#([^']+)'\)/g)].map((m) => m[1]));
const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
check(missingIds.length === 0, `manager.js 引用的 ${usedIds.size} 个 id 都能在 HTML 里找到`);
if (missingIds.length) notes.push(`缺失的 id：${missingIds.join(', ')}`);

/* ------------------------- 弹窗 CSS ------------------------- */

console.log('\n▶ 弹窗 CSS');
// 浏览器默认 dialog:not([open]) { display: none }。
// 只要给非 [open] 的 dialog 选择器写了 display，弹窗就会常驻屏幕且关不掉。
const css = readFileSync(join(root, 'src/manager/manager.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const cssOffenders = [];

/** 这个选择器是不是“直接选中弹窗元素本身”（而不是 .dialog-head 这种内部元素） */
function targetsDialogElement(selector) {
  return selector.split(',').some((part) => {
    const last = part.trim().split(/\s+/).pop() || '';
    const withoutPseudo = last.replace(/::?[a-z-]+(\([^)]*\))?$/i, '');
    return /^(dialog|\.[\w-]*dialog|\.dialog)(\[[^\]]*\])*$/.test(withoutPseudo);
  });
}

for (const block of css.split('}')) {
  const braceIndex = block.indexOf('{');
  if (braceIndex < 0) continue;
  const selector = block.slice(0, braceIndex).trim().split('\n').pop().trim();
  const body = block.slice(braceIndex + 1);
  if (!targetsDialogElement(selector)) continue;
  if (/\[open\]/.test(selector)) continue;
  if (/(^|[;\s])display\s*:/.test(body)) cssOffenders.push(selector);
}

check(
  cssOffenders.length === 0,
  'dialog 元素本身的 display 只写在 [open] 选择器里（否则会覆盖默认的 display:none）',
);
if (cssOffenders.length) notes.push(`有问题的选择器：${cssOffenders.join(', ')}`);

/* ------------------------- 图标 ------------------------- */

console.log('\n▶ 图标');
for (const size of [16, 32, 48, 128]) {
  const file = join(root, 'icons', `icon${size}.png`);
  if (!existsSync(file)) {
    check(false, `icons/icon${size}.png 存在`);
    continue;
  }
  const buf = readFileSync(file);
  const signatureOk = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const hasEnd = buf.subarray(buf.length - 8, buf.length - 4).equals(Buffer.from('IEND'));
  let inflateOk = false;
  const idatStart = buf.indexOf(Buffer.from('IDAT'));
  if (idatStart > 0) {
    const length = buf.readUInt32BE(idatStart - 4);
    const data = buf.subarray(idatStart + 4, idatStart + 4 + length);
    try {
      const raw = inflateSync(data);
      inflateOk = raw.length === height * (1 + width * 4);
    } catch {
      inflateOk = false;
    }
  }
  check(signatureOk && width === size && height === size && hasEnd && inflateOk, `icons/icon${size}.png 是合法 PNG 且尺寸为 ${size}×${size}`);
}

/* ------------------------- 调试残留 ------------------------- */

console.log('\n▶ 调试残留');
const dirty = [];
// 只检查真正打进扩展包里的代码，tools/ 与 test/ 里的输出是有意为之；
// src/vendor/ 是第三方发行包的原样副本，不按我们的规范要求它。
const shippedFiles = walk(join(root, 'src')).filter((file) => !rel(file).startsWith('src/vendor/'));
for (const file of shippedFiles) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    if (/\bconsole\.(log|debug|info)\(/.test(line)) dirty.push(`${rel(file)}:${index + 1}`);
  });
}
check(dirty.length === 0, 'src/ 下没有遗留 console.log / console.info 调试输出');
if (dirty.length) notes.push(`调试语句：${dirty.join(', ')}`);

/* ------------------------- 结果 ------------------------- */

console.log('\n' + '─'.repeat(60));
if (problems.length === 0) {
  console.log('✅ 静态检查全部通过');
} else {
  console.log(`❌ ${problems.length} 项未通过：`);
  for (const item of problems) console.log(`   - ${item}`);
}
for (const note of notes) console.log(`   · ${note}`);
process.exit(problems.length ? 1 : 0);
