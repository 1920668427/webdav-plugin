/**
 * 音频元数据解析：标签、内嵌封面、ReplayGain。
 *
 * 支持的真实世界格式：
 *   - MP3（ID3v2.2 / 2.3 / 2.4，含 APIC 封面、TXXX 与 RVA2 两种 ReplayGain、ID3v1 兜底）
 *   - FLAC（STREAMINFO / VORBIS_COMMENT / PICTURE 块）
 *   - Ogg Vorbis 与 Opus（Vorbis comment + METADATA_BLOCK_PICTURE）
 *   - M4A / MP4 / AAC（moov.udta.meta.ilst：©nam / ©ART / ©alb / covr / ---- 自由字段）
 *   - WAV（RIFF 块、LIST INFO，以及内嵌的 id3 块）
 *
 * 全部是对 Uint8Array 的纯函数式解析，不依赖浏览器 API，
 * 所以既能跑在扩展页面里，也能直接在 Node 里做单元测试。
 */

const dec = {
  latin1: new TextDecoder('latin1'),
  utf8: new TextDecoder('utf-8'),
  utf16: new TextDecoder('utf-16'),
  utf16be: new TextDecoder('utf-16be'),
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function bytesEqual(bytes, offset, text) {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readAscii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** ID3 的 syncsafe 整数：每字节只用低 7 位 */
function readSyncSafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

/**
 * 现实里大量中文 MP3 把 GBK 字节标成了 latin1（编码字节 0），
 * 直接按 latin1 解出来就是 "¸¡¿ä" 这种乱码。
 * 这里做启发式重解：高位字节成对出现且能解出汉字时，采用 GBK/Big5/Shift-JIS。
 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

let legacyDecoders = null;
function getLegacyDecoders() {
  if (legacyDecoders !== null) return legacyDecoders;
  legacyDecoders = {};
  for (const [name, label] of [['gbk', 'gbk'], ['big5', 'big5'], ['shift_jis', 'shift_jis']]) {
    try {
      legacyDecoders[name] = new TextDecoder(label, { fatal: true });
    } catch {
      /* 环境不支持就跳过 */
    }
  }
  return legacyDecoders;
}

function countCjk(text) {
  let count = 0;
  for (const char of text) if (CJK_PATTERN.test(char)) count++;
  return count;
}

/** GBK/Big5 这类双字节编码的线索：高位字节成对出现 */
function legacyByteScore(bytes) {
  let high = 0;
  for (const byte of bytes) if (byte >= 0x81 && byte <= 0xfe) high++;
  return high;
}

function decodeLegacyCjk(bytes) {
  if (legacyByteScore(bytes) < 4) return null;
  for (const [name, decoder] of Object.entries(getLegacyDecoders())) {
    try {
      const text = stripNulls(decoder.decode(bytes));
      if (countCjk(text) >= 2) return text;
    } catch {
      /* 这个编码解不通，换下一个 */
    }
  }
  return null;
}

/** 尽量猜对编码：UTF-8 能解通就用 UTF-8，否则退回 latin1 */
function decodeSmartText(bytes) {
  if (!bytes || !bytes.length) return '';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.includes('\uFFFD')) return stripNulls(text);
  } catch {
    /* 不是合法 UTF-8 */
  }
  return stripNulls(dec.latin1.decode(bytes));
}

function stripNulls(text) {
  return text.replace(/\u0000+$/g, '').replace(/^\u0000+/, '').trim();
}

/** 按 ID3 的编码字节解码文本 */
function decodeId3Text(bytes, encoding) {
  if (!bytes || !bytes.length) return '';
  try {
    switch (encoding) {
      case 0: {
        const latin = stripNulls(dec.latin1.decode(bytes));
        // 只在确实像“双字节编码被当成 latin1”时才改写，避免误伤 Björk 这种正常西文
        if (countCjk(latin) === 0 && legacyByteScore(bytes) >= 4) {
          const fixed = decodeLegacyCjk(bytes);
          if (fixed) return fixed;
        }
        return latin;
      }
      case 1:
        return stripNulls(dec.utf16.decode(bytes));
      case 2:
        return stripNulls(dec.utf16be.decode(bytes));
      case 3:
        return stripNulls(dec.utf8.decode(bytes));
      default:
        return stripNulls(dec.latin1.decode(bytes));
    }
  } catch {
    return '';
  }
}

/** ID3 去同步化：0xFF 0x00 → 0xFF */
function removeUnsynchronisation(bytes) {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[length++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, length);
}

