/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

/**
 * SFX - 音效类
 * 可重叠播放的音频效果
 */
class SFX {
    constructor(options = {}) {
        this.Config = {
            volume: 1,
            rate: 1,
            stopOnHidden: false,
            preload: false,
            enable: true,
        };
        this.ActiveInstances = new Set();
        this.Cache = new Map(); // id -> src
        this.visibilityHandler = null;
        this.blocked = false;
        if (options.volume !== undefined) {
            this.Config.volume = Math.max(0, Math.min(1, options.volume));
        }
        if (options.rate !== undefined) {
            this.Config.rate = options.rate;
        }
        if (options.stopOnHidden !== undefined) {
            this.Config.stopOnHidden = options.stopOnHidden;
        }
        if (options.preload !== undefined) {
            this.Config.preload = options.preload;
        }
        if (options.enable !== undefined) {
            this.Config.enable = options.enable;
        }
        this.configProxy = this.createConfigProxy();
        this.setupVisibilityHandler();
    }
    createConfigProxy() {
        return new Proxy(this.Config, {
            set: (target, prop, value) => {
                const oldValue = target[prop];
                target[prop] = value;
                // 处理配置变更
                this.handleConfigChange(prop, value, oldValue);
                return true;
            },
        });
    }
    handleConfigChange(key, newValue, oldValue) {
        if (newValue === oldValue)
            return;
        switch (key) {
            case "enable":
                if (newValue === false) {
                    this.stopAll();
                }
                break;
            case "stopOnHidden":
                this.setupVisibilityHandler();
                break;
        }
    }
    setupVisibilityHandler() {
        // 清理旧的监听器
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        // 如果启用 stopOnHidden，设置新的监听器
        if (this.Config.stopOnHidden) {
            this.visibilityHandler = () => {
                if (document.hidden) {
                    this.blocked = true;
                    this.stopAll();
                }
                else {
                    this.blocked = false;
                }
            };
            document.addEventListener("visibilitychange", this.visibilityHandler);
        }
    }
    /**
     * 预加载音效资源（preload: true 时建议提前调用；preload: false 时可跳过）
     */
    load(id, src) {
        return __awaiter(this, void 0, void 0, function* () {
            // load 操作不受 enable 限制，允许预加载资源
            if (!this.Config.preload) {
                // 非预加载模式：仅缓存 src，不触发网络请求
                this.Cache.set(id, src);
                return;
            }
            return new Promise((resolve, reject) => {
                let audio = new Audio(src);
                this.Cache.set(id, src);
                const onLoad = () => {
                    audio = null;
                    resolve();
                };
                const onError = (e) => {
                    audio = null;
                    reject(e);
                };
                audio.addEventListener("canplaythrough", onLoad, { once: true });
                audio.addEventListener("error", onError, { once: true });
                audio.load();
            });
        });
    }
    /**
     * 播放音效（每次创建新实例，支持重叠播放）
     * preload: false 时可直接传 src 而无需提前调用 load()
     */
    play(id_1) {
        return __awaiter(this, arguments, void 0, function* (id, options = {}) {
            var _a;
            if (!this.Config.enable) {
                return;
            }
            if (this.blocked)
                return;
            const src = (_a = options.src) !== null && _a !== void 0 ? _a : this.Cache.get(id);
            if (!src) {
                throw new Error(`SFX: "${id}" not found. Call load() first or pass { src } directly.`);
            }
            // 按需缓存
            if (!this.Cache.has(id))
                this.Cache.set(id, src);
            const mergedOptions = Object.assign(Object.assign({}, this.Config), options);
            const audio = new Audio(src);
            if (mergedOptions.volume !== undefined) {
                audio.volume = Math.max(0, Math.min(1, mergedOptions.volume));
            }
            if (mergedOptions.rate !== undefined) {
                audio.playbackRate = mergedOptions.rate;
            }
            const instance = {
                audio,
                id,
                stop() {
                    audio.pause();
                    audio.currentTime = 0;
                },
            };
            this.ActiveInstances.add(instance);
            audio.addEventListener("ended", () => {
                this.ActiveInstances.delete(instance);
            }, { once: true });
            audio.addEventListener("error", () => {
                this.ActiveInstances.delete(instance);
            }, { once: true });
            try {
                yield audio.play();
            }
            catch (error) {
                this.ActiveInstances.delete(instance);
                throw error;
            }
        });
    }
    /**
     * 直接播放一个音频文件（无需预加载或缓存）
     * 适用于一次性播放的音效
     */
    once(src_1) {
        return __awaiter(this, arguments, void 0, function* (src, options = {}) {
            if (!this.Config.enable) {
                return;
            }
            if (this.blocked)
                return;
            const mergedOptions = Object.assign(Object.assign({}, this.Config), options);
            const audio = new Audio(src);
            if (mergedOptions.volume !== undefined) {
                audio.volume = Math.max(0, Math.min(1, mergedOptions.volume));
            }
            if (mergedOptions.rate !== undefined) {
                audio.playbackRate = mergedOptions.rate;
            }
            const instance = {
                audio,
                id: src, // 使用 src 作为临时 id
                stop() {
                    audio.pause();
                    audio.currentTime = 0;
                },
            };
            this.ActiveInstances.add(instance);
            audio.addEventListener("ended", () => {
                this.ActiveInstances.delete(instance);
            }, { once: true });
            audio.addEventListener("error", () => {
                this.ActiveInstances.delete(instance);
            }, { once: true });
            try {
                yield audio.play();
            }
            catch (error) {
                this.ActiveInstances.delete(instance);
                throw error;
            }
        });
    }
    /**
     * 停止所有正在播放的音效实例
     */
    stopAll() {
        this.ActiveInstances.forEach((instance) => instance.stop());
        this.ActiveInstances.clear();
    }
    /**
     * 停止指定 id 的所有音效实例
     */
    stop(id) {
        this.ActiveInstances.forEach((instance) => {
            if (instance.id === id) {
                instance.stop();
                this.ActiveInstances.delete(instance);
            }
        });
    }
    /**
     * 获取当前活跃实例数量
     */
    get activeCount() {
        return this.ActiveInstances.size;
    }
    get config() {
        return this.configProxy;
    }
    set config(newConfig) {
        Object.keys(newConfig).forEach((key) => {
            const k = key;
            if (newConfig[k] !== undefined) {
                this.configProxy[k] = newConfig[k];
            }
        });
    }
    destroy() {
        this.stopAll();
        this.ActiveInstances.clear();
        this.Cache.clear();
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }
}

