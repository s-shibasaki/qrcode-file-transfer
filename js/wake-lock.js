/**
 * 画面が暗くなる / スリープするのを防ぐための Screen Wake Lock ラッパ。
 *
 * - Wake Lock はタブが非表示になると OS 側から自動的に解除されるので、
 *   復帰時に取り直す必要がある。
 * - Secure context (https または localhost) でのみ利用できる。
 */

/** @type {WakeLockSentinel | null} */
let wakeLockSentinel = null;
/** ロックを保持したい状態かどうか。visibilitychange での取り直し判定に使う。 */
let wakeLockDesired = false;

const wakeLockStatusEl = document.querySelector('#wake-lock-status');

/**
 * @param {string} text
 */
function setWakeLockStatus(text) {
    if (wakeLockStatusEl) {
        wakeLockStatusEl.textContent = text;
    }
}

function isWakeLockSupported() {
    return 'wakeLock' in navigator;
}

async function acquireWakeLock() {
    if (!isWakeLockSupported()) {
        setWakeLockStatus('unsupported');
        return;
    }
    if (wakeLockSentinel !== null || document.visibilityState !== 'visible') {
        return;
    }
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        setWakeLockStatus('on');
        wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
            setWakeLockStatus(wakeLockDesired ? 'suspended' : 'off');
        });
    } catch (e) {
        // 電源設定などで拒否されることがある。転送自体は続けられるので握りつぶす。
        wakeLockSentinel = null;
        setWakeLockStatus(`failed (${e.name})`);
    }
}

async function releaseWakeLock() {
    if (wakeLockSentinel === null) {
        return;
    }
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    try {
        await sentinel.release();
    } catch (e) {
        // 既に解除済みの場合など。無視してよい。
    }
}

/**
 * 画面スリープ抑止の ON / OFF を切り替える。
 * @param {boolean} enabled
 */
function setKeepScreenAwake(enabled) {
    wakeLockDesired = enabled;
    if (enabled) {
        acquireWakeLock();
    } else {
        setWakeLockStatus(isWakeLockSupported() ? 'off' : 'unsupported');
        releaseWakeLock();
    }
}

document.addEventListener('visibilitychange', () => {
    if (wakeLockDesired && document.visibilityState === 'visible') {
        acquireWakeLock();
    }
});

setWakeLockStatus(isWakeLockSupported() ? 'off' : 'unsupported');
