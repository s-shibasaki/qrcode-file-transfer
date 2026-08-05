/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number}} begin
 * @param {{x: number, y: number}} end
 */
function drawLine(ctx, begin, end) {
    ctx.beginPath();
    ctx.moveTo(begin.x, begin.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ff0000';
    ctx.stroke();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{location: {
 *   topLeftCorner: {x: number, y: number},
 *   topRightCorner: {x: number, y: number},
 *   topRightCorner: {x: number, y: number},
 *   bottomRightCorner: {x: number, y: number},
 *   bottomRightCorner: {x: number, y: number},
 *   bottomLeftCorner: {x: number, y: number},
 *   bottomLeftCorner: {x: number, y: number},
 *   topLeftCorner: {x: number, y: number},
 * }}} code
 */
function drawQrcodeRegion(ctx, code) {
    drawLine(ctx, code.location.topLeftCorner, code.location.topRightCorner);
    drawLine(ctx, code.location.topRightCorner, code.location.bottomRightCorner);
    drawLine(ctx, code.location.bottomRightCorner, code.location.bottomLeftCorner);
    drawLine(ctx, code.location.bottomLeftCorner, code.location.topLeftCorner);
}

/**
 * @param {ArrayBuffer} qrcodeBuffer
 * @returns {{
 * blockIndex: number,
 * blockOffset: number,
 * blockData: Uint8ClampedArray,
 * fileName?: string,
 * fileLength?: number,
 * blockSize?: number,
 * lastBlockIndex?: number,
 * }}
 */
function parseQRcodeBuffer(qrcodeBuffer) {
    const view = new DataView(qrcodeBuffer);
    const blockIndex = view.getUint32(0, true);
    const blockOffset = view.getUint32(4, true);
    const blockData = new Uint8ClampedArray(qrcodeBuffer, 8, qrcodeBuffer.byteLength - 8);
    if (blockIndex === 0) {
        const fileInfo = JSON.parse(Array.from(blockData).map(c => String.fromCodePoint(c)).join(''));
        return {
            blockIndex,
            blockOffset,
            blockData,
            fileName: fileInfo.fileName,
            fileLength: fileInfo.fileLength,
            blockSize: fileInfo.blockSize,
            lastBlockIndex: fileInfo.lastBlockIndex,
        };
    }
    return {
        blockIndex,
        blockOffset,
        blockData,
    };
}

/**
 * 欠損ブロックの集合を "3,7,10-15" のような連続範囲表現にまとめる。
 * @param {Set<number>} indexSet
 * @returns {string}
 */
function formatBlockIndexSet(indexSet) {
    const sorted = Array.from(indexSet).sort((a, b) => a - b);
    const parts = [];
    let begin = null;
    let prev = null;
    for (const i of sorted) {
        if (begin === null) {
            begin = prev = i;
        } else if (i === prev + 1) {
            prev = i;
        } else {
            parts.push(begin === prev ? `${begin}` : `${begin}-${prev}`);
            begin = prev = i;
        }
    }
    if (begin !== null) {
        parts.push(begin === prev ? `${begin}` : `${begin}-${prev}`);
    }
    return parts.join(',');
}

const video = document.createElement('video');
const progressBarCanvas = document.querySelector('#progress-bar');
const canvas = document.querySelector('#canvas');
document.body.append(canvas);
const progressBarCtx = progressBarCanvas.getContext('2d');
progressBarCtx.fillStyle = '#ccc';
progressBarCtx.fillRect(0, 0, progressBarCanvas.width, progressBarCanvas.height);
const ctx = canvas.getContext('2d', {willReadFrequently: true});
navigator.mediaDevices.getUserMedia({
    video: {
        facingMode: 'environment',
        width: 1920,
        height: 1080,
    }
}).then((stream) => {
    video.srcObject = stream;
    video.setAttribute('playsinline', true); // required to tell iOS safari we don't want fullscreen
    video.play();
    let fileName = 'file';
    let fileData = null;
    let blockCount = null;
    let remainingBlockIndexSet = null;
    let blockSize = null;

    const missingBlocksEl = document.querySelector('#missing-blocks');
    const updateMissingBlockList = () => {
        if (!remainingBlockIndexSet) {
            missingBlocksEl.textContent = '-';
            return;
        }
        missingBlocksEl.textContent = remainingBlockIndexSet.size === 0
            ? 'none (complete)'
            : formatBlockIndexSet(remainingBlockIndexSet);
    };
    updateMissingBlockList();

    const tick = () => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const t0 = Date.now();
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert',
            });
            const t1 = Date.now();
            if (code) {
                drawQrcodeRegion(ctx, code);
                if (code.binaryData.length > 8) {
                    const result = parseQRcodeBuffer(new Uint8ClampedArray(code.binaryData).buffer);
                    if (result.blockIndex === 0) {
                        // blockSize が変わるとブロック境界が変わるので受信済みデータは使えない
                        if (fileData === null || result.fileName !== fileName || result.fileLength !== fileData.byteLength || result.blockSize !== blockSize) {
                            fileName = result.fileName;
                            fileData = new Uint8ClampedArray(result.fileLength);
                            blockCount = result.lastBlockIndex;
                            blockSize = result.blockSize;
                            remainingBlockIndexSet = new Set();
                            for (let i = 1; i <= result.lastBlockIndex; i++) {
                                remainingBlockIndexSet.add(i);
                            }
                            document.querySelector('#file-name').textContent = `${result.fileName}`;
                            document.querySelector('#file-length').textContent = `${result.fileLength}`;
                            document.querySelector('#speed').textContent = `${t1 - t0}`;
                            document.querySelector('#finished-block-count').textContent = `1`;
                            document.querySelector('#all-block-count').textContent = `${blockCount}`;
                            progressBarCanvas.width = result.lastBlockIndex + 1;
                            progressBarCtx.fillStyle = '#ccc';
                            progressBarCtx.fillRect(0, 0, progressBarCanvas.width, progressBarCanvas.height);
                            progressBarCtx.fillStyle = '#390';
                            progressBarCtx.fillRect(result.blockIndex, 0, 1, 1);
                            updateMissingBlockList();
                        }
                    } else {
                        if (fileData && remainingBlockIndexSet.has(result.blockIndex)) {
                            // ファイル末尾のブロックは blockSize より短いので、はみ出さないよう切り詰める
                            const length = Math.min(result.blockData.length, fileData.byteLength - result.blockOffset);
                            if (length > 0) {
                                (new Uint8ClampedArray(fileData.buffer, result.blockOffset, length)).set(result.blockData.subarray(0, length));
                                remainingBlockIndexSet.delete(result.blockIndex);
                                document.querySelector('#finished-block-count').textContent = `${blockCount - remainingBlockIndexSet.size}`;
                                progressBarCtx.fillStyle = '#390';
                                progressBarCtx.fillRect(result.blockIndex, 0, 1, 1);
                                updateMissingBlockList();
                            }
                        }
                    }
                }
            }
        }
        requestAnimationFrame(tick);
    }
    tick();

    document.querySelector('#reset-button').addEventListener('click', () => {
        fileName = 'file';
        fileData = null;
        blockCount = null;
        remainingBlockIndexSet = null;
        blockSize = null;
        document.querySelector('#file-name').textContent = '';
        document.querySelector('#file-length').textContent = '';
        document.querySelector('#finished-block-count').textContent = '0';
        progressBarCtx.fillStyle = '#ccc';
        progressBarCtx.fillRect(0, 0, progressBarCanvas.width, progressBarCanvas.height);
        updateMissingBlockList();
    });
    document.querySelector('#copy-missing-button').addEventListener('click', () => {
        navigator.clipboard.writeText(missingBlocksEl.textContent);
    });
    document.querySelector('#download-button').addEventListener('click', () => {
        if (fileData) {
            const blob = new Blob([fileData], {type: 'application/octet-stream'});
            saveAs(blob, fileName);
        }
    });
});
