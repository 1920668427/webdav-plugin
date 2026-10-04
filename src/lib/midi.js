/**
 * Web MIDI：消息编解码 + 设备桥接 + 默认映射。
 *
 * 用途：让 MIDI 键盘 / 控制器能直接操作播放器（播放暂停、切歌、调音量、定位），
 * 同时把 Start / Stop / Continue 与 MIDI 时钟发给外部设备或 DAW，做到同步。
 *
 * 设计上把 navigator.requestMIDIAccess 做成可注入的依赖，
 * 这样单元测试和端到端测试都能塞一个假设备进来，不需要真硬件。
 */

/* ------------------------------------------------------------------ */
/* 消息编解码                                                          */
/* ------------------------------------------------------------------ */

const REALTIME_NAMES = {
  0xf8: 'clock',
  0xfa: 'start',
  0xfb: 'continue',
  0xfc: 'stop',
  0xfe: 'activesense',
  0xff: 'reset',
};

/**
 * 解析一条 MIDI 消息。
 * @param {Uint8Array|number[]} data
 * @returns {object|null}
 */
export function parseMidiMessage(data) {
  if (!data || !data.length) return null;
  const bytes = Array.from(data);
  const status = bytes[0];

  if (status >= 0xf8) {
    return { type: REALTIME_NAMES[status] || 'realtime', status, raw: bytes };
  }
  if (status === 0xf0 || status === 0xf7) {
    return { type: 'sysex', status, raw: bytes };
  }
  if (status < 0x80) {
    return { type: 'invalid', status, raw: bytes };
  }

  const command = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  switch (command) {
    case 0x80:
      return { type: 'noteoff', channel, note: bytes[1], velocity: bytes[2] ?? 0, status, raw: bytes };
    case 0x90:
      return bytes[2]
        ? { type: 'noteon', channel, note: bytes[1], velocity: bytes[2], status, raw: bytes }
        : { type: 'noteoff', channel, note: bytes[1], velocity: 0, status, raw: bytes };
    case 0xa0:
      return { type: 'polyaftertouch', channel, note: bytes[1], pressure: bytes[2], status, raw: bytes };
    case 0xb0:
      return { type: 'cc', channel, controller: bytes[1], value: bytes[2], status, raw: bytes };
    case 0xc0:
      return { type: 'program', channel, program: bytes[1], status, raw: bytes };
    case 0xd0:
      return { type: 'aftertouch', channel, pressure: bytes[1], status, raw: bytes };
    case 0xe0: {
      const value = ((bytes[2] << 7) | bytes[1]) - 8192;
      return { type: 'pitchbend', channel, value, normalized: value / 8192, status, raw: bytes };
    }
    default:
      return { type: 'unknown', status, raw: bytes };
  }
}

/** 把带数值的消息归一化到 0..1（推子、力度、弯音轮都能用同一个函数） */
export function midiValueToUnit(message) {
  if (!message) return 0;
  switch (message.type) {
    case 'cc':
      return message.value / 127;
    case 'noteon':
      return message.velocity / 127;
    case 'pitchbend':
      return (message.value + 8192) / 16383;
    case 'aftertouch':
    case 'polyaftertouch':
      return (message.pressure ?? 0) / 127;
    default:
      return 0;
  }
}

/** 编号 → 音名，例如 60 → C4 */
export function noteName(note) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(note / 12) - 1;
  return `${names[note % 12]}${octave}`;
}

/** CC 编号 → 常见名称 */
export function controllerName(controller) {
  const names = {
    1: '调制轮',
    2: '呼吸',
    4: '脚踏',
    7: '音量',
    10: '声像',
    11: '表情',
    64: '延音踏板',
    65: '滑音',
    66: 'Sostenuto',
    67: '弱音踏板',
    71: '共鸣',
    74: '亮度',
    84: '滑音控制',
    91: '混响',
    93: '合唱',
    120: '全部声音关闭',
    121: '重置控制器',
    123: '全部音符关闭',
  };
  return names[controller] || `CC${controller}`;
}

