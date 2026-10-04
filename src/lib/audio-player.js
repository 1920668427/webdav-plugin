/**
 * 网页音频播放器。
 *
 * 引擎部分（AudioPlayer）：
 *   走带与媒体装载交给 WebAudioKit 的 MusicPlayer（副本见 src/vendor/webaudiokit），
 *   DSP 仍然是我们自己的 Web Audio 图，挂在它创建的 <audio> 上：
 *     <audio> → MediaElementSource → ReplayGain 增益 → 用户音量 → 分析器 → 输出
 *   - 走 Web Audio 图，所以能精确控制增益、能画频谱、能做峰值保护
 *   - ReplayGain 直接作用在增益节点上，并与用户音量解耦
 *
 * 界面部分（PlayerUI）：
 *   封面 / 标题 / 频谱 / 走带 / 进度 / 音量 / 速度 / 循环 / ReplayGain 面板 / MIDI 面板 / 标签详情
 *   同一套界面既能驱动音频后端，也能驱动 MIDI 文件后端（见 smf.js 的 SmfPlayer）。
 */

import { MusicPlayer, Music } from '../vendor/webaudiokit/index.js';
import { computeReplayGain, describeReplayGain } from './tags.js';
import { describeMatch } from './midi.js';
import { SmfPlayer, SimpleSynth } from './smf.js';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 毫秒 → 0:00 / 1:02:03 */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * MediaError.code → 人能看懂的原因。
 *
 * 注意 2 是**网络错误**而不是解码错误：对 blob: 资源来说，它基本等于
 * 「数据提前没了」——最常见的原因就是文件根本没下完（Range 分块读漏了），
 * 所以文案不能再写成「可能是格式不被浏览器支持」，那样会把排查方向带偏。
 */
export function describeMediaError(code) {
  switch (code) {
    case 1:
      return '播放被中止（错误码 1）';
    case 2:
      return '读取中断（错误码 2）：媒体数据没传完，文件可能被截断或服务器提前断开了连接';
    case 3:
      return '解码失败（错误码 3）：文件可能已损坏，或这个编码参数浏览器不支持';
    case 4:
      return '格式不受支持（错误码 4）：浏览器无法解码这个容器 / 编码';
    default:
      return `播放失败（错误码 ${code}）`;
  }
}

/** 极简事件发射器，避免依赖 DOM 的 EventTarget（Node 里也能跑） */
class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.warn('[player] 监听器异常', err);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 音频后端                                                            */
/* ------------------------------------------------------------------ */

/**
 * 音频播放后端。
 *
 * 装载与走带交给 WebAudioKit 的 MusicPlayer，我们只往它的列表里放当前这一首；
 * 上一首 / 下一首与播放列表仍然由 manager 管。
 *
 * DSP 仍然是我们自己的 Web Audio 图（见文件头注释）。因为库的 volume 是直接写
 * audio.volume 的，所以元素音量固定为 1，音量完全由图里的 volumeNode 控制。
 *
 * 不用 decodeAudioData：那要把整个文件解成 PCM，一首 60MB 的 FLAC 解出来是几百 MB。
 */
export class AudioPlayer extends Emitter {
  constructor({ audioContext = null } = {}) {
    super();

    this.context = audioContext;
    this.ownsContext = false;
    this.graphReady = false;
    this.graphElement = null; // 当前已接入图的元素；换曲目时元素会换
    this.sourceNode = null;
    this.replayGainNode = null;
    this.volumeNode = null;
    this.analyser = null;
    this.frequencyData = null;

    this.volume = 1;
    this.muted = false;
    this.rate = 1;
    this.loop = false;
    this.replayGain = { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null };
    this.replayGainMode = 'track';
    this.preAmpDb = 0;
    this.preventClipping = true;
    this.gainInfo = { gainDb: 0, linear: 1, limited: false, available: false, reason: '尚未解析' };
    this.objectUrl = null;
    this.name = '';
    this.url = '';
    this.duration = 0;
    this.error = null;

    this.player = new MusicPlayer({
      volume: 1,
      rate: 1,
      loop: false,
      fade: false, // 淡入淡出会去改元素音量，和我们的增益节点打架
      preload: false, // 播放列表在 manager，别让库再预加载下一首
      stopOnHidden: false,
    });
    this.bindPlayer();
  }

  /** WebAudioKit 每次装载都会新建 <audio>，元素只能从它这里拿 */
  get element() {
    return this.player.audioElement;
  }

  bindPlayer() {
    const player = this.player;
    player.on('play', () => this.emit('state', this.getState()));
    player.on('pause', () => this.emit('state', this.getState()));
    // 库把元素的 timeupdate 转出来了，进度条因此能平滑推进（以前只有 play/pause 才更新）
    player.on('timeupdate', () => this.emit('state', this.getState()));
    player.on('ended', () => {
      this.emit('state', this.getState());
      this.emit('ended', this.getState());
    });
    player.on('musicchange', () => this.attachElement());
    player.on('error', () => {
      const el = this.element;
      const code = el && el.error ? el.error.code : 0;
      this.error = describeMediaError(code);
      this.emit('error', this.error);
      this.emit('state', this.getState());
    });
  }

