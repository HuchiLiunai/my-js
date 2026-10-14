// ==UserScript==
// @name         默认通过
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  视频变化时800毫秒后自动点击“通过”按钮；检测到 get 请求时再尝试一次
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/1/recheck/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 与主控脚本保持一致的 references 请求正则
    const RE_REFS = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;

    // get 请求正则
    const RE_GET = /\/result\/verify\/project\/[^/]+\/base-queue\/[^/]+\/get(\?|$)/;

    let networkTimer = null;
    let getTimer = null;

    // ---------- 选择“通过” ----------
    function selectPassResult() {
    const notPassBtn = document.querySelector('.verify-result .btns .no-pass-btn');
    const passBtn = document.querySelector('.verify-result .btns .pass-btn');

    // 如果“不通过”已被选中（有 no-pass 类），则跳过
    if (notPassBtn && notPassBtn.classList.contains('no-pass')) {
        console.log('⏭️ 当前已选“不通过”，不自动选择“通过”');
        return;
    }

    // 如果“通过”已经选中（有 pass 类），也不用再点
    if (passBtn && passBtn.classList.contains('pass')) {
        console.log('✅ “通过”已选中，无需操作');
        return;
    }

    // 否则点击“通过”
    if (passBtn) {
        passBtn.click();
        console.log('✅ 已自动选择“通过”');
    }
}

    // ---------- 视频变化回调 ----------
    function onVideoChanged(pageId) {
        console.log(`✅ 默认通过：检测到 references 请求，page=${pageId}，准备自动选择“通过”`);
        // 延迟一点等待按钮出现
        setTimeout(selectPassResult, 300);
    }

    // ---------- 网络请求监听 ----------
    function extractPageId(url) {
        if (!url) return null;
        try {
            const str = typeof url === 'string'
                ? url
                : (url.url || url.href || String(url));

            const m = str.match(RE_REFS);
            return m ? m[1] : null;
        } catch (e) {
            return null;
        }
    }

    function isGetRequest(url) {
        if (!url) return false;
        try {
            const str = typeof url === 'string'
                ? url
                : (url.url || url.href || String(url));
            return RE_GET.test(str);
        } catch (e) {
            return false;
        }
    }

    function triggerVideoChanged(pageId) {
        clearTimeout(networkTimer);
        networkTimer = setTimeout(function () {
            onVideoChanged(pageId);
        }, 100);
    }

    // get 请求命中后，再尝试一次选择“通过”
    function triggerGetRetry() {
        clearTimeout(getTimer);
        getTimer = setTimeout(function () {
            console.log('🔁 默认通过：检测到 get 请求，再次尝试选择“通过”');
            selectPassResult();
        }, 300);
    }

    function hookNetworkRequests() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        // 劫持 fetch
        if (win.fetch && !win.fetch.__passDefaultHooked) {
            const originalFetch = win.fetch;

            win.fetch = function (input) {
                const pageId = extractPageId(input);
                const isGet = isGetRequest(input);

                const p = originalFetch.apply(this, arguments);

                if (p && typeof p.then === 'function') {
                    p.then(function () {
                        if (pageId) triggerVideoChanged(pageId);
                        if (isGet) triggerGetRetry();
                    }).catch(function () {});
                }

                return p;
            };

            win.fetch.__passDefaultHooked = true;
        }

        // 劫持 XMLHttpRequest
        const XHR = win.XMLHttpRequest;
        if (XHR && XHR.prototype && !XHR.prototype.__passDefaultHooked) {
            const originalOpen = XHR.prototype.open;
            const originalSend = XHR.prototype.send;

            XHR.prototype.open = function (method, url) {
                this.__passDefaultUrl = url;
                this.__passDefaultPageId = null;
                this.__passDefaultIsGet = false;
                return originalOpen.apply(this, arguments);
            };

            XHR.prototype.send = function () {
                const pageId = extractPageId(this.__passDefaultUrl);
                const isGet = isGetRequest(this.__passDefaultUrl);

                if ((pageId && !this.__passDefaultPageId) || (isGet && !this.__passDefaultIsGet)) {
                    if (pageId) this.__passDefaultPageId = pageId;
                    if (isGet) this.__passDefaultIsGet = true;

                    this.addEventListener('loadend', function () {
                        if (pageId) triggerVideoChanged(pageId);
                        if (isGet) triggerGetRetry();
                    });
                }

                return originalSend.apply(this, arguments);
            };

            XHR.prototype.__passDefaultHooked = true;
        }

        console.log('📡 默认通过：已监听 references / get 网络请求');
    }

    // ---------- 初始化 ----------
    function init() {
        // 处理当前已加载的视频（防止脚本注入时页面已经就绪）
        setTimeout(() => {
            const video = document.getElementById('video-player_html5_api');
            if (video && video.src) {
                console.log('📌 默认通过：检测到当前已有视频，立即尝试选择“通过”');
                selectPassResult();
            }
        }, 800);//0.8秒后自动点击通过，别太快，容易误点通过
    }

    // 网络劫持不依赖 DOM，尽早执行，避免错过早期请求
    hookNetworkRequests();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('✅ 默认通过脚本已加载（网络监听版 v1.2）');
})();
