# WebDAV 文件管理器（Microsoft Edge 扩展）

把 WebDAV 服务器返回的那一堆**原始报文**（`PROPFIND` 请求 + `207 Multi-Status` XML），
在浏览器里直接变成**可读、可点击、可读写**的文件管理网页。

```
浏览器直接打开 WebDAV 地址                     装上本扩展之后
┌──────────────────────────────┐              ┌───────────────────────────────────────────┐
│ <?xml version="1.0" ...?>    │              │ 🗄️ WebDAV 文件管理器      [https://dav/...]│
│ <D:multistatus xmlns:D="DAV:">│              ├───────────────┬───────────────────────────┤
│   <D:response>               │   ───────▶   │ 已保存的连接  │ 📁 名称   大小   修改时间  │
│     <D:href>/dav/docs/</D:href>│             │ 服务器能力    │ 📄 readme.txt  1.2KB 10-03 │
│     <D:propstat>             │              │ 原始报文日志  │ 🖼️ logo.png    8KB  10-02 │
│       <D:prop>...            │              │              │ [下载][重命名][移动][删除] │
└──────────────────────────────┘              └───────────────┴───────────────────────────┘
        不可操作的 XML 文本                        可读、可直接操作的文件管理界面
```

---

## 1. 它到底做了什么

| 能力 | 说明 |
| --- | --- |
| **读取原始请求 / 响应** | 后台 Service Worker 在 host 权限下直接发 `PROPFIND`、`OPTIONS`、`PUT`…，并把**发出去的原始请求行、请求头、请求体**和**服务器回的状态行、响应头、响应正文**完整回传给页面 |
| **原始报文可视化** | 侧栏是实时报文日志（方法 / 状态码 / 耗时 / 认证方式），点开就有四个标签页：原始请求、原始响应、响应正文 XML、解析结果，一键复制 |
| **渲染成文件列表** | 用 `DOMParser` 解析 `207 Multi-Status`，把 `displayname`、`getcontentlength`、`getlastmodified`、`getetag`、`resourcetype` 等属性渲染成表格（图标、大小、时间、类型、排序、过滤、面包屑） |
| **可直接操作** | 浏览 / 上传（含整目录）/ 下载 / 预览 / 新建文件夹 / 重命名 / 移动 / 复制 / 删除 / 批量删除 / 拖拽上传 |
| **自动识别 207 页面** | 直接在浏览器里打开一个返回 207 XML 的地址时，右下角会浮出「用文件管理器打开」入口 |
| **权限自检与诊断** | 连接前检查 host 权限是否真的生效，缺失时给出黄色提示条 +「申请访问权限」按钮；工具栏「🔍 诊断」一键输出权限 / 连通性 / 认证 / 服务器能力报告 |
| **音频播放器** | 预览音频时用自研的 Web Audio 播放器：封面、实时频谱、进度条、音量、变速、循环、快捷键，播放列表前后切换 |
| **封面与标签解析** | 自研 ID3v2.2/2.3/2.4、FLAC、Ogg/Opus、MP4/M4A、WAV 解析，读出内嵌封面（含 4000×4000 大图）、GBK/Shift-JIS 老标签与全部原始字段 |
| **ReplayGain** | 支持 TXXX / RVA2 / Vorbis comment / MP4 自由字段 / Opus R128 五种来源，直接作用在 Web Audio 增益节点上（音轨/专辑/关闭 + 预增益 + 峰值防削波） |
| **Web MIDI** | MIDI 键盘直接操作播放器（走带/音量/速度/定位），支持 MIDI Learn 改键；播放时向输出设备发 Start/Stop/Continue 与 MIDI 时钟，同步外部硬件。权限**按需申请**：只有展开 MIDI 面板或点「启用 Web MIDI」等明确操作时才请求，不会因为打开一个文件就弹权限框 |
| **MIDI 文件** | 解析标准 MIDI 文件（多轨、变长量、running status、速度表），内置合成器直接出声（面板里有开关，可关掉只走外部音源），也可同时送往 MIDI 输出设备 |
| **认证** | 匿名、Basic、**Digest（MD5 / MD5-sess / SHA-256，含 qop=auth、opaque、nc/cnonce）**，以及「自动」模式（先试 Basic，被要求 Digest 就自动改走摘要流程） |

支持的操作与对应协议方法：

