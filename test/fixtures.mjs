/**
 * 测试夹具：用代码手工构造各种音频容器，用来验证 src/lib/tags.js 的解析。
 *
 * 不依赖任何第三方库，全部按规范逐字节拼出来，
 * 因此既能当单元测试的输入，也能给测试用 WebDAV 服务器当种子文件。
 */

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 1×1 的合法 PNG（红色），用来当封面测试数据 */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** 1×1 的 JPEG，用来验证 mime 识别 */
export const TINY_JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  ),
);

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const utf8 = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
/** MP4 的原子类型是 4 个字节，© 是单字节 0xA9，不能用 UTF-8（会变两个字节） */
const latin1 = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
const u16be = (value) => new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
const u32be = (value) => new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const u32le = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const u16le = (value) => new Uint8Array([value & 0xff, (value >> 8) & 0xff]);

/** ID3 的 syncsafe 整数 */
function syncSafe(value) {
  return new Uint8Array([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

/* ------------------------------------------------------------------ */
/* ID3v2 帧                                                            */
/* ------------------------------------------------------------------ */

/** 文本帧：编码字节 3 = UTF-8 */
export function textFrame(id, text) {
  const payload = concat([new Uint8Array([3]), utf8(text)]);
  return { id, data: payload };
}

/** TXXX：自定义键值，ReplayGain 就走这里 */
export function txxxFrame(description, value) {
  const payload = concat([new Uint8Array([3]), utf8(description), new Uint8Array([0]), utf8(value)]);
  return { id: 'TXXX', data: payload };
}

/** APIC：内嵌封面 */
export function apicFrame(mimeType, imageData, pictureType = 3, description = '') {
  const payload = concat([
    new Uint8Array([3]), // UTF-8
    utf8(mimeType),
    new Uint8Array([0]),
    new Uint8Array([pictureType]),
    utf8(description),
    new Uint8Array([0]),
    imageData,
  ]);
  return { id: 'APIC', data: payload };
}

/** RVA2：ID3v2.4 标准的音量调整帧，增益单位是 1/512 dB */
export function rva2Frame(gainDb, peak = null, identification = '') {
  const raw = Math.round(gainDb * 512);
  const signed = raw < 0 ? raw + 65536 : raw;
  const parts = [
    utf8(identification),
    new Uint8Array([0]), // 结束符
    new Uint8Array([1]), // 声道类型 1 = master volume
    u16be(signed),
  ];
  if (peak == null) {
    parts.push(new Uint8Array([0]));
  } else {
    // 用 16 位表示峰值
    const peakValue = Math.round(peak * 65535);
    parts.push(new Uint8Array([16]));
    parts.push(u16be(peakValue));
  }
  return { id: 'RVA2', data: concat(parts) };
}

/**
 * 组装一个完整的 ID3v2 标签。
 * @param {Array<{id:string,data:Uint8Array}>} frames
 * @param {{version?:3|4, padding?:number}} options
 */
export function buildId3v2Tag(frames, { version = 3, padding = 0, tagFlags = 0 } = {}) {
  const body = [];
  for (const frame of frames) {
    const size = frame.data.length;
    if (version === 2) {
      body.push(utf8(frame.id.slice(0, 3)));
      body.push(new Uint8Array([(size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff]));
    } else {
      body.push(utf8(frame.id.slice(0, 4)));
      body.push(version === 4 ? syncSafe(size) : u32be(size));
      body.push(u16be(frame.flags || 0));
    }
    body.push(frame.data);
  }
  if (padding) body.push(new Uint8Array(padding));
  const content = concat(body);

  const header = concat([
    utf8('ID3'),
    new Uint8Array([version, 0, tagFlags]), // 版本 + 修订 + 标志
    syncSafe(content.length),
  ]);
  return concat([header, content]);
}

/** 一段假的 MPEG 帧（只需要开头像 MP3 即可） */
export function fakeMpegFrames(count = 4) {
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1 Layer3
  frame[2] = 0x90;
  frame[3] = 0x00;
  const frames = [];
  for (let i = 0; i < count; i++) frames.push(frame);
  return concat(frames);
}

/* ------------------------------------------------------------------ */
/* WAV（可真实播放，用于端到端测试）                                    */
/* ------------------------------------------------------------------ */

/**
 * 生成一段可播放的正弦波 WAV。
 * 可以顺带塞一个 id3 块，用来验证「WAV 里的 ID3 标签 + 封面 + ReplayGain」。
 */
export function buildWavFile({
  durationSec = 1,
  sampleRate = 8000,
  frequency = 440,
  amplitude = 0.6,
  id3 = null,
  infoTags = null,
} = {}) {
  const sampleCount = Math.max(1, Math.round(durationSec * sampleRate));
  const data = new Uint8Array(sampleCount * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767;
    view.setInt16(i * 2, Math.round(value), true);
  }

  const chunks = [];
  const fmt = concat([
    utf8('fmt '),
    u32le(16),
    u16le(1), // PCM
    u16le(1), // 单声道
    u32le(sampleRate),
    u32le(sampleRate * 2), // byte rate
    u16le(2), // block align
    u16le(16), // bits
  ]);
  chunks.push(fmt, concat([utf8('data'), u32le(data.length), data]));

  if (id3) chunks.push(concat([utf8('id3 '), u32le(id3.length), id3, id3.length % 2 ? new Uint8Array([0]) : new Uint8Array(0)]));

  if (infoTags) {
    const entries = [];
    for (const [id, value] of Object.entries(infoTags)) {
      const text = concat([utf8(value), new Uint8Array([0])]);
      const padded = text.length % 2 ? concat([text, new Uint8Array([0])]) : text;
      entries.push(concat([utf8(id), u32le(text.length), padded]));
    }
    const listBody = concat([utf8('INFO'), ...entries]);
    chunks.push(concat([utf8('LIST'), u32le(listBody.length), listBody]));
  }

  const body = concat([utf8('WAVE'), ...chunks]);
  return concat([utf8('RIFF'), u32le(body.length), body]);
}

/* ------------------------------------------------------------------ */
/* FLAC                                                               */
/* ------------------------------------------------------------------ */

function flacBlock(type, data, isLast = false) {
  const header = new Uint8Array(4);
  header[0] = (isLast ? 0x80 : 0) | (type & 0x7f);
  header[1] = (data.length >> 16) & 0xff;
  header[2] = (data.length >> 8) & 0xff;
  header[3] = data.length & 0xff;
  return concat([header, data]);
}

export function buildVorbisComment({ vendor = 'webdav-test', comments = {} } = {}) {
  const vendorBytes = utf8(vendor);
  const list = Object.entries(comments).map(([key, value]) => {
    const text = utf8(`${key}=${value}`);
    return concat([u32le(text.length), text]);
  });
  return concat([u32le(vendorBytes.length), vendorBytes, u32le(list.length), ...list]);
}

/** FLAC 的 PICTURE 块内容（Ogg 的 METADATA_BLOCK_PICTURE 也用这个结构） */
export function buildFlacPicture({ mimeType = 'image/png', data = TINY_PNG, width = 1, height = 1, type = 3, description = '' } = {}) {
  const mimeBytes = utf8(mimeType);
  const descBytes = utf8(description);
  return concat([
    u32be(type),
    u32be(mimeBytes.length),
    mimeBytes,
    u32be(descBytes.length),
    descBytes,
    u32be(width),
    u32be(height),
    u32be(24), // 色深
    u32be(0), // 调色板颜色数
    u32be(data.length),
    data,
  ]);
}

export function buildFlacFile({ comments = {}, picture = null, sampleRate = 44100, channels = 2, bits = 16, totalSamples = 44100 } = {}) {
  // STREAMINFO：20 位采样率 + 3 位声道 + 5 位位深 + 36 位样本数
  const streaminfo = new Uint8Array(34);
  const si = new DataView(streaminfo.buffer);
  si.setUint16(0, 4096, false); // 最小块大小
  si.setUint16(2, 4096, false); // 最大块大小
  streaminfo[10] = (sampleRate >> 12) & 0xff;
  streaminfo[11] = (sampleRate >> 4) & 0xff;
  streaminfo[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bits - 1) >> 4) & 0x01);
  streaminfo[13] = (((bits - 1) & 0x0f) << 4) | ((totalSamples / 4294967296) & 0x0f);
  si.setUint32(14, totalSamples >>> 0, false);

  const blocks = [flacBlock(0, streaminfo)];
  blocks.push(flacBlock(4, buildVorbisComment({ comments })));
  if (picture) blocks.push(flacBlock(6, buildFlacPicture(picture), true));
  else blocks[blocks.length - 1] = flacBlock(4, buildVorbisComment({ comments }), true);

  return concat([utf8('fLaC'), ...blocks]);
}

/* ------------------------------------------------------------------ */
/* Ogg（Vorbis / Opus）                                                */
/* ------------------------------------------------------------------ */

function oggPage(packets, { serial = 1, sequence = 0, headerType = 0 } = {}) {
  const segments = [];
  const payloads = [];
  for (const packet of packets) {
    let offset = 0;
    while (offset < packet.length || offset === 0) {
      const size = Math.min(255, packet.length - offset);
      segments.push(size);
      payloads.push(packet.subarray(offset, offset + size));
      offset += size;
      if (size < 255) break;
    }
    if (packet.length % 255 === 0 && packet.length > 0) segments.push(0);
  }
  const body = concat(payloads);
  const header = concat([
    utf8('OggS'),
    new Uint8Array([0, headerType]),
    new Uint8Array(8), // granule
    u32le(serial),
    u32le(sequence),
    u32le(0), // crc（解析用不到）
    new Uint8Array([segments.length]),
    new Uint8Array(segments),
  ]);
  return concat([header, body]);
}

function vorbisCommentPacket(comments) {
  return concat([new Uint8Array([3]), utf8('vorbis'), buildVorbisComment({ comments })]);
}

export function buildOggVorbisFile({ comments = {}, picture = null, sampleRate = 44100, channels = 2 } = {}) {
  const identification = concat([
    new Uint8Array([1]),
    utf8('vorbis'),
    u32le(0), // version
    new Uint8Array([channels]),
    u32le(sampleRate),
  ]);
  const allComments = { ...comments };
  if (picture) {
    allComments.METADATA_BLOCK_PICTURE = Buffer.from(buildFlacPicture(picture)).toString('base64');
  }
  const commentPacket = vorbisCommentPacket(allComments);
  const setupPacket = concat([new Uint8Array([5]), utf8('vorbis'), new Uint8Array(16)]);
  return concat([
    oggPage([identification], { headerType: 0x02, sequence: 0 }),
    oggPage([commentPacket, setupPacket], { sequence: 1 }),
  ]);
}

export function buildOggOpusFile({ comments = {}, picture = null } = {}) {
  const head = concat([utf8('OpusHead'), new Uint8Array([1, 2]), new Uint8Array([0, 0]), u32le(48000), new Uint8Array([0, 0, 0])]);
  const allComments = { ...comments };
  if (picture) allComments.METADATA_BLOCK_PICTURE = Buffer.from(buildFlacPicture(picture)).toString('base64');
  const tags = concat([utf8('OpusTags'), buildVorbisComment({ comments: allComments })]);
  return concat([oggPage([head], { headerType: 0x02 }), oggPage([tags], { sequence: 1 })]);
}

/* ------------------------------------------------------------------ */
/* MP4 / M4A                                                          */
/* ------------------------------------------------------------------ */

function atom(type, ...payload) {
  const body = concat(payload);
  return concat([u32be(body.length + 8), latin1(type), body]);
}

function dataAtom(typeIndicator, payload) {
  return atom('data', u32be(typeIndicator), u32be(0), payload);
}

export function buildMp4File({ tags = {}, cover = null, freeform = {} } = {}) {
  const items = [];
  for (const [type, value] of Object.entries(tags)) {
    items.push(atom(type, dataAtom(1, utf8(value))));
  }
  if (cover) items.push(atom('covr', dataAtom(13, cover)));
  for (const [name, value] of Object.entries(freeform)) {
    items.push(atom('----', atom('mean', u32be(0), utf8('com.apple.iTunes')), atom('name', u32be(0), utf8(name)), dataAtom(1, utf8(value))));
  }

  const ilst = atom('ilst', ...items);
  const meta = atom('meta', u32be(0), ilst);
  const udta = atom('udta', meta);
  const moov = atom('moov', udta);
  const ftyp = atom('ftyp', utf8('M4A '), u32be(512), utf8('M4A '), utf8('isom'));
  const mdat = atom('mdat', new Uint8Array(64));
  return concat([ftyp, moov, mdat]);
}

/* ------------------------------------------------------------------ */
/* 常用组合：给测试服务器准备的可播放样例                              */
/* ------------------------------------------------------------------ */

/** 一首「带封面 + ReplayGain + 完整标签」的 WAV，用于端到端验证 */
export function buildTaggedWav() {
  const id3 = buildId3v2Tag([
    textFrame('TIT2', '测试音轨'),
    textFrame('TPE1', 'WebDAV 测试'),
    textFrame('TALB', '自动化测试专辑'),
    textFrame('TYER', '2026'),
    textFrame('TRCK', '3/12'),
    apicFrame('image/png', TINY_PNG),
    txxxFrame('REPLAYGAIN_TRACK_GAIN', '-7.32 dB'),
    txxxFrame('REPLAYGAIN_TRACK_PEAK', '0.988'),
    txxxFrame('REPLAYGAIN_ALBUM_GAIN', '-5.10 dB'),
    txxxFrame('REPLAYGAIN_ALBUM_PEAK', '1.012'),
  ]);
  return buildWavFile({ durationSec: 2, sampleRate: 8000, frequency: 440, id3 });
}

/* ------------------------------------------------------------------ */
/* MIDI 文件                                                          */
/* ------------------------------------------------------------------ */

/** 变长量编码 */
function varLength(value) {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return new Uint8Array(bytes);
}

function metaEvent(type, data) {
  return concat([new Uint8Array([0xff, type]), varLength(data.length), data]);
}

/**
 * 生成一个小而完整的 format 0 MIDI 文件。
 * 默认是 C 大调琶音，4 拍、120 BPM，正好 2 秒。
 *
 * `trackNameBytes` 用来塞任意编码的曲名（GBK / Shift-JIS 字节），
 * 不传就按 UTF-8 编码 `trackName`。
 */
export function buildMidiFile({
  division = 480,
  bpm = 120,
  trackName = '夹具音轨',
  trackNameBytes = null,
  notes = [
    { note: 60, start: 0, duration: 480, velocity: 100 },
    { note: 64, start: 480, duration: 480, velocity: 96 },
    { note: 67, start: 960, duration: 480, velocity: 92 },
    { note: 72, start: 1440, duration: 480, velocity: 110 },
  ],
  program = 0,
} = {}) {
  const events = [];
  let cursor = 0;

  const push = (tick, bytes) => events.push({ tick, bytes });

  push(0, metaEvent(0x03, trackNameBytes ?? utf8(trackName)));
  const usPerQuarter = Math.round(60000000 / bpm);
  push(0, metaEvent(0x51, new Uint8Array([(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff])));
  push(0, metaEvent(0x58, new Uint8Array([4, 2, 24, 8])));

  for (const item of notes) {
    push(item.start, new Uint8Array([0xc0, program & 0x7f]));
    push(item.start, new Uint8Array([0x90, item.note, item.velocity]));
    push(item.start + item.duration, new Uint8Array([0x80, item.note, 0]));
  }

  const endTick = Math.max(...notes.map((n) => n.start + n.duration), 0) + division;
  push(endTick, metaEvent(0x2f, new Uint8Array(0)));

  events.sort((a, b) => a.tick - b.tick);

  const track = [];
  for (const event of events) {
    track.push(varLength(event.tick - cursor));
    track.push(event.bytes);
    cursor = event.tick;
  }
  const trackData = concat(track);
  const header = concat([
    utf8('MThd'),
    u32be(6),
    u16be(0), // format 0
    u16be(1), // 单轨
    u16be(division),
  ]);
  const chunk = concat([utf8('MTrk'), u32be(trackData.length), trackData]);
  return concat([header, chunk]);
}

/** 对一段数据做 ID3 去同步化（0xFF → 0xFF 0x00），用于构造测试用例 */
export function applyUnsynchronisation(data) {
  const out = [];
  for (const byte of data) {
    out.push(byte);
    if (byte === 0xff) out.push(0x00);
  }
  return new Uint8Array(out);
}
