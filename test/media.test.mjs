/**
 * 媒体相关单元测试：音频标签解析（含封面与 ReplayGain）、Web MIDI、标准 MIDI 文件。
 *
 *   node --test test/media.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readAudioMetadata,
  parseId3v2,
  parseId3v1,
  parseFlac,
  parseOgg,
  parseMp4,
  parseWav,
  computeReplayGain,
  describeReplayGain,
} from '../src/lib/tags.js';
import {
  parseMidiMessage,
  midiValueToUnit,
  matchBinding,
  buildMatchFromMessage,
  describeMessage,
  describeMatch,
  noteName,
  MidiBridge,
  DEFAULT_BINDINGS,
} from '../src/lib/midi.js';
import { parseSmf, buildPlaybackSchedule, tickToMs, SimpleSynth, SmfPlayer, decodeText } from '../src/lib/smf.js';
import { SmfBackend, AudioPlayer, describeMediaError } from '../src/lib/audio-player.js';
import {
  TINY_PNG,
  TINY_JPEG,
  textFrame,
  txxxFrame,
  apicFrame,
  rva2Frame,
  buildId3v2Tag,
  buildTaggedWav,
  buildWavFile,
  buildFlacFile,
  buildFlacPicture,
  buildOggVorbisFile,
  buildOggOpusFile,
  buildMp4File,
  buildMidiFile,
  buildVorbisComment,
  fakeMpegFrames,
  applyUnsynchronisation,
} from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '..');
const samplePath = (name) => resolve(workspace, name);

/* ================================================================== */
/* 音频标签                                                            */
/* ================================================================== */

test('标签：ID3v2.3 文本帧 + APIC 封面 + TXXX ReplayGain', () => {
  const tag = buildId3v2Tag([
    textFrame('TIT2', '浮夸'),
    textFrame('TPE1', '陈奕迅'),
    textFrame('TALB', 'U87'),
    textFrame('TRCK', '5/12'),
    apicFrame('image/png', TINY_PNG),
    txxxFrame('REPLAYGAIN_TRACK_GAIN', '-9.21 dB'),
    txxxFrame('REPLAYGAIN_TRACK_PEAK', '1.047'),
    txxxFrame('REPLAYGAIN_ALBUM_GAIN', '-8.50 dB'),
  ], { version: 3 });
  const bytes = new Uint8Array([...tag, ...fakeMpegFrames(2)]);

  const meta = readAudioMetadata(bytes, { name: 'test.mp3' });
  assert.equal(meta.format, 'mp3');
  assert.equal(meta.tags.title, '浮夸');
  assert.equal(meta.tags.artist, '陈奕迅');
  assert.equal(meta.tags.album, 'U87');
  assert.equal(meta.tags.track, '5/12');
  assert.equal(meta.pictures.length, 1);
  assert.equal(meta.pictures[0].mimeType, 'image/png');
  assert.equal(meta.pictures[0].kind, 'cover-front');
  assert.deepEqual([...meta.pictures[0].data], [...TINY_PNG]);
  assert.equal(meta.replayGain.trackGain, -9.21);
  assert.equal(meta.replayGain.trackPeak, 1.047);
  assert.equal(meta.replayGain.albumGain, -8.5);
  assert.equal(meta.replayGain.source, 'ID3 TXXX');
});

test('标签：ID3v2.4 帧级去同步化时仍能正确读到封面', () => {
  /*
   * 真实文件里踩到的坑：标签头带 0x80（去同步化），
   * 同时某些帧带 0x0002（帧级去同步化）。
   * 如果按 v2.3 的做法先把整块标签去同步化，帧偏移就会整体错位，
   * 后面的 APIC 封面直接读不到 —— 陈奕迅那首 MP3 就是这么丢封面的。
   */
  const picture = apicFrame('image/jpeg', TINY_JPEG);
  const unsynchronised = { id: 'APIC', data: applyUnsynchronisation(picture.data), flags: 0x0002 };

  const tag = buildId3v2Tag(
    [textFrame('TIT2', '同步化测试'), unsynchronised, txxxFrame('REPLAYGAIN_TRACK_GAIN', '-3.00 dB')],
    { version: 4, tagFlags: 0x80 },
  );
  const bytes = new Uint8Array([...tag, ...fakeMpegFrames(1)]);

  const meta = readAudioMetadata(bytes, { name: 'unsync.mp3' });
  assert.equal(meta.tags.title, '同步化测试');
  assert.equal(meta.pictures.length, 1, '封面必须能读出来');
  assert.equal(meta.pictures[0].mimeType, 'image/jpeg');
  assert.deepEqual([...meta.pictures[0].data], [...TINY_JPEG], '去同步化后应还原成原始 JPEG');
  assert.equal(meta.replayGain.trackGain, -3);
});

test('标签：RVA2（ID3v2.4 标准音量帧）', () => {
  const tag = buildId3v2Tag([
    textFrame('TIT2', 'RVA2'),
    rva2Frame(-6.5, 0.75),
  ], { version: 4 });
  const meta = parseId3v2(tag);
  assert.equal(Math.round(meta.replayGain.trackGain * 100) / 100, -6.5);
  assert.equal(meta.replayGain.source, 'ID3 RVA2');
});

test('标签：GBK 被当成 latin1 的中文标签能自动纠正', () => {
  // 真实文件里 TIT2 声明 encoding=0，但内容是 GBK
  const gbk = Uint8Array.from([0xb8, 0xa1, 0xbf, 0xe4]); // "浮夸"
  const frame = { id: 'TIT2', data: new Uint8Array([0, ...gbk]) };
  const tag = buildId3v2Tag([frame], { version: 3 });
  const meta = parseId3v2(tag);
  assert.equal(meta.tags.title, '浮夸');
});

