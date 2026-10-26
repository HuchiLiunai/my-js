// ==UserScript==
// @name         审核助手 v2：计数 + 配速 + 月表
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  verify/recheck 计数，实时配速 + ETA + 进度描边，月表编辑，Home 老板键
// @match        https://test.baidu.com/argus/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
      // ============ 权重配置 ============
    const WEIGHTED_QUEUE_IDS = new Set([31,32,33,35,36,48,68,71,72,]); // 长视频队列
    const QUEUE_MULTIPLIER   = 1.5;   // 长视频队列计数 → ×1.5
    const RECHECK_MULTIPLIER = 1.1;   // RECHECK 场景 → ×1.1
    // ============ 常量 ============
    const robotUserIds = [23481280, 23766290, 23457936, 23660189, 23782297, 23717370];//机审Id
    const DATA_KEY   = 'aa_data_v1';
    const EVENTS_KEY = 'aa_events_v1';
    const CONFIG_KEY = 'aa_config_v1';

    const PANEL_ID = 'aa-panel';
    const MENU_ID  = 'aa-menu';
    const MONTH_ID = 'aa-month-modal';

    const COLOR_BLUE   = '#0487ff';
    const COLOR_GOLD   = '#f5a623';
    const COLOR_GREEN  = '#30bf13';
    const COLOR_RED    = '#f33e3e';
    const COLOR_GREY   = '#b8babf';


    const DEFAULT_CONFIG = {
        idleGap: 5,           // 空闲阈值（分钟）
        speedWindow: 30,      // 配速窗口（分钟）
        defaultTarget: 1200,  // 默认日目标
    };

    // ============ 状态 ============
    let currentUserId = null;
    let lastHistory   = null;
    let panelVisible  = true;
    let menuOpen      = false;
    let resizeObs     = null;
    // pageId → pageType 缓存（用于识别 SAMPLE 题目）
    // ============ 工具 ============
    const todayKey = (ts = Date.now()) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const loadJSON = (k, fb = null) => {
        try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; }
    };
    const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
    // 精度步长：0.05
    const STEP     = 0.05;
    // 四舍五入到最近的 0.05，并清掉浮点尾巴（最多 2 位小数）
    const round1   = n => {
        const v = Number(n);
        if (!isFinite(v)) return 0;
        return Math.round(Math.round(v / STEP) * STEP * 100) / 100;
    };

    // ============ 数据层 ============
    const loadData = () => loadJSON(DATA_KEY, {});
    const saveData = d  => saveJSON(DATA_KEY, d);
    const getToday = () => loadData()[todayKey()] || { target: 0, actual: 0, note: '' };
    const isTodayInit = () => !!loadData()[todayKey()];

    const loadConfig = () => ({ ...DEFAULT_CONFIG, ...loadJSON(CONFIG_KEY, {}) });
    const saveConfig = c => saveJSON(CONFIG_KEY, c);

    function setTodayField(field, value) {
        const d = loadData();
        const k = todayKey();
        if (!d[k]) d[k] = { target: 0, actual: 0, note: '' };
        if (field === 'note') {
            d[k].note = String(value || '').slice(0, 256);
        } else {
            let v = Number(value);
            if (!isFinite(v) || v < 0) v = 0;
            d[k][field] = round1(v);
        }
        saveData(d);
        refreshUI();
    }

    const loadEvents = () => {
        const o = loadJSON(EVENTS_KEY, { day: null, events: [] });
        return o.day === todayKey() && Array.isArray(o.events) ? o.events : [];
    };
    const saveEvents = events => saveJSON(EVENTS_KEY, { day: todayKey(), events });
    // 从 URL 里抠出 queueId
    function getQueueId(url, type /* 'verify' | 'recheck' */) {
      const re = type === 'recheck'
          ? /\/result\/recheck\/queue\/(\d+)\/answer/
          : /\/result\/verify\/queue\/(\d+)\/answer/;
      const m = String(url || '').match(re);
      return m ? Number(m[1]) : null;
    }

    // 计算权重
    function calcDelta(queueId, isRecheck) {
      let delta = isRecheck ? RECHECK_MULTIPLIER : 1;   // RECHECK 基础 1.1
      if (queueId != null && WEIGHTED_QUEUE_IDS.has(queueId)) {
        delta *= QUEUE_MULTIPLIER;                    // 命中高权重队列 ×1.5
      }
      return round1(delta);
    }
    function recordEvent(delta = 1) {
      delta = round1(delta);
      if (!(delta > 0)) return;              // ★ 0 或负数不计数（0×1.1 = 0）

      const events = loadEvents();
      events.push(Date.now());
      saveEvents(events);

      const d = loadData();
      const k = todayKey();
      if (!d[k]) d[k] = { target: 0, actual: 0, note: '' };
      d[k].actual = round1((Number(d[k].actual) || 0) + delta); // ★ 加 delta 而不是 1
      saveData(d);

      refreshUI();
    }


    // ============ 计数 ============
    function getHourCount() {
        const events = loadEvents();
        const now = new Date();
        const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
        return events.filter(t => t >= hourStart).length;
    }

    function computeSpeed() {
        const cfg = loadConfig();
        const events = loadEvents();
        if (events.length < 2) return null;
        const now = Date.now();
        const windowMs = cfg.speedWindow * 60 * 1000;
        const idleGap  = cfg.idleGap * 60 * 1000;
        const recent = events.filter(t => now - t < windowMs);
        if (recent.length < 2) return null;

        let activeTime = 0, activeCount = 0;
        for (let i = 1; i < recent.length; i++) {
            const gap = recent[i] - recent[i - 1];
            if (gap < idleGap) { activeTime += gap; activeCount++; }
        }
        if (activeTime < 60 * 1000) return null;
        return activeCount / (activeTime / 3600000);
    }

    function computeETA(speed) {
    if (!speed || speed < 0.5) return null;

    const cappedSpeed = Math.min(Number(speed), 175); // speed > 175 时按 175 计算

    const t = getToday();
    const remaining = Number(t.target) - Number(t.actual);
    if (remaining <= 0) return { done: true };

    const hours = remaining / cappedSpeed;
    return {
        done: false,
        hours,
        eta: new Date(Date.now() + hours * 3600000)
    };
}

    // ============ 面板 UI ============
    const fmt = n => {
      const v = Number(n) || 0;
      if (v % 1 === 0) return String(v);
      return String(parseFloat(v.toFixed(2)));  // 1.65 → "1.65"，1.50 → "1.5"
    };

    function updateProgressPath() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const path = panel.querySelector('.aa-progress-path');
        if (!path) return;
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const r = 10;
        const cx = w / 2;
        // 顶部中心 → 顺时针
        const d = [
            `M ${cx} 0`,
            `L ${w - r} 0`,
            `A ${r} ${r} 0 0 1 ${w} ${r}`,
            `L ${w} ${h - r}`,
            `A ${r} ${r} 0 0 1 ${w - r} ${h}`,
            `L ${r} ${h}`,
            `A ${r} ${r} 0 0 1 0 ${h - r}`,
            `L 0 ${r}`,
            `A ${r} ${r} 0 0 1 ${r} 0`,
            `L ${cx} 0`,
        ].join(' ');
        path.setAttribute('d', d);
        updateProgressFill();
    }

    function updateProgressFill() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const path = panel.querySelector('.aa-progress-path');
        if (!path) return;

        const t = getToday();
        const target = Number(t.target) || 0;
        const actual = Number(t.actual) || 0;

        let pct, color;
        if (target <= 0) {
            // 没排班 → 金色满
            pct = 100;
            color = COLOR_GOLD;
        } else {
            const raw = actual / target;
            pct = Math.min(100, raw * 100);
            color = raw >= 1 ? COLOR_GOLD : COLOR_BLUE;
        }
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
    }

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const el = document.createElement('div');
        el.id = PANEL_ID;
        el.style.cssText = `
            position: fixed; bottom: 20px; right: 20px;
            background: rgba(255,255,255,0.98);
            border-radius: 10px;
            padding: 14px 20px 12px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            user-select: none;
            cursor: grab;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            box-sizing: border-box;
            overflow: visible;
        `;
        el.innerHTML = `
            <svg style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible;">
                <path class="aa-progress-path" fill="none"
                      stroke="${COLOR_BLUE}" stroke-width="3" stroke-linecap="round"
                      pathLength="100" stroke-dasharray="0 100"/>
            </svg>
            <div style="display:flex;align-items:center;gap:18px;position:relative;">
                <div class="aa-actual" style="font-size:46px;font-weight:700;color:${COLOR_BLUE};line-height:1;min-width:56px;text-align:center;">0</div>
                <div style="display:flex;flex-direction:column;gap:6px;padding-right:2px;">
                    <div class="aa-hour"  style="font-size:20px;font-weight:600;color:#333;line-height:1;text-align:right;">0</div>
                    <div class="aa-speed" style="font-size:13px;color:#888;line-height:1;text-align:right;">--/h</div>
                </div>
            </div>
            <div class="aa-eta" style="margin-top:8px;font-size:12px;color:#999;text-align:center;">ETA --</div>
        `;
        document.body.appendChild(el);

        resizeObs = new ResizeObserver(updateProgressPath);
        resizeObs.observe(el);

        bindPanelInteractions(el);
        buildMenu(el);

        requestAnimationFrame(updateProgressPath);
    }

    function bindPanelInteractions(el) {
        let downX = 0, downY = 0, downTime = 0;
        let startLeft = 0, startTop = 0;
        let dragging = false, moved = false;

        el.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('#aa-menu')) return;   // 菜单内不触发
            downX = e.clientX;
            downY = e.clientY;
            downTime = Date.now();
            moved = false;
            dragging = true;

            const r = el.getBoundingClientRect();
            startLeft = r.left;
            startTop  = r.top;
            el.style.left = r.left + 'px';
            el.style.top  = r.top + 'px';
            el.style.bottom = 'auto';
            el.style.right  = 'auto';
            el.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const dx = e.clientX - downX;
            const dy = e.clientY - downY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
            const newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  startLeft + dx));
            const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop  + dy));
            el.style.left = newLeft + 'px';
            el.style.top  = newTop  + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            el.style.cursor = 'grab';
            const dt = Date.now() - downTime;
            if (!moved && dt < 300) toggleMenu();
        });
    }

    function refreshUI() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;

        const aEl = panel.querySelector('.aa-actual');
        const hEl = panel.querySelector('.aa-hour');
        const sEl = panel.querySelector('.aa-speed');
        const eEl = panel.querySelector('.aa-eta');

        const t = getToday();
        if (aEl) aEl.textContent = String(Math.floor(Number(t.actual) || 0));
        if (hEl) hEl.textContent = String(getHourCount());

        const sp = computeSpeed();
        if (sEl) sEl.textContent = sp ? `${sp.toFixed(0)}/h` : '--/h';

        const eta = computeETA(sp);
        if (eEl) {
            if (!eta) eEl.textContent = 'ETA --';
            else if (eta.done) eEl.textContent = '✅ 已完成';
            else {
                const etaMs = Date.now() + Math.round(eta.hours * 60) * 60000;
                const tt = new Date(etaMs);
                const now = new Date();
                const hh = String(tt.getHours()).padStart(2, '0');
                const mm = String(tt.getMinutes()).padStart(2, '0');
                let prefix = '';
                if (tt.toDateString() !== now.toDateString()) {
                    prefix = `${tt.getMonth() + 1}/${tt.getDate()} `;
                }
                eEl.textContent = `ETA ${prefix}${hh}:${mm}`;
            }
        }
        updateProgressFill();
    }

    // ============ 菜单 ============
    function buildMenu(panel) {
        const menu = document.createElement('div');
        menu.id = MENU_ID;
        menu.style.cssText = `
            position: absolute;
            bottom: 100%;
            right: 0;
            margin-bottom: 8px;
            background: rgba(255,255,255,0.98);
            border: 1px solid #e5e5e5;
            border-radius: 10px;
            padding: 14px 16px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            min-width: 250px;
            display: none;
            font-family: inherit;
            box-sizing: border-box;
            cursor: default;
        `;
        menu.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <span style="font-weight:600;color:#333;font-size:14px;">审核助手</span>
                <span class="aa-menu-close" style="cursor:pointer;color:#999;font-size:20px;line-height:1;padding:0 4px;">×</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
                <button class="aa-menu-btn" data-action="month"  style="padding:8px;background:#f5f5f5;border:none;border-radius:6px;cursor:pointer;font-size:13px;color:#333;">📅 月表</button>
                <button class="aa-menu-btn" data-action="export" style="padding:8px;background:#f5f5f5;border:none;border-radius:6px;cursor:pointer;font-size:13px;color:#333;">📥 导出</button>
            </div>
            <div style="border-top:1px solid #eee;padding-top:10px;font-size:12px;color:#666;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <label>空闲阈值</label>
                    <div><input type="number" id="aa-cfg-idle" min="1" max="60" style="width:52px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;text-align:right;"/> 分钟</div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <label>配速窗口</label>
                    <div><input type="number" id="aa-cfg-window" min="5" max="120" style="width:52px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;text-align:right;"/> 分钟</div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <label>默认目标</label>
                    <div><input type="number" id="aa-cfg-target" min="0" style="width:52px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;text-align:right;"/></div>
                </div>
            </div>
        `;
        panel.appendChild(menu);

        // 阻止面板拖动逻辑干扰菜单
        menu.addEventListener('mousedown', e => e.stopPropagation());

        menu.querySelector('.aa-menu-close').addEventListener('click', e => {
            e.stopPropagation();
            closeMenu();
        });
        menu.querySelector('[data-action="month"]').addEventListener('click', e => {
            e.stopPropagation();
            closeMenu();
            openMonthModal();
        });
        menu.querySelector('[data-action="export"]').addEventListener('click', e => {
            e.stopPropagation();
            exportXML();
        });

        // 配置
        const cfg = loadConfig();
        const inIdle   = menu.querySelector('#aa-cfg-idle');
        const inWindow = menu.querySelector('#aa-cfg-window');
        const inTarget = menu.querySelector('#aa-cfg-target');
        inIdle.value   = cfg.idleGap;
        inWindow.value = cfg.speedWindow;
        inTarget.value = cfg.defaultTarget;

        inIdle.addEventListener('change', e => {
            const c = loadConfig();
            c.idleGap = Math.max(1, Math.min(60, parseInt(e.target.value) || 5));
            saveConfig(c);
            e.target.value = c.idleGap;
            refreshUI();
        });
        inWindow.addEventListener('change', e => {
            const c = loadConfig();
            c.speedWindow = Math.max(5, Math.min(120, parseInt(e.target.value) || 30));
            saveConfig(c);
            e.target.value = c.speedWindow;
            refreshUI();
        });
        inTarget.addEventListener('change', e => {
            const c = loadConfig();
            c.defaultTarget = Math.max(0, parseInt(e.target.value) || 0);
            saveConfig(c);
            e.target.value = c.defaultTarget;
        });
    }

    function toggleMenu() {
        menuOpen ? closeMenu() : openMenu();
    }
    function openMenu() {
        const m = document.getElementById(MENU_ID);
        if (!m) return;
        m.style.display = 'block';
        menuOpen = true;
    }
    function closeMenu() {
        const m = document.getElementById(MENU_ID);
        if (!m) return;
        m.style.display = 'none';
        menuOpen = false;
    }

    // ============ 目标询问 ============
    function openTargetPrompt() {
        const cfg = loadConfig();
        openModal('设置今日目标', {
            target: { label: '今日目标（未排班填 0）', value: cfg.defaultTarget || 0 }
        }, out => {
            const v = parseFloat(out.target);
            setTodayField('target', isFinite(v) ? v : 0);
        }, { defaultValue: 0 });
    }

    // ============ 通用弹窗 ============
    function openModal(title, fields, onOk, opts = {}) {
        document.getElementById('aa-generic-modal')?.remove();
        const mask = document.createElement('div');
        mask.id = 'aa-generic-modal';
        mask.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999999;
            display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
        `;
        const fieldHtml = (id, label, val, hint = '') => `
            <label style="display:block;margin-bottom:12px;">
                <div style="font-size:12px;color:#666;margin-bottom:4px;">${label}</div>
                <input id="${id}" type="number" step="0.05" min="0" value="${val}"
                    style="width:100%;padding:8px 10px;font-size:16px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;" />
                ${hint ? `<div style="font-size:11px;color:#999;margin-top:4px;">${hint}</div>` : ''}
            </label>`;

        mask.innerHTML = `
            <div style="background:#fff;border-radius:10px;padding:22px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
                <h3 style="margin:0 0 16px;font-size:16px;color:#333;">${title}</h3>
                ${Object.entries(fields).map(([k, v]) => fieldHtml('aa-f-' + k, v.label, v.value, v.hint)).join('')}
                <div style="margin-top:8px;text-align:right;">
                    <button id="aa-ok" style="padding:6px 16px;background:${COLOR_BLUE};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">确定</button>
                </div>
            </div>`;
        document.body.appendChild(mask);

        const firstInput = mask.querySelector('input');
        if (firstInput) { firstInput.focus(); firstInput.select(); }

        const submit = () => {
            const out = {};
            for (const k of Object.keys(fields)) {
                const inp = mask.querySelector('#aa-f-' + k);
                out[k] = inp ? inp.value : '';
            }
            mask.remove();
            onOk(out);
        };
        mask.querySelector('#aa-ok').addEventListener('click', submit);
        mask.addEventListener('keydown', e => {
            if (e.key === 'Enter') submit();
        });
    }

    // ============ 月表 ============
    function openMonthModal() {
        document.getElementById(MONTH_ID)?.remove();
        const modal = document.createElement('div');
        modal.id = MONTH_ID;
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.5);
            z-index: 9999999; display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        `;
        document.body.appendChild(modal);

        let ym = todayKey().slice(0, 7);   // 'YYYY-MM'

        function render() {
            const data = loadData();
            const [y, m] = ym.split('-').map(Number);
            const daysInMonth = new Date(y, m, 0).getDate();

            let totalTarget = 0, totalActual = 0, completeDays = 0, scheduledDays = 0;
            const rows = [];
            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const rec = data[dateStr] || { target: 0, actual: 0, note: '' };
                const tg = Number(rec.target) || 0;
                const ac = Number(rec.actual) || 0;
                totalTarget += tg;
                totalActual += ac;
                if (tg > 0) {
                    scheduledDays++;
                    if (ac >= tg) completeDays++;
                }
                rows.push({ date: dateStr, day: d, target: tg, actual: ac, note: rec.note || '' });
            }
            const diff = round1(totalActual - totalTarget);
            const diffColor = diff >= 0 ? COLOR_GREEN : COLOR_RED;

            modal.innerHTML = `
                <div style="background:#fff;border-radius:12px;padding:20px;max-width:760px;width:92%;max-height:82vh;display:flex;flex-direction:column;box-sizing:border-box;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <button class="aa-m-prev" style="border:none;background:#f5f5f5;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:16px;">‹</button>
                            <span style="font-size:16px;font-weight:600;color:#333;">${y}年${m}月</span>
                            <button class="aa-m-next" style="border:none;background:#f5f5f5;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:16px;">›</button>
                        </div>
                        <span style="font-size:13px;color:#666;">已完成 <b style="color:${COLOR_BLUE};">${completeDays}</b> / ${scheduledDays} 天</span>
                        <button class="aa-m-close" style="border:none;background:none;font-size:22px;cursor:pointer;color:#999;line-height:1;">×</button>
                    </div>
                    <div style="overflow-y:auto;flex:1;border:1px solid #f0f0f0;border-radius:8px;">
                        <table style="width:100%;border-collapse:collapse;font-size:13px;">
                            <thead>
                                <tr style="background:#fafafa;position:sticky;top:0;z-index:1;">
                                    <th style="padding:8px 10px;text-align:left;font-weight:500;color:#666;border-bottom:1px solid #eee;">日期</th>
                                    <th style="padding:8px 10px;text-align:right;font-weight:500;color:#666;border-bottom:1px solid #eee;">目标</th>
                                    <th style="padding:8px 10px;text-align:right;font-weight:500;color:#666;border-bottom:1px solid #eee;">实际</th>
                                    <th style="padding:8px 10px;text-align:right;font-weight:500;color:#666;border-bottom:1px solid #eee;">差值</th>
                                    <th style="padding:8px 10px;text-align:left;font-weight:500;color:#666;border-bottom:1px solid #eee;">备注</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows.map(r => {
                                    const d = round1(r.actual - r.target);
                                    const dc = d >= 0 ? COLOR_GREEN : COLOR_RED;
                                    return `
                                        <tr style="border-bottom:1px solid #f5f5f5;">
                                            <td style="padding:6px 10px;color:#333;">${r.day}</td>
                                            <td style="padding:6px 10px;text-align:right;" class="aa-cell" data-date="${r.date}" data-field="target">${r.target || 0}</td>
                                            <td style="padding:6px 10px;text-align:right;" class="aa-cell" data-date="${r.date}" data-field="actual">${r.actual || 0}</td>
                                            <td style="padding:6px 10px;text-align:right;color:${dc};">${d > 0 ? '+' : ''}${d}</td>
                                            <td style="padding:6px 10px;color:#666;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" class="aa-cell" data-date="${r.date}" data-field="note" title="${r.note || ''}">${r.note || ''}</td>
                                        </tr>`;
                                }).join('')}
                            </tbody>
                            <tfoot>
                                <tr style="background:#fafafa;font-weight:600;border-top:2px solid #eee;">
                                    <td style="padding:8px 10px;color:#333;">合计</td>
                                    <td style="padding:8px 10px;text-align:right;">${round1(totalTarget)}</td>
                                    <td style="padding:8px 10px;text-align:right;">${round1(totalActual)}</td>
                                    <td style="padding:8px 10px;text-align:right;color:${diffColor};">${diff > 0 ? '+' : ''}${diff}</td>
                                    <td></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            `;

            modal.querySelector('.aa-m-close').onclick = () => modal.remove();
            modal.querySelector('.aa-m-prev').onclick = () => {
                const [yy, mm] = ym.split('-').map(Number);
                const d = new Date(yy, mm - 2, 1);
                ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                render();
            };
            modal.querySelector('.aa-m-next').onclick = () => {
                const [yy, mm] = ym.split('-').map(Number);
                const d = new Date(yy, mm, 1);
                ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                render();
            };

            // 行内编辑
            modal.querySelectorAll('.aa-cell').forEach(el => {
                el.style.cursor = 'text';
                el.style.transition = 'background 0.15s';
                el.addEventListener('mouseenter', () => { el.style.background = '#f0f7ff'; });
                el.addEventListener('mouseleave', () => { el.style.background = ''; });
                el.addEventListener('click', () => startEdit(el));
            });

            // 点击背景关闭
            modal.addEventListener('click', e => {
                if (e.target === modal) modal.remove();
            });
        }

        function startEdit(span) {
            if (span.dataset.editing === '1') return;
            span.dataset.editing = '1';
            const date = span.dataset.date;
            const field = span.dataset.field;
            const oldText = span.textContent;

            const input = document.createElement('input');
            if (field === 'note') {
                input.type = 'text';
                input.maxLength = 256;
            } else {
                input.type = 'number';
                input.step = '0.05';
                input.min = '0';
            }
            input.value = oldText;
            input.style.cssText = `
                width: 100%; padding: 2px 4px; box-sizing: border-box;
                border: 1px solid ${COLOR_BLUE}; border-radius: 3px;
                font-size: inherit; font-family: inherit; text-align: inherit; outline: none;
            `;
            span.textContent = '';
            span.appendChild(input);
            input.focus();
            input.select();

            let committed = false;
            const commit = () => {
                if (committed) return;
                committed = true;
                const data = loadData();
                if (!data[date]) data[date] = { target: 0, actual: 0, note: '' };
                if (field === 'note') {
                    data[date].note = input.value.trim().slice(0, 256);
                } else {
                    const v = Math.max(0, round1(parseFloat(input.value) || 0));
                    data[date][field] = v;
                }
                saveData(data);
                render();
                refreshUI();
            };
            const cancel = () => {
                if (committed) return;
                committed = true;
                render();
            };

            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
                if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', commit); cancel(); }
            });
        }

        render();
    }

    // ============ 老板键 ============
    function setupBossKey() {
        document.addEventListener('keydown', e => {
            if (e.key !== 'Home') return;
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            e.preventDefault();

            panelVisible = !panelVisible;
            if (panelVisible) {
                buildPanel();
                refreshUI();
            } else {
                closeMenu();
                document.getElementById(PANEL_ID)?.remove();
                document.getElementById('aa-generic-modal')?.remove();
                document.getElementById(MONTH_ID)?.remove();
                if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
            }
        }, true);
    }

    // ============ XML 导出 ============
    function exportXML() {
        const data = loadData();
        const dates = Object.keys(data).sort();
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<records>\n';
        for (const d of dates) {
            const rec = data[d] || {};
            const target = round1(Number(rec.target) || 0);
            const actual = round1(Number(rec.actual) || 0);
            const diff = round1(actual - target);
            const note = (rec.note || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            xml += `  <record date="${d}" target="${target}" actual="${actual}" diff="${diff}" note="${note}"/>\n`;
        }
        xml += '</records>';
        const blob = new Blob([xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit_records_${todayKey()}.xml`;
        a.click();
        URL.revokeObjectURL(url);
        //console.log('[AA] XML 已导出');
    }

   // ============ 网络拦截 ============
    function handleResponse(url, body, resp) {
    // current_user：记录当前登录用户 ID
    if (/\/user\/current_user/.test(url) && resp?.errorCode === 0) {
        currentUserId = resp.data?.id ?? null;
        console.log('当前用户ID是' + currentUserId);
        return;
    }

    // history：取响应数组最后一条作为「最新一条审核记录」
    if (/\/result\/queue\/\d+\/page\/\d+\/history/.test(url) && resp?.errorCode === 0) {
        const list = resp.data;
        if (Array.isArray(list) && list.length) {
            const latest = list[list.length - 1];   // ← 直接取最后一条，不排序
            lastHistory = {
                pageId: latest.pageId,
                latestUserId: latest.userId,
            };
            console.log('最新pageId是' + latest.pageId);
            console.log('最新用户ID是' + latest.userId);
        }
        return;
    }
            // verify answer
    if (/\/result\/verify\/queue\/\d+\/answer/.test(url) && resp?.errorCode === 0) {
        let p = {};
        try { p = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch {}

        if (p.scene !== 'RECHECK') {
            if (p.pageType === 'SAMPLE') return;   // ★ 直接判 SAMPLE，命中即跳过
            const queueId = getQueueId(url, 'verify');
            recordEvent(calcDelta(queueId, false));
        }
        return;
    }

        // recheck answer
        if (/\/result\/recheck\/queue\/\d+\/answer/.test(url) && resp?.errorCode === 0) {
    let p = {};
    try { p = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch {}
    if (!lastHistory) return;
    if (p.pageId && lastHistory.pageId !== p.pageId) return;
    if (lastHistory.latestUserId === currentUserId) return;
    if (!robotUserIds.includes(lastHistory.latestUserId)) return;
    const queueId = getQueueId(url, 'recheck');      // ★ 取 queueId
    recordEvent(calcDelta(queueId, true));           // ★ RECHECK ×1.1（可能再叠加 ×1.5）

    lastHistory.latestUserId = currentUserId;
    return;
}
    }

    function installHooks() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (m, url) {
            this.__aa_url = String(url || '');
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            const self = this;
            this.addEventListener('load', function () {
                try {
                    const url = self.__aa_url || '';
                    const resp = JSON.parse(self.responseText || '{}');
                    handleResponse(url, body, resp);
                } catch {}
            });
            return origSend.apply(this, arguments);
        };

        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const body = init && init.body;
            return origFetch.apply(this, arguments).then(resp => {
                resp.clone().json().then(d => handleResponse(url, body, d)).catch(() => {});
                return resp;
            });
        };
    }

    // ============ 初始化 ============
    function init() {
        buildPanel();
        refreshUI();
        setupBossKey();

        // 首次访问弹窗
        setTimeout(() => {
            if (!isTodayInit()) openTargetPrompt();
        }, 1000);

        // 每分钟检测跨天 + 刷新（自然小时切换）
        setInterval(() => {
            if (!isTodayInit()) openTargetPrompt();
            refreshUI();
        }, 60 * 1000);

        // 窗口 resize 时防止面板出界
        window.addEventListener('resize', () => {
            const el = document.getElementById(PANEL_ID);
            if (!el || !el.style.left) return;
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth)  el.style.left = (window.innerWidth  - r.width) + 'px';
            if (r.bottom > window.innerHeight) el.style.top  = (window.innerHeight - r.height) + 'px';
            if (r.left < 0) el.style.left = '0px';
            if (r.top  < 0) el.style.top  = '0px';
        });
        window.addEventListener('focus', refreshUI);

          document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
              refreshUI();
              if (!isTodayInit()) openTargetPrompt();
          }
        });
        // 暴露调试
        window.__AA__ = {
            get data() { return loadData(); },
            get events() { return loadEvents(); },
            get config() { return loadConfig(); },
            setTodayField,
            exportXML,
        };

    }

    installHooks();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    //console.log('%c[审核助手] v2 已加载（单击面板开菜单 / Home 老板键）','color:#0487ff;font-weight:bold');
})();
