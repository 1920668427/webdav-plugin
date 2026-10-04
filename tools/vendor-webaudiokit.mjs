/**
 * 把 WebAudioKit 的发行包取回 src/vendor/webaudiokit/。
 *
 *   node tools/vendor-webaudiokit.mjs [版本]
 *
 * 这个扩展是零构建的纯静态扩展（MV3 的 CSP 只允许 'self'），所以第三方库必须以
 * 源码形式放在扩展目录里，用相对路径 import。本脚本让「这份副本从哪来」可复现：
 * 下载 → 校验 SHA-256 → 写入，校验不过就什么都不写。
 *
 * 升级步骤：
 *   1) 改下面的 PINNED 常量（版本 + 期望的 index.js 哈希）；
 *   2) 跑本脚本；
 *   3) npm test，并确认 src/vendor/webaudiokit/README.md 里第 2 条（loadAt 行为）仍然成立。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'src/vendor/webaudiokit');

const PINNED = {
  version: '1.1.2',
  files: {
    'index.js': '8dd62312b986e98b5f23a304a82443183492803baf75e77b02206f3fca24aadc',
  },
};

const version = process.argv[2] || PINNED.version;
const sources = {
  'index.js': [`https://cdn.jsdelivr.net/npm/webaudiokit@${version}/dist/index.js`, `https://unpkg.com/webaudiokit@${version}/dist/index.js`],
  'index.js.map': [`https://cdn.jsdelivr.net/npm/webaudiokit@${version}/dist/index.js.map`, `https://unpkg.com/webaudiokit@${version}/dist/index.js.map`],
  LICENSE: [`https://cdn.jsdelivr.net/npm/webaudiokit@${version}/LICENSE`, `https://unpkg.com/webaudiokit@${version}/LICENSE`],
};

async function fetchFirst(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      errors.push(`${url} → ${err.message}`);
    }
  }
  throw new Error(`全部下载失败：\n  ${errors.join('\n  ')}`);
}

const wanted = PINNED.files;
const downloaded = {};
for (const [name, urls] of Object.entries(sources)) {
  const buffer = await fetchFirst(urls);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const expected = wanted[name];
  if (expected && sha !== expected) {
    console.error(`✖ ${name} 的 SHA-256 对不上：\n  期望 ${expected}\n  实际 ${sha}`);
    console.error('  如果你确实要升级版本，请同步更新本脚本里的 PINNED 与 src/vendor/webaudiokit/README.md。');
    process.exit(1);
  }
  downloaded[name] = { buffer, sha };
  console.log(`  ✔ ${name.padEnd(14)} ${String(buffer.length).padStart(7)} 字节  ${sha.slice(0, 16)}…`);
}

mkdirSync(target, { recursive: true });
for (const [name, { buffer }] of Object.entries(downloaded)) {
  writeFileSync(resolve(target, name), buffer);
}
console.log(`\n✅ 已写入 ${target}`);

// 提醒：源码里的集成假设也要跟着确认
const player = readFileSync(resolve(root, 'src/lib/audio-player.js'), 'utf8');
if (!player.includes('loadAt')) {
  console.error('⚠️  src/lib/audio-player.js 里不再引用 loadAt()，请确认「只装载不播放」的实现是否还有效。');
}
if (!existsSync(resolve(target, 'README.md'))) {
  console.error('⚠️  缺少 src/vendor/webaudiokit/README.md，请补上版本与哈希记录。');
}
