/**
 * @param {HTMLDivElement} el
 * @param {number} progress
 * @param {string} frontColor
 * @param {string} backgroundColor
 */
function progressBarSetProgress(el, progress, frontColor, backgroundColor) {
    el.style.background = `linear-gradient(to right, ${frontColor} 0%, ${frontColor} ${progress * 100}%, ${backgroundColor} ${progress * 100}%, ${backgroundColor} 100%)`;
}

/**
 * @param {HTMLElement} el
 * @param {function (progress: number): void} callback
 */
function progressBarAddProgressListener(el, callback) {
    let isDown = false;
    const wrappedCallback = (eventType) => (e) => {
        if (eventType === 'pointerdown') {
            isDown = true;
            e.target.setPointerCapture(e.pointerId);
        } else if (eventType === 'pointerup' || eventType === 'pointercancel') {
            isDown = false;
        }
        if (isDown) {
            callback(Math.min(Math.max(e.clientX / el.clientWidth, 0), 1));
        }
    }
    el.addEventListener('pointerdown', wrappedCallback('pointerdown'));
    el.addEventListener('pointermove', wrappedCallback('pointermove'));
    el.addEventListener('pointerup', wrappedCallback('pointerup'));
    el.addEventListener('pointercancel', wrappedCallback('pointercancel'));
}

/**
 * @param {number[] | Uint8Array | Uint8ClampedArray} uint8Array
 * @param {number} typeNumber QR の型番 (1-40)。0 を渡すとデータ量から自動選択される
 * @param {'L' | 'M' | 'Q' | 'H'} errorCorrectionLevel
 * @returns {string}
 */
function createQrcodeDataUrl(uint8Array, typeNumber, errorCorrectionLevel) {
    qrcode.stringToBytesFuncs['buffer'] = (s) => s;
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['buffer'];
    const qr = qrcode(typeNumber, errorCorrectionLevel);
    qr.addData(uint8Array);
    qr.make();
    return qr.createDataURL();
}

/**
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result);
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * @param {number} blockIndex
 * @param {number} blockOffset
 * @param {Uint8ClampedArray} blockData
 * @returns {Uint8ClampedArray}
 */
function addBlockIndexHeader(blockIndex, blockOffset, blockData) {
    const buffer = new ArrayBuffer(8 + blockData.byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, blockIndex, true);
    view.setUint32(4, blockOffset, true);
    new Uint8ClampedArray(buffer, 8, blockData.byteLength).set(blockData);
    return new Uint8ClampedArray(buffer);
}