/**
 * BGM - 背景音乐类
 * 支持多曲预加载、按 id 播放、淡入淡出、页面隐藏暂停/恢复
 */
const DEFAULT_FADE_MS$1 = 1000;
function resolveFadeMs$1(fade, explicit) {
    if (explicit !== undefined && explicit > 0)
        return explicit;
    if (fade)
        return DEFAULT_FADE_MS$1;
    return 0;
}
class BGM {
    constructor(options = {}) {
        this.Config = {
            loop: true,
            volume: 1,
            rate: 1,
            fade: false,
            preload: false,
            stopOnHidden: false,
            enable: true,
        };
        this.Cache = new Map();
        this.audio = null;
        this.currentId = null;
        this.fadeTimer = null;
        this.blocked = false;
        this.pausedByHidden = false;
        this.visibilityHandler = null;
        this.eventListeners = new Map();
        if (options.volume !== undefined) {
            this.Config.volume = Math.max(0, Math.min(1, options.volume));
        }
        if (options.rate !== undefined)
            this.Config.rate = options.rate;
        if (options.loop !== undefined)
            this.Config.loop = options.loop;
        if (options.stopOnHidden !== undefined) {
            this.Config.stopOnHidden = options.stopOnHidden;
        }
        if (options.preload !== undefined)
            this.Config.preload = options.preload;
        if (options.enable !== undefined)
            this.Config.enable = options.enable;
        this.Config.fadeIn = resolveFadeMs$1(options.fade, options.fadeIn);
        this.Config.fadeOut = resolveFadeMs$1(options.fade, options.fadeOut);
        this.configProxy = this.createConfigProxy();
        this.setupVisibilityHandler();
    }
    createConfigProxy() {
        return new Proxy(this.Config, {
            set: (target, prop, value) => {
                const oldValue = target[prop];
                target[prop] = value;
                // 处理配置变更
                this.handleConfigChange(prop, value, oldValue);
                return true;
            },
        });
    }
    handleConfigChange(key, newValue, oldValue) {
        if (newValue === oldValue)
            return;
        switch (key) {
            case "enable":
                if (newValue === false) {
                    this.clearFade();
                    this.stop();
                }
                break;
            case "volume":
                if (this.audio) {
                    this.audio.volume = Math.max(0, Math.min(1, newValue));
                    this.emit("volumechange", newValue);
                }
                break;
            case "rate":
                if (this.audio) {
                    this.audio.playbackRate = newValue;
                }
                break;
            case "loop":
                if (this.audio) {
                    this.audio.loop = newValue;
                }
                break;
            case "stopOnHidden":
                this.setupVisibilityHandler();
                break;
        }
    }
    setupVisibilityHandler() {
        // 清理旧的监听器
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        // 如果启用 stopOnHidden，设置新的监听器
        if (this.Config.stopOnHidden) {
            this.visibilityHandler = () => {
                if (document.hidden) {
                    this.blocked = true;
                    if (this.audio && !this.audio.paused) {
                        this.clearFade();
                        this.audio.pause();
                        this.pausedByHidden = true;
                    }
                }
                else {
                    this.blocked = false;
                    if (this.pausedByHidden && this.audio) {
                        this.pausedByHidden = false;
                        this.resumePlay();
                    }
                }
            };
            document.addEventListener("visibilitychange", this.visibilityHandler);
        }
    }
    load(id, src) {
        return __awaiter(this, void 0, void 0, function* () {
            // load 操作不受 enable 限制，允许预加载资源
            if (!this.Config.preload) {
                // 非预加载模式：仅缓存 src
                this.Cache.set(id, src);
                return;
            }
            return new Promise((resolve, reject) => {
                let audio = new Audio(src);
                this.Cache.set(id, src);
                const onLoad = () => {
                    audio = null;
                    resolve();
                };
                const onError = (e) => {
                    audio = null;
                    reject(e);
                };
                audio.addEventListener("canplaythrough", onLoad, { once: true });
                audio.addEventListener("error", onError, { once: true });
                audio.load();
            });
        });
    }
    play(id) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                return;
            }
            if (this.blocked)
                return;
            const src = this.Cache.get(id);
            if (!src)
                throw new Error(`BGM: "${id}" not found. Call load() first.`);
            if (this.currentId === id && this.audio && !this.audio.paused)
                return;
            if (this.audio && !this.audio.paused) {
                yield this.fadeOut();
                this.stopCurrent();
            }
            else if (this.audio) {
                this.stopCurrent();
            }
            this.audio = new Audio(src);
            this.audio.volume = this.Config.volume;
            this.audio.playbackRate = this.Config.rate;
            this.audio.loop = this.Config.loop;
            this.currentId = id;
            this.setupAudioEvents();
            this.pausedByHidden = false;
            yield this.fadeIn();
        });
    }
    pause() {
        if (!this.audio)
            return;
        this.clearFade();
        this.audio.pause();
    }
    resume() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                return;
            }
            if (this.blocked || !this.audio || !this.audio.paused)
                return;
            yield this.resumePlay();
        });
    }
    stop() {
        this.clearFade();
        this.stopCurrent();
        this.pausedByHidden = false;
    }
    get volume() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.volume) !== null && _b !== void 0 ? _b : this.Config.volume;
    }
    set volume(value) {
        const vol = Math.max(0, Math.min(1, value));
        this.Config.volume = vol;
        if (this.audio) {
            this.audio.volume = vol;
            this.emit("volumechange", vol);
        }
    }
    get rate() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.playbackRate) !== null && _b !== void 0 ? _b : this.Config.rate;
    }
    set rate(value) {
        this.Config.rate = value;
        if (this.audio)
            this.audio.playbackRate = value;
    }
    get loop() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.loop) !== null && _b !== void 0 ? _b : this.Config.loop;
    }
    set loop(value) {
        this.Config.loop = value;
        if (this.audio)
            this.audio.loop = value;
    }
    get currentTime() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.currentTime) !== null && _b !== void 0 ? _b : 0;
    }
    set currentTime(value) {
        if (this.audio)
            this.audio.currentTime = value;
    }
    get duration() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.duration) !== null && _b !== void 0 ? _b : 0;
    }
    get paused() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.paused) !== null && _b !== void 0 ? _b : true;
    }
    get playing() {
        return this.currentId;
    }
    get config() {
        return this.configProxy;
    }
    set config(newConfig) {
        Object.keys(newConfig).forEach((key) => {
            const k = key;
            if (newConfig[k] !== undefined) {
                this.configProxy[k] = newConfig[k];
            }
        });
    }
    on(event, listener) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event).add(listener);
    }
    off(event, listener) {
        var _a;
        (_a = this.eventListeners.get(event)) === null || _a === void 0 ? void 0 : _a.delete(listener);
    }
    destroy() {
        this.clearFade();
        this.stopCurrent();
        this.Cache.clear();
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        this.eventListeners.clear();
    }
    stopCurrent() {
        if (!this.audio)
            return;
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.src = "";
        this.audio.load();
        this.audio = null;
        this.currentId = null;
        this.emit("stop");
    }
    setupAudioEvents() {
        if (!this.audio)
            return;
        this.audio.addEventListener("play", () => this.emit("play"));
        this.audio.addEventListener("pause", () => this.emit("pause"));
        this.audio.addEventListener("ended", () => this.emit("ended"));
        this.audio.addEventListener("timeupdate", () => {
            if (!this.audio)
                return;
            this.emit("timeupdate", {
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
            });
        });
        this.audio.addEventListener("error", (e) => this.emit("error", e));
    }
    resumePlay() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.audio || this.blocked)
                return;
            try {
                if (this.Config.fadeIn > 0)
                    yield this.fadeIn();
                else
                    yield this.audio.play();
            }
            catch (error) {
                this.emit("error", error);
            }
        });
    }
    fadeIn() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.audio)
                return;
            this.clearFade();
            if (this.Config.fadeIn <= 0) {
                try {
                    yield this.audio.play();
                }
                catch (e) {
                    this.emit("error", e);
                    throw e;
                }
                return;
            }
            const target = this.Config.volume;
            this.audio.volume = 0;
            try {
                yield this.audio.play();
            }
            catch (e) {
                this.emit("error", e);
                throw e;
            }
            return new Promise((resolve) => {
                const step = target / (this.Config.fadeIn / 50);
                let vol = 0;
                this.fadeTimer = window.setInterval(() => {
                    if (!this.audio) {
                        this.clearFade();
                        resolve();
                        return;
                    }
                    vol += step;
                    if (vol >= target) {
                        this.audio.volume = target;
                        this.clearFade();
                        resolve();
                    }
                    else
                        this.audio.volume = vol;
                }, 50);
            });
        });
    }
    fadeOut() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.audio || this.Config.fadeOut <= 0)
                return;
            this.clearFade();
            const start = this.audio.volume;
            return new Promise((resolve) => {
                const step = start / (this.Config.fadeOut / 50);
                let vol = start;
                this.fadeTimer = window.setInterval(() => {
                    if (!this.audio) {
                        this.clearFade();
                        resolve();
                        return;
                    }
                    vol -= step;
                    if (vol <= 0) {
                        this.audio.volume = 0;
                        this.clearFade();
                        resolve();
                    }
                    else
                        this.audio.volume = vol;
                }, 50);
            });
        });
    }
    clearFade() {
        if (this.fadeTimer !== null) {
            clearInterval(this.fadeTimer);
            this.fadeTimer = null;
        }
    }
    emit(event, data) {
        var _a;
        (_a = this.eventListeners.get(event)) === null || _a === void 0 ? void 0 : _a.forEach((listener) => listener(data));
    }
}