test('标签：正常西文标签不会被乱码纠正误伤', () => {
  const latin = { id: 'TIT2', data: new Uint8Array([0, ...Buffer.from('Björk', 'latin1')]) };
  const meta = parseId3v2(buildId3v2Tag([latin], { version: 3 }));
  assert.equal(meta.tags.title, 'Björk');
});

test('标签：ID3v1 兜底', () => {
  const v1 = new Uint8Array(128);
  v1.set(Buffer.from('TAG', 'latin1'), 0);
  v1.set(Buffer.from('老歌', 'latin1'), 3);
  v1.set(Buffer.from('老歌手', 'latin1'), 33);
  v1.set(Buffer.from('1999', 'latin1'), 93);
  const bytes = new Uint8Array([...fakeMpegFrames(1), ...v1]);
  const meta = readAudioMetadata(bytes, { name: 'old.mp3' });
  assert.equal(meta.allTags['ID3v1 标题'] !== undefined, true);
  assert.equal(meta.tags.year, '1999');
});

test('标签：FLAC（STREAMINFO + VORBIS_COMMENT + PICTURE）', () => {
  const bytes = buildFlacFile({
    comments: {
      TITLE: '预言 Prophecy',
      ARTIST: 'HOYO-MiX',
      ALBUM: '绝区零',
      DATE: '2026',
      REPLAYGAIN_TRACK_GAIN: '-6.18 dB',
      REPLAYGAIN_TRACK_PEAK: '0.987654',
      REPLAYGAIN_ALBUM_GAIN: '-6.00 dB',
    },
    picture: { mimeType: 'image/jpeg', data: TINY_PNG, width: 1200, height: 1200 },
    sampleRate: 48000,
    channels: 2,
    bits: 24,
    totalSamples: 48000 * 10,
  });

  const meta = readAudioMetadata(bytes, { name: 'song.flac' });
  assert.equal(meta.format, 'flac');
  assert.equal(meta.tags.title, '预言 Prophecy');
  assert.equal(meta.tags.artist, 'HOYO-MiX');
  assert.equal(meta.audio.sampleRate, 48000);
  assert.equal(meta.audio.channels, 2);
  assert.equal(meta.audio.bitsPerSample, 24);
  assert.equal(Math.round(meta.audio.duration), 10);
  assert.equal(meta.pictures.length, 1);
  assert.equal(meta.pictures[0].width, 1200);
  assert.equal(meta.replayGain.trackGain, -6.18);
  assert.equal(meta.replayGain.albumGain, -6);
  assert.match(meta.replayGain.source, /Vorbis/);
});

test('标签：FLAC 的 R128（Q7.8 定点增益）', () => {
  const bytes = buildFlacFile({ comments: { TITLE: 'opus 风格', R128_TRACK_GAIN: '-1880' } });
  const meta = readAudioMetadata(bytes);
  assert.equal(meta.replayGain.trackGain, -1880 / 256);
  assert.ok(meta.replayGain.source);
});

test('标签：Ogg Vorbis 注释 + METADATA_BLOCK_PICTURE 封面', () => {
  const picture = buildFlacPicture({ mimeType: 'image/png', data: TINY_PNG, width: 500, height: 500 });
  const bytes = buildOggVorbisFile({
    comments: { TITLE: 'Ogg 测试', ARTIST: '测试者', REPLAYGAIN_TRACK_GAIN: '+2.50 dB' },
    picture: { mimeType: 'image/png', data: TINY_PNG, width: 500, height: 500 },
  });

  const meta = readAudioMetadata(bytes);
  assert.equal(meta.format, 'vorbis');
  assert.equal(meta.tags.title, 'Ogg 测试');
  assert.equal(meta.tags.artist, '测试者');
  assert.equal(meta.replayGain.trackGain, 2.5);
  assert.equal(meta.pictures.length, 1);
  assert.equal(meta.pictures[0].width, 500);
  assert.equal(meta.pictures[0].mimeType, 'image/png');
  assert.ok(picture.length > 0);
});

test('标签：Opus 的 OpusTags', () => {
  const bytes = buildOggOpusFile({ comments: { TITLE: 'Opus 测试', REPLAYGAIN_TRACK_GAIN: '-1.00 dB' } });
  const meta = readAudioMetadata(bytes);
  assert.equal(meta.format, 'opus');
  assert.equal(meta.tags.title, 'Opus 测试');
  assert.equal(meta.replayGain.trackGain, -1);
});

test('标签：MP4/M4A 的 ilst（含 covr 与自由字段 ReplayGain）', () => {
  const bytes = buildMp4File({
    tags: { '©nam': 'M4A 标题', '©ART': 'M4A 艺术家', '©alb': 'M4A 专辑', '©day': '2025' },
    cover: TINY_JPEG,
    freeform: { replaygain_track_gain: '-4.20 dB', replaygain_track_peak: '0.99' },
  });

  const meta = readAudioMetadata(bytes, { name: 'song.m4a' });
  assert.equal(meta.format, 'm4a');
  assert.equal(meta.tags.title, 'M4A 标题');
  assert.equal(meta.tags.artist, 'M4A 艺术家');
  assert.equal(meta.tags.year, '2025');
  assert.equal(meta.pictures.length, 1);
  assert.equal(meta.pictures[0].mimeType, 'image/jpeg');
  assert.deepEqual([...meta.pictures[0].data], [...TINY_JPEG]);
  assert.equal(meta.replayGain.trackGain, -4.2);
  assert.match(meta.replayGain.source, /MP4/);
});

test('标签：WAV 里的 id3 块 + LIST INFO', () => {
  const id3 = buildId3v2Tag([textFrame('TIT2', 'WAV 标题'), apicFrame('image/png', TINY_PNG)], { version: 3 });
  const bytes = buildWavFile({ durationSec: 0.2, id3, infoTags: { IART: 'WAV 艺术家' } });
  const meta = readAudioMetadata(bytes, { name: 'sound.wav' });
  assert.equal(meta.format, 'wav');
  assert.equal(meta.audio.sampleRate, 8000);
  assert.equal(meta.audio.bitsPerSample, 16);
  assert.equal(meta.audio.channels, 1);
  assert.equal(meta.tags.title, 'WAV 标题');
  assert.equal(meta.tags.artist, 'WAV 艺术家');
  assert.equal(meta.pictures.length, 1);
});

