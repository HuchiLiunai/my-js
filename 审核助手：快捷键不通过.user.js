// ==UserScript==
// @name         审核助手：快捷键不通过
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  快捷键不通过
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/1/recheck/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ---------- 配置：快捷键映射 ----------
    const SHORTCUTS = [
        { key: 'q', ctrl: false, alt: false, shift: false, reason: '媒体新闻', labels: ['媒体新闻', '重要监管事业单位'] },
        { key: 'w', ctrl: false, alt: false, shift: false, reason: '国家领导人非负面', labels: ['涉政非负面', '国家领导人非负面'] },
        { key: 'w', ctrl: false, alt: false, shift: true, reason: '国家领导人非负面', labels: ['涉政非负面', '一号非负面'] },
        { key: 'e', ctrl: false, alt: false, shift: false, reason: '敏感事件',         labels: ['涉政非负面', '敏感事件'] },
        { key: 'e', ctrl: false, alt: true, shift: false, reason: '历史事件',         labels: ['涉政非负面', '历史事件'] },

        { key: 'r', ctrl: false, alt: false, shift: false, reason: '不良价值观',       labels: ['不良导向', '不良价值观'] },
        { key: 'r', ctrl: false, alt: true, shift: false, reason: '不当语言',       labels: ['不良导向', '不当语言'] },
        { key: 't', ctrl: false, alt: false, shift: false, reason: '劣迹艺人',         labels: ['不良导向', '劣迹艺人'] },
        { key: 'y', ctrl: false, alt: false, shift: false, reason: '随手拍低质',       labels: ['内容低质', '随手拍低质'] },
        { key: 'y', ctrl: false, alt: false, shift: true, reason: '黑边低质',       labels: ['内容低质', '黑边低质'] },

        { key: 'a', ctrl: false, alt: false, shift: false, reason: '轻度软色情',         labels: ['软色情(新)', '轻度软色情'] },
        { key: 's', ctrl: false, alt: false, shift: false, reason: '中度软色情',       labels: ['软色情(新)', '中度软色情'] },
        { key: 's', ctrl: false, alt: false, shift: true, reason: '重度软色情',       labels: ['软色情(新)', '重度软色情'] },

        { key: 's', ctrl: false, alt: true , shift: false , reason: '非主流性向',       labels: ['涉黄', '非主流性向'] },

        { key: 'z', ctrl: false, alt: false, shift: true, reason: '联系方式',         labels: ['营销导流', '联系方式'] },
        { key: 'z', ctrl: false, alt: false, shift: false, reason: '未授权平台导流',   labels: ['营销导流', '未授权平台导流'] },

        { key: 'x', ctrl: false, alt: false, shift: false, reason: '硬广',             labels: ['营销导流', '硬广'] },
        { key: 'x', ctrl: false, alt: false, shift: true, reason: '本地生活广告',     labels: ['广告', '本地生活广告'] },


        { key: 'd', ctrl: false, alt: false, shift: false, reason: '轻度引人不适内容', labels: ['观感画风不适', '轻度引人不适内容'] },
        { key: 'f', ctrl: false, alt: false, shift: false, reason: '重度引人不适内容', labels: ['观感画风不适', '重度引人不适内容'] },



    ];

    // ---------- 工具 ----------
    function isVisible(el) {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        if (el.offsetParent === null) {
            let p = el.parentElement;
            while (p) {
                if (getComputedStyle(p).position === 'fixed') return true;
                p = p.parentElement;
            }
            return false;
        }
        return true;
    }

    function waitForVisible(selector, timeout = 800) {
        return new Promise((resolve) => {
            const tryCheck = () => {
                const el = document.querySelector(selector);
                return (el && isVisible(el)) ? el : null;
            };
            const immediate = tryCheck();
            if (immediate) return resolve(immediate);

            let done = false;
            const finish = (el) => {
                if (done) return;
                done = true;
                obs.disconnect();
                clearTimeout(timer);
                resolve(el);
            };
            const obs = new MutationObserver(() => {
                const el = tryCheck();
                if (el) finish(el);
            });
            obs.observe(document.body, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['style', 'class'],
            });
            const timer = setTimeout(() => finish(null), timeout);
        });
    }

    function findByText(root, selector, text) {
        for (const el of root.querySelectorAll(selector)) {
            if (el.textContent.trim() === text) return el;
        }
        return null;
    }

    // ---------- 强制关闭面板（同步、幂等） ----------
    function closePanelForce() {
        const panel = document.querySelector('.select-label-box');
        if (!panel || !isVisible(panel)) return;
        const closeBtn = panel.querySelector('span[aria-label="close"]');
        if (closeBtn) { closeBtn.click(); return; }
        // 兜底：尝试 Esc
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    // ============================================================
    // 主流程：代际编号，任何旧流程都不允许再操作 DOM
    // ============================================================
    let generation = 0;

    async function runFlow(labels, myGen) {
        const isStale = () => myGen !== generation;
        const t0 = performance.now();

        // ① 清场：无论处于什么状态，先关掉现有面板
        closePanelForce();
        if (isStale()) return;

        // ② 点"不通过"
        const notPassBtn = document.querySelector('.verify-result .btns .no-pass-btn');
        if (!notPassBtn) {
            console.warn('[快捷键] 未找到"不通过"按钮');
            return;
        }
        notPassBtn.click();
        if (isStale()) return;

        // ③ 等面板出现（MutationObserver，一出现就继续）
        const panel = await waitForVisible('.select-label-box', 800);
        if (isStale()) return;   // 期间按键已递增 generation → 放弃
        if (!panel) {
            console.warn('[快捷键] 标签面板未出现');
            return;
        }

        // ④ 找并点击二级标签
        const targetLabel = labels[labels.length - 1];
        const tag = findByText(panel, '.flex-tags .tag-item', targetLabel);
        if (isStale()) return;
        if (!tag) {
            console.warn(`[快捷键] 未找到标签: ${targetLabel}`);
            closePanelForce();
            return;
        }
        tag.click();
        console.log(`[快捷键] ✅ ${targetLabel} (${(performance.now() - t0).toFixed(1)}ms)`);

        // ⑤ 关面板（给 Vue 一个微任务的时间）
        await Promise.resolve();
        if (isStale()) return;
        closePanelForce();
    }

    function triggerShortcut(labels) {
        const myGen = ++generation;   // 新的代际
        runFlow(labels, myGen);
    }

    // ============================================================
    // 绑定
    // ============================================================
    function isEditable(t) {
        if (!t) return false;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return true;
        if (t.isContentEditable) return true;
        return false;
    }

    document.addEventListener('keydown', function (e) {
        if (isEditable(e.target)) return;

        for (const s of SHORTCUTS) {
            if (e.ctrlKey !== s.ctrl) continue;
            if (e.altKey !== s.alt) continue;
            if (e.shiftKey !== s.shift) continue;
            if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;

            e.preventDefault();
            e.stopPropagation();
            triggerShortcut(s.labels);
            return;
        }
    }, true);

    console.log('⌨️ [快捷键] 零等待版已加载，键位:', SHORTCUTS.map(s => s.key).join(','));
})();