// match `[12:30.1][12:30.2]`
const SQUARE_TAGS_REGEXP = /^(?:\s*\[[^\]]+\])+/;
// match `ti: The Title`
const INFO_REGEXP = /^\s*(\w+)\s*:(.*)$/;
// match `512:34.1`
const TIME_REGEXP = /^\s*(\d+)\s*:\s*(\d+(\s*[.:]\s*\d+)?)\s*$/;
// match `<12:30.1> word` (A2 extension) | `[12:30.1] word` (Foobar2000)
const ENHANCED_TAG_WORD_REGEXP = /[<[](\d+:\d+(?:\.\d+)?)[>\]]([^[<]*)/;
var LineType;
(function (LineType) {
    LineType["INVALID"] = "INVALID";
    LineType["INFO"] = "INFO";
    LineType["TIME"] = "TIME";
})(LineType || (LineType = {}));
function parseSquareTags(line) {
    line = line.trim();
    const matches = SQUARE_TAGS_REGEXP.exec(line);
    if (matches === null)
        return null;
    const tag = matches[0];
    const content = line.slice(tag.length);
    return {
        tags: tag.slice(1, -1).split(/\]\s*\[/),
        rawContent: content,
    };
}
function parseTimestamp(str) {
    var _a, _b;
    const matches = TIME_REGEXP.exec(str);
    if (!matches)
        return null;
    const minuteStr = (_a = matches[1]) !== null && _a !== void 0 ? _a : '0';
    const secondStr = (_b = matches[2]) !== null && _b !== void 0 ? _b : '0';
    const minutes = parseFloat(minuteStr);
    const seconds = parseFloat(secondStr.replace(/\s+/g, '').replace(':', '.'));
    return minutes * 60 + seconds;
}
function parseEnhancedWords(timestamps, rawContent) {
    const wordTimestamps = [];
    let stripContent = '';
    let stripIndex = 0;
    const pushContent = (timestamp, wordContent) => {
        if (!wordContent.trim())
            return;
        if (stripContent.endsWith(' ') && wordContent.startsWith(' ')) {
            wordContent = wordContent.trimStart();
        }
        stripContent += wordContent;
        wordTimestamps.push({
            timestamp,
            content: wordContent,
        });
    };
    const firstTimestamp = timestamps[timestamps.length - 1];
    if (!firstTimestamp)
        return null;
    const firstMatches = ENHANCED_TAG_WORD_REGEXP.exec(rawContent);
    const firstContent = firstMatches
        ? rawContent.slice(0, firstMatches.index)
        : rawContent;
    pushContent(firstTimestamp, firstContent);
    if (firstMatches)
        while (stripIndex < rawContent.length) {
            const wordMatches = ENHANCED_TAG_WORD_REGEXP.exec(rawContent.slice(stripIndex));
            if (!wordMatches)
                break;
            stripIndex += wordMatches.index + wordMatches[0].length;
            const timestamp = parseTimestamp(wordMatches[1]);
            if (timestamp === null)
                continue;
            const wordContent = wordMatches[2];
            pushContent(timestamp, wordContent);
        }
    return {
        type: LineType.TIME,
        timestamps,
        content: stripContent.trim(),
        rawContent,
        wordTimestamps,
    };
}
function parseTime(tags, rawContent, { enhanced = true } = {}) {
    const timestamps = tags
        .map((tag) => parseTimestamp(tag))
        .filter((it) => it !== null);
    rawContent = rawContent.trim();
    if (enhanced) {
        const parsedWords = parseEnhancedWords(timestamps, rawContent);
        if (parsedWords)
            return parsedWords;
    }
    return {
        type: LineType.TIME,
        timestamps,
        rawContent,
        content: rawContent,
    };
}
function parseInfo(tag) {
    var _a, _b;
    const matches = INFO_REGEXP.exec(tag);
    if (!matches)
        return null;
    const key = (_a = matches[1]) !== null && _a !== void 0 ? _a : '';
    const value = (_b = matches[2]) !== null && _b !== void 0 ? _b : '';
    return {
        type: LineType.INFO,
        key: key.trim(),
        value: value.trim(),
    };
}
const parseLineInner = (line, options) => {
    const parsedTags = parseSquareTags(line);
    if (!parsedTags)
        return null;
    const { tags, rawContent } = parsedTags;
    const firstTag = tags[0];
    if (!firstTag)
        return null;
    if (TIME_REGEXP.test(firstTag)) {
        return parseTime(tags, rawContent, options);
    }
    else {
        return parseInfo(firstTag);
    }
};
/**
 * line parse lrc of timestamp
 * @example
 * const lp = parseLine('[ti: Song title]')
 * lp.type === LineParser.TYPE.INFO
 * lp.key === 'ti'
 * lp.value === 'Song title'
 *
 * const lp = parseLine('[10:10.10]hello')
 * lp.type === LineParser.TYPE.TIME
 * lp.timestamps === [10*60+10.10]
 * lp.content === 'hello'
 *
 * const lp = parseLine('[10:10.10] <10:10.12> hello <10:11.02> world')
 * lp.type === LineParser.TYPE.TIME
 * lp.timestamps === [10*60+10.10]
 * lp.content === 'hello world'
 * lp.wordTimestamps === [
 *  { timestamp: 10*60+10.12, content: 'hello' },
 *  { timestamp: 10*60+11.02, content: 'world' }
 * ]
 */
function parseLine(line, options) {
    const result = parseLineInner(line, options);
    return result
        ? result
        : {
            type: LineType.INVALID,
        };
}

function padStartZero2(num) {
    return num.toString().padStart(2, '0');
}
/**
 * get lrc time string
 * @example
 * Lrc.timestampToString(143.54)
 * // return '02:23.54':
 * @param timestamp second timestamp
 */
function timestampToString(timestamp) {
    const minutes = Math.floor(timestamp / 60);
    const secondsFraction = timestamp % 60;
    const seconds = Math.floor(secondsFraction);
    const fraction = Math.round((secondsFraction - seconds) * 100);
    return `${padStartZero2(minutes)}:${padStartZero2(seconds)}.${fraction.toString().padEnd(2, '0')}`;
}
class Lrc {
    constructor() {
        this.info = {};
        this.lyrics = [];
        this.plain = '';
    }
    /**
     * parse lrc text and return a Lrc object
     */
    static parse(text, options) {
        const lyrics = [];
        const info = {};
        let plain = '';
        const lines = text.split(/\r\n|[\n\r]/g).map((line) => {
            return parseLine(line, options);
        });
        for (const line of lines) {
            switch (line.type) {
                case LineType.INFO:
                    info[line.key] = line.value;
                    break;
                case LineType.TIME:
                    for (const timestamp of line.timestamps) {
                        lyrics.push({
                            timestamp,
                            wordTimestamps: line.wordTimestamps,
                            rawContent: line.rawContent,
                            content: line.content,
                        });
                        plain += `${line.content}\n`;
                    }
                    break;
            }
        }
        const lrc = new this();
        lrc.lyrics = lyrics;
        lrc.info = info;
        lrc.plain = plain;
        return lrc;
    }
    offset(offsetTime) {
        for (const lyric of this.lyrics) {
            lyric.timestamp += offsetTime;
            if (lyric.timestamp < 0) {
                lyric.timestamp = 0;
            }
        }
    }
    clone() {
        function clonePlainObject(obj) {
            return JSON.parse(JSON.stringify(obj));
        }
        const lrc = new Lrc();
        lrc.info = clonePlainObject(this.info);
        lrc.lyrics = clonePlainObject(this.lyrics);
        return lrc;
    }
    /**
     * get lrc text
     * @param opts.combine lyrics combine by same content
     * @param opts.sort lyrics sort by timestamp
     * @param opts.lineFormat newline format
     */
    toString({ combine = true, lineFormat = '\r\n', sort = true, } = {}) {
        const lines = [];
        // generate info
        for (const [key, value] of Object.entries(this.info)) {
            lines.push(`[${key}:${value}]`);
        }
        if (combine) {
            const lyricsMap = new Map();
            const lyricsList = [];
            // uniqueness
            for (const lyric of this.lyrics) {
                const existLyric = lyricsMap.get(lyric.rawContent);
                if (existLyric) {
                    existLyric[0].push(lyric.timestamp);
                }
                else {
                    lyricsMap.set(lyric.rawContent, [
                        [lyric.timestamp],
                        lyric.rawContent,
                    ]);
                }
            }
            // sorted
            for (const [content, value] of lyricsMap.entries()) {
                lyricsList.push({
                    timestamps: value[0],
                    rawContent: value[1],
                    content,
                });
            }
            if (sort) {
                lyricsList.sort((a, b) => { var _a, _b; return ((_a = a.timestamps[0]) !== null && _a !== void 0 ? _a : 0) - ((_b = b.timestamps[0]) !== null && _b !== void 0 ? _b : 0); });
            }
            // generate lyrics
            for (const lyric of lyricsList) {
                lines.push(`[${lyric.timestamps
                    .map((timestamp) => timestampToString(timestamp))
                    .join('][')}]${lyric.rawContent || ''}`);
            }
        }
        else {
            for (const lyric of this.lyrics) {
                lines.push(`[${timestampToString(lyric.timestamp)}]${lyric.content || ''}`);
            }
        }
        return lines.join(lineFormat);
    }
}

/**
 * Music - 音乐数据类
 * 表示单个音乐项，包含元数据和歌词（纯数据，歌词懒加载）
 */
class Music {
    constructor(src, metadata = {}, lrcUrl = null) {
        this.lyrics = [];
        this.lrcLoaded = false;
        this.lrcLoading = false;
        this.src = src;
        this.metadata = metadata;
        this.lrcUrl = lrcUrl;
        this.metadataProxy = this.createMetadataProxy();
        if (this.metadata.lrc) {
            if (Music.isURL(this.metadata.lrc)) {
                if (!this.lrcUrl) {
                    this.lrcUrl = this.metadata.lrc;
                }
            }
            else {
                this.lyrics = Music.parseLyrics(this.metadata.lrc);
                this.lrcLoaded = true;
            }
        }
    }
    static isURL(str) {
        try {
            new URL(str);
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    createMetadataProxy() {
        return new Proxy(this.metadata, {
            set: (target, prop, value) => {
                target[prop] = value;
                if (prop === "lrc") {
                    if (value) {
                        if (Music.isURL(value)) {
                            this.lrcUrl = value;
                            this.lrcLoaded = false;
                            this.lyrics = [];
                        }
                        else {
                            this.lyrics = Music.parseLyrics(value);
                            this.lrcLoaded = true;
                        }
                    }
                    else {
                        this.lrcUrl = null;
                        this.lrcLoaded = false;
                        this.lyrics = [];
                    }
                }
                return true;
            },
        });
    }
    get url() {
        return this.src;
    }
    get meta() {
        return this.metadataProxy;
    }
    set meta(data) {
        Object.keys(data).forEach((key) => {
            const k = key;
            if (data[k] !== undefined) {
                this.metadataProxy[k] = data[k];
            }
        });
    }
    /**
     * 懒加载歌词，播放时调用，已加载则直接返回
     */
    loadLyrics() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.lrcLoaded || this.lrcLoading)
                return;
            let urlToFetch = null;
            if (this.lrcUrl) {
                urlToFetch = this.lrcUrl;
            }
            else if (this.metadata.lrc && Music.isURL(this.metadata.lrc)) {
                urlToFetch = this.metadata.lrc;
                this.lrcUrl = urlToFetch;
            }
            if (!urlToFetch)
                return;
            this.lrcLoading = true;
            try {
                const text = yield fetch(urlToFetch).then((r) => r.text());
                this.lyrics = Music.parseLyrics(text);
                this.lrcLoaded = true;
            }
            catch (_a) {
                // Silently fail if lyrics cannot be fetched
            }
            finally {
                this.lrcLoading = false;
            }
        });
    }
    getLyrics() {
        return [...this.lyrics];
    }
    getLyricAt(time) {
        if (this.lyrics.length === 0)
            return null;
        let index = -1;
        for (let i = 0; i < this.lyrics.length; i++) {
            if (time >= this.lyrics[i].time)
                index = i;
            else
                break;
        }
        return index >= 0 ? this.lyrics[index] : null;
    }
    get hasLyrics() {
        return this.lyrics.length > 0;
    }
    get lyricsReady() {
        return this.lrcLoaded;
    }
    static parseLyrics(text) {
        try {
            const lrc = Lrc.parse(text);
            return lrc.lyrics.map((line) => ({
                time: line.timestamp,
                text: line.content,
            }));
        }
        catch (_a) {
            return [];
        }
    }
}