test('标签：无法识别的数据不抛异常', () => {
  const meta = readAudioMetadata(new Uint8Array(64), { name: 'x.bin' });
  assert.equal(meta.format, 'unknown');
  assert.deepEqual(meta.pictures, []);
  assert.equal(meta.replayGain.trackGain, null);
});

test('标签：分派函数能识别各容器的魔数', () => {
  assert.equal(readAudioMetadata(buildFlacFile({}), {}).format, 'flac');
  assert.equal(readAudioMetadata(buildOggVorbisFile({}), {}).format, 'vorbis');
  assert.equal(readAudioMetadata(buildMp4File({}), {}).format, 'm4a');
  assert.equal(readAudioMetadata(buildWavFile({}), {}).format, 'wav');
  assert.equal(parseId3v1(new Uint8Array(200)), null);
  assert.equal(parseFlac(new Uint8Array([0x66, 0x4c, 0x61, 0x43])).format, 'flac');
  assert.equal(parseOgg(new Uint8Array(20)).format, 'ogg');
  assert.equal(parseMp4(new Uint8Array(20)).warnings.length > 0, true);
  assert.equal(parseWav(buildWavFile({})).format, 'wav');
  assert.ok(buildVorbisComment({ comments: { A: 'b' } }).length > 0);
});

/* ---------------------------- ReplayGain 计算 ---------------------------- */

test('ReplayGain：音轨 / 专辑 / 关闭三种模式', () => {
  const rg = { trackGain: -7.32, trackPeak: 0.5, albumGain: -5.1, albumPeak: 0.6, source: 'test' };
  assert.equal(computeReplayGain(rg, { mode: 'track' }).gainDb, -7.32);
  assert.equal(computeReplayGain(rg, { mode: 'album' }).gainDb, -5.1);

  const off = computeReplayGain(rg, { mode: 'off' });
  assert.equal(off.gainDb, 0);
  assert.equal(off.available, false);
});

test('ReplayGain：缺失数据时明确说明原因', () => {
  const none = computeReplayGain({ trackGain: null, albumGain: null }, { mode: 'track' });
  assert.equal(none.available, false);
  assert.match(none.reason, /没有.*ReplayGain/);

  const albumOnly = computeReplayGain({ trackGain: null, albumGain: -4 }, { mode: 'track' });
  assert.equal(albumOnly.available, false);
  assert.match(albumOnly.reason, /没有音轨增益/);
  assert.match(albumOnly.reason, /专辑/, '应提示可以改用专辑增益');

  const trackOnly = computeReplayGain({ trackGain: -4, albumGain: null }, { mode: 'album' });
  assert.match(trackOnly.reason, /没有专辑增益/);
});

test('ReplayGain：预增益与峰值防削波', () => {
  const rg = { trackGain: -6, trackPeak: 1.0 };
  assert.equal(computeReplayGain(rg, { mode: 'track', preAmpDb: 2 }).gainDb, -4);

  // 峰值 0.5 → 最多只能 +6.02 dB，再高就会削波
  const loud = computeReplayGain({ trackGain: 12, trackPeak: 0.5 }, { mode: 'track' });
  assert.equal(loud.limited, true);
  assert.ok(loud.gainDb < 6.03 && loud.gainDb > 6.0);
  assert.match(loud.reason, /削波/);

  // 关掉保护就照原样应用
  const unguarded = computeReplayGain({ trackGain: 12, trackPeak: 0.5 }, { mode: 'track', preventClipping: false });
  assert.equal(unguarded.gainDb, 12);
  assert.equal(unguarded.limited, false);
});

test('ReplayGain：线性增益换算正确', () => {
  const result = computeReplayGain({ trackGain: -6.0206, trackPeak: null }, { mode: 'track' });
  assert.ok(Math.abs(result.linear - 0.5) < 0.001);
});

test('ReplayGain：描述文案', () => {
  assert.equal(describeReplayGain(null), '无');
  const text = describeReplayGain({ trackGain: -7.32, albumGain: -5.1, trackPeak: 0.988, source: 'ID3 TXXX' });
  assert.match(text, /音轨 -7.32 dB/);
  assert.match(text, /专辑 -5.10 dB/);
  assert.match(text, /峰值 0.988/);
});

/* ================================================================== */
/* 音频后端 × WebAudioKit                                              */
/* ================================================================== */

/**
 * Node 里没有 Audio/HTMLMediaElement，用一个最小的假元素替身，
 * 好验证「WebAudioKit 负责装载、我们负责 DSP」这套集成还成立。
 */
function installFakeAudio() {
  const created = [];
  class FakeAudio {
    constructor(src = '') {
      this.src = src;
      this.paused = true;
      this.ended = false;
      this.volume = 1;
      this.playbackRate = 1;
      this.preservesPitch = true;
      this.loop = false;
      this.preload = 'auto';
      this.readyState = 0;
      this.duration = NaN;
      this.currentTime = 0;
      this.buffered = { length: 0 };
      this.error = null;
      this.listeners = new Map();
      created.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    }
    dispatch(type, payload) {
      for (const handler of this.listeners.get(type) || []) handler(payload);
    }
    play() {
      this.paused = false;
      this.dispatch('play');
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatch('pause');
    }
    load() {}
  }
  const previous = globalThis.Audio;
  globalThis.Audio = FakeAudio;
  return {
    created,
    restore() {
      if (previous === undefined) delete globalThis.Audio;
      else globalThis.Audio = previous;
    },
  };
}

