// ==UserScript==
// @name          verify提交答案后自动点击下一题
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  feedback 200 → 给 active 的相邻卡片打 data-argus-anchor → 3s 内有 verify 就点这个元素；防御同样基于元素
// @match        https://test.baidu.com/argus/*
// @exclude      https://test.baidu.com/argus/plaza/*/recheck/*
// @exclude      https://test.baidu.com/argus/plaza/*/appeal/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ============ 可调参数 ============ */
    const FEEDBACK_RE        = /\/argus\/api\/video\/response\/project\/\d+\/feedback/;
    const VERIFY_RE          = /\/argus\/api\/result\/verify\/queue\/\d+\/answer/;
    const CARD_SELECTOR      = '.slid-container .slid-list .video-card';
    const CONTAINER_SELECTOR = '.slid-container';
    const ANCHOR_ATTR        = 'data-argus-anchor';
    const WAIT_MS            = 3000;  // verify 判定窗口
    const DEFENSE_MS         = 5000;  // 点击后防御窗口
    const DEFENSE_POLL_MS    = 100;   // 确认阶段轮询间隔
    const DEBUG              = true;

    /* ============ 全局鼠标跟踪 ============ */
    const lastMousePos = { x: -1, y: -1 };
    document.addEventListener('mousemove', (e) => {
        lastMousePos.x = e.clientX;
        lastMousePos.y = e.clientY;
    }, { passive: true });

    function isMouseInContainer() {
        const area = document.querySelector(CONTAINER_SELECTOR);
        if (!area) return false;
        const rect = area.getBoundingClientRect();
        const { x, y } = lastMousePos;
        if (x < 0 || y < 0) return false;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    /* ============ data-argus-anchor 锚点工具 ============ */
    function clearAnchorMarks() {
        document.querySelectorAll(`[${ANCHOR_ATTR}]`)
                .forEach(el => el.removeAttribute(ANCHOR_ATTR));
    }

    function getMarkedCard() {
        return document.querySelector(`${CARD_SELECTOR}[${ANCHOR_ATTR}]`);
    }

    // feedback 200：给 active 的相邻卡片打标，返回锚点上下文
    function buildTargetAnchor() {
        clearAnchorMarks();

        const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
        const activeIdx = cards.findIndex(el => el.classList.contains('active'));
        if (activeIdx === -1) {
            return { ok: false, reason: 'no-active', total: cards.length };
        }

        let target = null;
        let mode   = 'next';
        if (activeIdx + 1 < cards.length) {
            target = cards[activeIdx + 0];
        } else if (activeIdx - 1 >= 0) {
            target = cards[activeIdx - 1];
            mode = 'prev';
        }
        if (!target) {
            return { ok: false, reason: 'no-neighbor', total: cards.length };
        }

        target.setAttribute(ANCHOR_ATTR, '1');

        return {
            ok: true,
            mode,
            element: target,          // 元素引用（次要兜底）
            baseIdx: activeIdx,       // 仅日志使用，不参与逻辑
            total: cards.length,
        };
    }

    // verify 200：按属性取回目标元素
    function resolveTargetElement(anchor) {
        const marked = getMarkedCard();
        if (marked) return marked;

        // 属性被外部脚本意外抹掉，但元素还在 → 用引用兜底
        if (anchor && anchor.element && anchor.element.isConnected) {
            anchor.element.setAttribute(ANCHOR_ATTR, '1');
            return anchor.element;
        }
        return null;   // 元素已消失 → 放弃本次
    }

    /* ============ 点击（按元素，不按 index） ============ */
    function clickCardElement(card, { startDefense = true } = {}) {
        if (!card || !card.isConnected) {
            console.warn('[Argus] 目标元素已从 DOM 移除，放弃点击');
            return false;
        }

        try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}

        const fire = (el) => {
            el.click();
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        };
        fire(card);
        const video = card.querySelector('video');
        if (video) fire(video);

        const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
        const idx = cards.indexOf(card);
        console.log(
            `%c[Argus] 已点击 ${ANCHOR_ATTR} 目标元素（当前索引 ${idx} / 共 ${cards.length}）`,
            'color:#30bf13;font-weight:bold'
        );

        if (startDefense) startActiveDefense(card);
        return true;
    }

    /* ============ 5s 防御（基于元素） ============ */
    let currentDefense = null;

    function startActiveDefense(initialCard) {
        if (currentDefense) currentDefense.stop('被新防御替换');
        if (!initialCard || !initialCard.isConnected) return;

        const container = document.querySelector(CONTAINER_SELECTOR);
        if (!container) return;

        const startTime = Date.now();
        let target    = initialCard;   // 当前跟踪的目标元素（不再用 index）
        let confirmed = false;
        let stopped   = false;
        let confirmTimer = null;
        let endTimer     = null;
        let observer     = null;

        const self = { stop };
        currentDefense = self;

        function stop(reason) {
            if (stopped) return;
            stopped = true;
            if (confirmTimer) { clearInterval(confirmTimer); confirmTimer = null; }
            if (endTimer)     { clearTimeout(endTimer);      endTimer = null; }
            if (observer)     { observer.disconnect();       observer = null; }
            if (currentDefense === self) currentDefense = null;
            console.log(`%c[Argus] 防御结束：${reason}`, 'color:#999');
        }

        // ① 确认阶段：等目标元素自己带上 .active
        confirmTimer = setInterval(() => {
            if (stopped || confirmed) return;
            if (!target.isConnected) {
                stop('目标元素已从 DOM 移除');
                return;
            }
            if (target.classList.contains('active')) {
                confirmed = true;
                clearInterval(confirmTimer);
                confirmTimer = null;
                console.log(
                    `%c[Argus] 防御：目标元素已 active，进入 ${DEFENSE_MS}ms 监听`,
                    'color:#409eff'
                );
            } else if (Date.now() - startTime >= DEFENSE_MS) {
                stop('确认阶段超时（目标元素未 active）');
            }
        }, DEFENSE_POLL_MS);

        // ② 监听：目标元素失去 active 时处理
        observer = new MutationObserver(() => {
            if (stopped || !confirmed) return;
            if (!target.isConnected) {
                stop('目标元素已从 DOM 移除');
                return;
            }
            if (target.classList.contains('active')) return;   // 仍是预期元素

            if (isMouseInContainer()) {
                // 鼠标在区域内 → 跟随用户，把锚点迁移到新的 active 元素
                const newActive = document.querySelector(`${CARD_SELECTOR}.active`);
                if (newActive && newActive !== target) {
                    console.log('[Argus] 防御：目标元素不再 active，鼠标在区域内，锚点跟随新 active');
                    target.removeAttribute(ANCHOR_ATTR);
                    newActive.setAttribute(ANCHOR_ATTR, '1');
                    target = newActive;
                }
                return;
            }

            console.log(
                `%c[Argus] 防御：目标元素不再 active，鼠标不在区域内，恢复一次`,
                'color:#f33;font-weight:bold'
            );
            clickCardElement(target, { startDefense: false });
            stop('已恢复一次');
        });
        observer.observe(container, {
            attributes: true, subtree: true, attributeFilter: ['class']
        });

        // ③ 总窗口
        endTimer = setTimeout(() => {
            if (stopped) return;
            stop(confirmed
                ? `${DEFENSE_MS}ms 监听窗口结束`
                : `${DEFENSE_MS}ms 内未确认 active`);
        }, DEFENSE_MS);
    }

    /* ============ 状态机 ============ */
    let pendingClick = null;

    function handleFeedback200() {
        if (pendingClick) {
            pendingClick.cancelled = true;
            clearTimeout(pendingClick.timer);
            pendingClick = null;
        }

        const anchor = buildTargetAnchor();
        if (!anchor.ok) {
            if (anchor.reason === 'no-active') {
                console.warn(`[Argus] feedback 200 但当前没有 .active 元素（共 ${anchor.total} 张卡片），放弃本次`);
            } else {
                console.warn(`[Argus] feedback 200 但 active 无相邻卡片（共 ${anchor.total} 张卡片），放弃本次`);
            }
            return;
        }

        const ctx = { anchor, verifyArrived: false, timer: null, cancelled: false };

        console.log(
            `%c[Argus] feedback 200 → 已在 active（索引 ${anchor.baseIdx} / 共 ${anchor.total}）的` +
            `${anchor.mode === 'next' ? '下一张' : '上一张'}打上 ${ANCHOR_ATTR}，开启 ${WAIT_MS}ms 等待窗口`,
            'color:#ffa500;font-weight:bold'
        );

        ctx.timer = setTimeout(() => {
            if (ctx.cancelled) return;
            if (!ctx.verifyArrived) {
                console.log(`%c[Argus] ${WAIT_MS}ms 内无 verify/answer，清除 ${ANCHOR_ATTR} 标记`,
                            'color:#f33;font-weight:bold');
                clearAnchorMarks();
            }
            if (pendingClick === ctx) pendingClick = null;
        }, WAIT_MS);

        pendingClick = ctx;
    }

    function handleVerify200() {
        if (!pendingClick || pendingClick.cancelled) return;
        pendingClick.verifyArrived = true;
        clearTimeout(pendingClick.timer);

        const ctx = pendingClick;
        pendingClick = null;

        const target = resolveTargetElement(ctx.anchor);
        if (!target) {
            console.warn(`[Argus] verify/answer 200 → 找不到 ${ANCHOR_ATTR} 目标元素，放弃本次点击`);
            return;
        }

        console.log(
            `%c[Argus] verify/answer 200 → 找到 ${ANCHOR_ATTR} 目标元素，开始点击`,
            'color:#409eff;font-weight:bold'
        );
        clickCardElement(target);
    }

    /* ============ 拦截 XHR ============ */
    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__argusUrl = url;
        return rawOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        const reqUrl = this.__argusUrl || '';
        this.addEventListener('loadend', () => {
            if (this.status !== 200) return;
            const url = this.responseURL || reqUrl;
            if (FEEDBACK_RE.test(url))      handleFeedback200();
            else if (VERIFY_RE.test(url))   handleVerify200();
        });
        return rawSend.apply(this, args);
    };

    /* ============ 拦截 fetch ============ */
    if (typeof window.fetch === 'function') {
        const rawFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const p = rawFetch.call(this, input, init);
            p.then(res => {
                if (res.status !== 200) return;
                const realUrl = res.url || url;
                if (FEEDBACK_RE.test(realUrl))      handleFeedback200();
                else if (VERIFY_RE.test(realUrl))   handleVerify200();
            }).catch(() => {});
            return p;
        };
    }

    if (DEBUG) {
        console.log(
            '%c[Argus Feedback Watcher v2.0] 已注入（data-argus-anchor 单锚点）',
            'color:#409eff;font-weight:bold'
        );
    }
})();