/**
 * WebAudioKit - Type Definitions
 */
/**
 * 播放模式
 */
var PlayMode;
(function (PlayMode) {
    PlayMode["LOOP"] = "loop";
    PlayMode["SHUFFLE"] = "shuffle";
    PlayMode["SINGLE"] = "single";
    PlayMode["SEQUENTIAL"] = "sequential";
})(PlayMode || (PlayMode = {}));
/**
 * 播放状态
 */
var PlayState;
(function (PlayState) {
    PlayState["PLAYING"] = "playing";
    PlayState["PAUSED"] = "paused";
    PlayState["STOPPED"] = "stopped";
    PlayState["LOADING"] = "loading";
    PlayState["ERROR"] = "error";
})(PlayState || (PlayState = {}));

/**
 * MusicPlayer - 音乐播放器类
 * 管理播放列表，支持多种播放模式、页面隐藏暂停/恢复
 */
const DEFAULT_FADE_MS = 1000;
function resolveFadeMs(fade, explicit) {
    if (explicit !== undefined && explicit > 0)
        return explicit;
    if (fade)
        return DEFAULT_FADE_MS;
    return 0;
}
class MusicPlayer {
    constructor(options = {}) {
        this.Config = {
            volume: 1,
            rate: 1,
            loop: false,
            fade: false,
            stopOnHidden: false,
            preload: true,
            mode: PlayMode.SEQUENTIAL,
            enable: true,
        };
        this.audio = null;
        this.eventListeners = new Map();
        this._state = PlayState.STOPPED;
        this.lyricIndex = -1;
        this.playlist = [];
        this.index = -1;
        this.shuffleOrder = [];
        this.blocked = false;
        this.pausedByHidden = false;
        this.visibilityHandler = null;
        this.fadeTimer = null;
        this.preloadAudio = null;
        this.preloadSrc = null;
        if (options.volume !== undefined) {
            this.Config.volume = Math.max(0, Math.min(1, options.volume));
        }
        if (options.rate !== undefined)
            this.Config.rate = options.rate;
        if (options.loop !== undefined)
            this.Config.loop = options.loop;
        if (options.mode !== undefined)
            this.Config.mode = options.mode;
        if (options.enable !== undefined)
            this.Config.enable = options.enable;
        this.Config.fadeIn = resolveFadeMs(options.fade, options.fadeIn);
        this.Config.fadeOut = resolveFadeMs(options.fade, options.fadeOut);
        if (options.preload !== undefined)
            this.Config.preload = options.preload;
        if (options.stopOnHidden !== undefined) {
            this.Config.stopOnHidden = options.stopOnHidden;
        }
        this.configProxy = this.createConfigProxy();
        this.setupVisibilityHandler();
    }
    createConfigProxy() {
        return new Proxy(this.Config, {
            set: (target, prop, value) => {
                const oldValue = target[prop];
                target[prop] = value;
                // 处理配置变更
                this.handleConfigChange(prop, value, oldValue);
                return true;
            },
        });
    }
    handleConfigChange(key, newValue, oldValue) {
        if (newValue === oldValue)
            return;
        switch (key) {
            case "enable":
                if (newValue === false) {
                    this.clearFade();
                    this.stop();
                }
                break;
            case "volume":
                if (this.audio) {
                    this.audio.volume = Math.max(0, Math.min(1, newValue));
                    this.emit("volumechange", newValue);
                }
                break;
            case "rate":
                if (this.audio) {
                    this.audio.playbackRate = newValue;
                }
                break;
            case "loop":
                if (this.audio) {
                    this.audio.loop = newValue;
                }
                break;
            case "mode":
                if (newValue === PlayMode.SHUFFLE) {
                    this.rebuildShuffle();
                }
                break;
            case "stopOnHidden":
                this.setupVisibilityHandler();
                break;
        }
    }
    setupVisibilityHandler() {
        // 清理旧的监听器
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        // 如果启用 stopOnHidden，设置新的监听器
        if (this.Config.stopOnHidden) {
            this.visibilityHandler = () => {
                if (document.hidden) {
                    this.blocked = true;
                    if (this.audio && !this.audio.paused) {
                        this.audio.pause();
                        this.pausedByHidden = true;
                    }
                }
                else {
                    this.blocked = false;
                    if (this.pausedByHidden && this.audio) {
                        this.pausedByHidden = false;
                        this.audio.play().catch((e) => this.emit("error", e));
                    }
                }
            };
            document.addEventListener("visibilitychange", this.visibilityHandler);
        }
    }
    // ==================== 播放列表管理 ====================
    add(music) {
        this.playlist.push(music);
        if (this.index === -1)
            this.index = 0;
        this.rebuildShuffle();
        this.emit("playlistchange");
    }
    addList(musicList) {
        this.playlist.push(...musicList);
        if (this.index === -1 && this.playlist.length > 0)
            this.index = 0;
        this.rebuildShuffle();
        this.emit("playlistchange");
    }
    addFromMeting(data) {
        return __awaiter(this, void 0, void 0, function* () {
            const musicList = data.map((item) => {
                var _a, _b, _c, _d, _e, _f;
                const metadata = {
                    title: (_a = item.name) !== null && _a !== void 0 ? _a : item.title,
                    artist: (_b = item.artist) !== null && _b !== void 0 ? _b : item.author,
                    album: (_c = item.album) !== null && _c !== void 0 ? _c : "",
                    cover: (_d = item.pic) !== null && _d !== void 0 ? _d : item.cover,
                };
                // 只存歌词 URL，播放时懒加载
                const lrcUrl = (_f = (_e = item.lrc) !== null && _e !== void 0 ? _e : item.lyric) !== null && _f !== void 0 ? _f : null;
                return new Music(item.url, metadata, lrcUrl);
            });
            this.addList(musicList);
        });
    }
    remove(idx) {
        if (idx < 0 || idx >= this.playlist.length)
            return;
        this.playlist.splice(idx, 1);
        if (this.index >= this.playlist.length) {
            this.index = this.playlist.length - 1;
        }
        this.rebuildShuffle();
        this.emit("playlistchange");
    }
    clear() {
        this.stop();
        this.playlist = [];
        this.index = -1;
        this.shuffleOrder = [];
        this.emit("playlistchange");
    }
    // ==================== 播放控制 ====================
    play(idx) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                return;
            }
            if (this.blocked)
                return;
            if (idx !== undefined) {
                yield this.loadAt(idx);
                return;
            }
            // 没有 audio 实例时，加载当前 index
            if (!this.audio) {
                if (this.playlist.length === 0 || this.index < 0) {
                    throw new Error("No music to play");
                }
                yield this.loadAt(this.index);
                return;
            }
            try {
                yield this.audio.play();
            }
            catch (error) {
                this._state = PlayState.ERROR;
                this.emit("error", error);
                throw error;
            }
        });
    }
    pause() {
        if (!this.audio)
            return;
        this.clearFade();
        this.pausedByHidden = false;
        this.audio.pause();
    }
    stop() {
        if (!this.audio)
            return;
        this.clearFade();
        this.pausedByHidden = false;
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.src = "";
        this.audio.load();
        this._state = PlayState.STOPPED;
        this.emit("stop");
    }
    playNext() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                return;
            }
            const nextIdx = this.resolveNext();
            if (nextIdx === null)
                return;
            yield this.loadAt(nextIdx);
        });
    }
    playPrev() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                return;
            }
            const prevIdx = this.resolvePrev();
            if (prevIdx === null)
                return;
            yield this.loadAt(prevIdx);
        });
    }
    // ==================== 内部加载 ====================
    loadAt(idx) {
        return __awaiter(this, void 0, void 0, function* () {
            if (idx < 0 || idx >= this.playlist.length) {
                throw new Error("Invalid music index");
            }
            const music = this.playlist[idx];
            // 淡出并清理旧实例
            if (this.audio && !this.audio.paused) {
                yield this.execFadeOut(this.audio);
            }
            if (this.audio) {
                this.audio.pause();
                this.audio.src = "";
                this.audio = null;
            }
            // 复用预加载的 audio（如果 src 匹配）
            if (this.preloadAudio && this.preloadSrc === music.url) {
                this.audio = this.preloadAudio;
                this.preloadAudio = null;
                this.preloadSrc = null;
            }
            else {
                // 丢弃不匹配的预加载
                if (this.preloadAudio) {
                    this.preloadAudio.src = "";
                    this.preloadAudio = null;
                    this.preloadSrc = null;
                }
                this.audio = new Audio(music.url);
            }
            this.audio.volume = this.Config.volume;
            this.audio.playbackRate = this.Config.rate;
            this.audio.loop = this.Config.loop;
            this.index = idx;
            this.lyricIndex = -1;
            this._state = PlayState.LOADING;
            this.setupEvents();
            this.emit("musicchange", music);
            // 歌词懒加载，不阻塞播放
            music.loadLyrics().catch(() => { });
            if (!this.blocked && this.Config.enable) {
                try {
                    yield this.execFadeIn(this.audio);
                }
                catch (error) {
                    this._state = PlayState.ERROR;
                    this.emit("error", error);
                    throw error;
                }
            }
            // 预加载下一首
            if (this.Config.preload)
                this.preloadNext();
        });
    }
    setupEvents() {
        if (!this.audio)
            return;
        this.audio.addEventListener("play", () => {
            this._state = PlayState.PLAYING;
            this.emit("play");
        });
        this.audio.addEventListener("pause", () => {
            this._state = PlayState.PAUSED;
            this.emit("pause");
        });
        this.audio.addEventListener("ended", () => {
            this.emit("ended");
            this.handleEnded();
        });
        this.audio.addEventListener("timeupdate", () => {
            if (!this.audio)
                return;
            this.emit("timeupdate", {
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
            });
            this.updateLyric();
        });
        this.audio.addEventListener("error", (e) => {
            this._state = PlayState.ERROR;
            this.emit("error", e);
        });
    }
    handleEnded() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.Config.enable) {
                this._state = PlayState.STOPPED;
                this.emit("stop");
                return;
            }
            const nextIdx = this.resolveNext();
            if (nextIdx !== null) {
                yield this.loadAt(nextIdx);
            }
            else {
                this._state = PlayState.STOPPED;
                this.emit("stop");
            }
        });
    }
    /** 预加载下一首的音频、封面图片和歌词 */
    preloadNext() {
        const nextIdx = this.resolveNext();
        if (nextIdx === null || nextIdx === this.index)
            return;
        const next = this.playlist[nextIdx];
        if (!next)
            return;
        // 避免重复预加载同一首
        if (this.preloadSrc === next.url)
            return;
        // 清理旧的预加载
        if (this.preloadAudio) {
            this.preloadAudio.src = "";
            this.preloadAudio = null;
        }
        // 预加载音频
        this.preloadSrc = next.url;
        this.preloadAudio = new Audio();
        this.preloadAudio.preload = "auto";
        this.preloadAudio.src = next.url;
        this.preloadAudio.volume = 0;
        this.preloadAudio.load();
        // 预加载封面
        const cover = next.meta.cover;
        if (cover) {
            const img = new Image();
            img.src = cover;
        }
        // 预加载歌词
        next.loadLyrics().catch(() => { });
    }
    // ==================== 播放顺序计算（无副作用） ====================
    /**
     * 计算下一首的 index，不修改 this.index
     */
    resolveNext() {
        if (this.playlist.length === 0)
            return null;
        switch (this.Config.mode) {
            case PlayMode.SINGLE:
                return this.index;
            case PlayMode.SHUFFLE: {
                const pos = this.shuffleOrder.indexOf(this.index);
                return this.shuffleOrder[(pos + 1) % this.shuffleOrder.length];
            }
            case PlayMode.LOOP:
                return (this.index + 1) % this.playlist.length;
            case PlayMode.SEQUENTIAL:
                return this.index < this.playlist.length - 1 ? this.index + 1 : null;
            default:
                return null;
        }
    }
    /**
     * 计算上一首的 index，不修改 this.index
     */
    resolvePrev() {
        if (this.playlist.length === 0)
            return null;
        switch (this.Config.mode) {
            case PlayMode.SINGLE:
                return this.index;
            case PlayMode.SHUFFLE: {
                const pos = this.shuffleOrder.indexOf(this.index);
                return this
                    .shuffleOrder[pos === 0 ? this.shuffleOrder.length - 1 : pos - 1];
            }
            case PlayMode.LOOP:
                return this.index === 0 ? this.playlist.length - 1 : this.index - 1;
            case PlayMode.SEQUENTIAL:
                return this.index > 0 ? this.index - 1 : null;
            default:
                return null;
        }
    }
    rebuildShuffle() {
        this.shuffleOrder = Array.from({ length: this.playlist.length }, (_, i) => i);
        for (let i = this.shuffleOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffleOrder[i], this.shuffleOrder[j]] = [
                this.shuffleOrder[j],
                this.shuffleOrder[i],
            ];
        }
    }
    updateLyric() {
        const music = this.current;
        if (!music || !music.hasLyrics)
            return;
        const lyrics = music.getLyrics();
        const time = this.currentTime;
        let newIndex = -1;
        for (let i = 0; i < lyrics.length; i++) {
            if (time >= lyrics[i].time)
                newIndex = i;
            else
                break;
        }
        if (newIndex !== this.lyricIndex) {
            this.lyricIndex = newIndex;
            this.emit("lyricchange", this.lyric);
        }
    }
    // ==================== Getters & Setters ====================
    get audioElement() {
        return this.audio;
    }
    get volume() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.volume) !== null && _b !== void 0 ? _b : this.Config.volume;
    }
    set volume(value) {
        const vol = Math.max(0, Math.min(1, value));
        this.Config.volume = vol;
        if (this.audio) {
            this.audio.volume = vol;
            this.emit("volumechange", vol);
        }
    }
    get rate() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.playbackRate) !== null && _b !== void 0 ? _b : this.Config.rate;
    }
    set rate(value) {
        this.Config.rate = value;
        if (this.audio)
            this.audio.playbackRate = value;
    }
    get loop() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.loop) !== null && _b !== void 0 ? _b : this.Config.loop;
    }
    set loop(value) {
        this.Config.loop = value;
        if (this.audio)
            this.audio.loop = value;
    }
    get currentTime() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.currentTime) !== null && _b !== void 0 ? _b : 0;
    }
    set currentTime(value) {
        if (this.audio)
            this.audio.currentTime = value;
    }
    get duration() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.duration) !== null && _b !== void 0 ? _b : 0;
    }
    get paused() {
        var _a, _b;
        return (_b = (_a = this.audio) === null || _a === void 0 ? void 0 : _a.paused) !== null && _b !== void 0 ? _b : true;
    }
    get state() {
        return this._state;
    }
    get progress() {
        return this.duration > 0 ? this.currentTime / this.duration : 0;
    }
    set progress(value) {
        this.currentTime = value * this.duration;
    }
    get current() {
        return this.index >= 0 && this.index < this.playlist.length
            ? this.playlist[this.index]
            : null;
    }
    get(idx) {
        return idx >= 0 && idx < this.playlist.length ? this.playlist[idx] : null;
    }
    getAll() {
        return [...this.playlist];
    }
    get length() {
        return this.playlist.length;
    }
    get currentIndex() {
        return this.index;
    }
    set currentIndex(value) {
        if (value >= 0 && value < this.playlist.length)
            this.index = value;
    }
    get playMode() {
        return this.Config.mode;
    }
    set playMode(value) {
        this.Config.mode = value;
        if (value === PlayMode.SHUFFLE)
            this.rebuildShuffle();
    }
    get config() {
        return this.configProxy;
    }
    set config(newConfig) {
        Object.keys(newConfig).forEach((key) => {
            const k = key;
            if (newConfig[k] !== undefined) {
                this.configProxy[k] = newConfig[k];
            }
        });
    }
    get lyric() {
        const music = this.current;
        if (!music)
            return null;
        const lyrics = music.getLyrics();
        return this.lyricIndex >= 0 && this.lyricIndex < lyrics.length
            ? lyrics[this.lyricIndex]
            : null;
    }
    getLyrics() {
        var _a, _b;
        return (_b = (_a = this.current) === null || _a === void 0 ? void 0 : _a.getLyrics()) !== null && _b !== void 0 ? _b : [];
    }
    // ==================== Events ====================
    on(event, listener) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event).add(listener);
    }
    off(event, listener) {
        var _a;
        (_a = this.eventListeners.get(event)) === null || _a === void 0 ? void 0 : _a.delete(listener);
    }
    emit(event, data) {
        var _a;
        (_a = this.eventListeners.get(event)) === null || _a === void 0 ? void 0 : _a.forEach((listener) => listener(data));
    }
    destroy() {
        this.clearFade();
        this.stop();
        if (this.audio) {
            this.audio.src = "";
            this.audio.load();
            this.audio = null;
        }
        if (this.preloadAudio) {
            this.preloadAudio.src = "";
            this.preloadAudio = null;
            this.preloadSrc = null;
        }
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
        this.eventListeners.clear();
        this.playlist = [];
        this.index = -1;
    }
    clearFade() {
        if (this.fadeTimer !== null) {
            clearInterval(this.fadeTimer);
            this.fadeTimer = null;
        }
    }
    execFadeIn(audio) {
        return __awaiter(this, void 0, void 0, function* () {
            this.clearFade();
            if (this.Config.fadeIn <= 0) {
                yield audio.play();
                return;
            }
            const target = this.Config.volume;
            audio.volume = 0;
            yield audio.play();
            return new Promise((resolve) => {
                const step = target / (this.Config.fadeIn / 50);
                let vol = 0;
                this.fadeTimer = window.setInterval(() => {
                    vol += step;
                    if (vol >= target) {
                        audio.volume = target;
                        this.clearFade();
                        resolve();
                    }
                    else
                        audio.volume = vol;
                }, 50);
            });
        });
    }
    execFadeOut(audio) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.Config.fadeOut <= 0)
                return;
            this.clearFade();
            const start = audio.volume;
            return new Promise((resolve) => {
                const step = start / (this.Config.fadeOut / 50);
                let vol = start;
                this.fadeTimer = window.setInterval(() => {
                    vol -= step;
                    if (vol <= 0) {
                        audio.volume = 0;
                        this.clearFade();
                        resolve();
                    }
                    else
                        audio.volume = vol;
                }, 50);
            });
        });
    }
}

export { BGM, Music, MusicPlayer, PlayMode, PlayState, SFX };
//# sourceMappingURL=index.js.map