test('音频后端：交给 WebAudioKit 装载，但不自动播放', async () => {
  const fake = installFakeAudio();
  try {
    const backend = new AudioPlayer({ audioContext: null });
    const states = [];
    backend.on('state', (state) => states.push(state));

    backend.load('blob:test-audio', { name: 'demo.mp3' });
    const el = backend.element;
    assert.ok(el, 'WebAudioKit 应该已经建好 <audio>（靠 loadAt + enable=false 预装载）');
    assert.equal(el.src, 'blob:test-audio');
    assert.equal(el.paused, true, '装载不等于播放');
    assert.equal(backend.playing, false);

    // 元数据到位后时长、状态都要能读出来
    el.duration = 2;
    el.readyState = 4;
    el.dispatch('loadedmetadata');
    assert.equal(Math.round(backend.durationMs), 2000);
    assert.equal(backend.getState().durationMs, 2000);
    assert.equal(backend.getState().backend, 'audio');

    backend.play();
    await Promise.resolve();
    assert.equal(el.paused, false, 'play() 才真正出声');
    assert.equal(backend.playing, true);

    // 变速 / 循环要落到元素上，并且新元素也要继承
    backend.setRate(1.5);
    assert.equal(el.playbackRate, 1.5);
    assert.equal(el.preservesPitch, true);
    backend.setLoop(true);
    assert.equal(el.loop, true);
    assert.equal(backend.getState().loop, true);

    backend.stop();
    assert.equal(el.paused, true);
    assert.equal(el.currentTime, 0);
    assert.equal(backend.element, el, 'stop() 不能销毁元素，否则界面就没时长了');

    assert.ok(states.length > 0, '状态变化要发出去给界面');
    backend.dispose();
  } finally {
    fake.restore();
  }
});

test('音频后端：媒体错误码翻译成人话（2 是读取中断，不是格式问题）', () => {
  assert.match(describeMediaError(1), /中止/);
  assert.match(describeMediaError(2), /读取中断/);
  assert.match(describeMediaError(2), /没传完/);
  assert.match(describeMediaError(3), /解码失败/);
  assert.match(describeMediaError(4), /格式不受支持/);
  assert.match(describeMediaError(0), /错误码 0/);
  // 错误码 2 不该再被描述成「格式不被浏览器支持」——那会把排查方向带偏
  assert.doesNotMatch(describeMediaError(2), /格式/);
});

test('音频后端：换文件时重接图，且不会互相串台', async () => {
  const fake = installFakeAudio();
  try {
    const backend = new AudioPlayer({ audioContext: null });
    backend.load('blob:first', { name: 'a.mp3' });
    const first = backend.element;
    backend.load('blob:second', { name: 'b.mp3' });
    const second = backend.element;
    assert.notEqual(first, second, 'WebAudioKit 每个曲目一个元素');
    assert.equal(second.src, 'blob:second');
    assert.equal(second.paused, true, '换文件同样不该自动播放');
    assert.equal(backend.name, 'b.mp3');
    backend.dispose();
  } finally {
    fake.restore();
  }
});

/* ================================================================== */
/* Web MIDI                                                            */
/* ================================================================== */

test('MIDI：各种消息的解析', () => {
  assert.deepEqual(
    { type: 'noteon', channel: 1, note: 60, velocity: 100 },
    (({ type, channel, note, velocity }) => ({ type, channel, note, velocity }))(parseMidiMessage([0x90, 60, 100])),
  );
  // 力度 0 的音符开启 = 音符关闭
  assert.equal(parseMidiMessage([0x90, 60, 0]).type, 'noteoff');
  assert.equal(parseMidiMessage([0x80, 60, 64]).type, 'noteoff');
  assert.equal(parseMidiMessage([0xb0, 7, 127]).controller, 7);
  assert.equal(parseMidiMessage([0xb0, 7, 127]).value, 127);
  assert.equal(parseMidiMessage([0xc0, 42]).program, 42);
  assert.equal(parseMidiMessage([0xd0, 55]).pressure, 55);
  assert.equal(parseMidiMessage([0xa0, 60, 33]).type, 'polyaftertouch');
  assert.equal(parseMidiMessage([0xe0, 0x00, 0x40]).value, 0);
  assert.equal(parseMidiMessage([0xe0, 0x7f, 0x7f]).value, 8191);
  assert.equal(parseMidiMessage([0xe0, 0x00, 0x00]).value, -8192);
  assert.equal(parseMidiMessage([0xf8]).type, 'clock');
  assert.equal(parseMidiMessage([0xfa]).type, 'start');
  assert.equal(parseMidiMessage([0xfc]).type, 'stop');
  assert.equal(parseMidiMessage([0xf0, 1, 2, 0xf7]).type, 'sysex');
  assert.equal(parseMidiMessage([]), null);
  assert.equal(parseMidiMessage([0x90, 60, 100]).channel, 1);
  assert.equal(parseMidiMessage([0x9f, 60, 100]).channel, 16);
});

test('MIDI：数值归一化', () => {
  assert.equal(midiValueToUnit({ type: 'cc', value: 64 }), 64 / 127);
  assert.equal(midiValueToUnit({ type: 'noteon', velocity: 127 }), 1);
  assert.ok(Math.abs(midiValueToUnit({ type: 'pitchbend', value: 0 }) - 0.5) < 1e-4);
  assert.equal(midiValueToUnit({ type: 'pitchbend', value: -8192 }), 0);
});

