# webaudiokit（内置副本）

[WebAudioKit](https://github.com/Roy-Jin/WebAudioKit) —— 基于 Web Audio / `HTMLAudioElement`
的背景音乐、音效与音乐播放器库。**本目录是它的发行版副本，不是我们写的代码，请勿手改。**

| 项 | 值 |
| --- | --- |
| 包名 | `webaudiokit` |
| 版本 | `1.1.2`（发行包 `dist/index.js`，ESM） |
| 许可 | MIT（见 [LICENSE](LICENSE)） |
| 主页 | https://WebAudioKit.pages.dev |
| 仓库 | https://github.com/Roy-Jin/WebAudioKit |
| `index.js` SHA-256 | `8dd62312b986e98b5f23a304a82443183492803baf75e77b02206f3fca24aadc` |

## 为什么拷进来

这个扩展是**纯静态、零构建**的：没有打包器，MV3 的 CSP 也不允许从 CDN 引脚本
（`script-src 'self'`）。所以只能把发行包原样放进扩展里，用相对路径 import：

```js
import { MusicPlayer, Music } from '../vendor/webaudiokit/index.js';
```

`lrc-kit` 已经内联在这份发行包里，因此没有别的依赖。

## 用了什么 / 没用什么

- **用**：`MusicPlayer`（装载并播放单个音频、事件、状态）、`Music`（一条音轨）。
- **没用**：`BGM` / `SFX` / 歌词 / `PlayMode` 的列表与洗牌能力。
  上一首 / 下一首和播放列表仍然由扩展的 `manager.js` 管。

## 集成上的三个注意点

1. **这个库本身不建 Web Audio 图**：它的 `volume` 是直接写 `audio.volume` 的。
   所以 ReplayGain 增益节点与频谱分析器仍然是扩展自己的（`src/lib/audio-player.js`）：
   我们把 WebAudioKit 创建的 `<audio>` 用 `createMediaElementSource()` 接进自己的图，
   并把**元素音量固定为 1**，音量完全交给图里的 `volumeNode`（否则会和库的 volume 双重衰减）。
2. **`loadAt()` 在 TS 里是 private，但运行时存在**。我们靠它 + 先设 `config.enable = false`
   实现「只装载、不自动播放」（`play()` 会直接出声，而预览需要先出封面和时长）。
   升级版本时必须重新验证这一点，`test/media.test.mjs` / `test/e2e.mjs` 里有对应断言。
3. **`stop()` 会销毁 `<audio>` 元素**（`src = ""` + `load()`），那样界面就没时长了。
   所以后端的 `stop()` 自己实现为「暂停 + 回到 0」，只在 `dispose()` 时用库的 `destroy()`。

## 怎么升级

```bash
node tools/vendor-webaudiokit.mjs 1.1.2
```

脚本从 jsDelivr（失败自动退回 unpkg）取 `dist/index.js`、`dist/index.js.map` 和 `LICENSE`，
校验 SHA-256 后写入本目录。升级后请跑 `npm test`，并确认上面第 2 条的 `loadAt` 行为没变。
