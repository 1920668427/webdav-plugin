/**
 * 标准 MIDI 文件（SMF / .mid）解析与播放。
 *
 * 解析：MThd 头 + 多个 MTrk 轨道，处理变长量、running status、元事件（速度/拍号/曲名）、SysEx。
 * 播放：把通道消息摊平成时间轴，一半发给 Web MIDI 输出设备，一半交给内置合成器直接出声，
 *       这样有没有硬件都能听到东西。
 */

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readAscii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] || 0);
  return out;
}

/** 变长量（最多 4 字节） */
function readVarLength(bytes, cursor) {
  let value = 0;
  let consumed = 0;
  while (cursor + consumed < bytes.length) {
    const byte = bytes[cursor + consumed];
    value = (value << 7) | (byte & 0x7f);
    consumed++;
    if ((byte & 0x80) === 0) break;
    if (consumed === 4) break;
  }
  return { value, consumed };
}

const CHANNEL_DATA_LENGTH = { 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2 };

const META_NAMES = {
  0x00: 'sequence-number',
  0x01: 'text',
  0x02: 'copyright',
  0x03: 'track-name',
  0x04: 'instrument-name',
  0x05: 'lyric',
  0x06: 'marker',
  0x07: 'cue-point',
  0x20: 'channel-prefix',
  0x21: 'port',
  0x2f: 'end-of-track',
  0x51: 'tempo',
  0x54: 'smpte-offset',
  0x58: 'time-signature',
  0x59: 'key-signature',
  0x7f: 'sequencer-specific',
};

/**
 * 解析一个标准 MIDI 文件。
 * @param {Uint8Array} bytes
 */