test('MIDI：默认映射命中', () => {
  assert.equal(matchBinding(parseMidiMessage([0x90, 36, 100])).action, 'play-pause');
  assert.equal(matchBinding(parseMidiMessage([0x90, 37, 100])).action, 'stop');
  assert.equal(matchBinding(parseMidiMessage([0xb0, 7, 64])).action, 'volume');
  assert.equal(matchBinding(parseMidiMessage([0xb0, 1, 64])).action, 'rate');
  assert.equal(matchBinding(parseMidiMessage([0xe0, 0, 64])).action, 'seek');
  assert.equal(matchBinding(parseMidiMessage([0x90, 100, 100])), null); // 普通演奏音符不触发
  assert.equal(matchBinding(parseMidiMessage([0xf8])), null);
  assert.ok(DEFAULT_BINDINGS.length >= 8);
});

test('MIDI：消息描述与音名', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(36), 'C2');
  assert.match(describeMessage(parseMidiMessage([0xb0, 7, 100])), /音量/);
  assert.match(describeMessage(parseMidiMessage([0x90, 36, 100])), /C2/);
  assert.equal(describeMatch({ type: 'cc', controller: 7 }), '音量');
  assert.equal(describeMatch({ type: 'noteon', note: 36 }), '音符 C2');
  assert.equal(buildMatchFromMessage(parseMidiMessage([0xb0, 74, 1])).controller, 74);
});

/** 造一个假的 MIDI 设备环境 */
function fakeMidi() {
  const sent = [];
  const input = { id: 'in-1', name: 'Fake Keyboard', manufacturer: 'Test', state: 'connected', onmidimessage: null };
  const output = {
    id: 'out-1',
    name: 'Fake Synth',
    manufacturer: 'Test',
    state: 'connected',
    send: (data, timestamp) => sent.push({ data: Array.from(data), timestamp }),
  };
  return {
    access: { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), onstatechange: null },
    input,
    output,
    sent,
  };
}

test('MIDI 桥：枚举设备并把消息派发成动作', async () => {
  const fake = fakeMidi();
  const actions = [];
  const bridge = new MidiBridge({ requestAccess: async () => fake.access, onAction: (event) => actions.push(event) });
  const status = await bridge.init();

  assert.equal(status.state, 'ready');
  assert.equal(bridge.inputs.length, 1);
  assert.equal(bridge.outputs.length, 1);
  assert.equal(bridge.inputs[0].name, 'Fake Keyboard');
  // 状态快照：界面就是靠它渲染设备下拉与状态栏的
  assert.equal(bridge.getStatus().state, 'ready');
  assert.equal(bridge.getStatus().inputs.length, 1);
  assert.equal(bridge.getStatus().outputs[0].name, 'Fake Synth');
  assert.ok(Array.isArray(bridge.getStatus().bindings));

  // 默认「不监听」：任何端口来的消息都不该驱动播放器
  fake.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
  assert.equal(actions.length, 0, '没选输入设备时不该响应任何 MIDI 消息');

  // 选中输入设备之后才开始工作
  bridge.selectInput('in-1');
  fake.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
  assert.equal(actions.at(-1).action, 'play-pause');

  // 连续量带值
  fake.input.onmidimessage({ data: new Uint8Array([0xb0, 7, 64]) });
  assert.equal(actions.at(-1).action, 'volume');
  assert.ok(Math.abs(actions.at(-1).value - 64 / 127) < 1e-6);

  // 没绑定的消息不产生动作
  const before = actions.length;
  fake.input.onmidimessage({ data: new Uint8Array([0x90, 90, 100]) });
  assert.equal(actions.length, before);
});

test('MIDI 桥：输出设备、时钟与走带', async () => {
  const fake = fakeMidi();
  const bridge = new MidiBridge({ requestAccess: async () => fake.access });
  await bridge.init();
  bridge.selectOutput('out-1');
  assert.ok(bridge.getOutputPort());

  assert.equal(bridge.sendTransport('start'), true);
  assert.deepEqual(fake.sent.at(-1).data, [0xfa]);
  bridge.sendTransport('stop');
  assert.deepEqual(fake.sent.at(-1).data, [0xfc]);

  // 时钟：120 BPM 下每 20.8ms 一个 tick
  const before = fake.sent.length;
  bridge.startClock(240);
  await new Promise((resolve) => setTimeout(resolve, 130));
  bridge.stopClock();
  const ticks = fake.sent.slice(before).filter((item) => item.data[0] === 0xf8);
  assert.ok(ticks.length >= 4, `应该发了若干个时钟 tick，实际 ${ticks.length}`);
  assert.ok(ticks.every((tick) => typeof tick.timestamp === 'number'), '时钟应带时间戳');

  bridge.allNotesOff();
  assert.ok(fake.sent.some((item) => item.data[1] === 123));
});

test('MIDI 桥：MIDI Learn 能改写映射', async () => {
  const fake = fakeMidi();
  const actions = [];
  const bridge = new MidiBridge({ requestAccess: async () => fake.access, onAction: (event) => actions.push(event) });
  await bridge.init();

  bridge.learn('volume');
  assert.equal(bridge.learning, 'volume');
  fake.input.onmidimessage({ data: new Uint8Array([0xb0, 74, 90]) }); // 用 CC74 当音量
  assert.equal(bridge.learning, null);
  assert.equal(actions.at(-1).action, 'learned');

  const volumeBinding = bridge.bindings.find((binding) => binding.action === 'volume');
  assert.deepEqual(volumeBinding.match, { type: 'cc', controller: 74 });

  // 新映射立刻生效（要选中输入设备；Learn 期间是例外，任何端口都收）
  bridge.selectInput('in-1');
  fake.input.onmidimessage({ data: new Uint8Array([0xb0, 74, 32]) });
  assert.equal(actions.at(-1).action, 'volume');

  // 恢复默认
  bridge.resetBindings();
  assert.equal(bridge.bindings.find((b) => b.action === 'volume').match.controller, 7);
});

