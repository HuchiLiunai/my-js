// ==UserScript==
// @name         自动确认"标题""视频抽帧图""语音识别""下挂卡"（3 轮版）
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  劫持 setTimeout，把 1s 延迟压成 1ms；循环 3 轮 mouseenter 确保不漏
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /* ============================================================
     * 1. setTimeout 劫持
     * ============================================================ */
    const origSetTimeout = window.setTimeout;
    let boostUntil = 0;

    window.setTimeout = function(fn, delay, ...args) {
        if (boostUntil > Date.now()
            && typeof delay === 'number'
            && delay >= 950 && delay <= 1050
            && typeof fn === 'function'
            && /stayedLessThanTenSeconds/.test(fn.toString())) {
            return origSetTimeout(fn, 1, ...args);
        }
        return origSetTimeout(fn, delay, ...args);
    };

    function boostFor(ms) {
        boostUntil = Math.max(boostUntil, Date.now() + ms);
    }

    /* ============================================================
     * 2. 配置
     * ============================================================ */
    const RE_REFS = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;
    const SELECTORS = [
        '.left-video-info', '.tabs-box', '.audio-box',
        '.lower-hanging-card', '.comment-box',
    ];

    const ROUNDS           = 3;     // 循环次数
    const ROUND_GAP        = 400;   // 轮与轮之间的等待
    const PER_ELEMENT_WAIT = 20;    // 每个元素派发后等待
    const BOOST_WINDOW     = 2500;  // 每轮加速窗口长度

    function sleep(ms) { return new Promise(r => origSetTimeout(r, ms)); }

    /* ============================================================
     * 3. 主流程
     * ============================================================ */
    async function activateSequence() {
        const t0 = performance.now();

        for (let round = 1; round <= ROUNDS; round++) {
            // 等目标 DOM 出现
            for (let i = 0; i < 40; i++) {
                if (document.querySelector(SELECTORS.join(','))) break;
                await sleep(25);
            }

            // 每轮重新开加速窗口（Vue 每轮可能调度新的 1s 定时器）
            boostFor(BOOST_WINDOW);

            // 每轮重新抓一遍（关键：元素可能被 Vue 替换）
            const elements = [];
            for (const sel of SELECTORS) {
                document.querySelectorAll(sel).forEach(el => elements.push(el));
            }

            let fired = 0;
            for (const el of elements) {
                if (!document.contains(el)) continue;  // 跳过已脱离的
                el.dispatchEvent(new MouseEvent('mouseenter', {
                    bubbles: false, cancelable: true, relatedTarget: null,
                }));
                fired++;
                await sleep(PER_ELEMENT_WAIT);
            }

            // mouseleave 清理（此时定时器多半已跑完，无副作用）
            for (const el of elements) {
                if (document.contains(el)) {
                    el.dispatchEvent(new MouseEvent('mouseleave', {
                        bubbles: false, cancelable: true, relatedTarget: null,
                    }));
                }
            }

            console.log(`⚡ 第 ${round}/${ROUNDS} 轮完成：命中 ${fired} 个模块`);

            if (round < ROUNDS) await sleep(ROUND_GAP);
        }

        console.log(`✅ ${ROUNDS} 轮全部完成，总耗时 ${(performance.now() - t0).toFixed(0)}ms`);
    }

    /* ============================================================
     * 4. 网络监听
     * ============================================================ */
    function installNetworkHook() {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string' && RE_REFS.test(url)) {
                this.addEventListener('load', () => activateSequence(), { once: true });
            }
            return origOpen.apply(this, arguments);
        };

        if (typeof window.fetch === 'function') {
            const origFetch = window.fetch;
            window.fetch = function(input) {
                let url = typeof input === 'string' ? input : (input && input.url) || '';
                const p = origFetch.apply(this, arguments);
                if (url && RE_REFS.test(url)) {
                    p.then(() => activateSequence()).catch(() => {});
                }
                return p;
            };
        }
    }

    installNetworkHook();
    console.log('🚀 setTimeout 加速版自动确认（3 轮）已加载');
})();