| 界面动作 | HTTP 方法 | 关键头 |
| --- | --- | --- |
| 打开连接、探测服务器能力 | `OPTIONS` | 读取 `DAV:` / `Allow` |
| 列目录 | `PROPFIND` | `Depth: 1`，正文是属性清单 XML |
| 下载 / 预览 | `GET` | — |
| 上传文件 | `PUT` | `Content-Type` |
| 新建文件夹 | `MKCOL` | — |
| 重命名 / 移动 | `MOVE` | `Destination`、`Overwrite` |
| 复制 | `COPY` | `Destination`、`Overwrite` |
| 删除 | `DELETE` | 集合递归删除 |

---

## 2. 安装（Edge，1 分钟）

1. 打开 `edge://extensions/`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择本目录（`webdav-plugin`）
4. 建议把「WebDAV 文件管理器」固定到工具栏

> 无需构建、无需 npm install：整个扩展就是纯静态文件。
> 唯一的第三方库 WebAudioKit 以**源码副本**放在 `src/vendor/webaudiokit/`，同样不需要安装或打包。

用 Chrome 安装的步骤完全一样（`chrome://extensions/`）。

---

## 3. 快速开始

### 3.1 连一个真实 WebDAV 服务器

点扩展图标 → 填地址、用户名、密码 → **打开文件管理器**。

常见地址示例：

| 服务 | 地址 |
| --- | --- |
| Nextcloud / ownCloud | `https://cloud.example.com/remote.php/dav/files/用户名/` |
| 群晖 WebDAV Server | `http://nas:5005/共享文件夹名/` |
| Apache `mod_dav` | `http://host/dav/` |
| Nginx + `dav_ext` | `http://host/dav/` |
| 坚果云 | `https://dav.jianguoyun.com/dav/`（密码填**应用密码**） |

### 3.2 本地起一个测试服务器（零依赖）

```bash
node tools/webdav-server.mjs --port 8899 --root .tmp/davroot --auth basic --user demo --pass demo
```

然后在文件管理器里连 `http://127.0.0.1:8899/`，用户名 `demo`，密码 `demo`。

其他模式：

```bash
node tools/webdav-server.mjs --auth none    # 匿名
node tools/webdav-server.mjs --auth digest  # Digest 摘要认证
```

浏览器访问 `http://127.0.0.1:8899/__xml-demo` 可以看到一份 207 XML，
用来体验「自动识别 207 页面」的悬浮入口。

---

## 4. 界面说明

```
┌─ 顶栏：服务器地址 / 用户名 / 密码 / 认证方式 / 连接 / 保存 ─────────────────┐
├──────────────┬────────────────────────────────────────────────────────┤
│ 已保存的连接  │ 路径栏：上一级 · 刷新 · 面包屑 · 过滤框                  │
│ 服务器能力    │ 工具栏：新建文件夹 上传文件 上传文件夹 下载选中 全选 删除 │
│ （OPTIONS）   │ 原始 XML                                                │
│ 原始报文日志  │ 拖拽上传区                                              │
│              │ 文件表格（名称 / 大小 / 修改时间 / 类型 / 操作）          │
└──────────────┴────────────────────────────────────────────────────────┘
```

- **双击**目录进入，双击文件预览（图片 / 视频 / 音频 / PDF / 文本 / 代码）
- 表头可排序，右上角过滤框对当前列表做本地筛选
- 目录行可以重命名 / 移动，文件行还可以下载 / 复制
- 点任意一条报文日志（或工具栏「原始 XML」）打开原始报文查看器
- 行内「属性」按钮看的是**单条 `<D:response>` 的原始 XML 片段**，排查服务器兼容性问题很好用

---

## 5. 原始报文是怎么抓的

```
manager 页面                 Service Worker（唯一有跨域特权的地方）        WebDAV 服务器
   │  chrome.runtime.sendMessage        │                                    │
   ├──── {type:'DAV_REQUEST', ...} ────▶│  fetch(PROPFIND + Depth + Basic)   │
   │                                    ├───────────────────────────────────▶│
   │                                    │◀──── 207 Multi-Status XML ─────────┤
   │◀── {status, headers, bodyText, ────┤  同时记录：请求行/请求头/请求体      │
   │      raw:{request,response}}       │           状态行/响应头/响应正文     │
   │  DOMParser 解析 → 文件表格          │                                    │
```

