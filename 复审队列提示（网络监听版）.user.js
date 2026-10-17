// ==UserScript==
// @name         复审队列提示（网络监听版）
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  监听 /argus/api/result/queue/{qid}/page_info，fullQueueName 命中关键字即提示
// @match        https://test.baidu.com/argus/plaza/project/*/recheck/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 配置 ----------
    const RE_QUEUE_INFO = /\/api\/result\/queue\/\d+\/page_info/;
    const KEYWORDS      = ['复审', '交易', 'vvr', '涉黄'];  // 命中任一即提示
    const MSG_DURATION  = 6000;                             // 兜底提示停留时长(ms)

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    let lastMsgTimer = null;

    // ========== 提示（脉冲式，自动消失） ==========
    function showWarningMessage(text) {
        // 优先用页面自带的 antd message
        const antd = win.antd || win.__antd || win.Antd;
        if (antd && antd.message && typeof antd.message.warning === 'function') {
            antd.message.warning(text, 5);
            return;
        }
        if (win.message && typeof win.message.warning === 'function') {
            win.message.warning(text, 5);
            return;
        }

        // 兜底：自绘提示条
        const oldMsg = document.querySelector('.my-custom-message');
        if (oldMsg) oldMsg.remove();
        if (lastMsgTimer) { clearTimeout(lastMsgTimer); lastMsgTimer = null; }

        if (!document.getElementById('my-msg-style')) {
            const style = document.createElement('style');
            style.id = 'my-msg-style';
            style.textContent = `
                @keyframes myMsgFadeIn {
                    from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
            `;
            document.head.appendChild(style);
        }

        const div = document.createElement('div');
        div.className = 'my-custom-message';
        div.style.cssText = `
            position: fixed;
            top: 24px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999999;
            background: #fff7e6;
            border: 1px solid #ffd591;
            border-radius: 4px;
            padding: 12px 24px;
            box-shadow: 0 3px 6px -4px rgba(0,0,0,0.12), 0 6px 16px 0 rgba(0,0,0,0.08), 0 9px 28px 8px rgba(0,0,0,0.05);
            color: #d46b08;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            max-width: 600px;
            word-break: break-word;
            animation: myMsgFadeIn 0.3s ease;
        `;
        div.innerHTML = `
            <span style="font-size:20px; line-height:1;">⚠️</span>
            <span style="white-space: pre-line;">${text}</span>
        `;
        (document.body || document.documentElement).appendChild(div);

        lastMsgTimer = setTimeout(() => {
            div.remove();
            lastMsgTimer = null;
        }, MSG_DURATION);
    }

    // ========== 通用工具 ==========
    function getUrlString(input) {
        if (!input) return '';
        if (typeof input === 'string') return input;
        if (input.url) return input.url;
        if (input.href) return input.href;
        try { return String(input); } catch (e) { return ''; }
    }

    // ========== 核心：解析 page_info 响应 ==========
    function handleQueueInfo(json) {
        const data = json && json.data;
        if (!data || typeof data !== 'object') return;

        const name = data.fullQueueName;
        if (!name || typeof name !== 'string') return;

        const hit = KEYWORDS.find(k => name.includes(k));
        if (!hit) return;

        console.log('🎯 命中关键字:', hit,
                    '| fullQueueName =', name,
                    '| queueId =', data.queueId,
                    '| resultId =', data.resultId,
                    '| data =', data);

        showWarningMessage(`⚠️ 该题目所属队列包含「${hit}」\n${name}`);
    }

    // ========== 网络 hook ==========
    function hookNetwork() {
        // ---------- fetch ----------
        if (win.fetch && !win.fetch.__queueInfoHooked) {
            const origFetch = win.fetch;
            win.fetch = function (input, init) {
                const p = origFetch.apply(this, arguments);
                if (RE_QUEUE_INFO.test(getUrlString(input))) {
                    p.then(r => r.clone().json())
                     .then(handleQueueInfo)
                     .catch(() => {});
                }
                return p;
            };
            win.fetch.__queueInfoHooked = true;
        }

        // ---------- XHR ----------
        const XHR = win.XMLHttpRequest;
        if (XHR && XHR.prototype && !XHR.prototype.__queueInfoHooked) {
            const origOpen = XHR.prototype.open;
            const origSend = XHR.prototype.send;

            XHR.prototype.open = function (method, url) {
                this.__queueInfoUrl = url;
                return origOpen.apply(this, arguments);
            };

            XHR.prototype.send = function () {
                if (RE_QUEUE_INFO.test(getUrlString(this.__queueInfoUrl))) {
                    this.addEventListener('loadend', function () {
                        let json = null;
                        try { json = JSON.parse(this.responseText); } catch (e) {}
                        handleQueueInfo(json);
                    });
                }
                return origSend.apply(this, arguments);
            };
            XHR.prototype.__queueInfoHooked = true;
        }
    }

    // ========== 启动 ==========
    hookNetwork();
    console.log('[QueueInfo] 监听已启动，关键字：', KEYWORDS.join(' / '));
})();