const JSON_stringify = (o) => JSON.stringify(o).replace(/[\u007F-\uFFFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * @param {string} fileName
 * @param {number} fileLength
 * @param {number} blockSize
 * @param {number} lastBlockIndex
 * @returns {string}
 */
function buildFileInfoJson(fileName, fileLength, blockSize, lastBlockIndex) {
    return JSON_stringify({
        fileName,
        fileLength,
        blockSize,
        lastBlockIndex,
    });
}

/**
 * @param {string} fileName
 * @param {number} fileLength
 * @param {number} blockSize
 * @param {number} lastBlockIndex
 * @returns {Uint8ClampedArray}
 */
function buildFileInfo(fileName, fileLength, blockSize, lastBlockIndex) {
    const s = buildFileInfoJson(fileName, fileLength, blockSize, lastBlockIndex);
    const uint8Array = new Uint8ClampedArray(blockSize);
    for (let i = 0; i < s.length; i++) {
        uint8Array[i] = s.codePointAt(i);
    }
    for (let i = s.length; i < blockSize; i++) {
        uint8Array[i] = ' '.codePointAt(0);
    }
    return uint8Array;
}

/**
 * @param {string} s "1,3,5-9" のような表現をインデックス配列に変換する
 * @param {number} lastBlockIndex
 * @returns {number[]}
 */
function parseBlockIndexList(s, lastBlockIndex) {
    const result = [];
    for (const part of s.split(/[,\s]+/)) {
        if (part === '') {
            continue;
        }
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) {
            continue;
        }
        const begin = parseInt(m[1]);
        const end = m[2] === undefined ? begin : parseInt(m[2]);
        for (let i = Math.min(begin, end); i <= Math.max(begin, end); i++) {
            if (i >= 0 && i <= lastBlockIndex) {
                result.push(i);
            }
        }
    }
    return result;
}

const progressBarEl = document.querySelector('#progress-bar');
const qrcodeEl = document.querySelector('#qrcode');
const currentBlockIndexEl = document.querySelector('#current-block-index');
const allBlockCountEl = document.querySelector('#all-block-count');
const startButtonEl = document.querySelector('#start-button');
const speedEl = document.querySelector('#speed');
const blockListEl = document.querySelector('#block-list');
const repeatFileInfoEl = document.querySelector('#repeat-file-info');
const blockSizeEl = document.querySelector('#block-size');
const errorCorrectionLevelEl = document.querySelector('#error-correction-level');
const qrcodeVersionEl = document.querySelector('#qrcode-version');
const qrcodeSizeEl = document.querySelector('#qrcode-size');

/** ヘッダ (blockIndex + blockOffset) の長さ */
const HEADER_SIZE = 8;
const MIN_QRCODE_VERSION = 1;
const MAX_QRCODE_VERSION = 40;

progressBarSetProgress(progressBarEl, 0, '#390', '#ccc');

/** 現在選択中のファイルの状態。ファイルを選び直すたびに丸ごと差し替える。 */
let session = null;
/** 進行中のタイマー。セッション切り替え時にキャンセルする。 */
let timerId = null;
let isRun = false;

function stopSending() {
    isRun = false;
    if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
    }
    startButtonEl.value = 'Start';
}

/**
 * QR の型番と誤り訂正レベルの入力を読み取り、有効範囲に収めて書き戻す。
 * @returns {{typeNumber: number, errorCorrectionLevel: 'L'|'M'|'Q'|'H', blockSize: number}}
 */
function readEncodingSettings() {
    let typeNumber = parseInt(qrcodeVersionEl.value);
    if (isNaN(typeNumber)) {
        typeNumber = MAX_QRCODE_VERSION;
    }
    typeNumber = Math.min(Math.max(typeNumber, MIN_QRCODE_VERSION), MAX_QRCODE_VERSION);
    qrcodeVersionEl.value = `${typeNumber}`;
    const errorCorrectionLevel = errorCorrectionLevelEl.value;
    // 型番と誤り訂正レベルで 1 フレームの容量が決まり、そこからヘッダを引いたものがブロックサイズ
    const blockSize = qrcode.getMaxDataBytes(typeNumber, errorCorrectionLevel) - HEADER_SIZE;
    return {typeNumber, errorCorrectionLevel, blockSize};
}

/**
 * QR の型番 / 誤り訂正レベルの変更を現在のセッションに反映する。
 */
function applyEncodingSettings() {
    stopSending();
    const settings = readEncodingSettings();
    blockSizeEl.textContent = `${settings.blockSize}`;
    qrcodeSizeEl.textContent = `${settings.typeNumber * 4 + 17}x${settings.typeNumber * 4 + 17}`;
    if (!session) {
        return;
    }
    // フレーム 0 のファイル情報 JSON が 1 フレームに収まらない型番は使えない
    const fileInfoLength = buildFileInfoJson(session.fileName, session.fileLength, settings.blockSize, 1).length;
    if (settings.blockSize < fileInfoLength) {
        blockSizeEl.textContent = `${settings.blockSize} (too small: file info needs ${fileInfoLength})`;
        return;
    }
    Object.assign(session, settings);
    session.lastBlockIndex = Math.ceil(session.fileLength / settings.blockSize);
    allBlockCountEl.textContent = `${session.lastBlockIndex}`;
    // ブロック境界が変わるので先頭から送り直す
    session.prevBlockIndex = null;
    setProgress(0);
}

/**
 * @param {number} blockIndex
 */