  /** 元素换新之后重新接线：属性、元数据事件、Web Audio 图 */
  attachElement() {
    const el = this.element;
    if (!el) return;

    el.preload = 'auto';
    el.playbackRate = this.rate;
    el.preservesPitch = this.rate !== 1;
    el.loop = this.loop;
    el.addEventListener('loadedmetadata', () => {
      this.duration = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
      this.error = null;
      this.emit('state', this.getState());
    });

    if (this.graphElement && this.graphElement !== el) this.detachGraph();
    this.ensureGraph();
    this.neutralizeElementVolume();
    this.applyGain();
    this.applyVolume();
  }

  /** 断开旧元素的接入点（元素被库丢弃时调用） */
  detachGraph() {
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* 已经断开 */
    }
    this.sourceNode = null;
    this.graphElement = null;
  }

  /** 按需建图：AudioContext 必须等用户手势之后才能启动 */
  ensureGraph() {
    const el = this.element;
    if (!el) return false;
    if (this.graphReady && this.graphElement === el) return true;

    try {
      if (!this.context) {
        const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null;
        if (!Ctor) return false;
        this.context = new Ctor();
        this.ownsContext = true;
      }

      // 每个 <audio> 只能建一个 MediaElementSource，换元素就得换源
      if (this.graphElement !== el) {
        this.detachGraph();
        this.sourceNode = this.context.createMediaElementSource(el);
        this.graphElement = el;
      }

      if (!this.analyser) {
        this.replayGainNode = this.context.createGain();
        this.volumeNode = this.context.createGain();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.75;
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

        this.replayGainNode.connect(this.volumeNode);
        this.volumeNode.connect(this.analyser);
        this.analyser.connect(this.context.destination);
      }

      this.sourceNode.connect(this.replayGainNode);
      this.graphReady = true;
      this.neutralizeElementVolume();
      this.applyGain();
      this.applyVolume();
      return true;
    } catch (err) {
      // 建图失败就退回元素自带音量，功能降级但还能播
      this.graphReady = false;
      this.emit('error', `Web Audio 初始化失败，已退回到基础播放：${err.message}`);
      return false;
    }
  }

  /** 图接管音量后元素音量必须保持 1，否则会被衰减两次 */
  neutralizeElementVolume() {
    if (!this.graphReady) return; // 没图的时候音量还得靠元素自己
    const el = this.element;
    if (el) el.volume = 1;
    if (this.player.volume !== 1) this.player.volume = 1;
  }

  /** 装载一个音频地址（blob: 或 http(s):）；只装载，不自动播放 */
  load(url, { name = '', revokePrevious = true } = {}) {
    this.stop();
    if (revokePrevious && this.objectUrl && this.objectUrl !== url) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (url.startsWith('blob:')) this.objectUrl = url;
    this.name = name;
    this.url = url;
    this.duration = 0;
    this.error = null;

    const player = this.player;
    player.clear();
    player.add(new Music(url, { title: name }));

    // enable=false 时 loadAt() 只建元素、不调 play()，正好是预览要的：
    // 先出封面与时长，等用户点播放再出声。loadAt 是库里的私有方法，见 vendor README。
    player.config.enable = false;
    const prepared = player.loadAt(0);
    player.config.enable = true;
    Promise.resolve(prepared).catch((err) => {
      this.error = `装载失败：${err.message}`;
      this.emit('error', this.error);
      this.emit('state', this.getState());
    });

    this.emit('state', this.getState());
  }

  /* ------------------------- 播放控制 ------------------------- */

  play() {
    this.ensureGraph();
    this.neutralizeElementVolume();
    if (this.context && this.context.state === 'suspended') this.context.resume().catch(() => {});
    const promise = this.player.play();
    if (promise && promise.catch) {
      promise.catch((err) => {
        this.error = `播放失败：${err.message}`;
        this.emit('error', this.error);
        this.emit('state', this.getState());
      });
    }
  }

  pause() {
    this.player.pause();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 自己的 stop：暂停 + 回到 0。库的 stop() 会把元素销毁，界面就没时长了 */
  stop() {
    this.player.pause();
    try {
      this.player.currentTime = 0;
    } catch {
      /* 还没装载好时忽略 */
    }
    this.emit('state', this.getState());
  }

  seek(ms) {
    const target = clamp(ms, 0, this.durationMs || Infinity) / 1000;
    try {
      this.player.currentTime = target;
    } catch {
      /* 忽略 */
    }
    this.emit('state', this.getState());
  }

  seekBy(deltaMs) {
    this.seek(this.positionMs + deltaMs);
  }

  /* ------------------------- 音量 / 增益 ------------------------- */

  setVolume(value) {
    this.volume = clamp(value, 0, 1);
    this.applyVolume();
    this.emit('state', this.getState());
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.applyVolume();
    this.emit('state', this.getState());
  }

  applyVolume() {
    const effective = this.muted ? 0 : this.volume;
    if (this.graphReady && this.volumeNode) {
      this.volumeNode.gain.value = effective;
      const el = this.element;
      if (el) el.volume = 1;
    } else {
      // 图还没建起来（浏览器没有 AudioContext）就退回元素音量
      this.player.volume = effective;
    }
  }

  /** 传入 tags.js 解析出来的 ReplayGain */
  setReplayGain(replayGain) {
    if (replayGain) this.replayGain = replayGain;
    this.applyGain();
    this.emit('state', this.getState());
  }

  setReplayGainMode(mode) {
    this.replayGainMode = mode;
    this.applyGain();
    this.emit('state', this.getState());
  }

  setPreAmpDb(db) {
    this.preAmpDb = clamp(Number(db) || 0, -12, 12);
    this.applyGain();
    this.emit('state', this.getState());
  }

  setPreventClipping(enabled) {
    this.preventClipping = Boolean(enabled);
    this.applyGain();
    this.emit('state', this.getState());
  }

  applyGain() {
    this.gainInfo = computeReplayGain(this.replayGain, {
      mode: this.replayGainMode,
      preAmpDb: this.preAmpDb,
      preventClipping: this.preventClipping,
    });
    if (this.graphReady && this.replayGainNode) {
      this.replayGainNode.gain.value = this.gainInfo.available ? this.gainInfo.linear : 1;
    }
  }

  /* ------------------------- 速度 / 循环 ------------------------- */

  setRate(rate) {
    this.rate = clamp(Number(rate) || 1, 0.25, 4);
    const el = this.element;
    if (el) {
      el.playbackRate = this.rate;
      el.preservesPitch = this.rate !== 1;
    }
    this.player.rate = this.rate; // 让库在新创建的元素上也用这个速率
    this.emit('state', this.getState());
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
    this.player.loop = this.loop; // 库里会同时写 Config.loop 与元素的 loop
    this.emit('state', this.getState());
  }

  /* ------------------------- 状态 ------------------------- */

  get playing() {
    const el = this.element;
    return Boolean(el) && !el.paused && !el.ended && el.readyState > 2;
  }

  get positionMs() {
    const el = this.element;
    return el ? (el.currentTime || 0) * 1000 : 0;
  }

  get durationMs() {
    const el = this.element;
    if (el && Number.isFinite(el.duration)) return el.duration * 1000;
    return this.duration;
  }

  get bufferedMs() {
    const el = this.element;
    try {
      if (!el || !el.buffered.length) return 0;
      return el.buffered.end(el.buffered.length - 1) * 1000;
    } catch {
      return 0;
    }
  }

  getSpectrum() {
    if (!this.graphReady || !this.analyser) return null;
    this.analyser.getByteFrequencyData(this.frequencyData);
    return this.frequencyData;
  }

  getState() {
    return {
      backend: 'audio',
      playing: this.playing,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      bufferedMs: this.bufferedMs,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
      loop: this.loop,
      replayGain: this.replayGain,
      replayGainMode: this.replayGainMode,
      preAmpDb: this.preAmpDb,
      preventClipping: this.preventClipping,
      gainInfo: this.gainInfo,
      graphReady: this.graphReady,
      supportsRate: true,
      supportsReplayGain: true,
      error: this.error,
    };
  }

  dispose() {
    try {
      this.player.destroy();
    } catch {
      /* 忽略清理异常 */
    }
    this.detachGraph();
    for (const node of [this.replayGainNode, this.volumeNode, this.analyser]) {
      try {
        node?.disconnect();
      } catch {
        /* 已经断开 */
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.ownsContext && this.context) {
      this.context.close().catch(() => {});
    }
    this.listeners.clear();
  }
}

/* ------------------------------------------------------------------ */
/* MIDI 文件后端                                                       */
/* ------------------------------------------------------------------ */

/**
 * 把 SmfPlayer 包装成和 AudioPlayer 一样的接口，好让同一套界面驱动它。
 *
 * 差异点：
 *   - 变速不支持（要变速得重排时间轴，留作以后）
 *   - 频谱来自内置合成器的分析节点
 *   - 循环在「播完」回调里自己实现
 */
export class SmfBackend extends Emitter {
  constructor({ audioContext = null, midiBridge = null, smfPlayer = null, useSynth = true } = {}) {
    super();
    this.midiBridge = midiBridge;
    this.volume = 1;
    this.muted = false;
    this.loop = false;
    this.error = null;
    // 用户对「内置合成器」的意愿，与静音 / 音量解耦：
    // 静音只是临时不出声，不该顺手把开关本身改掉。
    this.synthEnabled = Boolean(useSynth);

    this.player =
      smfPlayer ||
      new SmfPlayer({
        audioContext,
        midiBridge,
        onProgress: () => this.emit('state', this.getState()),
        onEnded: () => {
          if (this.loop) {
            this.player.seek(0);
            this.player.play();
            return;
          }
          this.emit('state', this.getState());
          this.emit('ended', this.getState());
        },
      });
    this.player.setUseSynth(this.synthEnabled);
  }

  /** @param {Uint8Array} bytes */
  load(bytes, { name = '' } = {}) {
    this.name = name;
    const smf = this.player.load(bytes);
    if (smf.warnings?.length) this.error = smf.warnings.join('；');
    this.applyVolume();
    this.emit('state', this.getState());
    return smf;
  }

  play() {
    this.player.play();
    this.emit('state', this.getState());
  }

  pause() {
    this.player.pause();
    this.emit('state', this.getState());
  }

  toggle() {
    if (this.player.playing) this.pause();
    else this.play();
  }

  stop() {
    this.player.stop();
    this.emit('state', this.getState());
  }

  seek(ms) {
    this.player.seek(ms);
    this.emit('state', this.getState());
  }

  seekBy(deltaMs) {
    this.seek(this.player.positionMs + deltaMs);
  }

  setVolume(value) {
    this.volume = clamp(value, 0, 1);
    this.applyVolume();
    this.emit('state', this.getState());
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.applyVolume();
    this.emit('state', this.getState());
  }

  applyVolume() {
    const effective = this.muted ? 0 : this.volume;
    this.player.synth?.setVolume(effective);
    // 真正发声 = 用户开关打开 && 没静音 && 音量不为 0
    this.player.setUseSynth(this.synthEnabled && effective > 0);
  }

  /** 内置合成器总开关：关掉后只把消息发给外部 MIDI 输出设备 */
  setSynthEnabled(enabled) {
    this.synthEnabled = Boolean(enabled);
    this.applyVolume();
    this.emit('state', this.getState());
    return this.synthEnabled;
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
    this.emit('state', this.getState());
  }

  /** MIDI 不支持变速，界面上会把控件禁用 */
  setRate() {
    return false;
  }

  getSpectrum() {
    return this.player.synth?.getSpectrum?.() || null;
  }

  getState() {
    const state = this.player.getState();
    return {
      backend: 'midi',
      playing: state.playing,
      positionMs: state.positionMs,
      durationMs: state.durationMs,
      bufferedMs: state.durationMs,
      volume: this.volume,
      muted: this.muted,
      rate: 1,
      loop: this.loop,
      eventCount: state.eventCount,
      noteCount: state.noteCount,
      bpm: state.bpm,
      activeVoices: state.activeVoices,
      supportsSynth: Boolean(this.player.synth),
      synthEnabled: this.synthEnabled,
      synthActive: Boolean(this.player.useSynth),
      replayGain: { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null },
      replayGainMode: 'off',
      preAmpDb: 0,
      gainInfo: { gainDb: 0, linear: 1, limited: false, available: false, reason: 'MIDI 文件没有 ReplayGain' },
      supportsRate: false,
      supportsReplayGain: false,
      error: this.error,
    };
  }

  dispose() {
    this.player.dispose();
    this.listeners.clear();
  }
}

/* ------------------------------------------------------------------ */
/* 界面                                                                */
/* ------------------------------------------------------------------ */

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 播放器界面。传入任意实现了同一套接口的后端（AudioPlayer / MIDI 后端）即可。
 */
export class PlayerUI {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = options;
    this.container = options.container;
    this.metadata = options.metadata || null;
    this.coverUrl = null;
    this.frame = null;
    this.midi = options.midiBridge || null;
    this.smfPlayer = options.smfPlayer || null;
    // 只有 MIDI 文件会传 smfPlayer。MIDI 设置（设备 / 映射 / 时钟 / 内置合成器）
    // 对音频文件没有意义，界面上整块收起来，见 renderMidi()。
    this.isMidiFile = Boolean(this.smfPlayer);
    this.onPrevNext = options.onPrevNext || null;
    this.midiLog = [];

    this.build();
    this.subscribe();
    this.render(this.backend.getState());
    this.startLoop();
  }

  /* ------------------------- 构建 DOM ------------------------- */

  build() {
    const root = document.createElement('div');
    root.className = 'player';
    root.dataset.testid = 'player';
    root.tabIndex = 0; // 让空格/方向键快捷键能落到播放器上

    root.innerHTML = `
      <div class="player-head">
        <div class="player-cover" data-testid="player-cover"><span>🎵</span></div>
        <div class="player-meta">
          <div class="player-title" data-testid="player-title">未命名音轨</div>
          <div class="player-sub" data-testid="player-sub"></div>
          <div class="player-badges" data-testid="player-badges"></div>
        </div>
        <canvas class="player-visualizer" width="320" height="72" data-testid="player-visualizer"></canvas>
      </div>

      <div class="player-transport">
        <button type="button" class="btn icon" data-action="prev" title="上一个 (Ctrl+←)">⏮</button>
        <button type="button" class="btn icon" data-action="back" title="后退 5 秒">⏪</button>
        <button type="button" class="btn icon primary" data-action="toggle" data-testid="player-toggle" title="播放 / 暂停 (空格)">▶</button>
        <button type="button" class="btn icon" data-action="forward" title="前进 5 秒">⏩</button>
        <button type="button" class="btn icon" data-action="stop" title="停止">⏹</button>
        <button type="button" class="btn icon" data-action="next" title="下一个 (Ctrl+→)">⏭</button>
        <div class="player-seek">
          <input type="range" min="0" max="1000" value="0" step="1" data-testid="player-seek" title="播放进度" />
          <span class="player-time" data-testid="player-time">0:00 / 0:00</span>
        </div>
      </div>

      <div class="player-controls">
        <button type="button" class="btn icon" data-action="mute" data-testid="player-mute" title="静音 (M)">🔊</button>
        <input type="range" min="0" max="100" value="100" data-testid="player-volume" title="音量" />
        <label class="player-field">速度
          <select data-testid="player-rate">${RATE_OPTIONS.map((r) => `<option value="${r}">${r}×</option>`).join('')}</select>
        </label>
        <button type="button" class="btn icon" data-action="loop" data-testid="player-loop" title="循环 (L)">🔁</button>
        <label class="player-field">ReplayGain
          <select data-testid="player-rg-mode">
            <option value="track">音轨</option>
            <option value="album">专辑</option>
            <option value="off">关闭</option>
          </select>
        </label>
        <label class="player-field">预增益
          <input type="range" min="-12" max="12" step="0.5" value="0" data-testid="player-preamp" title="ReplayGain 预增益 (dB)" />
        </label>
        <span class="player-gain" data-testid="player-gain"></span>
      </div>

      <details class="player-panel" data-testid="player-midi-panel">
        <summary>🎹 MIDI 设备与同步</summary>
        <div class="player-midi">
          <div class="player-midi-row">
            <label>输入设备 <select data-testid="midi-input"></select></label>
            <label>输出设备 <select data-testid="midi-output"></select></label>
            <button type="button" class="btn" data-action="midi-refresh" data-testid="midi-refresh">启用 Web MIDI</button>
            <button type="button" class="btn" data-action="midi-reset">恢复默认映射</button>
          </div>
          <div class="player-midi-row">
            <label class="check"><input type="checkbox" data-testid="midi-synth" checked /> 内置合成器发声</label>
            <label class="check"><input type="checkbox" data-testid="midi-clock" /> 发送 MIDI 时钟与 Start/Stop</label>
            <span class="player-midi-status muted" data-testid="midi-status">未初始化</span>
          </div>
          <div class="player-midi-actions" data-testid="midi-bindings"></div>
          <div class="player-midi-monitor muted" data-testid="midi-monitor">最近消息：—</div>
        </div>
      </details>

      <details class="player-panel" data-testid="player-tags-panel">
        <summary>🏷️ 标签 / 封面 / ReplayGain 详情</summary>
        <div class="player-tags" data-testid="player-tags"></div>
      </details>
    `;

    this.container.innerHTML = '';
    this.container.appendChild(root);
    this.root = root;

    this.el = {
      cover: root.querySelector('.player-cover'),
      title: root.querySelector('.player-title'),
      sub: root.querySelector('.player-sub'),
      badges: root.querySelector('.player-badges'),
      canvas: root.querySelector('.player-visualizer'),
      seek: root.querySelector('[data-testid="player-seek"]'),
      time: root.querySelector('.player-time'),
      toggle: root.querySelector('[data-testid="player-toggle"]'),
      volume: root.querySelector('[data-testid="player-volume"]'),
      mute: root.querySelector('[data-testid="player-mute"]'),
      rate: root.querySelector('[data-testid="player-rate"]'),
      loop: root.querySelector('[data-testid="player-loop"]'),
      rgMode: root.querySelector('[data-testid="player-rg-mode"]'),
      preamp: root.querySelector('[data-testid="player-preamp"]'),
      gain: root.querySelector('[data-testid="player-gain"]'),
      midiPanel: root.querySelector('[data-testid="player-midi-panel"]'),
      midiInput: root.querySelector('[data-testid="midi-input"]'),
      midiOutput: root.querySelector('[data-testid="midi-output"]'),
      midiRefresh: root.querySelector('[data-testid="midi-refresh"]'),
      synth: root.querySelector('[data-testid="midi-synth"]'),
      midiClock: root.querySelector('[data-testid="midi-clock"]'),
      midiStatus: root.querySelector('[data-testid="midi-status"]'),
      midiBindings: root.querySelector('[data-testid="midi-bindings"]'),
      midiMonitor: root.querySelector('[data-testid="midi-monitor"]'),
      tags: root.querySelector('[data-testid="player-tags"]'),
      tagsPanel: root.querySelector('[data-testid="player-tags-panel"]'),
    };

    this.bindControls();
    this.renderMetadata();
    this.renderMidi();

    // 时钟开关跟着上次保存的设置走。注意 SmfPlayer 默认 sendClock = true，
    // 如果这里不同步，就会出现在「发送 MIDI 时钟」没勾的情况下照样往外发 Start / 时钟。
    if (this.el.midiClock) {
      this.el.midiClock.checked = Boolean(this.options.sendClock);
      this.smfPlayer?.setSendClock(this.el.midiClock.checked);
    }
  }

  bindControls() {
    const { root, el } = this;

    root.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      this.handleAction(button.dataset.action);
    });

    el.seek.addEventListener('input', () => {
      const duration = this.backend.getState().durationMs || 0;
      this.backend.seek((Number(el.seek.value) / 1000) * duration);
    });

    el.volume.addEventListener('input', () => {
      this.backend.setVolume(Number(el.volume.value) / 100);
    });

    el.rate.addEventListener('change', () => {
      this.backend.setRate(Number(el.rate.value));
    });

    el.rgMode?.addEventListener('change', () => {
      this.backend.setReplayGainMode?.(el.rgMode.value);
    });

    el.preamp?.addEventListener('input', () => {
      this.backend.setPreAmpDb?.(Number(el.preamp.value));
    });

    el.midiInput?.addEventListener('change', () => {
      this.midi?.selectInput(el.midiInput.value);
      this.renderMidi();
    });

    el.midiOutput?.addEventListener('change', () => {
      this.midi?.selectOutput(el.midiOutput.value);
      this.renderMidi();
      this.options.onOutputChange?.(el.midiOutput.value);
    });

    el.midiClock?.addEventListener('change', () => {
      this.smfPlayer?.setSendClock(el.midiClock.checked);
      // 勾选时钟就是「我要用 MIDI 输出」，这时候才值得去申请权限
      if (el.midiClock.checked) this.enableMidi();
      this.options.onClockChange?.(el.midiClock.checked);
      this.midi?.emitStatus();
    });

    el.synth?.addEventListener('change', () => {
      const enabled = this.backend.setSynthEnabled?.(el.synth.checked) ?? el.synth.checked;
      this.options.onSynthChange?.(Boolean(enabled));
      this.renderMidi();
      this.render(this.backend.getState());
    });

    // 展开面板本身就是一个明确的「我要用 MIDI」信号：
    // 浏览器现在要求用户同意才能用 Web MIDI，所以不在这里之前申请权限。
    el.midiPanel?.addEventListener('toggle', () => {
      if (el.midiPanel.open) this.enableMidi();
    });

    el.midiBindings?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-learn]');
      if (!button) return;
      const action = button.dataset.learn;
      // 学映射必须有输入设备，同样算是明确要用 MIDI
      this.enableMidi();
      if (this.midi?.learning === action) this.midi.cancelLearn();
      else this.midi?.learn(action);
      this.renderMidi();
    });

    root.addEventListener('keydown', (event) => {
      const tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const handled = this.handleKey(event);
      if (handled) event.preventDefault();
    });
  }

  handleKey(event) {
    switch (event.key) {
      case ' ':
        this.backend.toggle();
        return true;
      case 'ArrowLeft':
        if (event.ctrlKey || event.metaKey) return this.runPrevNext(-1);
        this.backend.seekBy(-5000);
        return true;
      case 'ArrowRight':
        if (event.ctrlKey || event.metaKey) return this.runPrevNext(1);
        this.backend.seekBy(5000);
        return true;
      case 'ArrowUp':
        this.backend.setVolume(clamp((this.backend.getState().volume ?? 1) + 0.05, 0, 1));
        return true;
      case 'ArrowDown':
        this.backend.setVolume(clamp((this.backend.getState().volume ?? 1) - 0.05, 0, 1));
        return true;
      default:
        if (event.key === 'm' || event.key === 'M') {
          this.backend.setMuted(!this.backend.getState().muted);
          return true;
        }
        if (event.key === 'l' || event.key === 'L') {
          this.backend.setLoop(!this.backend.getState().loop);
          return true;
        }
        return false;
    }
  }

  handleAction(action) {
    const backend = this.backend;
    switch (action) {
      case 'toggle':
        backend.toggle();
        break;
      case 'stop':
        backend.stop();
        break;
      case 'back':
        backend.seekBy(-5000);
        break;
      case 'forward':
        backend.seekBy(5000);
        break;
      case 'prev':
        this.runPrevNext(-1);
        break;
      case 'next':
        this.runPrevNext(1);
        break;
      case 'mute':
        backend.setMuted(!backend.getState().muted);
        break;
      case 'loop':
        backend.setLoop(!backend.getState().loop);
        break;
      case 'midi-refresh':
        this.enableMidi();
        break;
      case 'midi-reset':
        this.midi?.resetBindings();
        this.renderMidi();
        break;
      default:
        break;
    }
  }

  /**
   * 按需申请 Web MIDI 权限。
   *
   * 浏览器（Chrome 124+ / Edge 同源实现）把 Web MIDI 放到了权限提示后面，
   * 只要调用 navigator.requestMIDIAccess 就会弹权限、并且即使已经授权过
   * 控制台也会留一条警告。所以这里只在用户明确表达了「我要用 MIDI」时才调用：
   * 展开 MIDI 面板、点「启用 Web MIDI」、勾选发送时钟、或者学映射。
   * 播放 MIDI 文件用的内置合成器不依赖 Web MIDI，完全不受影响。
   */
  enableMidi() {
    if (!this.midi) return Promise.resolve();
    const status = this.midi.getStatus?.() || this.midi.status || {};
    if (status.state === 'ready' || status.state === 'unsupported') {
      this.renderMidi();
      return Promise.resolve();
    }
    return Promise.resolve(this.midi.init())
      .then(() => this.renderMidi())
      .catch(() => this.renderMidi());
  }

  runPrevNext(direction) {
    if (this.onPrevNext && this.onPrevNext(direction) !== false) return true;
    this.backend.seekBy(direction * 5000);
    return false;
  }

  /* ------------------------- 渲染 ------------------------- */

  subscribe() {
    this.unsubscribe = this.backend.on('state', (state) => this.render(state));
    this.backend.on('ended', () => this.options.onEnded?.());
    this.backend.on('error', (message) => this.options.onError?.(message));
  }

  renderMetadata() {
    const meta = this.metadata;
    const el = this.el;
    if (!meta) return;

    el.title.textContent = meta.tags?.title || this.options.name || '未命名音轨';
    const subParts = [meta.tags?.artist, meta.tags?.album].filter(Boolean);
    el.sub.textContent = subParts.join(' · ') || this.options.name || '';

    // 封面
    const picture = (meta.pictures || []).find((p) => p.kind === 'cover-front') || (meta.pictures || [])[0];
    if (picture && picture.data && picture.data.length) {
      const blob = new Blob([picture.data], { type: picture.mimeType || 'image/jpeg' });
      this.coverUrl = URL.createObjectURL(blob);
      el.cover.innerHTML = '';
      const img = document.createElement('img');
      img.src = this.coverUrl;
      img.alt = '封面';
      img.dataset.testid = 'player-cover-img';
      el.cover.appendChild(img);
    }

    // 徽标：格式、采样率、位深、ReplayGain
    const badges = [];
    if (meta.format) badges.push(meta.format.toUpperCase());
    if (meta.audio?.sampleRate) badges.push(`${(meta.audio.sampleRate / 1000).toFixed(1)} kHz`);
    if (meta.audio?.bitsPerSample) badges.push(`${meta.audio.bitsPerSample} bit`);
    if (meta.audio?.channels) badges.push(meta.audio.channels === 1 ? '单声道' : `${meta.audio.channels} 声道`);
    if (meta.id3?.version) badges.push(`ID3v${meta.id3.version.slice(2)}`);
    const rg = meta.replayGain;
    if (rg && (rg.trackGain != null || rg.albumGain != null)) badges.push('ReplayGain');
    if (meta.pictures?.length) badges.push(`${meta.pictures.length} 张图`);
    el.badges.innerHTML = badges.map((text) => `<span class="player-badge">${text}</span>`).join('');

    this.renderTags();
  }

  renderTags() {
    const meta = this.metadata;
    if (!meta || !this.el.tags) return;
    const rows = [];
    const push = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      rows.push(`<div class="player-tag-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`);
    };

    push('文件名', this.options.name);
    push('容器格式', meta.format);
    if (meta.audio?.duration) push('时长', formatTime(meta.audio.duration * 1000));
    if (meta.audio?.sampleRate) push('采样率', `${meta.audio.sampleRate} Hz`);
    if (meta.audio?.bitsPerSample) push('位深', `${meta.audio.bitsPerSample} bit`);
    if (meta.audio?.channels) push('声道数', meta.audio.channels);
    push('标题', meta.tags?.title);
    push('艺术家', meta.tags?.artist);
    push('专辑', meta.tags?.album);
    push('专辑艺术家', meta.tags?.albumArtist);
    push('年份', meta.tags?.year);
    push('音轨号', meta.tags?.track);
    push('流派', meta.tags?.genre);
    push('注释', meta.tags?.comment);

    const rg = meta.replayGain || {};
    push('ReplayGain 音轨增益', rg.trackGain != null ? `${rg.trackGain.toFixed(2)} dB` : '（无）');
    push('ReplayGain 音轨峰值', rg.trackPeak != null ? rg.trackPeak.toFixed(4) : '（无）');
    push('ReplayGain 专辑增益', rg.albumGain != null ? `${rg.albumGain.toFixed(2)} dB` : '（无）');
    push('ReplayGain 专辑峰值', rg.albumPeak != null ? rg.albumPeak.toFixed(4) : '（无）');
    push('ReplayGain 来源', rg.source || '（文件未写入 ReplayGain）');

    if (meta.pictures?.length) {
      meta.pictures.forEach((pic, index) => {
        push(`封面 #${index + 1}`, `${pic.kind} · ${pic.mimeType} · ${(pic.data.length / 1024).toFixed(0)} KB${pic.width ? ` · ${pic.width}×${pic.height}` : ''}`);
      });
    } else {
      push('封面', '（文件里没有内嵌图片）');
    }

    const otherKeys = Object.keys(meta.allTags || {});
    if (otherKeys.length) {
      rows.push('<div class="player-tag-sep">其他原始标签</div>');
      for (const key of otherKeys.slice(0, 40)) {
        const value = meta.allTags[key];
        if (typeof value === 'string' && value.length > 300) continue;
        push(key, value);
      }
    }

    if (meta.warnings?.length) {
      rows.push('<div class="player-tag-sep">解析警告</div>');
      for (const warning of meta.warnings) push('警告', warning);
    }

    this.el.tags.innerHTML = rows.join('') || '<div class="muted">没有读到标签信息</div>';
  }

  renderMidi() {
    if (!this.midi) {
      if (this.el.midiPanel) this.el.midiPanel.hidden = true;
      return;
    }
    // 非 MIDI 文件（MP3 / FLAC / WAV…）下整块收起：设备选择、映射、时钟、
    // 内置合成器开关都只对 MIDI 文件有意义。内容照常渲染，只是藏起来，
    // 这样状态栏文案、控件的禁用态与隐藏与否无关，也不会因为隐藏而忘记同步。
    if (this.el.midiPanel) this.el.midiPanel.hidden = !this.isMidiFile;
    const el = this.el;
    const status = this.midi.getStatus?.() || {};
    const playerState = this.backend.getState?.() || {};
    const inputs = status.inputs || this.midi.inputs || [];
    const outputs = status.outputs || this.midi.outputs || [];
    const idle = status.state !== 'ready';

    const fill = (select, devices, selectedId, placeholder) => {
      if (!select) return;
      const current = select.value;
      select.innerHTML = `<option value="">${placeholder}</option>` + devices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('');
      select.value = selectedId || current || '';
      select.disabled = idle;
    };
    const idleHint = '点「启用 Web MIDI」后选择';
    fill(el.midiInput, inputs, status.selectedInputId, idle ? idleHint : inputs.length ? '不监听' : '没有发现输入设备');
    fill(el.midiOutput, outputs, status.selectedOutputId, idle ? idleHint : outputs.length ? '不输出' : '没有发现输出设备');

    if (el.midiRefresh) el.midiRefresh.textContent = idle ? '启用 Web MIDI' : '重新扫描';

    if (el.midiStatus) {
      const parts = [];
      if (!status.supported) parts.push('❌ 这个浏览器不支持 Web MIDI');
      else if (status.state === 'denied') parts.push(`❌ ${status.error}`);
      else if (status.state === 'ready') parts.push(`✅ 输入 ${inputs.length} 个 / 输出 ${outputs.length} 个`);
      else parts.push('未启用 Web MIDI（浏览器要求用户同意后才会扫描设备）');
      if (status.learning) parts.push(`● 正在学习：${status.learning}`);
      else if (playerState.supportsSynth) parts.push(`时钟 ${el.midiClock?.checked ? '开' : '关'} · 合成器${playerState.synthEnabled !== false ? '开' : '关'}`);
      el.midiStatus.textContent = parts.join(' · ');
    }

    if (el.midiBindings) {
      const bindings = status.bindings || [];
      el.midiBindings.innerHTML = bindings
        .map(
          (binding) =>
            `<button type="button" class="player-bind ${status.learning === binding.action ? 'learning' : ''}" data-learn="${escapeHtml(binding.action)}">
               <span class="player-bind-key">${escapeHtml(describeMatch(binding.match))}</span>
               <span class="player-bind-label">${escapeHtml(binding.label)}</span>
             </button>`,
        )
        .join('');
    }
  }

  pushMidiMonitor(message, text) {
    this.midiLog.unshift(text);
    this.midiLog.length = Math.min(this.midiLog.length, 6);
    if (this.el.midiMonitor) this.el.midiMonitor.textContent = `最近消息：${this.midiLog.join(' ｜ ')}`;
  }

  render(state) {
    if (!state) return;
    const el = this.el;
    const duration = state.durationMs || 0;

    el.toggle.textContent = state.playing ? '⏸' : '▶';
    el.toggle.title = state.playing ? '暂停 (空格)' : '播放 (空格)';

    const percent = duration > 0 ? (state.positionMs / duration) * 1000 : 0;
    if (document.activeElement !== el.seek) el.seek.value = String(Math.round(percent));
    el.time.textContent = `${formatTime(state.positionMs)} / ${formatTime(duration)}`;

    if (document.activeElement !== el.volume) el.volume.value = String(Math.round((state.muted ? 0 : state.volume ?? 1) * 100));
    el.mute.textContent = state.muted ? '🔇' : (state.volume > 0.5 ? '🔊' : '🔉');
    el.rate.value = String(state.rate ?? 1);
    el.rate.disabled = state.supportsRate === false;
    el.rate.title = state.supportsRate === false ? 'MIDI 文件暂不支持变速播放' : '播放速度';
    if (el.rgMode) {
      el.rgMode.disabled = state.supportsReplayGain === false;
      el.preamp.disabled = state.supportsReplayGain === false;
    }
    el.loop.classList.toggle('active', Boolean(state.loop));

    if (el.synth) {
      const supported = state.supportsSynth === true;
      el.synth.disabled = !supported;
      if (document.activeElement !== el.synth) el.synth.checked = supported && state.synthEnabled !== false;
      const label = el.synth.closest('label');
      if (label) {
        label.classList.toggle('disabled', !supported);
        label.title = supported
          ? '关闭后 MIDI 文件只发给外部输出设备，不再在浏览器里发声'
          : '当前播放的文件没有内置合成器（仅 MIDI 文件有）';
      }
    }

    if (state.replayGainMode && el.rgMode) el.rgMode.value = state.replayGainMode;
    if (el.preamp && document.activeElement !== el.preamp) el.preamp.value = String(state.preAmpDb ?? 0);

    if (el.gain) {
      const info = state.gainInfo || {};
      if (info.available) {
        el.gain.textContent = `${info.gainDb >= 0 ? '+' : ''}${info.gainDb.toFixed(2)} dB${info.limited ? '（限幅）' : ''}`;
        el.gain.classList.toggle('limited', Boolean(info.limited));
        el.gain.title = `线性增益 ×${info.linear.toFixed(3)}${info.reason ? ` · ${info.reason}` : ''}`;
      } else {
        el.gain.textContent = state.replayGainMode === 'off' ? 'RG 已关闭' : '无 RG 数据';
        el.gain.classList.remove('limited');
        el.gain.title = info.reason || describeReplayGain(state.replayGain);
      }
    }

    this.options.onState?.(state);
  }

  /* ------------------------- 频谱 ------------------------- */

  startLoop() {
    const canvas = this.el.canvas;
    if (!canvas) return;
    const context = canvas.getContext('2d');

    const draw = () => {
      this.frame = requestAnimationFrame(draw);
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      const data = this.backend.getSpectrum?.();
      const bars = 56;
      const barWidth = width / bars;

      if (!data) {
        context.fillStyle = 'rgba(128,128,128,0.25)';
        context.fillRect(0, height - 3, width, 3);
        return;
      }

      const step = Math.floor(data.length / bars) || 1;
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j] || 0;
        const value = sum / step / 255;
        const barHeight = Math.max(2, value * height);
        const gradient = context.createLinearGradient(0, height, 0, height - barHeight);
        gradient.addColorStop(0, 'rgba(37, 99, 235, 0.85)');
        gradient.addColorStop(1, 'rgba(96, 165, 250, 0.95)');
        context.fillStyle = gradient;
        context.fillRect(i * barWidth + 1, height - barHeight, Math.max(1, barWidth - 2), barHeight);
      }
    };
    this.frame = requestAnimationFrame(draw);
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.unsubscribe?.();
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    this.container.innerHTML = '';
  }
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
