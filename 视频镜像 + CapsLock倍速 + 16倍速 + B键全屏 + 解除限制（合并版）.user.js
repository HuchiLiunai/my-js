// ==UserScript==
// @name         视频镜像 + CapsLock倍速 + 16倍速 + B键全屏 + 解除限制（合并版）
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  视频水平翻转（Home键控制按钮显隐）+ CapsLock倍速开关 + 扩展倍速菜单[0.25~16]  + B键全屏 + 解除20s/300s限制 个人使用
// @match        https://test.baidu.com/argus/plaza/*
// @grant        unsafeWindow
// @run-at       document-start
// @license All Rights Reserved
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 配置 & 状态
     * ============================================================ */
    const CONTAINER_ID = 'video-player';
    const VIDEO_ID     = 'video-player_html5_api';
    const STORAGE_KEY  = 'custom_playback_rate';
    const RE_REFS      = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;
    const WANTED_RATES = [0.25, 0.5, 1, 2, 3, 5, 10,12.5, 16];
    const FULLSCREEN_KEYS = new Set(['b', 'B']);

    // 镜像状态
    let flipEnabled = false;
    let uiVisible   = true;   // Home 键开关：仅控制翻转按钮显隐

    // 倍速状态
    let capsLockOn      = false;
    let savedRate       = parseFloat(localStorage.getItem(STORAGE_KEY)) || 1;
    let targetRate      = 1;
    let settingByScript = false;
    let rateListenerBound = false;
    let maintainTimer   = null;

    // 网络 / 页面切换
    let networkTimer  = null;
    let currentSrcKey = '';

    /* ============================================================
     * 工具
     * ============================================================ */
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    function getContainer() { return document.getElementById(CONTAINER_ID); }
    function getVideoEl() {
        return document.getElementById(VIDEO_ID)
            || (getContainer() && getContainer().querySelector('video'));
    }
    function getVideojsPlayer() {
        const c = getContainer();
        if (!c || !win.videojs) return null;
        try { return win.videojs.getPlayer(c); } catch (e) {}
        try { return win.videojs.getPlayer(CONTAINER_ID); } catch (e) {}
        return null;
    }
    function isEditable(t) {
        if (!t) return false;
        if (t.nodeName === 'INPUT' && ['text','number','password','email','search'].includes(t.type)) return true;
        if (t.nodeName === 'TEXTAREA') return true;
        if (t.isContentEditable) return true;
        return false;
    }

    /* ============================================================
     * 一、镜像翻转
     * ============================================================ */
    function applyFlip(video, enabled) {
        if (!video) return;
        if (enabled) {
            video.style.transform = 'scaleX(-1)';
            // 关键：让 video 不接收指针事件，避免拖动进度条时鼠标坐标被镜像
            video.style.pointerEvents = 'none';
        } else {
            video.style.transform = '';
            video.style.pointerEvents = '';
        }
    }

    function addFlipButton() {
        const container = getContainer();
        if (!container) { setTimeout(addFlipButton, 500); return; }
        if (container.querySelector('.vjs-flip-button')) return;

        const controlBar = container.querySelector('.vjs-control-bar');
        if (!controlBar) { setTimeout(addFlipButton, 500); return; }

        // 兜底：仅在翻转开启时接管点击播放/暂停
        if (!container.dataset.flipClickBound) {
            container.dataset.flipClickBound = '1';
            container.addEventListener('click', function (e) {
                if (!flipEnabled) return;
                if (e.target.closest('.vjs-control-bar')) return;
                const v = container.querySelector('video');
                if (!v) return;
                if (v.paused) v.play(); else v.pause();
            });
        }

        const button = document.createElement('button');
        button.className = 'vjs-flip-button vjs-control vjs-button';
        button.setAttribute('type', 'button');
        button.setAttribute('aria-disabled', 'false');
        button.title = '水平翻转';

        button.innerHTML = `<span class="vjs-icon-placeholder" aria-hidden="true">
            <svg focusable="false" data-icon="swap" width="20" height="20" fill="currentColor" aria-hidden="true" viewBox="64 64 896 896" style="display:block; vertical-align:middle;">
                <path d="M847.9 592H152c-4.4 0-8 3.6-8 8v60c0 4.4 3.6 8 8 8h605.2L612.9 851c-4.1 5.2-.4 13 6.3 13h72.5c4.9 0 9.5-2.2 12.6-6.1l168.8-214.1c16.5-21 1.6-51.8-25.2-51.8zM872 356H266.8l144.3-183c4.1-5.2.4-13-6.3-13h-72.5c-4.9 0-9.5 2.2-12.6 6.1L150.9 380.2c-16.5 21-1.6 51.8 25.1 51.8h696c4.4 0 8-3.6 8-8v-60c0-4.4-3.6-8-8-8z"></path>
            </svg>
        </span>`;

        button.addEventListener('click', function (e) {
            e.stopPropagation();
            const video = container.querySelector('video');
            if (!video) return;
            flipEnabled = !flipEnabled;
            applyFlip(video, flipEnabled);
            this.classList.toggle('vjs-flip-active');
        });

        if (!uiVisible) button.classList.add('vjs-flip-hidden');

        const fullscreenBtn = controlBar.querySelector('.vjs-fullscreen-control');
        if (fullscreenBtn) controlBar.insertBefore(button, fullscreenBtn);
        else controlBar.appendChild(button);

        if (!document.getElementById('__merged_video_flip_style')) {
            const style = document.createElement('style');
            style.id = '__merged_video_flip_style';
            style.textContent = `
    .vjs-flip-button.vjs-flip-active { color: #ffcc00 !important; }
    .vjs-flip-button.vjs-control {
        display: inline-block !important;
        vertical-align: top !important;
        height: 3em !important;
        width: 4em !important;
        position: relative !important;
    }
    .vjs-flip-button .vjs-icon-placeholder {
        position: absolute !important;
        top: 0 !important; left: 0 !important;
        width: 100% !important; height: 100% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        transform: translateY(6px);
    }
    .vjs-flip-button svg { width: 20px !important; height: 20px !important; display: block !important; }
    .vjs-flip-button.vjs-flip-hidden { display: none !important; }
`;
            document.head.appendChild(style);
        }
    }

    /* ============================================================
     * 二、倍速核心
     * ============================================================ */
    function applyPlaybackRate(rate) {
        if (rate === undefined) rate = capsLockOn ? savedRate : 1;
        targetRate = rate;

        const player = getVideojsPlayer();
        if (player && typeof player.playbackRate === 'function') {
            try { settingByScript = true; player.playbackRate(rate); }
            catch (e) {}
            finally { settingByScript = false; }
        }
        const video = getVideoEl();
        if (video && Math.abs(video.playbackRate - rate) > 0.001) {
            settingByScript = true;
            try { video.playbackRate = rate; } catch (e) {}
            settingByScript = false;
        }

        const display = document.querySelector('#' + CONTAINER_ID +
            ' .vjs-playback-rate .vjs-playback-rate-value');
        if (display) display.textContent = rate + 'x';

        syncMenuUI(rate);
    }

    function bindRateChange(target) {
        if (rateListenerBound || !target) return;
        const listener = function () {
            if (settingByScript) return;
            let newRate;
            if (target.tagName === 'VIDEO') newRate = target.playbackRate;
            else if (typeof target.playbackRate === 'function') newRate = target.playbackRate();
            else return;

            if (newRate === 1) {
                if (!capsLockOn) targetRate = 1;
                return;
            }
            if (Math.abs(newRate - savedRate) > 0.001) {
                savedRate = newRate;
                localStorage.setItem(STORAGE_KEY, String(savedRate));
            }
            if (capsLockOn) targetRate = newRate;
        };

        if (typeof target.on === 'function') target.on('ratechange', listener);
        else if (typeof target.addEventListener === 'function') target.addEventListener('ratechange', listener);
        else return;

        rateListenerBound = true;
    }

    function startMaintain() {
        if (maintainTimer) return;
        maintainTimer = setInterval(() => {
            const video = getVideoEl();
            if (!video || video.paused) return;
            if (Math.abs(video.playbackRate - targetRate) > 0.01) {
                applyPlaybackRate(targetRate);
            }
        }, 500);
    }

    /* ============================================================
     * 三、CapsLock
     * ============================================================ */
    function onCapsLockChanged() {
        applyPlaybackRate(capsLockOn ? savedRate : 1);
    }
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'CapsLock') return;
        setTimeout(() => {
            const s = e.getModifierState('CapsLock');
            if (s !== capsLockOn) {
                capsLockOn = s;
                win.__CAPSLOCK_ON__ = capsLockOn;
                onCapsLockChanged();
            }
        }, 50);
    });
    document.addEventListener('keyup', function (e) {
        if (e.key !== 'CapsLock') return;
        const s = e.getModifierState('CapsLock');
        if (s !== capsLockOn) {
            capsLockOn = s;
            win.__CAPSLOCK_ON__ = capsLockOn;
            onCapsLockChanged();
        }
    });

    /* ============================================================
     * 四、B / b 键全屏
     * ============================================================ */
    document.addEventListener('keydown', function (e) {
        if (!FULLSCREEN_KEYS.has(e.key)) return;
        if (isEditable(e.target)) return;
        const c = getContainer();
        if (!c) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
        else c.requestFullscreen().catch(()=>{});
    }, true);

    /* ============================================================
     * 五、扩展原生倍速菜单
     * ============================================================ */
    function getRateMenu() {
        const c = getContainer();
        return c ? c.querySelector('.vjs-playback-rate .vjs-menu-content') : null;
    }
    function parseRate(text) {
        const m = (text || '').match(/([\d.]+)\s*x/);
        return m ? parseFloat(m[1]) : null;
    }
    function syncMenuUI(rate) {
        const menu = getRateMenu();
        if (!menu) return;
        Array.from(menu.children).forEach(li => {
            const cr = parseRate(li.textContent);
            const sel = cr !== null && Math.abs(cr - rate) < 1e-3;
            li.setAttribute('aria-checked', sel ? 'true' : 'false');
            li.classList.toggle('vjs-selected', sel);
        });
    }
    function closeMenu() {
        const c = getContainer();
        if (!c) return;
        const btn = c.querySelector('.vjs-playback-rate');
        if (btn) btn.classList.remove('vjs-menu-button-active');
        const m = c.querySelector('.vjs-playback-rate .vjs-menu');
        if (m) m.classList.remove('vjs-lock-showing');
    }
    function injectRates() {
        const menu = getRateMenu();
        if (!menu) return;
        const existing = new Set();
        Array.from(menu.children).forEach(li => {
            const r = parseRate(li.textContent);
            if (r !== null) existing.add(r);
        });
        const missing = WANTED_RATES.filter(r => !existing.has(r));
        if (missing.length === 0) return;

        missing.forEach(r => {
            const li = document.createElement('li');
            li.className = 'vjs-menu-item';
            li.setAttribute('role', 'menuitemradio');
            li.setAttribute('tabindex', '-1');
            li.setAttribute('aria-checked', 'false');
            const span = document.createElement('span');
            span.className = 'vjs-menu-item-text';
            span.textContent = r + 'x';
            li.appendChild(span);

            li.addEventListener('click', e => {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();

                savedRate = r;
                localStorage.setItem(STORAGE_KEY, String(savedRate));
                targetRate = r;

                const video = getVideoEl();
                if (video) {
                    settingByScript = true;
                    try { video.playbackRate = r; } catch (err) {}
                    settingByScript = false;
                }
                applyPlaybackRate(r);
                closeMenu();
            }, true);

            menu.appendChild(li);
        });

        Array.from(menu.children)
            .sort((a, b) => (parseRate(a.textContent) ?? 0) - (parseRate(b.textContent) ?? 0))
            .forEach(li => menu.appendChild(li));
    }

    document.addEventListener('click', e => {
        const item = e.target.closest && e.target.closest('.vjs-playback-rate .vjs-menu-item');
        if (!item) return;
        const r = parseRate(item.textContent);
        if (r === null) return;
        savedRate = r;
        localStorage.setItem(STORAGE_KEY, String(savedRate));
        targetRate = r;
    }, true);

    /* ============================================================
     * 六、解除限制类
     * ⚠️ 与镜像脚本的冲突点：翻转开启时不要清 pointerEvents
     * ============================================================ */
    function clearRestrictionClasses() {
        const c = getContainer();
        if (!c) return;
        if (c.classList.contains('disable-progress')) c.classList.remove('disable-progress');
        if (c.classList.contains('speed-mode')) c.classList.remove('speed-mode');

        const v = c.querySelector('video');
        // 关键修复：翻转开启期间，video 上的 pointerEvents:none 是镜像脚本刻意设的，别动它
        if (v && !flipEnabled && v.style.pointerEvents === 'none') {
            v.style.pointerEvents = '';
        }
    }

    /* ============================================================
     * 七、抽帧跳转绕过
     * ============================================================ */
    function parseSeconds(text) {
        if (!text) return null;
        if (text.includes('封面图')) return 0;
        let m = text.match(/(\d+):(\d+):(\d+)/);
        if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        m = text.match(/(\d+):(\d+)/);
        if (m) return Number(m[1]) * 60 + Number(m[2]);
        return null;
    }
    document.addEventListener('click', e => {
        const el = e.target.closest && e.target.closest('.image-display, .range-time span, .img-wrapper img');
        if (!el) return;
        let text = '';
        if (el.matches('.img-wrapper img')) {
            const wrap = el.closest('.img-wrapper');
            const sib = wrap && wrap.parentElement && wrap.parentElement.querySelector('.image-display');
            text = sib ? sib.textContent : '';
        } else {
            text = el.textContent || '';
        }
        const seconds = parseSeconds(text);
        if (seconds === null) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const video = getVideoEl();
        if (!video) return;
        try { video.currentTime = seconds; } catch (err) { return; }
        video.play().catch(()=>{});
    }, true);

    /* ============================================================
     * 八、自动播放
     * ============================================================ */
    function playCurrentVideo() {
        const video = getVideoEl();
        if (!video) return;
        document.querySelectorAll('video').forEach(v => { if (v !== video) v.pause(); });
        video.play().then(() => {
            setTimeout(() => applyPlaybackRate(targetRate), 100);
        }).catch(err => {
            video.muted = true;
            video.play().then(() => {
                setTimeout(() => applyPlaybackRate(targetRate), 100);
            }).catch(e => {});
        });
    }

    document.addEventListener('playing', (e) => {
        if (e.target.tagName !== 'VIDEO') return;
        if (e.target !== getVideoEl()) return;
        applyPlaybackRate(targetRate);
        setTimeout(() => applyPlaybackRate(targetRate), 300);
    }, true);

    /* ============================================================
     * 九、页面切换（references 请求）
     * ============================================================ */
    function onPageIdChanged(pageId) {
        // —— 镜像：重置 + 重建按钮 ——
        flipEnabled = false;
        const c = getContainer();
        if (c) {
            const v = c.querySelector('video');
            if (v) applyFlip(v, false);
            const btn = c.querySelector('.vjs-flip-button');
            if (btn) btn.classList.remove('vjs-flip-active');
        }
        setTimeout(addFlipButton, 300);

        // —— 倍速 / 自动播放 ——
        let retries = 20;
        const tryPlay = () => {
            const video = getVideoEl();
            if (video && video.src) {
                targetRate = capsLockOn ? savedRate : 1;
                currentSrcKey = video.src || '';
                applyPlaybackRate(targetRate);
                playCurrentVideo();
                return;
            }
            if (retries-- > 0) setTimeout(tryPlay, 200);
        };
        setTimeout(tryPlay, 300);
    }

    function extractPageId(url) {
        if (!url) return null;
        try {
            const str = typeof url === 'string' ? url : (url.url || url.href || String(url));
            const m = str.match(RE_REFS);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }
    function triggerPageChanged(pageId) {
        clearTimeout(networkTimer);
        networkTimer = setTimeout(() => onPageIdChanged(pageId), 100);
    }
    function hookNetworkRequests() {
        if (win.fetch && !win.fetch.__mergedVideoHooked) {
            const originalFetch = win.fetch;
            win.fetch = function (input) {
                const pageId = extractPageId(input);
                const p = originalFetch.apply(this, arguments);
                if (pageId && p && typeof p.then === 'function') {
                    p.then(() => triggerPageChanged(pageId)).catch(() => {});
                }
                return p;
            };
            win.fetch.__mergedVideoHooked = true;
        }

        const XHR = win.XMLHttpRequest;
        if (XHR && XHR.prototype && !XHR.prototype.__mergedVideoHooked) {
            const originalOpen = XHR.prototype.open;
            const originalSend = XHR.prototype.send;
            XHR.prototype.open = function (method, url) {
                this.__mergedVideoUrl = url;
                this.__mergedVideoPageId = null;
                return originalOpen.apply(this, arguments);
            };
            XHR.prototype.send = function () {
                const pageId = extractPageId(this.__mergedVideoUrl);
                if (pageId && !this.__mergedVideoPageId) {
                    this.__mergedVideoPageId = pageId;
                    this.addEventListener('loadend', () => triggerPageChanged(pageId));
                }
                return originalSend.apply(this, arguments);
            };
            XHR.prototype.__mergedVideoHooked = true;
        }
    }

    /* ============================================================
     * 十、Home 键（仅切换翻转按钮显隐）
     * ============================================================ */
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Home') return;
        if (isEditable(document.activeElement)) return;   // 输入框里保留行首功能
        e.preventDefault();

        uiVisible = !uiVisible;
        const container = getContainer();
        if (container) {
            const btn = container.querySelector('.vjs-flip-button');
            if (btn) btn.classList.toggle('vjs-flip-hidden', !uiVisible);
        }
    });

    /* ============================================================
     * 十一、统一调度 & 初始化
     * ============================================================ */
    function tick() {
        const c = getContainer();
        if (!c) return;
        clearRestrictionClasses();
        injectRates();

        const video = c.querySelector('video');
        if (video) {
            const src = video.src || video.getAttribute('src') || '';
            if (src && src !== currentSrcKey) {
                currentSrcKey = src;
                targetRate = capsLockOn ? savedRate : 1;
            }
        }
    }

    function init() {
        win.__APPLY_PLAYBACK_RATE__ = applyPlaybackRate;
        win.__CAPSLOCK_ON__ = capsLockOn;

        targetRate = capsLockOn ? savedRate : 1;

        addFlipButton();

        setTimeout(() => {
            const player = getVideojsPlayer();
            if (player) bindRateChange(player);
            else {
                const v = getVideoEl();
                if (v) bindRateChange(v);
            }
        }, 1500);

        startMaintain();
        setTimeout(() => applyPlaybackRate(targetRate), 1000);
        setTimeout(playCurrentVideo, 1500);

        setInterval(tick, 500);
    }

    hookNetworkRequests();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();