为什么要绕一层后台：普通网页发 `PROPFIND` 会被 CORS 拦死（WebDAV 服务器基本不会返回
`Access-Control-Allow-*`），而扩展在 `host_permissions` 授权下能拿到完整的响应头和响应体。
所以所有网络动作都在 Service Worker 里做，页面只负责解析和渲染。

认证流程（`auto` 模式）：

1. 有用户名 → 先带 `Authorization: Basic …`
2. 收到 `401` + `WWW-Authenticate: Digest …` → 解析挑战（realm / nonce / qop / opaque / algorithm）
3. 按 RFC 7616 计算摘要（浏览器的 WebCrypto 不提供 MD5，所以 `src/lib/md5.js` 是自己实现的）
4. 换上新头重发一次，最多两次请求

原始请求里的 `Authorization` 与响应里的 `Set-Cookie` 在日志中会被替换成 `<凭据已隐藏>`，避免截图/贴日志泄露。

---

## 5.5 音频播放器 / 封面 / ReplayGain / MIDI

预览音频文件会打开完整的网页播放器：

```
┌──────────────────────────────────────────────────────────────────────┐
│ ┌────────┐  预言 Prophecy                                            │
│ │ 封面图 │  三Z-STUDIO/HOYO-MiX/Gin Wigmore · 绝区零-预言 Prophecy    │
│ └────────┘  [FLAC] [48.0 kHz] [24 bit] [2 声道] [ReplayGain] [1 张图] │
│             ▁▃▅▇█▇▅▃▁▂▄▆█▆▄▂   ← 实时频谱                            │
├──────────────────────────────────────────────────────────────────────┤
│ ⏮ ⏪ ▶ ⏩ ⏹ ⏭   ──────●──────────────  1:23 / 4:14                  │
│ 🔊 ────●──  速度 1×  🔁  ReplayGain[音轨▾] 预增益 ──●──  -6.18 dB    │
├──────────────────────────────────────────────────────────────────────┤
│ 🏷️ 标签 / 封面 / ReplayGain 详情                                     │
└──────────────────────────────────────────────────────────────────────┘
```

预览 MIDI 文件时会多一行 `🎹 MIDI 设备与同步`（音频文件下整块隐藏）：

```
│ 🎹 MIDI 设备与同步  输入[测试键盘▾] 输出[测试音源▾] ☑合成器 ☐发送时钟 │
```

### 播放引擎：WebAudioKit + 自建 DSP 图