function base64ToBytes(base64) {
  const clean = String(base64).replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node 环境
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** "-7.32 dB" / "0.988" / "-7.32" → 数字 */
function parseGainValue(value) {
  if (value == null) return null;
  const match = /-?\d+(\.\d+)?/.exec(String(value));
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function parsePeakValue(value) {
  const number = parseGainValue(value);
  if (number == null) return null;
  return number;
}

function emptyResult(format = 'unknown') {
  return {
    format,
    tags: {},
    allTags: {},
    pictures: [],
    replayGain: { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null },
    audio: {},
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* ReplayGain：把各种来源归一化到同一个结构                            */
/* ------------------------------------------------------------------ */

/**
 * 从 Vorbis comment / MP4 自由字段这类 "KEY=value" 集合里提取 ReplayGain。
 * 同时支持：
 *   - 经典 ReplayGain：REPLAYGAIN_TRACK_GAIN = "-7.32 dB"
 *   - Opus 的 R128：R128_TRACK_GAIN = "-1880"（Q7.8 定点，-1880/256 dB）
 */
function extractReplayGainFromPairs(pairs, source) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    lookup.set(String(key).toLowerCase(), value);
  }
  const pick = (...names) => {
    for (const name of names) {
      const value = lookup.get(name.toLowerCase());
      if (value !== undefined && value !== '') return value;
    }
    return null;
  };

  const replayGain = { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null };

  const trackGain = pick('REPLAYGAIN_TRACK_GAIN', 'replaygain_track_gain');
  const albumGain = pick('REPLAYGAIN_ALBUM_GAIN', 'replaygain_album_gain');
  const trackPeak = pick('REPLAYGAIN_TRACK_PEAK', 'replaygain_track_peak');
  const albumPeak = pick('REPLAYGAIN_ALBUM_PEAK', 'replaygain_album_peak');

  if (trackGain != null) replayGain.trackGain = parseGainValue(trackGain);
  if (albumGain != null) replayGain.albumGain = parseGainValue(albumGain);
  if (trackPeak != null) replayGain.trackPeak = parsePeakValue(trackPeak);
  if (albumPeak != null) replayGain.albumPeak = parsePeakValue(albumPeak);

  // Opus / R128：整数 Q7.8 dB
  if (replayGain.trackGain == null) {
    const r128 = pick('R128_TRACK_GAIN');
    if (r128 != null) {
      const raw = parseGainValue(r128);
      if (raw != null) replayGain.trackGain = raw / 256;
    }
  }
  if (replayGain.albumGain == null) {
    const r128 = pick('R128_ALBUM_GAIN');
    if (r128 != null) {
      const raw = parseGainValue(r128);
      if (raw != null) replayGain.albumGain = raw / 256;
    }
  }

  if (replayGain.trackGain != null || replayGain.albumGain != null) {
    replayGain.source = source;
  }
  return replayGain;
}

/* ------------------------------------------------------------------ */
/* ID3v2                                                               */
/* ------------------------------------------------------------------ */

const ID3V2_TEXT_FRAMES = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TDRC: 'year', TYER: 'year', TYE: 'year',
  TCON: 'genre', TCO: 'genre',
  TRCK: 'track', TRK: 'track',
  TPOS: 'disc', TPA: 'disc',
  TCOM: 'composer', TCM: 'composer',
  TENC: 'encodedBy', TEN: 'encodedBy',
  TSSE: 'encoderSettings',
  TBPM: 'bpm', TBP: 'bpm',
  TCOP: 'copyright',
  TIT1: 'grouping', TT1: 'grouping',
  TSRC: 'isrc',
  TLAN: 'language',
  COMM: 'comment',
};

/** 解析 ID3v2 头，返回 {version, size, bodyOffset, flags} */
export function parseId3v2Header(bytes, offset = 0) {
  if (!bytesEqual(bytes, offset, 'ID3')) return null;
  const major = bytes[offset + 3];
  const revision = bytes[offset + 4];
  const flags = bytes[offset + 5];
  const size = readSyncSafe(bytes, offset + 6);
  return {
    version: `2.${major}.${revision}`,
    major,
    flags,
    unsynchronisation: (flags & 0x80) !== 0,
    extendedHeader: (flags & 0x40) !== 0,
    experimental: (flags & 0x20) !== 0,
    footer: (flags & 0x10) !== 0,
    size,
    totalSize: 10 + size + (flags & 0x10 ? 10 : 0),
    bodyOffset: offset + 10,
  };
}

/**
 * 解析 ID3v2 标签体。
 * @returns {{tags: object, allTags: object, pictures: Array, replayGain: object}}
 */
export function parseId3v2(bytes, offset = 0) {
  const header = parseId3v2Header(bytes, offset);
  const out = { tags: {}, allTags: {}, pictures: [], replayGain: { trackGain: null, trackPeak: null, albumGain: null, albumPeak: null, source: null }, header };
  if (!header) return out;

  const storedBody = bytes.subarray(header.bodyOffset, Math.min(bytes.length, header.bodyOffset + header.size));

  /*
   * 去同步化的两种风格，处理方式完全不同：
   *  - v2.3：整块标签去同步化，帧长度记录的是**去同步化前**的长度，
   *          所以要先把整块还原，再按声明长度遍历（mutagen 也是这么做的）。
   *  - v2.4：去同步化是**逐帧**的，帧长度记录的是**存储长度**。
   *          这里如果也整块还原，帧偏移就会错位 —— 真实文件里
   *          （MP3 的 TSSE 帧带 0x0003 标志）会直接导致后面的 APIC 封面读不到。
   */
  const isV24 = header.major === 4;
  const body = isV24 || !header.unsynchronisation ? storedBody : removeUnsynchronisation(storedBody);

  let cursor = 0;
  if (header.extendedHeader && header.major >= 3) {
    cursor += header.major === 4 ? readSyncSafe(body, 0) : readUint32BE(body, 0) + 4;
  }

  const textPairs = {};
  const txxxPairs = {};

  while (cursor < body.length) {
    if (header.major === 2) {
      // v2.2：3 字节 ID + 3 字节长度
      const id = readAscii(body, cursor, 3);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const size = (body[cursor + 3] << 16) | (body[cursor + 4] << 8) | body[cursor + 5];
      const data = body.subarray(cursor + 6, cursor + 6 + size);
      handleFrame(id, data, out, textPairs, txxxPairs, 2);
      cursor += 6 + size;
    } else {
      const id = readAscii(body, cursor, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = isV24 ? readSyncSafe(body, cursor + 4) : readUint32BE(body, cursor + 4);
      const frameFlags = readUint16BE(body, cursor + 8);
      let data = body.subarray(cursor + 10, cursor + 10 + size);
      // v2.4：先读数据长度指示（它是存储数据的一部分），再去同步化
      if (isV24) {
        let declaredLength = null;
        if (frameFlags & 0x0001) {
          declaredLength = readSyncSafe(data, 0);
          data = data.subarray(4);
        }
        if (frameFlags & 0x0002) data = removeUnsynchronisation(data);
        if (declaredLength != null && declaredLength <= data.length) data = data.subarray(0, declaredLength);
      }
      if (size <= 0) break;
      handleFrame(id, data, out, textPairs, txxxPairs, header.major);
      cursor += 10 + size;
    }
  }

  // 文本帧 → 归一化字段
  for (const [id, entry] of Object.entries(textPairs)) {
    const field = ID3V2_TEXT_FRAMES[id];
    if (field && !out.tags[field]) out.tags[field] = entry;
  }

  // TXXX：ReplayGain 等自定义字段
  for (const [key, value] of Object.entries(txxxPairs)) {
    out.allTags[key] = value;
  }
  const fromTxxx = extractReplayGainFromPairs(txxxPairs, 'ID3 TXXX');
  out.replayGain = mergeReplayGain(out.replayGain, fromTxxx);

  // ID3v1 兜底（标签体里没有标题时再看文件末尾）
  return out;
}

function handleFrame(id, data, out, textPairs, txxxPairs, major) {
  if (!data || !data.length) return;

  if (id === 'APIC' || id === 'PIC') {
    const picture = parseApicFrame(data, id === 'PIC');
    if (picture) out.pictures.push(picture);
    return;
  }

  if (id === 'RVA2') {
    const rva = parseRva2Frame(data);
    if (rva) {
      out.replayGain = mergeReplayGain(out.replayGain, rva);
      out.allTags.RVA2 = `${rva.trackGain >= 0 ? '+' : ''}${rva.trackGain.toFixed(2)} dB`;
      if (rva.trackPeak != null) out.allTags.RVA2_PEAK = String(rva.trackPeak);
    }
    return;
  }

  if (id === 'TXXX' || id === 'TXX') {
    const encoding = data[0];
    const rest = data.subarray(1);
    const separator = findTerminator(rest, encoding);
    const description = decodeId3Text(rest.subarray(0, separator), encoding);
    const value = decodeId3Text(rest.subarray(separator + terminatorLength(encoding)), encoding);
    if (description) txxxPairs[description] = value;
    return;
  }

  if (id === 'COMM' || id === 'COM') {
    const encoding = data[0];
    const rest = data.subarray(1);
    // 语言(3) + 短描述 + \0 + 正文
    const afterLanguage = rest.subarray(3);
    const sep = findTerminator(afterLanguage, encoding);
    const text = decodeId3Text(afterLanguage.subarray(sep + terminatorLength(encoding)), encoding);
    if (text) textPairs[id] = text;
    return;
  }

  if (id.startsWith('T') || id === 'TT2' || id === 'TP1' || id === 'TAL') {
    const value = decodeId3Text(data.subarray(1), data[0]);
    if (value) textPairs[id] = value;
    return;
  }

  if (id === 'UFID' || id === 'PRIV' || id === 'MCDI' || id === 'GEOB') {
    return; // 二进制帧，忽略
  }
}

function terminatorLength(encoding) {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

/** 找到编码对应的字符串结束符位置 */
function findTerminator(bytes, encoding) {
  const step = terminatorLength(encoding);
  for (let i = 0; i + step <= bytes.length; i += step) {
    if (step === 1) {
      if (bytes[i] === 0) return i;
    } else if (bytes[i] === 0 && bytes[i + 1] === 0) {
      // UTF-16 的 0x0000 需要按字符对齐判断
      return i;
    }
  }
  return bytes.length;
}

/** APIC 帧 → {mimeType, data, kind, description} */
export function parseApicFrame(data, isV22 = false) {
  const encoding = data[0];
  let cursor = 1;
  let mimeType = 'image/jpeg';

  if (isV22) {
    const format = readAscii(data, cursor, 3).toLowerCase();
    mimeType = format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : `image/${format || 'jpeg'}`;
    cursor += 3;
  } else {
    let end = cursor;
    while (end < data.length && data[end] !== 0) end++;
    mimeType = readAscii(data, cursor, end - cursor) || 'image/jpeg';
    cursor = end + 1;
  }

  const pictureType = data[cursor] || 3;
  cursor += 1;

  const descriptionEnd = findTerminator(data.subarray(cursor), encoding);
  const description = decodeId3Text(data.subarray(cursor, cursor + descriptionEnd), encoding);
  cursor += descriptionEnd + terminatorLength(encoding);

  const image = data.subarray(cursor);
  if (!image.length) return null;
  return {
    mimeType,
    data: image,
    kind: PICTURE_TYPES[pictureType] || 'other',
    description,
  };
}

/** RVA2：每声道 2 字节的 1/512 dB 定点增益 */
export function parseRva2Frame(data) {
  let cursor = 0;
  while (cursor < data.length && data[cursor] !== 0) cursor++;
  const identification = readAscii(data, 0, cursor);
  cursor += 1;
  if (cursor >= data.length) return null;

  const channelType = data[cursor];
  const rawGain = (data[cursor + 1] << 8) | data[cursor + 2];
  const signed = rawGain > 32767 ? rawGain - 65536 : rawGain;
  const gainDb = signed / 512;
  cursor += 3;

  const peakBits = data[cursor];
  cursor += 1;
  let peak = null;
  if (peakBits > 0) {
    const peakBytes = Math.ceil(peakBits / 8);
    let value = 0;
    for (let i = 0; i < peakBytes; i++) value = value * 256 + (data[cursor + i] || 0);
    peak = value / Math.pow(2, peakBits);
  }

  const result = { trackGain: gainDb, trackPeak: peak, albumGain: null, albumPeak: null, source: 'ID3 RVA2' };
  // 主声道（channelType 1 = master volume）以外的先忽略
  return channelType === 1 || channelType === 0 ? result : result;
}

/** 合并两份 ReplayGain，非空字段优先 */
function mergeReplayGain(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const key of ['trackGain', 'trackPeak', 'albumGain', 'albumPeak']) {
    if (out[key] == null && extra[key] != null) out[key] = extra[key];
  }
  if (!out.source && extra.source) out.source = extra.source;
  return out;
}

/** ID3v1：文件最后 128 字节，只有文本字段，没有封面 */
export function parseId3v1(bytes) {
  const offset = bytes.length - 128;
  if (offset < 0 || !bytesEqual(bytes, offset, 'TAG')) return null;
  const field = (start, length) => stripNulls(dec.latin1.decode(bytes.subarray(offset + start, offset + start + length)));
  const tags = {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    year: field(93, 4),
    comment: field(97, 30),
  };
  if (bytes[offset + 125] === 0 && bytes[offset + 126] !== 0) {
    tags.track = String(bytes[offset + 126]);
  }
  const genreIndex = bytes[offset + 127];
  if (genreIndex < ID3V1_GENRES.length) tags.genre = ID3V1_GENRES[genreIndex];
  return tags;
}

/* ------------------------------------------------------------------ */
/* FLAC                                                               */
/* ------------------------------------------------------------------ */

/** 解析 FLAC 的 VORBIS_COMMENT 块 */
export function parseVorbisComment(bytes, offset = 0) {
  const vendorLength = readUint32LE(bytes, offset);
  let cursor = offset + 4 + vendorLength;
  const vendor = dec.utf8.decode(bytes.subarray(offset + 4, cursor));
  const count = readUint32LE(bytes, cursor);
  cursor += 4;

  const comments = {};
  for (let i = 0; i < count && cursor + 4 <= bytes.length; i++) {
    const length = readUint32LE(bytes, cursor);
    cursor += 4;
    const text = dec.utf8.decode(bytes.subarray(cursor, cursor + length));
    cursor += length;
    const eq = text.indexOf('=');
    if (eq > 0) {
      const key = text.slice(0, eq).toUpperCase();
      comments[key] = text.slice(eq + 1);
    }
  }
  return { vendor, comments };
}

/** 解析 FLAC 的 PICTURE 块（也用于 Ogg 的 METADATA_BLOCK_PICTURE） */
export function parseFlacPicture(bytes, offset = 0) {
  const read = (position) => readUint32BE(bytes, position);
  const type = read(offset);
  let cursor = offset + 4;
  const mimeLength = read(cursor);
  const mimeType = readAscii(bytes, cursor + 4, mimeLength);
  cursor += 4 + mimeLength;
  const descriptionLength = read(cursor);
  const description = dec.utf8.decode(bytes.subarray(cursor + 4, cursor + 4 + descriptionLength));
  cursor += 4 + descriptionLength;
  const width = read(cursor);
  const height = read(cursor + 4);
  const depth = read(cursor + 8);
  cursor += 12;
  cursor += 4; // 调色板颜色数
  const dataLength = read(cursor);
  cursor += 4;
  const data = bytes.subarray(cursor, cursor + dataLength);
  return {
    mimeType: mimeType || guessImageMime(data),
    data,
    width,
    height,
    depth,
    kind: PICTURE_TYPES[type] || 'other',
    description,
  };
}

function guessImageMime(data) {
  if (!data || data.length < 4) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

export function parseFlac(bytes) {
  const out = emptyResult('flac');
  let cursor = 4; // 跳过 'fLaC'
  let last = false;

  while (!last && cursor + 4 <= bytes.length) {
    const header = bytes[cursor];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    const body = cursor + 4;
    if (body + length > bytes.length) break;

    if (type === 0 && length >= 34) {
      // STREAMINFO
      const b = bytes.subarray(body);
      out.audio.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      out.audio.channels = ((b[12] >> 1) & 0x07) + 1;
      out.audio.bitsPerSample = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
      const totalSamples = ((b[13] & 0x0f) * 4294967296) + readUint32BE(b, 14);
      if (out.audio.sampleRate) out.audio.duration = totalSamples / out.audio.sampleRate;
    } else if (type === 4) {
      const { vendor, comments } = parseVorbisComment(bytes, body);
      out.allTags.VENDOR = vendor;
      Object.assign(out.allTags, comments);
      applyVorbisTags(out, comments);
    } else if (type === 6) {
      try {
        const picture = parseFlacPicture(bytes, body);
        if (picture.data.length) out.pictures.push(picture);
      } catch (err) {
        out.warnings.push(`PICTURE 块解析失败：${err.message}`);
      }
    }

    cursor = body + length;
  }

  out.replayGain = mergeReplayGain(out.replayGain, extractReplayGainFromPairs(out.allTags, 'Vorbis comment (FLAC)'));
  return out;
}

function applyVorbisTags(out, comments) {
  const map = {
    TITLE: 'title',
    ARTIST: 'artist',
    ALBUM: 'album',
    ALBUMARTIST: 'albumArtist',
    ALBUM_ARTIST: 'albumArtist',
    DATE: 'year',
    YEAR: 'year',
    GENRE: 'genre',
    TRACKNUMBER: 'track',
    DISCNUMBER: 'disc',
    COMPOSER: 'composer',
    COMMENT: 'comment',
    DESCRIPTION: 'comment',
    BPM: 'bpm',
  };
  for (const [key, field] of Object.entries(map)) {
    if (comments[key] && !out.tags[field]) out.tags[field] = comments[key];
  }
}

/* ------------------------------------------------------------------ */
/* Ogg（Vorbis / Opus）                                                */
/* ------------------------------------------------------------------ */

export function parseOgg(bytes) {
  const out = emptyResult('ogg');
  let cursor = 0;
  let packet = [];
  let packets = [];

  // 把 Ogg 页重新拼成包（只关心前几个包：识别头 + 注释头）
  while (cursor + 27 <= bytes.length && packets.length < 8) {
    if (!bytesEqual(bytes, cursor, 'OggS')) break;
    const segmentCount = bytes[cursor + 26];
    const tableOffset = cursor + 27;
    let dataOffset = tableOffset + segmentCount;
    let continued = (bytes[cursor + 5] & 0x01) !== 0;
    for (let i = 0; i < segmentCount; i++) {
      const size = bytes[tableOffset + i];
      packet.push(bytes.subarray(dataOffset, dataOffset + size));
      dataOffset += size;
      if (size < 255) {
        if (!continued) packets.push(concatBytes(packet));
        packet = [];
        continued = false;
      }
    }
    cursor = dataOffset;
  }

  const first = packets[0];
  if (first) {
    if (bytesEqual(first, 0, 'OpusHead')) {
      out.format = 'opus';
      out.audio.channels = first[9];
      out.audio.sampleRate = readUint32LE(first, 12) || 48000;
    } else if (first[0] === 1 && readAscii(first, 1, 6) === 'vorbis') {
      out.format = 'vorbis';
      out.audio.channels = first[11];
      out.audio.sampleRate = readUint32LE(first, 12);
    }
  }

  for (const p of packets) {
    const isVorbisComment = p[0] === 3 && readAscii(p, 1, 6) === 'vorbis';
    const isOpusTags = bytesEqual(p, 0, 'OpusTags');
    if (!isVorbisComment && !isOpusTags) continue;

    const offset = isOpusTags ? 8 : 7;
    const { vendor, comments } = parseVorbisComment(p, offset);
    out.allTags.VENDOR = vendor;
    Object.assign(out.allTags, comments);
    applyVorbisTags(out, comments);

    // METADATA_BLOCK_PICTURE：FLAC PICTURE 块的 base64
    for (const key of ['METADATA_BLOCK_PICTURE', 'COVERART']) {
      if (!comments[key]) continue;
      try {
        if (key === 'COVERART') {
          const data = base64ToBytes(comments[key]);
          out.pictures.push({ mimeType: guessImageMime(data), data, kind: 'cover-front', description: '' });
        } else {
          const block = base64ToBytes(comments[key]);
          const picture = parseFlacPicture(block, 0);
          if (picture.data.length) out.pictures.push(picture);
        }
        delete out.allTags[key]; // 体积太大，不留在标签列表里
      } catch (err) {
        out.warnings.push(`封面解析失败（${key}）：${err.message}`);
      }
    }
    break;
  }

  out.replayGain = mergeReplayGain(out.replayGain, extractReplayGainFromPairs(out.allTags, 'Vorbis comment (Ogg)'));
  return out;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* MP4 / M4A                                                          */
/* ------------------------------------------------------------------ */

const MP4_TAGS = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumArtist',
  '©alb': 'album',
  '©day': 'year',
  '©gen': 'genre',
  gnre: 'genre',
  '©cmt': 'comment',
  '©wrt': 'composer',
  '©too': 'encoderSettings',
  trkn: 'track',
  disk: 'disc',
  '©lyr': 'lyrics',
};

export function parseMp4(bytes) {
  const out = emptyResult('m4a');
  const moov = findAtom(bytes, 0, bytes.length, ['moov']);
  if (!moov) {
    out.warnings.push('没有找到 moov 原子');
    return out;
  }
  const udta = findAtom(bytes, moov.start, moov.end, ['udta']);
  if (!udta) return out;
  const meta = findAtom(bytes, udta.start, udta.end, ['meta']);
  if (!meta) return out;
  // meta 原子开头有 4 字节 version/flags
  const ilst = findAtom(bytes, meta.start + 4, meta.end, ['ilst']);
  if (!ilst) return out;

  let cursor = ilst.start;
  while (cursor + 8 <= ilst.end) {
    const size = readUint32BE(bytes, cursor);
    if (size < 8 || cursor + size > ilst.end) break;
    const type = readAscii(bytes, cursor + 4, 4);
    const bodyStart = cursor + 8;
    const bodyEnd = cursor + size;

    if (type === 'covr') {
      const data = findAtom(bytes, bodyStart, bodyEnd, ['data']);
      if (data) {
        const payload = bytes.subarray(data.start + 8, data.end);
        out.pictures.push({
          mimeType: guessImageMime(payload),
          data: payload,
          kind: 'cover-front',
          description: '',
        });
      }
    } else if (type === '----') {
      const meanAtom = findAtom(bytes, bodyStart, bodyEnd, ['mean']);
      const nameAtom = findAtom(bytes, bodyStart, bodyEnd, ['name']);
      const dataAtom = findAtom(bytes, bodyStart, bodyEnd, ['data']);
      if (nameAtom && dataAtom) {
        const name = dec.utf8.decode(bytes.subarray(nameAtom.start + 4, nameAtom.end));
        const value = dec.utf8.decode(bytes.subarray(dataAtom.start + 8, dataAtom.end));
        out.allTags[name] = value;
        const mean = meanAtom ? dec.utf8.decode(bytes.subarray(meanAtom.start + 4, meanAtom.end)) : '';
        if (mean && !mean.includes('iTunes')) out.allTags[`${mean}:${name}`] = value;
      }
    } else {
      const data = findAtom(bytes, bodyStart, bodyEnd, ['data']);
      if (data) {
        const payload = bytes.subarray(data.start + 8, data.end);
        const field = MP4_TAGS[type];
        if (type === 'trkn' || type === 'disk') {
          const number = (payload[2] << 8) | payload[3];
          const total = (payload[4] << 8) | payload[5];
          if (field) out.tags[field] = total ? `${number}/${total}` : String(number);
        } else if (field) {
          const text = dec.utf8.decode(payload).trim();
          if (text) out.tags[field] = text;
        }
        if (type === '©gen') out.allTags.GENRE = dec.utf8.decode(payload);
      }
    }
    cursor += size;
  }

  out.replayGain = mergeReplayGain(out.replayGain, extractReplayGainFromPairs(out.allTags, 'MP4 自由字段'));
  return out;
}

/**
 * 在 [start, end) 范围内按顺序查找嵌套原子路径。
 * @returns {{start:number, end:number}|null} start 指向子内容起点（已跳过原子头）
 */
function findAtom(bytes, start, end, path) {
  for (const wanted of path) {
    let cursor = start;
    let found = null;
    while (cursor + 8 <= end) {
      let size = readUint32BE(bytes, cursor);
      const type = readAscii(bytes, cursor + 4, 4);
      let headerSize = 8;
      if (size === 1) {
        // 64 位长度
        size = readUint32BE(bytes, cursor + 8) * 4294967296 + readUint32BE(bytes, cursor + 12);
        headerSize = 16;
      } else if (size === 0) {
        size = end - cursor;
      }
      if (size < headerSize || cursor + size > end) return null;
      if (type === wanted) {
        found = { start: cursor + headerSize, end: cursor + size };
        break;
      }
      cursor += size;
    }
    if (!found) return null;
    start = found.start;
    end = found.end;
    if (wanted === path[path.length - 1]) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* WAV                                                                */
/* ------------------------------------------------------------------ */

export function parseWav(bytes) {
  const out = emptyResult('wav');
  let cursor = 12; // 'RIFF' + size + 'WAVE'
  while (cursor + 8 <= bytes.length) {
    const id = readAscii(bytes, cursor, 4);
    const size = readUint32LE(bytes, cursor + 4);
    const body = cursor + 8;
    if (body + size > bytes.length) {
      if (size === 0) break;
    }
    const safeSize = Math.min(size, bytes.length - body);

    if (id === 'fmt ' && safeSize >= 16) {
      out.audio.channels = readUint16LE(bytes, body + 2);
      out.audio.sampleRate = readUint32LE(bytes, body + 4);
      out.audio.bitsPerSample = readUint16LE(bytes, body + 14);
    } else if (id === 'LIST' && readAscii(bytes, body, 4) === 'INFO') {
      let sub = body + 4;
      while (sub + 8 <= body + safeSize) {
        const subId = readAscii(bytes, sub, 4);
        const subSize = readUint32LE(bytes, sub + 4);
        const text = decodeSmartText(bytes.subarray(sub + 8, sub + 8 + subSize));
        const map = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre', ICMT: 'comment', ITRK: 'track', IENG: 'engineer' };
        if (map[subId] && text && !out.tags[map[subId]]) out.tags[map[subId]] = text;
        if (text) out.allTags[subId] = text;
        sub += 8 + subSize + (subSize % 2);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      // 内嵌的 ID3v2（很多打标工具会把标签塞进 WAV）
      const id3 = parseId3v2(bytes, body);
      Object.assign(out.tags, { ...id3.tags, ...out.tags });
      Object.assign(out.allTags, id3.allTags);
      out.pictures.push(...id3.pictures);
      out.replayGain = mergeReplayGain(out.replayGain, id3.replayGain);
      out.hasId3 = true;
    }

    cursor = body + safeSize + (safeSize % 2);
    if (size === 0) break;
  }

  if (out.audio.sampleRate && out.audio.bitsPerSample && out.audio.channels) {
    const dataBytes = Math.max(0, bytes.length - 44);
    out.audio.duration = dataBytes / (out.audio.sampleRate * out.audio.channels * (out.audio.bitsPerSample / 8));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

const PICTURE_TYPES = {
  0: 'other',
  1: 'file-icon',
  2: 'other-icon',
  3: 'cover-front',
  4: 'cover-back',
  5: 'leaflet',
  6: 'media',
  7: 'lead-artist',
  8: 'artist',
  9: 'conductor',
  10: 'band',
  11: 'composer',
  12: 'lyricist',
  13: 'recording-location',
  14: 'during-recording',
  15: 'during-performance',
  16: 'movie-capture',
  17: 'bright-coloured-fish',
  18: 'illustration',
  19: 'band-logotype',
  20: 'publisher-logotype',
};

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
];

/** 是否是 MPEG 音频帧同步字（0xFFEx） */
function looksLikeMpeg(bytes) {
  return bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function isIsoBmff(bytes) {
  return bytes.length > 12 && (bytesEqual(bytes, 4, 'ftyp') || bytesEqual(bytes, 4, 'moov') || bytesEqual(bytes, 4, 'free') || bytesEqual(bytes, 4, 'mdat'));
}

/**
 * 解析音频文件元数据。
 *
 * @param {Uint8Array} bytes 文件内容（可以只给文件头部，但 MP4 的 moov 可能在尾部）
 * @param {{name?: string, mimeType?: string}} [hint]
 * @returns {{
 *   format: string, tags: object, allTags: object,
 *   pictures: Array<{mimeType:string,data:Uint8Array,kind:string,description:string}>,
 *   replayGain: {trackGain:number|null,trackPeak:number|null,albumGain:number|null,albumPeak:number|null,source:string|null},
 *   audio: object, warnings: string[]
 * }}
 */
export function readAudioMetadata(bytes, hint = {}) {
  if (!bytes || bytes.length < 12) return emptyResult('unknown');
  const name = String(hint.name || '').toLowerCase();

  try {
    if (bytesEqual(bytes, 0, 'fLaC')) return parseFlac(bytes);
    if (bytesEqual(bytes, 0, 'OggS')) return parseOgg(bytes);
    if (bytesEqual(bytes, 0, 'RIFF')) {
      const result = parseWav(bytes);
      // 有些 MP3 被错误地包了一层 RIFF 头
      return result;
    }
    if (bytesEqual(bytes, 0, 'ID3') || looksLikeMpeg(bytes) || name.endsWith('.mp3')) {
      const out = emptyResult('mp3');
      const id3 = parseId3v2(bytes, 0);
      Object.assign(out.tags, id3.tags);
      Object.assign(out.allTags, id3.allTags);
      out.pictures = id3.pictures;
      out.replayGain = mergeReplayGain(out.replayGain, id3.replayGain);
      out.id3 = id3.header;

      if (!out.tags.title || !out.tags.artist) {
        const v1 = parseId3v1(bytes);
        if (v1) {
          const base = { title: 'ID3v1 标题', artist: 'ID3v1 艺术家', album: 'ID3v1 专辑', year: 'ID3v1 年份' };
          for (const [key, value] of Object.entries(v1)) {
            if (value && !out.tags[key]) out.tags[key] = value;
            if (value) out.allTags[base[key] || `ID3v1 ${key}`] = value;
          }
        }
      }
      return out;
    }
    if (isIsoBmff(bytes)) return parseMp4(bytes);
  } catch (err) {
    const out = emptyResult('unknown');
    out.warnings.push(`解析失败：${err.message}`);
    return out;
  }

  return emptyResult('unknown');
}

/**
 * 根据 ReplayGain 计算该用的线性增益。
 *
 * @param {object} replayGain readAudioMetadata 的结果
 * @param {{mode?:'off'|'track'|'album', preAmpDb?:number, preventClipping?:boolean}} options
 * @returns {{gainDb:number, linear:number, limited:boolean, available:boolean, reason:string}}
 */
export function computeReplayGain(replayGain, { mode = 'track', preAmpDb = 0, preventClipping = true } = {}) {
  const base = { gainDb: 0, linear: 1, limited: false, available: false, reason: '' };
  if (!replayGain || mode === 'off') {
    return { ...base, reason: mode === 'off' ? '已关闭' : '文件里没有 ReplayGain 信息' };
  }

  const gain = mode === 'album' ? replayGain.albumGain : replayGain.trackGain;
  const peak = mode === 'album' ? replayGain.albumPeak : replayGain.trackPeak;

  if (gain == null) {
    const otherAvailable = mode === 'album' ? replayGain.trackGain != null : replayGain.albumGain != null;
    return {
      ...base,
      reason: mode === 'album'
        ? `文件里没有专辑增益（Album Gain）${otherAvailable ? '，可切换成「音轨」试试' : ''}`
        : `文件里没有音轨增益（Track Gain）${otherAvailable ? '，可切换成「专辑」试试' : '，也没有其他 ReplayGain 信息'}`,
    };
  }

  let gainDb = gain + preAmpDb;
  let limited = false;
  if (preventClipping && peak != null && peak > 0) {
    const maxGainDb = 20 * Math.log10(1 / peak);
    if (gainDb > maxGainDb) {
      gainDb = maxGainDb;
      limited = true;
    }
  }

  return {
    gainDb,
    linear: Math.pow(10, gainDb / 20),
    limited,
    available: true,
    reason: limited ? '已按峰值限制，避免削波' : '',
  };
}

/** 给界面用的一句话描述 */
export function describeReplayGain(replayGain) {
  if (!replayGain || (replayGain.trackGain == null && replayGain.albumGain == null)) return '无';
  const parts = [];
  if (replayGain.trackGain != null) parts.push(`音轨 ${replayGain.trackGain >= 0 ? '+' : ''}${replayGain.trackGain.toFixed(2)} dB`);
  if (replayGain.albumGain != null) parts.push(`专辑 ${replayGain.albumGain >= 0 ? '+' : ''}${replayGain.albumGain.toFixed(2)} dB`);
  if (replayGain.trackPeak != null) parts.push(`峰值 ${replayGain.trackPeak.toFixed(3)}`);
  if (replayGain.source) parts.push(`来源 ${replayGain.source}`);
  return parts.join(' · ');
}
