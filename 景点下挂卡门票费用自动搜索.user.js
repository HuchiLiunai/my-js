// ==UserScript==
// @name         景点下挂卡门票费用自动搜索
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  监听网络请求，仅在挂卡页面显示搜索按钮，点击后才搜索（Home键开关UI）
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 配置 ----------
    const CARD_SELECTOR = 'div.card-detail div.title span';
    const SEARCH_ENGINE = 'https://www.bing.com/search?q=';
    const SEARCH_SUFFIX = '门票多少钱';

    // 监听的三类请求
    const RE_LOAD       = /\/result\/verify\/project\/[^/]+\/base-queue\/[^/]+\/get(\?|$)/;
    const RE_QUEUE_LIST = /\/result\/verify\/queue\/[^/]+\/list(\?|$)/;
    const RE_REFS       = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;

    // pageId 白名单的容量上限
    const PAGE_ID_CACHE_MAX = 16;

    // ---------- 状态 ----------
    const pageIdToCardName = new Map();   // pageId -> cardName（仅挂卡页面，LRU）
    let currentSearchText = '';           // 当前页面识别到的卡片名
    let btn = null;
    let refsDebounce = null;
    let uiVisible = true;                 // 视觉开关：仅控制按钮显隐

    // ---------- LRU 工具 ----------
    function lruSet(key, value) {
        const k = String(key);
        if (pageIdToCardName.has(k)) {
            pageIdToCardName.delete(k);
        }
        pageIdToCardName.set(k, value);

        while (pageIdToCardName.size > PAGE_ID_CACHE_MAX) {
            const oldestKey = pageIdToCardName.keys().next().value;
            pageIdToCardName.delete(oldestKey);
        }
    }

    function lruGet(key) {
        const k = String(key);
        if (!pageIdToCardName.has(k)) return undefined;
        const v = pageIdToCardName.get(k);
        pageIdToCardName.delete(k);
        pageIdToCardName.set(k, v);
        return v;
    }

    // ---------- 工具 ----------
    function getUrlString(input) {
        if (!input) return '';
        if (typeof input === 'string') return input;
        if (input.url) return input.url;
        if (input.href) return input.href;
        try { return String(input); } catch (e) { return ''; }
    }

    function getCurrentTextFromDom() {
        const el = document.querySelector(CARD_SELECTOR);
        return el ? el.textContent.trim() : '';
    }

    function doSearch(query) {
        if (!query) return;
        const fullQuery = query + SEARCH_SUFFIX;
        const url = SEARCH_ENGINE + encodeURIComponent(fullQuery);
        window.open(url, '_blank');
    }

    // ---------- 按钮 ----------
    function ensureButton() {
        if (btn) return;
        btn = document.createElement('button');
        btn.style.cssText = `
            position: fixed;
            bottom: 120px;
            right: 20px;
            z-index: 999998;
            padding: 12px 20px;
            background: #0078d7;
            color: white;
            border: none;
            border-radius: 30px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            transition: background 0.2s;
            display: none;
        `;
        btn.addEventListener('mouseenter', () => btn.style.background = '#005a9e');
        btn.addEventListener('mouseleave', () => btn.style.background = '#0078d7');
        btn.addEventListener('click', () => {
            // 只在点击时才搜索
            const text = getCurrentTextFromDom() || currentSearchText;
            if (text) doSearch(text);
        });
        document.body.appendChild(btn);
    }

    function showButton(text) {
        ensureButton();
        const raw = text || '未识别';
        const displayText = raw.length > 6 ? raw.substring(0, 5) + '…' : raw;
        btn.textContent = `🔍 搜索“${displayText}门票”`;
        // 仅在视觉开关打开时显示
        btn.style.display = uiVisible ? 'block' : 'none';
    }

    function hideButton() {
        if (btn) btn.style.display = 'none';
    }

    // ---------- Home 键开关（仅视觉） ----------
    function setupUiToggle() {
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Home') return;
            uiVisible = !uiVisible;
            if (btn) btn.style.display = uiVisible ? 'block' : 'none';
        });
    }

    // ---------- 从 API 响应收集挂卡 pageId ----------
    function collectFromItem(item) {
        if (!item) return;
        const pageId = item.pageId;
        const cards = item.data && item.data.attachedCard;
        if (!pageId || !Array.isArray(cards) || cards.length === 0) return;
        const name = cards[0].cardName || cards[0].cardTypeDesc || '';
        if (name) lruSet(pageId, name);
    }

    function collectFromLoadResponse(json) {
        const d = json && json.data ? json.data : json;
        if (d) collectFromItem(d);
    }

    function collectFromListResponse(json) {
        const list = json && json.data && json.data.pageList;
        if (Array.isArray(list)) list.forEach(collectFromItem);
    }

    // ---------- references 处理 ----------
    function extractRefsPageIdFromUrl(urlStr) {
        const m = urlStr.match(RE_REFS);
        return m ? m[1] : null;
    }

    function handleRefs(pageId, retries) {
        if (retries === undefined) retries = 5;
        if (!pageId) { hideButton(); currentSearchText = ''; return; }

        const cardName = lruGet(pageId);
        if (!cardName) {
            if (retries > 0) {
                // 可能 load/list 响应还没到，稍等再试
                setTimeout(() => handleRefs(pageId, retries - 1), 200);
                return;
            }
            hideButton();
            currentSearchText = '';
            return;
        }

        currentSearchText = cardName;
        // 只显示按钮，不自动搜索
        showButton(cardName);
    }

    // ---------- 网络监听 ----------
    function hookNetworkRequests() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        // ---- fetch ----
        if (win.fetch && !win.fetch.__ticketSearchHooked) {
            const originalFetch = win.fetch;
            win.fetch = function (input, init) {
                const urlStr = getUrlString(input);
                const isLoad = RE_LOAD.test(urlStr);
                const isList = RE_QUEUE_LIST.test(urlStr);
                const isRefs = RE_REFS.test(urlStr);
                const refsPageId = isRefs ? extractRefsPageIdFromUrl(urlStr) : null;

                const p = originalFetch.apply(this, arguments);

                if (isLoad || isList) {
                    p.then(r => r.clone().json()).then(json => {
                        if (isList) collectFromListResponse(json);
                        else collectFromLoadResponse(json);
                    }).catch(() => {});
                }

                if (isRefs) {
                    p.then(r => r.clone().json()).then(json => {
                        const bodyPageId = json && json.data && json.data.pageId;
                        clearTimeout(refsDebounce);
                        refsDebounce = setTimeout(
                            () => handleRefs(bodyPageId != null ? String(bodyPageId) : refsPageId),
                            100
                        );
                    }).catch(() => {
                        clearTimeout(refsDebounce);
                        refsDebounce = setTimeout(() => handleRefs(refsPageId), 100);
                    });
                }

                return p;
            };
            win.fetch.__ticketSearchHooked = true;
        }

        // ---- XHR ----
        const XHR = win.XMLHttpRequest;
        if (XHR && XHR.prototype && !XHR.prototype.__ticketSearchHooked) {
            const originalOpen = XHR.prototype.open;
            const originalSend = XHR.prototype.send;

            XHR.prototype.open = function (method, url) {
                this.__ticketUrl = url;
                return originalOpen.apply(this, arguments);
            };

            XHR.prototype.send = function () {
                const urlStr = getUrlString(this.__ticketUrl);
                const isLoad = RE_LOAD.test(urlStr);
                const isList = RE_QUEUE_LIST.test(urlStr);
                const isRefs = RE_REFS.test(urlStr);
                const refsPageId = isRefs ? extractRefsPageIdFromUrl(urlStr) : null;

                if (isLoad || isList || isRefs) {
                    this.addEventListener('loadend', function () {
                        let json = null;
                        try { json = JSON.parse(this.responseText); } catch (e) {}

                        if (isLoad && json) collectFromLoadResponse(json);
                        if (isList && json) collectFromListResponse(json);
                        if (isRefs) {
                            const bodyPageId = json && json.data && json.data.pageId;
                            clearTimeout(refsDebounce);
                            refsDebounce = setTimeout(
                                () => handleRefs(bodyPageId != null ? String(bodyPageId) : refsPageId),
                                100
                            );
                        }
                    });
                }

                return originalSend.apply(this, arguments);
            };
            XHR.prototype.__ticketSearchHooked = true;
        }
    }

    // ---------- 启动 ----------
    function init() {
        setupUiToggle();
    }

    hookNetworkRequests();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();