/** 消息 → 人类可读描述，给界面上的 MIDI 监视器用 */
export function describeMessage(message) {
  if (!message) return '';
  switch (message.type) {
    case 'noteon':
      return `音符 ${noteName(message.note)} 力度 ${message.velocity}（通道 ${message.channel}）`;
    case 'noteoff':
      return `松开 ${noteName(message.note)}（通道 ${message.channel}）`;
    case 'cc':
      return `${controllerName(message.controller)} = ${message.value}（通道 ${message.channel}）`;
    case 'pitchbend':
      return `弯音 ${message.value > 0 ? '+' : ''}${message.value}（通道 ${message.channel}）`;
    case 'program':
      return `音色切换 #${message.program}（通道 ${message.channel}）`;
    case 'clock':
      return 'MIDI 时钟';
    case 'start':
      return 'MIDI Start';
    case 'stop':
      return 'MIDI Stop';
    case 'continue':
      return 'MIDI Continue';
    case 'sysex':
      return `SysEx（${message.raw.length} 字节）`;
    default:
      return message.type;
  }
}

/* ------------------------------------------------------------------ */
/* 默认映射                                                            */
/* ------------------------------------------------------------------ */

/**
 * 出厂默认映射，尽量贴近常见控制器习惯：
 * 低音区（C1 起）当走带按钮，CC7 音量、CC1 调制轮当速度、弯音轮微调位置。
 */
export const DEFAULT_BINDINGS = [
  { action: 'play-pause', label: '播放 / 暂停', match: { type: 'noteon', note: 36 } },
  { action: 'stop', label: '停止', match: { type: 'noteon', note: 37 } },
  { action: 'seek-back', label: '后退 5 秒', match: { type: 'noteon', note: 38 } },
  { action: 'seek-forward', label: '前进 5 秒', match: { type: 'noteon', note: 39 } },
  { action: 'prev', label: '上一个', match: { type: 'noteon', note: 40 } },
  { action: 'next', label: '下一个', match: { type: 'noteon', note: 41 } },
  { action: 'loop', label: '循环开关', match: { type: 'noteon', note: 42 } },
  { action: 'mute', label: '静音开关', match: { type: 'noteon', note: 43 } },
  { action: 'replaygain-cycle', label: '切换 ReplayGain 模式', match: { type: 'noteon', note: 44 } },
  { action: 'volume', label: '音量', match: { type: 'cc', controller: 7 }, continuous: true },
  { action: 'rate', label: '播放速度', match: { type: 'cc', controller: 1 }, continuous: true, range: [0.5, 2] },
  { action: 'seek', label: '弯音轮定位', match: { type: 'pitchbend' }, continuous: true, relative: true },
];

/** 这条消息命中哪个绑定？ */
export function matchBinding(message, bindings = DEFAULT_BINDINGS) {
  if (!message) return null;
  for (const binding of bindings) {
    const match = binding.match || {};
    let hit = true;
    for (const [key, value] of Object.entries(match)) {
      if (message[key] !== value) {
        hit = false;
        break;
      }
    }
    if (hit) return binding;
  }
  return null;
}

/** 消息在这套绑定下的归属动作（用于 MIDI Learn 去重） */
export function bindingKey(match) {
  return Object.entries(match)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');
}

/* ------------------------------------------------------------------ */
/* 设备桥接                                                            */
/* ------------------------------------------------------------------ */

/**
 * Web MIDI 桥。
 *
 * 事件：
 *   status  —— 设备列表或状态变化
 *   action  —— 解析出播放器动作：{action, value, message, binding}
 *   message —— 原始消息（给 MIDI 监视器用）
 */
export class MidiBridge {
  constructor({ requestAccess = null, bindings = DEFAULT_BINDINGS, onStatus, onAction, onMessage } = {}) {
    this.requestAccess = requestAccess;
    this.bindings = bindings.map((binding) => ({ ...binding }));
    this.onStatus = onStatus || (() => {});
    this.onAction = onAction || (() => {});
    this.onMessage = onMessage || (() => {});

    this.access = null;
    this.inputs = [];
    this.outputs = [];
    this.selectedInputId = null;
    this.selectedOutputId = null;
    this.status = { supported: this.isSupported(), state: 'idle', error: null };
    this.pendingInit = null;
    this.learning = null;
    this.clock = { timer: null, bpm: 120, startedAt: 0, ticks: 0 };
    this.lastPitchBend = 0;
  }