function setProgress(blockIndex) {
    if (!session || blockIndex === session.prevBlockIndex) {
        return;
    }
    const {fileName, fileData, fileLength, blockSize, lastBlockIndex, typeNumber, errorCorrectionLevel} = session;
    let buffer;
    if (blockIndex === 0) {
        buffer = addBlockIndexHeader(0, 0, buildFileInfo(fileName, fileLength, blockSize, lastBlockIndex));
    } else {
        const blockOffset = (blockIndex - 1) * blockSize;
        buffer = addBlockIndexHeader(blockIndex, blockOffset, new Uint8ClampedArray(fileData, blockOffset, Math.min(blockSize, fileLength - blockOffset)));
    }
    progressBarSetProgress(progressBarEl, blockIndex / lastBlockIndex, '#390', '#ccc');
    currentBlockIndexEl.value = `${blockIndex}`;
    qrcodeEl.src = createQrcodeDataUrl(buffer, typeNumber, errorCorrectionLevel);
    session.prevBlockIndex = blockIndex;
}

/**
 * 連続送出を開始する。Blocks 欄が空なら現在位置から末尾まで順送り、
 * 指定があればそのブロックだけを順に送る (再送)。
 */
function startSending() {
    if (!session) {
        return;
    }
    stopSending();
    let queue = parseBlockIndexList(blockListEl.value, session.lastBlockIndex);
    if (queue.length === 0) {
        queue = null;
    } else if (queue[0] !== 0) {
        // 受信側がファイル情報を持っていない場合に備えて先頭に 0 を入れる
        queue.unshift(0);
    }
    isRun = true;
    startButtonEl.value = 'Stop';
    // ファイル情報フレームを何ブロックおきに挟むか (0 なら挟まない)
    const repeatFileInfo = parseInt(repeatFileInfoEl.value);
    let sentCount = 0;

    const nextBlockIndex = () => {
        if (repeatFileInfo > 0 && sentCount > 0 && sentCount % repeatFileInfo === 0) {
            sentCount++;
            return 0;
        }
        sentCount++;
        if (queue) {
            return queue.length > 0 ? queue.shift() : null;
        }
        const next = session.prevBlockIndex + 1;
        return next <= session.lastBlockIndex ? next : null;
    };

    const onTimer = () => {
        timerId = null;
        if (!isRun) {
            return;
        }
        const blockIndex = nextBlockIndex();
        if (blockIndex === null) {
            stopSending();
            return;
        }
        // ファイル情報フレームを挟んだ直後は prevBlockIndex が 0 になるため、
        // 順送りモードでは元の位置を保持しておく。
        const resume = blockIndex === 0 && !queue ? session.prevBlockIndex : null;
        setProgress(blockIndex);
        if (resume !== null) {
            session.prevBlockIndex = resume;
        }
        const interval = parseInt(speedEl.value);
        timerId = setTimeout(onTimer, isNaN(interval) ? 100 : interval);
    };
    onTimer();
}

document.querySelector('#file-selector').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    stopSending();
    session = null;
    const fileName = file.name;
    readFile(file).then((fileData) => {
        session = {
            fileName,
            fileData,
            fileLength: fileData.byteLength,
            typeNumber: null,
            errorCorrectionLevel: null,
            blockSize: null,
            lastBlockIndex: null,
            prevBlockIndex: null,
        };
        applyEncodingSettings();
    });
});

qrcodeVersionEl.addEventListener('change', applyEncodingSettings);
errorCorrectionLevelEl.addEventListener('change', applyEncodingSettings);
applyEncodingSettings();

progressBarAddProgressListener(progressBarEl, (progress) => {
    if (!session) {
        return;
    }
    stopSending();
    setProgress(Math.min(Math.floor(progress * session.lastBlockIndex), session.lastBlockIndex));
});

currentBlockIndexEl.addEventListener('change', (e) => {
    if (!session) {
        return;
    }
    const blockIndex = parseInt(e.target.value);
    if (!isNaN(blockIndex) && blockIndex >= 0 && blockIndex <= session.lastBlockIndex) {
        stopSending();
        setProgress(blockIndex);
    }
});

startButtonEl.addEventListener('click', () => {
    if (isRun) {
        stopSending();
        return;
    }
    startSending();
});