test('MIDI 桥：只听选中的输入端口，回环/别的键盘不能劫持播放', async () => {
  const fake = fakeMidi();
  const actions = [];
  const bridge = new MidiBridge({ requestAccess: async () => fake.access, onAction: (event) => actions.push(event) });

  // 再加一个「回环」端口：它会收到我们自己发给外部音源的音符
  const loopback = { id: 'loop-1', name: 'IAC 回环', manufacturer: 'OS', state: 'connected', onmidimessage: null };
  fake.access.inputs.set(loopback.id, loopback);
  await bridge.init();

  bridge.selectInput('in-1');
  // 回环端口收到的音符（38 = 快退，会把播放位置拉回开头）必须被忽略
  loopback.onmidimessage({ data: new Uint8Array([0x90, 38, 100]) });
  assert.equal(actions.length, 0, '未选中的端口不该触发任何动作');

  // 选中的键盘照常工作
  fake.input.onmidimessage({ data: new Uint8Array([0x90, 38, 100]) });
  assert.equal(actions.at(-1).action, 'seek-back');
  assert.equal(typeof loopback.onmidimessage, 'function', '监听器仍然挂在端口上，过滤发生在 handleMidiMessage 里');

  // 改选另一个输入后，原来的键盘就不再生效
  bridge.selectInput('loop-1');
  const before = actions.length;
  fake.input.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
  assert.equal(actions.length, before, '换选输入后，旧端口不再驱动播放器');
  loopback.onmidimessage({ data: new Uint8Array([0x90, 36, 100]) });
  assert.equal(actions.at(-1).action, 'play-pause');
});

test('MIDI 桥：不支持 / 被拒绝时给出可读状态', async () => {
  const unsupported = new MidiBridge({ requestAccess: null });
  unsupported.isSupported = () => false;
  const status = await unsupported.init();
  assert.equal(status.state, 'unsupported');
  assert.match(status.error, /不支持/);

  const denied = new MidiBridge({
    requestAccess: async () => {
      const error = new Error('denied');
      error.name = 'SecurityError';
      throw error;
    },
  });
  const deniedStatus = await denied.init();
  assert.equal(deniedStatus.state, 'denied');
  assert.match(deniedStatus.error, /拒绝/);
});

test('MIDI 桥：并发 init 只申请一次权限，失败后仍可重试', async () => {
  const fake = fakeMidi();
  let calls = 0;
  const bridge = new MidiBridge({
    requestAccess: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fake.access;
    },
  });
  const statuses = await Promise.all([bridge.init(), bridge.init(), bridge.init()]);
  assert.equal(calls, 1, '同一个会话里并发触发只该弹一次权限申请');
  assert.ok(statuses.every((status) => status.state === 'ready'));
  assert.equal(bridge.getStatus().inputs.length, 1);

  // 用户点了「启用」但被拒绝，之后再点应该还能重新申请
  let attempts = 0;
  const flaky = new MidiBridge({
    requestAccess: async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error('denied');
        error.name = 'SecurityError';
        throw error;
      }
      return fake.access;
    },
  });
  assert.equal((await flaky.init()).state, 'denied');
  assert.equal((await flaky.init()).state, 'ready');
  assert.equal(attempts, 2, '失败不应该把桥卡死，重试要真的再申请一次');
});

/* ================================================================== */
/* 标准 MIDI 文件                                                      */
/* ================================================================== */

test('SMF：解析合成文件（格式/轨道/音符/时长）', () => {
  const smf = parseSmf(buildMidiFile({ bpm: 120 }));
  assert.equal(smf.format, 0);
  assert.equal(smf.trackCount, 1);
  assert.equal(smf.division, 480);
  assert.equal(smf.noteCount, 4);
  assert.equal(smf.title, '夹具音轨');
  assert.equal(Math.round(smf.durationMs), 2000);
  assert.equal(Math.round(60000000 / smf.tempoMap[0].usPerQuarter), 120);
  assert.equal(smf.tracks[0].name, '夹具音轨');
  assert.deepEqual(smf.warnings, []);
});

test('SMF：速度表影响时间换算', () => {
  const fast = parseSmf(buildMidiFile({ bpm: 240 }));
  assert.equal(Math.round(60000000 / fast.tempoMap[0].usPerQuarter), 240);
  // 同样 4 拍，240 BPM 只要 1 秒
  assert.equal(Math.round(fast.durationMs), 1000);
  assert.equal(Math.round(tickToMs(fast, 480)), 250, '240 BPM 下一拍 = 250ms');
  assert.equal(Math.round(tickToMs(fast, 0)), 0);
});

test('SMF：时间轴单调递增且音符开关配平', () => {
  const smf = parseSmf(buildMidiFile());
  const schedule = buildPlaybackSchedule(smf);
  assert.ok(schedule.length >= 12);

  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i].timeMs >= schedule[i - 1].timeMs, '时间必须单调不减');
  }
  const on = schedule.filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
  const off = schedule.filter((e) => (e.data[0] & 0xf0) === 0x80 || ((e.data[0] & 0xf0) === 0x90 && e.data[2] === 0)).length;
  assert.equal(on, 4);
  assert.equal(off, 4);
});

test('SMF：非 MIDI 数据不崩', () => {
  const smf = parseSmf(new Uint8Array([1, 2, 3, 4]));
  assert.equal(smf.tracks.length, 0);
  assert.match(smf.warnings[0], /MThd/);
  assert.equal(parseSmf(new Uint8Array(0)).durationMs, 0);
});

test('SMF：播到结尾停在末尾，不会自动跳回开头', async () => {
  const player = new SmfPlayer({ audioContext: null, midiBridge: null });
  const smf = player.load(buildMidiFile({ bpm: 1200 })); // 把 2 秒的夹具压到 0.2 秒，测试跑得快
  const ended = [];
  player.onEnded = (state) => ended.push({ position: state.positionMs, playing: state.playing });

  player.play();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(player.playing, false, '到结尾应该停下');
  assert.equal(Math.round(player.positionMs), Math.round(smf.durationMs), '位置停在结尾');
  assert.equal(ended.length, 1, 'ended 只该触发一次');

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(player.playing, false, '停下之后不该自己重新播');
  assert.equal(Math.round(player.positionMs), Math.round(smf.durationMs), '停下之后位置不该回到开头');

  // 用户再点播放才是「重播」，这时才允许回到开头
  player.play();
  assert.ok(player.positionMs < smf.durationMs, '重播时才回到开头');
  player.pause();
  player.dispose();
});