  isSupported() {
    if (this.requestAccess) return true;
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  get supported() {
    return this.isSupported();
  }

  /** 申请 MIDI 访问权限并枚举设备。同一个会话里并发调用只会真正申请一次 */
  async init() {
    if (!this.isSupported()) {
      this.status = { supported: false, state: 'unsupported', error: '这个浏览器不支持 Web MIDI' };
      this.emitStatus();
      return this.status;
    }
    if (this.access) {
      this.refreshDevices();
      return this.status;
    }
    // 展开面板、勾选时钟、点「启用 Web MIDI」可能几乎同时触发，
    // 权限只申请一次，免得弹出好几个权限提示框。
    if (this.pendingInit) return this.pendingInit;

    this.pendingInit = (async () => {
      try {
        const request = this.requestAccess || ((options) => navigator.requestMIDIAccess(options));
        this.access = await request({ sysex: false });
        this.access.onstatechange = () => this.refreshDevices();
        this.status = { supported: true, state: 'ready', error: null };
        this.refreshDevices();
      } catch (err) {
        this.status = {
          supported: true,
          state: 'denied',
          error: err && err.name === 'SecurityError' ? '浏览器拒绝了 MIDI 访问权限' : `MIDI 初始化失败：${err.message}`,
        };
        this.emitStatus();
      }
      return this.status;
    })();

    try {
      return await this.pendingInit;
    } finally {
      this.pendingInit = null;
    }
  }

  refreshDevices() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].map((port) => ({
      id: port.id,
      name: port.name || '未命名输入',
      manufacturer: port.manufacturer || '',
      state: port.state,
    }));
    this.outputs = [...this.access.outputs.values()].map((port) => ({
      id: port.id,
      name: port.name || '未命名输出',
      manufacturer: port.manufacturer || '',
      state: port.state,
    }));

    // 设备掉线时清空选择
    if (this.selectedInputId && !this.inputs.some((p) => p.id === this.selectedInputId)) this.selectedInputId = null;
    if (this.selectedOutputId && !this.outputs.some((p) => p.id === this.selectedOutputId)) this.selectedOutputId = null;