export function parseSmf(bytes) {
  const result = {
    format: 0,
    trackCount: 0,
    division: 480,
    smpte: null,
    tracks: [],
    tempoMap: [{ tick: 0, usPerQuarter: 500000 }],
    durationMs: 0,
    noteCount: 0,
    channels: [],
    warnings: [],
    title: '',
  };

  if (!bytes || bytes.length < 14 || readAscii(bytes, 0, 4) !== 'MThd') {
    result.warnings.push('不是标准 MIDI 文件（缺少 MThd 头）');
    return result;
  }

  const headerLength = readUint32(bytes, 4);
  result.format = readUint16(bytes, 8);
  result.trackCount = readUint16(bytes, 10);
  const division = readUint16(bytes, 12);

  if (division & 0x8000) {
    // SMPTE：高字节是负的帧率
    const fps = 256 - ((division >> 8) & 0xff);
    const ticksPerFrame = division & 0xff;
    result.smpte = { fps, ticksPerFrame };
    result.division = fps * ticksPerFrame;
  } else {
    result.division = division || 480;
  }

  let cursor = 8 + headerLength;
  let trackIndex = 0;
  const tempoEvents = [];

  while (cursor + 8 <= bytes.length && trackIndex < result.trackCount) {
    const id = readAscii(bytes, cursor, 4);
    const length = readUint32(bytes, cursor + 4);
    if (id !== 'MTrk') {
      // 遇到未知块就跳过，尽量把能读的读完
      if (length <= 0) break;
      cursor += 8 + length;
      continue;
    }

    const end = Math.min(bytes.length, cursor + 8 + length);
    const track = { index: trackIndex, name: '', events: [], noteCount: 0 };
    let position = cursor + 8;
    let tick = 0;
    let runningStatus = 0;

    while (position < end) {
      const delta = readVarLength(bytes, position);
      position += delta.consumed;
      tick += delta.value;
      if (position >= end) break;

      let status = bytes[position];
      if (status < 0x80) {
        // running status：沿用上一个状态字节
        status = runningStatus;
      } else {
        position++;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[position++];
        const metaLength = readVarLength(bytes, position);
        position += metaLength.consumed;
        const data = bytes.subarray(position, position + metaLength.value);
        position += metaLength.value;
        const name = META_NAMES[metaType] || `meta-${metaType.toString(16)}`;

        if (metaType === 0x51 && data.length >= 3) {
          const usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
          tempoEvents.push({ tick, usPerQuarter });
          track.events.push({ tick, type: 'tempo', usPerQuarter, bpm: 60000000 / usPerQuarter });
        } else if (metaType === 0x03) {
          const text = decodeText(data);
          if (!track.name) track.name = text;
          if (!result.title && trackIndex === 0) result.title = text;
          track.events.push({ tick, type: 'track-name', text });
        } else if (metaType === 0x2f) {
          track.events.push({ tick, type: 'end-of-track' });
          break;
        } else if (metaType === 0x58 && data.length >= 4) {
          track.events.push({ tick, type: 'time-signature', numerator: data[0], denominator: 2 ** data[1] });
        } else if (metaType === 0x01 || metaType === 0x05 || metaType === 0x06) {
          track.events.push({ tick, type: name, text: decodeText(data) });
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVarLength(bytes, position);
        position += sysexLength.consumed + sysexLength.value;
        continue;
      }

      const command = status & 0xf0;
      const dataLength = CHANNEL_DATA_LENGTH[command >> 4];
      if (dataLength == null) break; // 数据坏了，别继续瞎读
      const data = bytes.subarray(position, position + dataLength);
      position += dataLength;

      const channel = status & 0x0f;
      if (!result.channels.includes(channel)) result.channels.push(channel);

      const event = {
        tick,
        type: 'channel',
        status,
        command,
        channel,
        data: Array.from(data),
        order: track.events.length,
      };

      if (command === 0x90 && data[1] > 0) {
        event.note = data[0];
        event.velocity = data[1];
        track.noteCount++;
        result.noteCount++;
      } else if (command === 0x80 || (command === 0x90 && data[1] === 0)) {
        event.note = data[0];
      } else if (command === 0xb0) {
        event.controller = data[0];
        event.value = data[1];
      } else if (command === 0xe0) {
        event.pitchBend = ((data[1] << 7) | data[0]) - 8192;
      } else if (command === 0xc0) {
        event.program = data[0];
      }

      track.events.push(event);
    }

    result.tracks.push(track);
    trackIndex++;
    cursor = end;
  }

  tempoEvents.sort((a, b) => a.tick - b.tick);
  const map = [{ tick: 0, usPerQuarter: 500000 }];
  for (const event of tempoEvents) {
    if (event.tick === 0) map[0] = event;
    else if (map[map.length - 1].tick !== event.tick) map.push(event);
  }
  result.tempoMap = map;

  /*
   * 总时长取最后一个“通道事件”（发声事件）的位置。
   * 很多 MIDI 文件末尾挂着几十秒的空小节，按 end-of-track 算会让播放器
   * 显示一个巨大的、后面全是静音的时长。
   */
  let lastSoundTick = 0;
  let lastAnyTick = 0;
  for (const track of result.tracks) {
    for (const event of track.events) {
      if (event.tick > lastAnyTick) lastAnyTick = event.tick;
      if (event.type === 'channel' && event.tick > lastSoundTick) lastSoundTick = event.tick;
    }
  }
  result.lastTick = lastSoundTick || lastAnyTick;
  result.durationMs = tickToMs(result, result.lastTick);
  result.tailMs = tickToMs(result, lastAnyTick);
  result.channels.sort((a, b) => a - b);
  return result;
}

/**
 * 元事件里的文本解码。
 *
 * MIDI 元事件没有任何编码标记，现实里的曲名不是 UTF-8，就是 Shift-JIS（日文）
 * 或 GBK（中文），只能挨个试。这里有个必须绕开的坑：
 *
 *   GBK 中文的字节几乎都落在 0xA1–0xDF，而这一段在 Shift-JIS 里正好是
 *   **单字节半角片假名**。于是 GBK 的「室内系的」被当成 Shift-JIS 解时既不抛异常、
 *   也没有 \uFFFD，只是安静地变成「ﾊﾒﾄﾚﾏｵｵﾄ」——
 *   只按「能解通就用」的顺序猜、且 Shift-JIS 排在 GBK 前面，中文曲名必乱码。
 *
 * 所以 Shift-JIS 解出来的结果要先验一下像不像日文（见 looksLikeMisreadGbk）：
 * 只要里面一半以上的非 ASCII 字符是半角片假名，或者混进了私用区字符
 * （例如「音乐：」的 F4C0 会解成 U+E36F），就认定这是 GBK 被误读，改用 GBK；
 * 真正的日文曲名含全角假名，不会被误伤。
 * 其余情况保持原有优先级 utf-8 → shift_jis → gbk → big5，
 * 真正的 Shift-JIS 曲名（例如「炉心融解　～ Melt Down」）不受影响。
 */
const textDecoders = (() => {
  const list = [];
  for (const label of ['utf-8', 'shift_jis', 'gbk', 'big5']) {
    try {
      list.push({ label, decoder: new TextDecoder(label, { fatal: true }) });
    } catch {
      /* 环境不支持就算了 */
    }
  }
  return list;
})();

const latin1Decoder = new TextDecoder('latin1');

function cleanText(text) {
  return text.replace(/\u0000+$/, '').trim();
}

/**
 * 这段文本像不像「GBK 被当成 Shift-JIS 解」？
 *   - 出现全角假名 → 就是日文，不是误读；
 *   - 出现私用区字符（U+E000–U+F8FF）→ 正常曲名里不会有，只能是解错了；
 *   - 一半以上是非 ASCII 字符是半角片假名 → 中文的典型误读形态。
 */
function looksLikeMisreadGbk(text) {
  const chars = Array.from(text.replace(/[\u0000-\u007F]/g, ''));
  if (!chars.length) return false;

  let halfWidth = 0;
  let privateUse = 0;
  let kana = 0;
  for (const char of chars) {
    const code = char.codePointAt(0);
    if (code >= 0x3040 && code <= 0x30ff) kana += 1;
    else if (code >= 0xff61 && code <= 0xff9f) halfWidth += 1;
    else if (code >= 0xe000 && code <= 0xf8ff) privateUse += 1;
  }

  if (kana > 0) return false;
  if (privateUse > 0) return true;
  return halfWidth >= chars.length / 2;
}

export function decodeText(bytes) {
  if (!bytes || !bytes.length) return '';

  const candidates = [];
  for (const { label, decoder } of textDecoders) {
    let text;
    try {
      text = cleanText(decoder.decode(bytes));
    } catch {
      continue; // 这个编码解不通，换下一个
    }
    if (!text || text.includes('\uFFFD')) continue;
    candidates.push({ label, text });
  }

  const picked = candidates.find((item) => !(item.label === 'shift_jis' && looksLikeMisreadGbk(item.text)));
  return (picked || candidates[0])?.text ?? cleanText(latin1Decoder.decode(bytes));
}

/**
 * tick → 毫秒（按速度表分段累加）
 */
export function tickToMs(smf, tick) {
  const { division, smpte, tempoMap } = smf;
  if (smpte) return (tick / division) * 1000;

  let ms = 0;
  let lastTick = 0;
  let tempo = 500000;
  for (const point of tempoMap) {
    if (point.tick >= tick) break;
    ms += ((point.tick - lastTick) * tempo) / division / 1000;
    lastTick = point.tick;
    tempo = point.usPerQuarter;
  }
  ms += ((tick - lastTick) * tempo) / division / 1000;
  return ms;
}

/**
 * 把所有通道消息摊平成一条按时间排序的播放时间轴。
 * @returns {Array<{timeMs:number, tick:number, data:number[]}>}
 */
export function buildPlaybackSchedule(smf) {
  const events = [];
  let order = 0;
  for (const track of smf.tracks) {
    for (const event of track.events) {
      if (event.type !== 'channel') continue;
      events.push({ tick: event.tick, data: [event.status, ...event.data], order: order++ });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const { division, smpte, tempoMap } = smf;
  let ms = 0;
  let lastTick = 0;
  let tempo = 500000;
  let tempoIndex = 0;

  for (const event of events) {
    if (smpte) {
      event.timeMs = (event.tick / division) * 1000;
      continue;
    }
    while (tempoIndex < tempoMap.length && tempoMap[tempoIndex].tick <= event.tick) {
      const point = tempoMap[tempoIndex++];
      ms += ((point.tick - lastTick) * tempo) / division / 1000;
      lastTick = point.tick;
      tempo = point.usPerQuarter;
    }
    ms += ((event.tick - lastTick) * tempo) / division / 1000;
    lastTick = event.tick;
    event.timeMs = ms;
  }

  return events;
}

/** 每个通道用得最多的音色，用来给界面显示 */
export function summarizePrograms(smf) {
  const programs = new Map();
  for (const track of smf.tracks) {
    for (const event of track.events) {
      if (event.type === 'channel' && event.command === 0xc0) programs.set(event.channel, event.data[0]);
    }
  }
  return [...programs.entries()].map(([channel, program]) => ({ channel, program }));
}

/* ------------------------------------------------------------------ */
/* 内置合成器（没有硬件也能出声）                                       */
/* ------------------------------------------------------------------ */

const WAVEFORMS = ['triangle', 'sawtooth', 'square', 'sine'];

/**
 * 一个够用就好的复音合成器：每个音符一个振荡器 + 包络，
 * 出口挂一个低通滤波，避免方波太刺耳。
 */
export class SimpleSynth {
  constructor({ audioContext, destination, maxVoices = 32 } = {}) {
    this.context = audioContext;
    this.maxVoices = maxVoices;
    this.voices = new Map(); // "channel:note" → {oscillator, gain, startedAt}
    this.master = null;
    this.filter = null;
    this.enabled = Boolean(audioContext);

    if (this.enabled) {
      this.filter = audioContext.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 5200;
      this.filter.Q.value = 0.4;

      this.master = audioContext.createGain();
      this.master.gain.value = 0.22;

      this.analyser = audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

      this.filter.connect(this.master);
      this.master.connect(this.analyser);
      this.analyser.connect(destination || audioContext.destination);
    }
  }

  get activeVoiceCount() {
    return this.voices.size;
  }

  noteOn(channel, note, velocity, when) {
    if (!this.enabled) return;
    const key = `${channel}:${note}`;
    if (this.voices.has(key)) this.noteOff(channel, note, when);

    if (this.voices.size >= this.maxVoices) {
      // 偷最老的音
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [voiceKey, voice] of this.voices) {
        if (voice.startedAt < oldestTime) {
          oldestTime = voice.startedAt;
          oldestKey = voiceKey;
        }
      }
      if (oldestKey) {
        const [oldChannel, oldNote] = oldestKey.split(':').map(Number);
        this.noteOff(oldChannel, oldNote, when);
      }
    }

    const time = Math.max(when || this.context.currentTime, this.context.currentTime);
    const oscillator = this.context.createOscillator();
    oscillator.type = WAVEFORMS[channel % WAVEFORMS.length];
    oscillator.frequency.value = 440 * Math.pow(2, (note - 69) / 12);

    const gain = this.context.createGain();
    const peak = Math.max(0.02, (velocity / 127) * 0.5);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.72), time + 0.25);

    oscillator.connect(gain);
    gain.connect(this.filter);
    oscillator.start(time);

    this.voices.set(key, { oscillator, gain, startedAt: time });
  }

  noteOff(channel, note, when) {
    if (!this.enabled) return;
    const key = `${channel}:${note}`;
    const voice = this.voices.get(key);
    if (!voice) return;
    const time = Math.max(when || this.context.currentTime, this.context.currentTime);
    try {
      voice.gain.gain.cancelScheduledValues(time);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), time);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
      voice.oscillator.stop(time + 0.16);
    } catch {
      /* 已经停了 */
    }
    this.voices.delete(key);
  }

  allNotesOff(when) {
    for (const key of [...this.voices.keys()]) {
      const [channel, note] = key.split(':').map(Number);
      this.noteOff(channel, note, when);
    }
  }

  setVolume(value) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, value)) * 0.3;
  }

  /** 给频谱可视化用 */
  getSpectrum() {
    if (!this.enabled || !this.analyser) return null;
    this.analyser.getByteFrequencyData(this.frequencyData);
    return this.frequencyData;
  }

  dispose() {
    this.allNotesOff();
    try {
      this.master && this.master.disconnect();
      this.filter && this.filter.disconnect();
    } catch {
      /* 忽略 */
    }
    this.enabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 播放器                                                             */
/* ------------------------------------------------------------------ */

const LOOKAHEAD_MS = 180;
const TICK_INTERVAL_MS = 25;

/**
 * MIDI 文件播放器：把时间轴上的消息同时投递给 Web MIDI 输出与内置合成器。
 *
 * 时间基准统一用 performance.now()，避免音频时钟和墙钟来回换算。
 */
export class SmfPlayer {
  constructor({ audioContext = null, midiBridge = null, synth = null, onProgress = null, onEnded = null } = {}) {
    this.context = audioContext;
    this.midiBridge = midiBridge;
    this.synth = synth || (audioContext ? new SimpleSynth({ audioContext, destination: null }) : null);
    this.onProgress = onProgress || (() => {});
    this.onEnded = onEnded || (() => {});

    this.smf = null;
    this.schedule = [];
    this.cursor = 0;
    this.playing = false;
    this.positionMs = 0;
    this.startedAt = 0;
    this.timer = null;
    this.sendClock = true;
    this.useSynth = Boolean(this.synth);
    this.activeNotes = new Set();
  }

  load(bytesOrSmf) {
    this.stop();
    this.smf = bytesOrSmf && bytesOrSmf.tracks ? bytesOrSmf : parseSmf(bytesOrSmf);
    this.schedule = buildPlaybackSchedule(this.smf);
    this.cursor = 0;
    this.positionMs = 0;
    this.onProgress(this.getState());
    return this.smf;
  }

  get durationMs() {
    return this.smf ? this.smf.durationMs : 0;
  }

  getState() {
    return {
      playing: this.playing,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      eventCount: this.schedule.length,
      noteCount: this.smf ? this.smf.noteCount : 0,
      bpm: this.currentBpm(),
      activeVoices: this.synth ? this.synth.activeVoiceCount : 0,
    };
  }

  currentBpm() {
    if (!this.smf) return 120;
    const map = this.smf.tempoMap;
    let bpm = 120;
    for (const point of map) {
      if (this.smf && tickToMs(this.smf, point.tick) <= this.positionMs) bpm = 60000000 / point.usPerQuarter;
    }
    return bpm;
  }

  /** 把音频上下文时间换算成“当前时刻” */
  contextTimeFor(wallMs) {
    if (!this.context) return 0;
    const delta = (wallMs - performance.now()) / 1000;
    return this.context.currentTime + delta;
  }

  play() {
    if (!this.smf || this.playing) return;
    if (this.positionMs >= this.durationMs - 1) this.seek(0);

    // 合成器要有声音，上下文必须处于 running
    if (this.context && this.context.state === 'suspended') this.context.resume().catch(() => {});

    this.playing = true;
    this.startedAt = performance.now() - this.positionMs;

    if (this.midiBridge && this.sendClock) {
      this.midiBridge.sendTransport(this.positionMs > 0 ? 'continue' : 'start');
      this.midiBridge.startClock(this.currentBpm());
    }

    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.tick();
    this.onProgress(this.getState());
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.positionMs = performance.now() - this.startedAt;
    clearInterval(this.timer);
    this.timer = null;
    this.allNotesOff();
    if (this.midiBridge) {
      this.midiBridge.stopClock();
      if (this.sendClock) this.midiBridge.sendTransport('stop');
    }
    this.onProgress(this.getState());
  }

  stop() {
    const wasPlaying = this.playing;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.allNotesOff();
    if (this.midiBridge && wasPlaying) {
      this.midiBridge.stopClock();
      if (this.sendClock) this.midiBridge.sendTransport('stop');
    }
    this.positionMs = 0;
    this.cursor = 0;
    this.onProgress(this.getState());
  }

  seek(ms) {
    const target = Math.max(0, Math.min(this.durationMs, ms));
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.pause();
      this.positionMs = target;
      // 把游标挪到目标位置之前最近的一个事件
      this.cursor = lowerBound(this.schedule, target);
      // 拖到末尾就停在末尾。不能直接 play()：play() 里有「已经在末尾就回到开头」
      // 的重播逻辑，会把「拖到结尾」变成「跳回开头」。
      if (target >= this.durationMs) {
        this.onProgress(this.getState());
        return;
      }
      this.play();
    } else {
      this.positionMs = target;
      this.cursor = lowerBound(this.schedule, target);
    }
    this.onProgress(this.getState());
  }

  allNotesOff() {
    if (this.useSynth && this.synth) this.synth.allNotesOff();
    if (this.midiBridge) this.midiBridge.allNotesOff();
    this.activeNotes.clear();
  }

  /** 前瞻调度：把未来 180ms 内的消息排出去 */
  tick() {
    if (!this.playing) return;
    const now = performance.now();
    this.positionMs = now - this.startedAt;
    const horizon = this.positionMs + LOOKAHEAD_MS;

    while (this.cursor < this.schedule.length && this.schedule[this.cursor].timeMs <= horizon) {
      const event = this.schedule[this.cursor++];
      this.dispatch(event, now);
    }

    if (this.positionMs >= this.durationMs) {
      this.pause();
      this.positionMs = this.durationMs;
      this.onProgress(this.getState());
      this.onEnded(this.getState());
      return;
    }

    this.onProgress(this.getState());
  }

  dispatch(event, now) {
    const wallMs = this.startedAt + event.timeMs;
    const audioTime = this.contextTimeFor(wallMs);
    const [status, ...data] = event.data;
    const command = status & 0xf0;
    const channel = status & 0x0f;

    if (this.midiBridge && this.midiBridge.getOutputPort && this.midiBridge.getOutputPort()) {
      this.midiBridge.send(event.data, wallMs);
    }

    if (!this.useSynth || !this.synth) return;
    if (command === 0x90 && data[1] > 0) {
      this.synth.noteOn(channel, data[0], data[1], audioTime);
      this.activeNotes.add(`${channel}:${data[0]}`);
    } else if (command === 0x80 || (command === 0x90 && data[1] === 0)) {
      this.synth.noteOff(channel, data[0], audioTime);
      this.activeNotes.delete(`${channel}:${data[0]}`);
    } else if (command === 0xb0 && (data[0] === 123 || data[0] === 120)) {
      this.synth.allNotesOff(audioTime);
    }
  }

  setUseSynth(enabled) {
    const wasEnabled = this.useSynth;
    this.useSynth = Boolean(enabled);
    if (wasEnabled && !this.useSynth) {
      // 关掉时要真的松开正在响的音。
      // 不能走 this.allNotesOff()：那时 useSynth 已经是 false，会被它跳过去，
      // 结果是「关了开关但音符还在响」。外部 MIDI 设备不受本地开关影响。
      if (this.synth) this.synth.allNotesOff();
      this.activeNotes.clear();
    }
  }

  setSendClock(enabled) {
    this.sendClock = Boolean(enabled);
    if (this.midiBridge && this.playing) {
      if (this.sendClock) this.midiBridge.startClock(this.currentBpm());
      else this.midiBridge.stopClock();
    }
  }

  dispose() {
    this.stop();
    if (this.synth) this.synth.dispose();
  }
}

/** 找到第一个 timeMs >= target 的下标 */
function lowerBound(schedule, target) {
  let low = 0;
  let high = schedule.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (schedule[mid].timeMs < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