test('SMF：播放中拖到末尾会停在末尾，而不是跳回开头', () => {
  const player = new SmfPlayer({ audioContext: null, midiBridge: null });
  const smf = player.load(buildMidiFile());
  player.play();
  assert.equal(player.playing, true);
  player.seek(smf.durationMs); // 相当于把进度条拖到最右
  assert.equal(player.playing, false, '拖到末尾应该停下');
  assert.equal(Math.round(player.positionMs), Math.round(smf.durationMs), '停在末尾而不是 0');
  player.dispose();
});

test('SMF：合成器在没有 AudioContext 时安静降级', () => {
  const synth = new SimpleSynth({ audioContext: null });
  assert.equal(synth.enabled, false);
  synth.noteOn(0, 60, 100, 0);
  synth.noteOff(0, 60, 0);
  synth.allNotesOff();
  assert.equal(synth.getSpectrum(), null);
  assert.equal(synth.activeVoiceCount, 0);
  synth.dispose();
});

/** 假合成器：只记录调用，用来验证开关 / 音量 / 静音三者的关系 */
function fakeSynth() {
  return {
    enabled: true,
    activeVoiceCount: 0,
    volume: null,
    notesOffCount: 0,
    allNotesOff() {
      this.notesOffCount++;
    },
    noteOn() {},
    noteOff() {},
    setVolume(value) {
      this.volume = value;
    },
    getSpectrum() {
      return null;
    },
    dispose() {
      this.enabled = false;
    },
  };
}

test('SMF 后端：内置合成器开关独立于音量与静音', () => {
  const synth = fakeSynth();
  const player = new SmfPlayer({ audioContext: null, synth });
  const backend = new SmfBackend({ smfPlayer: player, useSynth: true });

  assert.equal(backend.getState().supportsSynth, true);
  assert.equal(backend.getState().synthEnabled, true);
  assert.equal(player.useSynth, true);

  // 关掉开关：立刻松音，并且不再发声
  assert.equal(backend.setSynthEnabled(false), false);
  assert.equal(player.useSynth, false);
  assert.ok(synth.notesOffCount > 0, '关掉开关时应立刻松开所有音符');

  // 调音量 / 切静音不能偷偷把开关打开（曾经的回归：this.options 没赋值，静音一恢复合成器就自己开了）
  backend.setVolume(0.5);
  backend.setMuted(true);
  backend.setMuted(false);
  assert.equal(player.useSynth, false, '开关关着时，音量与静音变化不能重新打开合成器');
  assert.equal(backend.getState().synthEnabled, false);

  // 静音只是临时的：开关打开后，静音期间仍然不发声，取消静音再恢复
  backend.setSynthEnabled(true);
  assert.equal(player.useSynth, true);
  backend.setMuted(true);
  assert.equal(player.useSynth, false);
  backend.setMuted(false);
  assert.equal(player.useSynth, true, '取消静音后应恢复发声');

  // 音量为 0 也不发声，且播放器的音量透传给了合成器
  backend.setVolume(0);
  assert.equal(player.useSynth, false);
  backend.setVolume(1);
  assert.equal(player.useSynth, true);
  assert.equal(synth.volume, 1);

  // 没有 AudioContext 时如实报告「不支持」，但开关值仍然可读可写
  const silent = new SmfBackend({ audioContext: null });
  assert.equal(silent.getState().supportsSynth, false);
  assert.equal(silent.setSynthEnabled(true), true);
  assert.equal(silent.getState().synthEnabled, true);
  assert.equal(silent.getState().supportsSynth, false);
});

/* ================================================================== */
/* 真实文件（工作区里有就跑，没有就跳过）                                */
/* ================================================================== */

const REAL_MP3 = samplePath('陈奕迅 - 浮夸.mp3');
const REAL_FLAC = samplePath('三Z-STUDIO,HOYO-MiX,Gin Wigmore - 预言 Prophecy.flac');
const REAL_MIDI = samplePath('【東方風】炉心融解　～ Melt Down【アレンジ】.mid');
const REAL_GBK_MIDI = samplePath('室内系的TrackMaker.mid');

test('真实文件：MP3 的封面、GBK 标签与 ReplayGain', { skip: !existsSync(REAL_MP3) && '工作区里没有示例 MP3' }, () => {
  const meta = readAudioMetadata(new Uint8Array(readFileSync(REAL_MP3)), { name: '浮夸.mp3' });
  assert.equal(meta.format, 'mp3');
  assert.equal(meta.tags.title, '浮夸');
  assert.equal(meta.tags.artist, '陈奕迅');
  assert.ok(meta.pictures.length >= 1, '应该解析出内嵌封面');
  const cover = meta.pictures[0];
  assert.equal(cover.mimeType, 'image/jpeg');
  assert.ok(cover.data.length > 100 * 1024, `封面应该不小，实际 ${cover.data.length}`);
  assert.equal(cover.data[0], 0xff);
  assert.equal(cover.data[1], 0xd8);
  assert.equal(cover.data.at(-2), 0xff);
  assert.equal(cover.data.at(-1), 0xd9, 'JPEG 结尾标记必须完整');
  assert.ok(Math.abs(meta.replayGain.trackGain + 9.21) < 0.01, `ReplayGain 应为 -9.21，实际 ${meta.replayGain.trackGain}`);
  assert.ok(meta.replayGain.trackPeak > 1);
});