    this.attachInputs();
    this.emitStatus();
  }

  attachInputs() {
    if (!this.access) return;
    for (const port of this.access.inputs.values()) {
      // 把端口 id 传进去，好按「输入设备」选择过滤
      port.onmidimessage = (event) => this.handleMidiMessage(event, port.id);
    }
  }

  /**
   * 收到一条 MIDI 输入消息。
   *
   * 只有用户**明确选中**的输入设备才会驱动播放器：
   *   - 默认是「不监听」（selectedInputId 为 null）→ 直接忽略；
   *   - 选中了设备 → 只听它，别的端口一律忽略。
   *
   * 这条过滤很关键。默认映射把低音区 C1/C2 附近当走带按钮
   * （音符 36 播放暂停、37 停止、38 快退、42 循环…），而很多 MIDI 文件
   * 本身就带这些音。一旦输入端口收到回环（macOS IAC、DAW 的 MIDI Thru、
   * 硬件音源的软直通）或者用户随手弹了低音区，播放中就会莫名其妙
   * 「跳回开头」——因为那其实是被当成了「停止 / 快退」。
   *
   * 例外：正在 MIDI Learn 时用户就是在等一条消息，这时任何端口都收，
   * 否则「不监听」状态下根本学不了映射。
   */
  handleMidiMessage(event, portId = null) {
    const id = portId || (event && event.currentTarget && event.currentTarget.id) || null;
    if (!this.learning) {
      if (!this.selectedInputId) return;
      if (id !== this.selectedInputId) return;
    }

    const message = parseMidiMessage(event.data);
    if (!message) return;

    this.onMessage(message, event);

    // MIDI Learn：把下一条消息绑定到正在学习的动作
    if (this.learning && message.type !== 'clock' && message.type !== 'activesense') {
      const match = buildMatchFromMessage(message);
      if (match) {
        const action = this.learning;
        this.learning = null;
        this.bindings = this.bindings.filter((binding) => binding.action !== action);
        this.bindings.push({ action, label: describeMessage(message), match, continuous: isContinuous(message) });
        this.emitStatus();
        this.onAction({ action: 'learned', value: null, message, binding: this.bindings[this.bindings.length - 1] });
        return;
      }
    }

    const binding = matchBinding(message, this.bindings);
    if (!binding) return;

    let value = null;
    if (binding.continuous) {
      value = midiValueToUnit(message);
      if (binding.relative) {
        // 弯音轮：以中心为原点做相对定位
        value = message.normalized;
      }
    }
    this.onAction({ action: binding.action, value, message, binding });
  }

  selectInput(id) {
    this.selectedInputId = id || null;
    this.emitStatus();
  }

  selectOutput(id) {
    this.selectedOutputId = id || null;
    this.emitStatus();
  }

  getOutputPort() {
    if (!this.access || !this.selectedOutputId) return null;
    return this.access.outputs.get(this.selectedOutputId) || null;
  }

  /** 发送一条消息；timestamp 是 performance.now() 域的时间戳，可用则用 */
  send(bytes, timestamp) {
    const port = this.getOutputPort();
    if (!port) return false;
    try {
      if (typeof timestamp === 'number') port.send(bytes, timestamp);
      else port.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  sendTransport(kind) {
    const code = { start: 0xfa, continue: 0xfb, stop: 0xfc }[kind];
    if (code == null) return false;
    return this.send([code]);
  }

  /**
   * 启动 MIDI 时钟（24 分音符/拍）。
   * 用累积时间戳做漂移补偿，避免 setInterval 越跑越偏。
   */
  startClock(bpm = 120) {
    this.stopClock();
    this.clock.bpm = bpm;
    const intervalMs = 60000 / (bpm * 24);
    this.clock.startedAt = performance.now();
    this.clock.ticks = 0;
    this.clock.timer = setInterval(() => {
      const expected = this.clock.startedAt + this.clock.ticks * intervalMs;
      const now = performance.now();
      if (now - expected > intervalMs * 4) {
        // 落后太多（比如标签页被挂起），重新对齐
        this.clock.startedAt = now;
        this.clock.ticks = 0;
      }
      this.send([0xf8], Math.max(now, expected));
      this.clock.ticks++;
    }, Math.max(4, intervalMs));
  }

  stopClock() {
    if (this.clock.timer) clearInterval(this.clock.timer);
    this.clock.timer = null;
  }

  allNotesOff() {
    for (let channel = 0; channel < 16; channel++) {
      this.send([0xb0 | channel, 123, 0]);
      this.send([0xb0 | channel, 120, 0]);
    }
  }

  learn(action) {
    this.learning = action;
    this.emitStatus();
  }

  cancelLearn() {
    this.learning = null;
    this.emitStatus();
  }

  resetBindings() {
    this.bindings = DEFAULT_BINDINGS.map((binding) => ({ ...binding }));
    this.emitStatus();
  }

  /** 当前状态快照（设备列表、选择、映射、学习状态），界面直接拿它渲染 */
  getStatus() {
    return {
      ...this.status,
      inputs: this.inputs,
      outputs: this.outputs,
      selectedInputId: this.selectedInputId,
      selectedOutputId: this.selectedOutputId,
      learning: this.learning,
      bindings: this.bindings,
    };
  }

  emitStatus() {
    this.onStatus(this.getStatus());
  }

  dispose() {
    this.stopClock();
    this.allNotesOff();
    if (this.access) {
      for (const port of this.access.inputs.values()) port.onmidimessage = null;
      this.access.onstatechange = null;
    }
    this.access = null;
  }
}

/** 把一条消息变成匹配条件，用于 MIDI Learn */
export function buildMatchFromMessage(message) {
  switch (message.type) {
    case 'noteon':
      return { type: 'noteon', note: message.note };
    case 'noteoff':
      return { type: 'noteoff', note: message.note };
    case 'cc':
      return { type: 'cc', controller: message.controller };
    case 'pitchbend':
      return { type: 'pitchbend' };
    case 'program':
      return { type: 'program', program: message.program };
    default:
      return null;
  }
}

function isContinuous(message) {
  return message.type === 'cc' || message.type === 'pitchbend' || message.type === 'aftertouch';
}

/** 绑定 → "C1 / CC7" 这样的短标签 */
export function describeMatch(match) {
  if (!match) return '—';
  switch (match.type) {
    case 'noteon':
      return `音符 ${noteName(match.note)}`;
    case 'noteoff':
      return `松开 ${noteName(match.note)}`;
    case 'cc':
      return controllerName(match.controller);
    case 'pitchbend':
      return '弯音轮';
    case 'program':
      return `音色 #${match.program}`;
    default:
      return match.type;
  }
}