装载与走带（`<audio>` 的创建与切换、播放/暂停/结束事件、状态、变速、循环）交给
[**WebAudioKit**](https://github.com/Roy-Jin/WebAudioKit) 的 `MusicPlayer`，我们只往它的
列表里放当前这一首 —— 上一首 / 下一首与播放列表仍然由扩展自己管。

DSP 仍然是扩展自己的 Web Audio 图，接在 WebAudioKit 创建的那个 `<audio>` 上：

```
<audio> → MediaElementSource → ReplayGain 增益 → 用户音量 → 分析器 → 输出
                                  （峰值防削波）    （与 RG 解耦）  （频谱可视化）
```

WebAudioKit 的 `volume` 是直接写 `audio.volume` 的，所以**元素音量固定为 1**，
音量完全由图里的 `volumeNode` 控制，避免双重衰减；ReplayGain 与频谱因此原样保留。

| 关注点 | 谁负责 |
| --- | --- |
| 装载 / 切曲 / 走带事件 / 状态机 | WebAudioKit `MusicPlayer`（`src/vendor/webaudiokit/`） |
| 播放列表、上一首 / 下一首 | 扩展的 `manager.js` |
| ReplayGain 增益、音量、频谱分析器 | 扩展自己的 Web Audio 图（`src/lib/audio-player.js`） |
| 封面 / 标签 / ReplayGain 解析 | 扩展自己实现的 `src/lib/tags.js` |
| MIDI 文件播放与内置合成器 | 扩展自己实现的 `src/lib/smf.js`（**不经过 WebAudioKit**） |

这个库以**源码副本**内置在 `src/vendor/webaudiokit/`（MIT，发行包 `dist/index.js`），
因为扩展是零构建的、MV3 的 CSP 只允许 `'self'`，不能从 CDN 引脚本：

```js
import { MusicPlayer, Music } from '../vendor/webaudiokit/index.js';
```

副本的来源、版本与校验哈希记录在 [src/vendor/webaudiokit/README.md](src/vendor/webaudiokit/README.md)，
可用 `node tools/vendor-webaudiokit.mjs 1.1.2` 重新取回（会校验 SHA-256）。

### 封面与标签

解析器全部自己实现（`src/lib/tags.js`）：

| 容器 | 读取内容 |
| --- | --- |
| MP3 | ID3v2.2/2.3/2.4 文本帧、`APIC` 封面、`TXXX` 与 `RVA2` 两种 ReplayGain、ID3v1 兜底 |
| FLAC | `STREAMINFO`（采样率/位深/时长）、`VORBIS_COMMENT`、`PICTURE` 封面 |
| Ogg / Opus | Vorbis comment、`METADATA_BLOCK_PICTURE`、`COVERART` |
| M4A / MP4 | `ilst`（©nam / ©ART / ©alb / `covr` / `----` 自由字段里的 ReplayGain） |
| WAV | `fmt `、`LIST INFO`、内嵌 `id3 ` 块 |

处理过的真实世界脏数据：

- **ID3v2.4 的两种去同步化**：标签头 `0x80` 与帧级 `0x0002/0x0003` 同时存在时，
  整块去同步化会让帧偏移错位，后面的封面直接读不到（示例 MP3 就丢了 2.1 MB 的封面）。
  现在 v2.3 走整块还原、v2.4 走逐帧还原，两种都能正确读出。
- **GBK 被标成 latin1**：中文 MP3 常见，`TIT2` 声明编码 0 但内容是 GBK 字节，
  按 latin1 解会得到 `¸¡¿ä`。现在会启发式重解（GBK/Big5/Shift-JIS），
  同时保证 `Björk` 这类正常西文不被误伤。
- **MIDI 曲名是 Shift-JIS**：`炉心融解　～ Melt Down` 就是这么解出来的。
- **GBK 曲名被 Shift-JIS 误读**：`室内系的TrackMaker` 的 GBK 字节全落在 `0xA1–0xDF`，
  而这正是 Shift-JIS 里**单字节半角片假名**的范围。按「先试 UTF-8，再试 Shift-JIS，
  解不通才试 GBK」的顺序猜，这段字节既不抛异常也没有 `U+FFFD`，只是安静地变成
  `ﾊﾒﾄﾚﾏｵｵﾄTrackMaker`（142 条中文曲名里 68 条会中招）。现在会识别这种形态 ——
  整段非 ASCII 里一半以上是半角片假名、或出现私用区字符（如 `F4C0 → U+E36F`）——
  判定为「GBK 被当成 Shift-JIS 解」，改走 GBK；真正的日文曲名含全角假名，不受影响。
  见 [smf.js](src/lib/smf.js) 的 `looksLikeMisreadGbk()`。

### ReplayGain

解析到的增益**真的会作用到声音上**（独立增益节点，与用户音量解耦）：

- 模式：**音轨 / 专辑 / 关闭**
- 预增益 `-12 ~ +12 dB`
- **峰值防削波**：按 `REPLAYGAIN_TRACK_PEAK` 反算最大可用增益，超出就夹住并标注「限幅」
- 界面实时显示当前生效的 dB 值，悬停可看线性倍数与原因
- 缺失时明确说明：「文件里没有音轨增益（Track Gain），可切换成「专辑」试试」

支持的来源：`REPLAYGAIN_*_GAIN/PEAK`（ID3 TXXX / Vorbis / MP4 自由字段）、
ID3v2.4 的 `RVA2`、Opus 的 `R128_TRACK_GAIN`（Q7.8 定点）。

### Web MIDI

- **输入**：MIDI 键盘/控制器直接控制播放器。出厂映射：低音区 C1 起是走带按钮，
  CC7 音量、CC1 调制轮当速度、弯音轮微调定位；点任意映射按钮可 **MIDI Learn** 改键并持久化。
  面板底部有 MIDI 监视器，实时显示收到的消息。
  默认是 **「不监听」**：只有你在下拉里明确选中某个输入设备之后，消息才会驱动播放器；
  选中的设备会被记住，下次自动恢复。这样即使系统里有 IAC / DAW 的 MIDI 回环端口
  （自己发出去的音符又转回来），或者旁边还接着别的键盘，也不会在播放中途把走带搅乱
  （默认映射里 C2 附近就是播放/停止/快退，很容易撞上 MIDI 文件本身的音符）。
  MIDI Learn 期间是例外：那时你就是在等一条消息，任何端口都收。
- **输出**：播放时发送 `Start` / `Stop` / `Continue` 与 **MIDI 时钟**（24 分音符/拍，带漂移补偿），
  可把鼓机、合成器、DAW 同步到正在预览的曲子，速度跟随 MIDI 文件自己的速度表。
- **面板只对 MIDI 文件出现**：`🎹 MIDI 设备与同步` 整块设置（设备选择、映射、时钟、
  内置合成器开关）在音频文件（MP3 / FLAC / WAV…）预览时是隐藏的 —— 这些设置对音频
  没有意义，露出来只会让人以为「放 MP3 也能用内置合成器」。相应地，音频预览下
  外部 MIDI 设备也不会遥控播放器，不会出现「界面上看不到 MIDI 设置、播放器却被遥控」。
  判断依据是 `PlayerUI` 的 `isMidiFile`（只有 MIDI 后端会传 `smfPlayer`）。
- **权限按需申请**：从 Chrome 124 起 Web MIDI 被放到了权限提示后面
  （[Chrome 官方说明](https://developer.chrome.com/blog/web-midi-permission-prompt?hl=zh-cn)），
  只要调用 `navigator.requestMIDIAccess()` 就会弹权限框，而且**即使已经授权过**，
  控制台也会留下一条「Web MIDI 将请求使用权限」的警告
  （[Chromium issue 40058280](https://issues.chromium.org/issues/40058280)）。
  所以本扩展**不会**在你只是打开一个音频 / MIDI 文件时就申请 MIDI 权限，
  真正的申请时机只有四个：**展开「🎹 MIDI 设备与同步」面板**（该面板只在 MIDI 文件下出现）、
  点 **「启用 Web MIDI」**、勾选 **「发送 MIDI 时钟与 Start/Stop」**、或者点某个映射按钮做 **MIDI Learn**。
  在此之前设备下拉是禁用的，状态栏会写「未启用 Web MIDI」。
- 设备热插拔会自动重新枚举，掉线的设备自动取消选择。

`navigator.requestMIDIAccess` 做成了可注入依赖，测试里塞假设备即可验证完整链路，不需要真硬件。

### MIDI 文件

`.mid / .midi / .kar` 走 MIDI 播放器：解析多轨、变长量、running status、速度表，
时间轴摊平后**同时**投递给内置合成器（Web Audio 振荡器 + 包络，没硬件也能听）
与选中的 MIDI 输出设备（带时间戳的精确调度）。界面显示轨道数、音符数、tick、通道、速度。

MIDI 面板里有一个 **「内置合成器发声」** 开关（`data-testid="midi-synth"`）：

- **默认打开**，不接任何硬件也能听到声音；
- 关掉之后浏览器里**完全静音**（送出去之前也不再有本地声部），
  但时间轴照常运转，消息仍然发给选中的 **MIDI 输出设备** —— 适合
  「只用外部软音源 / 硬件音源出声」的场景；
- 开关状态存在 `chrome.storage.local` 的 `midiSettings.synthEnabled`，下次打开文件自动恢复；
- 开关与**音量 / 静音**是解耦的：静音或音量归零只是临时不发声，
  不会把开关本身改掉；反过来，开关关着时调音量、取消静音也不会偷偷把它打开；
- 播放中途关掉开关会立刻松开所有正在响的音符（不会留下「挂住」的长音）。

音频文件没有内置合成器，这个开关会显示为不可用，避免误会。

### 快捷键

| 键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 前进 5 秒 |
| Ctrl + ← / → | 上一个 / 下一个音频文件 |
| ↑ / ↓ | 音量 ±5% |
| M / L | 静音 / 循环 |

### 大文件怎么读

预览不再把整个文件塞进一条消息（扩展消息有大小上限，几十 MB 的 FLAC 会直接爆掉）。
现在用 **HTTP Range 分块读取**（每块 8 MB），边下边显示进度，最后拼成 Blob 交给播放器：

```
GET Range: bytes=0-8388607      → 206, 8 MB
GET Range: bytes=8388608-...    → 206, 8 MB
...
→ new Blob(chunks) → blob: URL → <audio> 流式解码
```

具体实现在 [src/lib/blob-fetch.js](src/lib/blob-fetch.js)（能在 Node 里单测），
`manager.js` 只负责把走 Service Worker 的 `request()` 和当前认证注入进去。

这里踩过两个真实的坑：

1. 请求 `bytes=0-8388607` 而文件只有 32 KB 时，**服务器必须把结束位置夹到文件长度以内**。
   测试服务器一开始没夹，于是声明了 8 MB 的 `Content-Length` 却只发 32 KB，
   浏览器就一直等剩下的数据（表现为请求永久挂起）。
2. **结束条件不能只看 `Content-Range` 里的总长。** 曾经这里的正则少写了两个捕获组：

   ```js
   /bytes\s+\d+-\d+\/(\d+|\*)/   // 只有 1 个组，却去取 match[3]
   → Number(undefined) = NaN → `offset < NaN` 永远为假
   → 读完第一块（8MB）就退出循环
   ```

   结果是**所有大于 8 MB 的文件都被悄悄截断**，播放时表现为「播到某个时间点突然报
   `音频解码失败（错误码 2）`」——96 kHz/24 bit 的 FLAC 正好 8 MB ≈ 16 秒。
   现在：总长未知（`bytes a-b/*` 或没有 `Content-Range`）也能一直读到短读 / 416 为止；
   万一没读完，**宁可报「读取中断」也不把半截文件交给播放器**。
   对应的 11 项单元测试在 [test/blob-fetch.test.mjs](test/blob-fetch.test.mjs)，
   e2e 里也会核对 13.5 MB 的 MP3 下载后字节数与服务器一致。

顺带一句：媒体错误码也翻译成人话了 —— `2` 是「读取中断（数据没传完）」，
`3` 才是「解码失败」，`4` 是「格式不受支持」，不再一律甩一句「可能是格式不支持」。

---

## 6. 安装后请留意

### 权限用途

| 权限 | 为什么需要 |
| --- | --- |
| `host_permissions: http/https://*` | WebDAV 服务器地址是任意的，必须能对它发请求并读取响应头 |
| `storage` | 保存连接配置与上次使用的地址 |
| `downloads` | 大文件交给浏览器下载器流式落盘（不占内存） |
| `scripting` | 页面加载完成后探测「这页是不是 207 报文」，是的话注入悬浮入口 |
| `optional_host_permissions` | 与 host_permissions 同范围。浏览器若把访问权限收回（「站点访问权限=单击时」），可以用它当场重新申请 |
| `contextMenus` | 右键「用 WebDAV 文件管理器打开」 |

### 凭据存放

勾选「保存」后，地址 / 用户名 / 密码保存在 `chrome.storage.local`（**明文，未加密**），
仅存在于本机浏览器配置目录里，不会上传到任何地方。共用电脑上请勿保存密码。

### 已知限制

- 目录整体下载未实现（需要在客户端打包），请逐个文件下载或先打包成压缩包
- 超过 128 MB 的文件会自动改用浏览器下载器；Digest 认证下无法预生成摘要头，
  因此 Digest + 超大文件会提示改用其他方式
- 上传走整体 `PUT`（不做分块），超大文件传输期间没有进度条
- 服务器不支持 `MOVE` / `COPY` 时会返回 `405`，界面会原样展示状态码并保留原始响应
- 有些服务器（如开启了 WebDAV 的 IIS）默认不允许 `PROPFIND` 的 `Depth: 1`，需要服务端调优

---

## 7. 目录结构

```
webdav-plugin/
├── manifest.json                 # MV3 清单
├── icons/                        # 16/32/48/128 图标（由脚本生成）
├── src/
│   ├── lib/
│   │   ├── md5.js                # 纯 JS MD5（Digest 认证需要，WebCrypto 没有）
│   │   ├── digest.js             # 认证挑战解析 + Authorization 构造
│   │   ├── http.js               # 原始报文抓取层（请求/响应全量记录）
│   │   ├── xml.js                # 207 Multi-Status 解析器
│   │   ├── webdav.js             # 协议常量、URL/路径、格式化、类型识别
│   │   ├── bytes.js              # base64 ↔ 字节/文本
│   │   ├── tags.js               # 音频标签 / 内嵌封面 / ReplayGain 解析
│   │   ├── blob-fetch.js         # 分块（Range）下载成 Blob，可在 Node 里单测
│   │   ├── audio-player.js       # 播放后端（WebAudioKit 走带 + 自建增益/频谱图）+ 播放器界面
│   │   ├── midi.js               # Web MIDI 编解码、设备桥接、映射与 Learn
│   │   └── smf.js                # 标准 MIDI 文件解析、调度与内置合成器
│   ├── vendor/webaudiokit/       # WebAudioKit 发行包副本（MIT，来源与哈希见其中 README）
│   ├── background/service-worker.js  # 跨域代理、下载器、右键菜单、207 页面探测
│   ├── manager/                  # 文件管理网页（HTML/CSS/JS + player.css）
│   ├── popup/                    # 工具栏弹窗
│   └── content/detect.js         # 207 XML 页面悬浮入口
├── tools/
│   ├── webdav-server.mjs         # 零依赖测试用 WebDAV 服务器（none/basic/digest）
│   ├── make-icons.mjs            # 手写 PNG 编码器生成图标
│   ├── vendor-webaudiokit.mjs    # 重新取回 WebAudioKit 副本（校验 SHA-256）
│   └── check.mjs                 # 静态结构检查
└── test/
    ├── unit.test.mjs             # 26 项单元测试（MD5/Digest/URL/格式化/base64）
    ├── media.test.mjs            # 48 项媒体测试（标签/封面/ReplayGain/音频后端/MIDI/SMF/曲名编码）
    ├── blob-fetch.test.mjs       # 11 项分块下载测试（含「>8MB 被截断」回归）
    ├── fixtures.mjs              # 手工构造的音频与 MIDI 夹具
    ├── e2e.mjs                   # 124 项端到端测试（真实 Edge + CDP）
    └── cdp.mjs                   # 零依赖 CDP 客户端
```

---

## 8. 开发与测试

```bash
npm run check        # 静态检查：清单、语法、DOM id、弹窗 CSS、PNG、调试残留
npm run test:unit    # 85 项单元测试（通用 + 媒体 + 音频后端集成 + 分块下载）
npm run test:media   # 只跑媒体相关的 48 项
npm run test:e2e     # 124 项端到端：headless Edge 加载扩展，跑完整流程
npm test             # 上面按顺序执行
npm run icons        # 重新生成图标
node tools/vendor-webaudiokit.mjs   # 重新取回 WebAudioKit 副本（校验 SHA-256）
```

端到端测试会：起三个 WebDAV 测试服务器（匿名 / Basic / Digest）→ 用带扩展的
Microsoft Edge（headless）打开文件管理器 → 通过 CDP 驱动界面完成
列目录、新建文件夹（真的去点弹窗）、上传、校验内容、重命名、进入子目录、过滤、
打开原始报文弹窗、下载落盘、删除、Digest 认证与错误密码、207 页面悬浮入口、
popup 读取历史连接等 **47 项断言**。

覆盖的关键断言（节选）：

```
✔ 服务器返回 207 Multi-Status
✔ 原始请求里含有 PROPFIND 请求行与 Depth 头
✔ 原始请求里带 Basic 认证头（凭据已隐藏）
✔ 原始响应正文是 multistatus XML
✔ PUT 原始请求带上 Content-Type   /   PUT 原始响应是 201/204
✔ MOVE 请求带 Destination 头
✔ 实际上走了 digest 摘要认证      /   错误密码：给出 401 提示
✔ 下载小文件（GET + Blob）成功     /   浏览器下载器（chrome.downloads）下载完成
✔ 识别到 207 XML 并注入悬浮入口    /   点击入口能打开文件管理器
```

> 测试脚本需要 `--no-sandbox`：在受限沙箱环境里 Chromium 自身的沙箱起不来
> （`sandbox initialization failed`）。这只影响自动化测试进程，与扩展本身无关。

---

## 9. 常见问题

**连不上 / 一直转圈**
先看状态栏和侧栏日志：`OPTIONS` 的返回码是什么、有没有 `DAV:` 头。
`401` 说明凭据或认证方式不对（试试把认证方式从「自动」改成「Basic」或「Digest」）。

**401 但密码明明是对的**
很多服务（Nextcloud、坚果云）要求**应用专用密码**而不是登录密码。

**`405 Method Not Allowed`**
服务器没开放该方法。界面上仍能看到原始响应，方便确认服务端配置。

**`409 Conflict`**
父集合不存在。上传多层目录时扩展会自动逐级 `MKCOL`，手动新建时请确认父目录存在。

**预览音频没有声音 / 封面不显示**
- 先看播放器下方「标签 / 封面 / ReplayGain 详情」：它会明确写出「文件里没有内嵌图片」
  「文件里没有 ReplayGain 信息」——这些是正常结论，不是解析失败。
- 音频在**后台标签页**里会被浏览器限制加载，请让文件管理器标签页保持在前台。
- 播放 MIDI 没声音时，看 MIDI 面板里 **「内置合成器发声」** 是否勾上（默认开，不需要外部硬件）；
  这个开关和音量 / 静音是两回事——静音、音量归零都会让它暂时不发声，但不会取消勾选。
- 如果刻意关掉了内置合成器，又没选 MIDI 输出设备，那就是「静音播放」，进度会走但没有声音，这是预期行为。

**MIDI 设备列表是空的**
- 先确认预览的是 **MIDI 文件**：`🎹 MIDI 设备与同步` 面板只在 `.mid / .midi / .kar`
  预览下出现，放 MP3 / FLAC 时整块是隐藏的（那些设置对音频没有意义）。
- 先确认已经**启用**：展开「🎹 MIDI 设备与同步」面板（或点「启用 Web MIDI」）才会申请权限并扫描设备，
  这是有意为之——浏览器现在需要用户同意，扩展不会在打开文件时擅自弹权限框。
- 需要浏览器支持 Web MIDI，且系统里存在可用设备或虚拟端口
  （macOS 可在「音频 MIDI 设置」里启用 IAC 驱动当虚拟端口）。
- 面板会显示「输入 N 个 / 输出 M 个」，显示 `❌` 表示浏览器拒绝了 MIDI 权限。
- 只是播放 MIDI 文件听个响**不需要** Web MIDI：内置合成器会直接出声。

**播放 MIDI 到一半突然跳回开头 / 自己开始循环**
- 这是被当成走带控制触发了。出厂映射把低音区当成走带按钮：
  音符 36 播放暂停、**37 停止**、**38 后退 5 秒**、39 前进、40/41 上下一首、**42 循环开关**、43 静音。
- 最可能的来源是**输入端口收到了回环**：macOS 的 IAC、DAW 的 MIDI Thru、硬件音源的软直通
  都会把你刚发出去的音符又送回来；也别忘了旁边还接着的 MIDI 键盘。
- 处理办法：在「输入设备」下拉里选 **「不监听」**（默认就是它），或者只选你真正要用来控制的那个键盘。
  扩展只认选中的端口，回环/别的设备一律忽略。
- 想确认是不是这个原因：看一眼面板底部的 MIDI 监视器，播放中如果不停冒出
  「音符 C2 / 松开 C2」这类你并没有弹的消息，那就是回环。

**证书是自签名的**
先在浏览器里直接访问一次该地址并信任证书，扩展沿用的是同一个网络栈。

**为什么不用 `fetch` 在页面里直接请求？**
会被 CORS 拦截（WebDAV 服务器通常不返回 CORS 头），且拿不到完整响应头。
所有请求都必须经过后台 Service Worker。

**控制台报 `blocked by CORS policy: Response to preflight request doesn't pass access control check`**
这是「扩展的 host 权限没生效」的典型症状，**不是**服务器坏了。原理：

- 权限正常时，扩展的请求由浏览器直接发出（带 host 权限的扩展请求**不经过 CORS**，不会发预检）；
- 一旦浏览器把这份权限收回（Edge/Chrome 的「**站点访问权限**」默认可能是「**单击时**」），
  请求就退化成普通网页的跨域请求 → 先发 `OPTIONS` 预检 → WebDAV 服务器通常只回 `401` 或
  `Allow:`，不会回 `Access-Control-Allow-*` → 预检失败，于是报上面这个错。

三种修法（任选其一）：

1. 地址栏打开 `edge://extensions` → 找到本扩展 → **详细信息** → **站点访问权限** → 改成「**在所有网站上**」；
2. 回到文件管理器，点黄色提示条上的「**申请访问权限**」当场授权；
3. 点工具栏「**🔍 诊断**」查看报告，第一行就会告诉你权限是 `✔ 已授予` 还是 `✗ 未授予`。

> 扩展 ID 是按**安装目录**算出来的：同一份代码在不同电脑 / 不同路径下安装，ID 不一样。
> 核对时以 `edge://extensions` 里显示的那串字母为准。

**为什么打开 XML 页面时右下角没有入口？**
只有内容看起来确实是 `<multistatus>`（含 DAV 命名空间或 href）才会出现；
普通 XML / RSS 不会打扰你。入口出现后点 ✕ 可以关闭。