test('真实文件：FLAC 的 24bit/48kHz 参数与 1.3MB 封面', { skip: !existsSync(REAL_FLAC) && '工作区里没有示例 FLAC' }, () => {
  const meta = readAudioMetadata(new Uint8Array(readFileSync(REAL_FLAC)), { name: 'prophecy.flac' });
  assert.equal(meta.format, 'flac');
  assert.equal(meta.tags.title, '预言 Prophecy');
  assert.equal(meta.audio.sampleRate, 48000);
  assert.equal(meta.audio.bitsPerSample, 24);
  assert.equal(meta.audio.channels, 2);
  assert.ok(meta.audio.duration > 200);
  assert.equal(meta.pictures.length, 1);
  assert.ok(meta.pictures[0].data.length > 1024 * 1024);
  assert.equal(meta.pictures[0].data[0], 0xff);
  assert.equal(meta.pictures[0].data.at(-1), 0xd9);
});

test('真实文件：多轨 MIDI 的轨道、音符与 Shift-JIS 曲名', { skip: !existsSync(REAL_MIDI) && '工作区里没有示例 MIDI' }, () => {
  const smf = parseSmf(new Uint8Array(readFileSync(REAL_MIDI)));
  assert.equal(smf.format, 1);
  assert.equal(smf.trackCount, 14);
  assert.equal(smf.tracks.length, 14);
  assert.ok(smf.noteCount > 5000, `音符数应该很多，实际 ${smf.noteCount}`);
  assert.equal(smf.title, '炉心融解　～ Melt Down', 'Shift-JIS 曲名要能正确解码');
  assert.ok(smf.channels.length >= 8);
  assert.ok(Math.abs(60000000 / smf.tempoMap[0].usPerQuarter - 168) < 0.5);

  const schedule = buildPlaybackSchedule(smf);
  const on = schedule.filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;
  const off = schedule.filter((e) => (e.data[0] & 0xf0) === 0x80 || ((e.data[0] & 0xf0) === 0x90 && e.data[2] === 0)).length;
  assert.equal(on, off, '音符开启与关闭必须配平');
  // 时长按最后一个发声事件算，不该把尾部空小节也算进去
  assert.ok(smf.durationMs < smf.tailMs);
});

/* ================================================================== */
/* MIDI 元事件的文本编码                                                */
/* ================================================================== */

const hexBytes = (hex) => new Uint8Array(hex.match(/../g).map((byte) => parseInt(byte, 16)));

test('MIDI 文本：GBK 曲名不会被 Shift-JIS 抢走', () => {
  // 「室内系的」的 GBK 字节全落在 0xA1–0xDF，而这一段在 Shift-JIS 里是单字节半角片假名：
  // 按「能解通就用」的顺序猜会得到「ﾊﾒﾄﾚﾏｵｵﾄ」，不抛异常也没有 U+FFFD。
  assert.equal(decodeText(hexBytes('cad2c4dacfb5b5c4')), '室内系的');
  // 「音乐：」在 Shift-JIS 下解出半角片假名 + 私用区字符（F4C0 → U+E36F）
  assert.equal(decodeText(hexBytes('d2f4c0d6a3ba')), '音乐：');
  // 「流行歌曲」在 Shift-JIS 下直接解不通，只能靠 GBK
  assert.equal(decodeText(hexBytes('c1f7d0d0b8e8c7fa')), '流行歌曲');
  assert.equal(decodeText(hexBytes('ecfeecfd')), '忐忑');
});

test('MIDI 文本：真正的 Shift-JIS 曲名不被 GBK 抢走', () => {
  // 「炉心融解　～」的真身是 Shift-JIS（GBK 解出来是「楩怱梈夝丂乣」这种生僻字）
  assert.equal(decodeText(hexBytes('98469053975a89f081408160')), '炉心融解　～');
  // 含全角假名 → 就是日文
  assert.equal(decodeText(hexBytes('8341838c83938357')), 'アレンジ');
});

test('MIDI 文本：UTF-8、纯 ASCII 与空数据', () => {
  assert.equal(decodeText(hexBytes('e5aea4e58685e7b3bbe79a84')), '室内系的');
  assert.equal(decodeText(hexBytes('4d494449')), 'MIDI');
  // 有的文件会在字符串后面补 \0
  assert.equal(decodeText(hexBytes('5069616e6f310000')), 'Piano1');
  assert.equal(decodeText(new Uint8Array(0)), '');
  assert.equal(decodeText(undefined), '');
});

test('MIDI 文本：曲名通过 parseSmf 落到 title（GBK 字节）', () => {
  const bytes = buildMidiFile({ trackNameBytes: hexBytes('cad2c4dacfb5b5c4') });
  const smf = parseSmf(bytes);
  assert.equal(smf.title, '室内系的');
  assert.equal(smf.tracks[0].name, '室内系的');
});

test('真实文件：GBK 曲名的 MIDI（Shift-JIS 假阳性回归）', { skip: !existsSync(REAL_GBK_MIDI) && '工作区里没有示例 MIDI' }, () => {
  const smf = parseSmf(new Uint8Array(readFileSync(REAL_GBK_MIDI)));
  // 修复前这里会变成「ﾊﾒﾄﾚﾏｵｵﾄTrackMaker」
  assert.equal(smf.title, '室内系的TrackMaker', 'GBK 曲名要能正确解码');
  assert.equal(smf.tracks[0].name, '室内系的TrackMaker');
  assert.equal(smf.format, 1);
  assert.equal(smf.trackCount, 17);
  assert.ok(smf.tracks.map((t) => t.name).includes('Track 1'));
  // 同一条轨道上的其它元事件（作词/风格）也是 GBK
  const lyric = smf.tracks[0].events.find((e) => e.type === 'text' && e.text.includes('Hanser'));
  assert.equal(lyric?.text, '音乐：Hanser，MIDI：ChireyXine');
});
