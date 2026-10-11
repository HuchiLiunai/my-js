// ==UserScript==
// @name         投稿审核记录
// @namespace    https://example.com/audit-submit-stats
// @version      3.1.0
// @description  拦截审核提交接口，按作者聚合标签计数；悬浮窗显示当前作者历史（Home键开关）
// @match        https://test.baidu.com/argus/plaza/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ==================== 配置 ==================== */
    const DB_NAME = 'audit_author_stats_db';
    const DB_VERSION = 1;
    const STORE = 'authors';
    const TOP_N = 10;

        const TAG_COLORS = {
        /* ===== 组 1：涉政类（最高优先）→ 柔和红 ===== */
        '一号非负面':       { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },
        '国家领导人非负面': { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },
        '重要监管事业单位': { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },
        '敏感事件':         { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },
        '历史事件':         { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },
        '国家形象非负面':   { bg: '#fde8e8', fg: '#a01b1b', border: '#f0b8b8' },

        /* ===== 组 2：涉性类（中间）→ 柔和橙 ===== */
        '自伤自残':         { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '涉性软色情':       { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '低俗性感':         { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '非主流性向':       { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '涉性非违规':       { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },

        /* ===== 组 3：专业高危动作（深灰） ===== */
        '专业高危动作':     { bg: '#d1d5db', fg: '#1f2937', border: '#9ca3af' },

        /* ===== 组 4：不良导向类（中间）→ 柔和橙 ===== */
        '未成年人不良导向': { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '不良价值观':       { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '不当语言':         { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },
        '劣迹艺人':         { bg: '#fdefdd', fg: '#9a4a0c', border: '#f0d0a8' },

        /* ===== 组 5：导流广告类（较低）→ 柔和蓝 ===== */
        '联系方式':         { bg: '#e3eefc', fg: '#1c4f9c', border: '#b8d0ec' },
        '未授权平台导流':   { bg: '#e3eefc', fg: '#1c4f9c', border: '#b8d0ec' },
        '硬广':             { bg: '#e3eefc', fg: '#1c4f9c', border: '#b8d0ec' },
        '本地生活广告':     { bg: '#e3eefc', fg: '#1c4f9c', border: '#b8d0ec' },

        /* ===== 组 6：引人不适（单独组）→ 柔和紫，深浅两档 ===== */
        '重度引人不适':     { bg: '#ece0f5', fg: '#6a2c96', border: '#d0b8e3' },
        '轻度引人不适内容': { bg: '#f4ebfa', fg: '#8552b0', border: '#dfcdeb' },

        /* ===== 组 7：低质类（灰阶：深 → 浅） ===== */
        '黑边低质':         { bg: '#d6dae0', fg: '#3b4451', border: '#b0b6c0' },
        '随手拍低质':       { bg: '#ebedf0', fg: '#5b6473', border: '#cdd1d8' },

        /* ===== 组 8：通过 ===== */
        '通过':             { bg: '#dbf0dd', fg: '#1f6b2b', border: '#b0dcb8' },
    };
    const DEFAULT_COLOR = { bg: '#eef2ff', fg: '#4a6bff', border: '#c7d2fe' };
    const getTagColor = t => TAG_COLORS[t] || DEFAULT_COLOR;

    /* ==================== IndexedDB ==================== */
    let _dbPromise = null;
    function openDB() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'uid' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('open db failed'));
            req.onblocked = () => reject(new Error('db blocked'));
        });
        return _dbPromise;
    }

    const DB = {
        get(uid) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readonly');
                const r = t.objectStore(STORE).get(uid);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            }));
        },
        put(record) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).put(record);
                t.oncomplete = () => resolve();
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error || new Error('tx aborted'));
            }));
        },
        getAll() {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readonly');
                const r = t.objectStore(STORE).getAll();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            }));
        },
        del(uid) {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).delete(uid);
                t.oncomplete = () => resolve();
                t.onerror = () => reject(t.error);
            }));
        },
        clear() {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).clear();
                t.oncomplete = () => resolve();
                t.onerror = () => reject(t.error);
            }));
        },
        count() {
            return openDB().then(db => new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readonly');
                const r = t.objectStore(STORE).count();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            }));
        }
    };

    /* ==================== 拦截规则 ==================== */
    const authorByResultId = new Map();
    const authorByPageId = new Map();
    let currentUid = null;
    let pendingRefPageId = null;

    const RE_LOAD       = /\/result\/verify\/project\/[^/]+\/base-queue\/[^/]+\/get(\?|$)/;
    const RE_SUBMIT     = /\/result\/verify\/queue\/[^/]+\/answer(\?|$)/;
    const RE_REFS       = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;
    const RE_QUEUE_LIST = /\/result\/verify\/queue\/[^/]+\/list(\?|$)/;

    /* --------- 加载题目响应：缓存 authorId --------- */
    function captureLoad(url, data) {
        if (!data || !data.data) return;
        const task = data.data;
        const authorId = task.data && task.data.authorId;
        if (authorId == null) return;
        if (task.resultId != null) authorByResultId.set(task.resultId, authorId);
        if (task.pageId != null) authorByPageId.set(Number(task.pageId), authorId);
        //console.log('[审计统计] load 缓存 authorId=' + authorId +' | pageId=' + task.pageId + ' | resultId=' + task.resultId);
        tryResolvePendingRef();
    }

    /* --------- queue list（初始化一次性拉全部待审任务） --------- */
    function captureQueueList(url, data) {
        if (!data || !data.data) return;
        const list = data.data.pageList;
        if (!Array.isArray(list)) return;
        let n = 0;
        for (const task of list) {
            if (!task) continue;
            const authorId = task.data && task.data.authorId;
            if (authorId == null) continue;
            if (task.resultId != null) authorByResultId.set(task.resultId, authorId);
            if (task.pageId != null) authorByPageId.set(Number(task.pageId), authorId);
            n++;
        }
        //console.log('[审计统计] queue list 缓存了 ' + n + ' 个 authorId');
        tryResolvePendingRef();
    }

    /* --------- references：识别当前作者 --------- */
    function captureRefs(url) {
        const m = RE_REFS.exec(url);
        if (!m) return;
        const pageId = Number(m[1]);
        const authorId = authorByPageId.get(pageId);
        if (authorId == null) {
            pendingRefPageId = pageId;
            //console.log('[审计统计] refs pageId=' + pageId + ' 暂存，等待 authorId');
            return;
        }
        const nextUid = String(authorId);
        //console.log('[审计统计] refs pageId=' + pageId + ' → uid=' + nextUid);
        if (nextUid !== currentUid) {
            currentUid = nextUid;
            renderFloat();
        }
    }

    function tryResolvePendingRef() {
        if (pendingRefPageId == null) return;
        const authorId = authorByPageId.get(pendingRefPageId);
        if (authorId == null) return;
        const nextUid = String(authorId);
        const pid = pendingRefPageId;
        pendingRefPageId = null;
        //console.log('[审计统计] pending refs pageId=' + pid + ' 补齐 → uid=' + nextUid);
        if (nextUid !== currentUid) {
            currentUid = nextUid;
            renderFloat();
        }
    }

    /* --------- 提交响应：写库 + 刷新 --------- */
    async function captureSubmit(url, reqBody, respBody) {
        if (!respBody || respBody.errorCode !== 0) return;

        let req = reqBody;
        if (typeof req === 'string') {
            try { req = JSON.parse(req); } catch { return; }
        }
        if (!req || typeof req !== 'object') return;

        if (req.pageType === 'SAMPLE') {
            //console.log('[审计统计] SAMPLE 跳过');
            return;
        }

        const authorId = authorByPageId.get(Number(req.pageId))
            ?? authorByResultId.get(req.resultId);
        if (authorId == null) {
            console.warn('[审计统计] 未匹配到作者，跳过。pageId=', req.pageId, 'resultId=', req.resultId);
            return;
        }

        const tagKeys = [];
        if (req.result === 'pass') {
            tagKeys.push('通过');
        } else if (req.result === 'fail' && req.resultDetail && Array.isArray(req.resultDetail.tags)) {
            for (const tag of req.resultDetail.tags) {
                if (!tag) continue;
                const child = Array.isArray(tag.children) && tag.children[0];
                const key = (child && child.desc) || tag.desc;
                if (key) tagKeys.push(key);
            }
        }

        const uid = String(authorId);
        await upsertRecord(uid, tagKeys);
        //console.log('[审计统计] 已记录 uid=' + uid + ' result=' + req.result + ' tags=' + JSON.stringify(tagKeys));

        if (uid === currentUid) renderFloat();
        if (panelRefresh) { try { panelRefresh(); } catch (e) {} }
    }

    async function upsertRecord(uid, tagKeys) {
        const now = Date.now();
        const existing = await DB.get(uid);

        if (existing) {
            existing.tags = existing.tags || {};
            for (const k of tagKeys) existing.tags[k] = (existing.tags[k] || 0) + 1;
            existing.total = (existing.total || 0) + 1;
            existing.lastAt = now;
            existing.updatedAt = now;
            await DB.put(existing);
        } else {
            const tags = {};
            for (const k of tagKeys) tags[k] = (tags[k] || 0) + 1;
            await DB.put({ uid, tags, total: 1, firstAt: now, lastAt: now, updatedAt: now });
        }
    }

    /* ==================== Hook fetch ==================== */
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const reqBody = init && init.body;
        return origFetch.apply(this, arguments).then(res => {
            if (!url) return res;
            const isLoad   = RE_LOAD.test(url);
            const isSubmit = RE_SUBMIT.test(url);
            const isRefs   = RE_REFS.test(url);
            const isQL     = RE_QUEUE_LIST.test(url);
            if (!isLoad && !isSubmit && !isRefs && !isQL) return res;
            try {
                if (isRefs) captureRefs(url);
                if (isLoad || isSubmit || isQL) {
                    res.clone().json().then(data => {
                        if (isLoad) captureLoad(url, data);
                        else if (isQL) captureQueueList(url, data);
                        else captureSubmit(url, reqBody, data).catch(e => console.warn('[审计统计]', e));
                    }).catch(() => {});
                }
            } catch (e) {}
            return res;
        });
    };

    /* ==================== Hook XHR ==================== */
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__statsUrl = url;
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const self = this;
        self.addEventListener('load', function () {
            const url = self.__statsUrl;
            if (!url) return;
            const isLoad   = RE_LOAD.test(url);
            const isSubmit = RE_SUBMIT.test(url);
            const isRefs   = RE_REFS.test(url);
            const isQL     = RE_QUEUE_LIST.test(url);
            if (!isLoad && !isSubmit && !isRefs && !isQL) return;
            try {
                if (isRefs) captureRefs(url);
                if (isLoad || isSubmit || isQL) {
                    const data = JSON.parse(self.responseText);
                    if (isLoad) captureLoad(url, data);
                    else if (isQL) captureQueueList(url, data);
                    else captureSubmit(url, body, data).catch(e => console.warn('[审计统计]', e));
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    /* ==================== 工具 ==================== */
    const pad = n => String(n).padStart(2, '0');
    const fmtTime = ts => {
        if (!ts) return '-';
        const d = new Date(ts);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const stamp = () => {
        const d = new Date();
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    };
    const safeStringify = v => {
        try { const s = JSON.stringify(v, null, 2); return s === undefined ? String(v) : s; }
        catch { return String(v); }
    };
    function download(text, filename) {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    }

    /* ==================== 悬浮窗 ==================== */
    let floatEl = null;
    let panelRefresh = null;
    let renderSeq = 0;

    async function renderFloat() {
        if (!floatEl) return;
        const mySeq = ++renderSeq;
        const uid = currentUid;

        if (!uid) { paintShapes([{ type: 'default' }]); return; }

        let record = null;
        try { record = await DB.get(uid); } catch (e) {}
        if (mySeq !== renderSeq) return;

        if (!record || !record.tags || !Object.keys(record.tags).length) {
            paintShapes([{ type: 'default' }]);
            return;
        }
        const entries = Object.entries(record.tags)
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_N);
        paintShapes(entries.map(([k, v]) => ({ type: 'tag', label: k, count: v })));
    }

    function paintShapes(items) {
        if (!floatEl) return;
        floatEl.innerHTML = '';
        if (!items.length) items = [{ type: 'default' }];

        const first = items[0];
        const rest = items.slice(1);

        const main = document.createElement('div');
        main.className = 'as-shape as-shape-main';
        if (first.type === 'default') {
            main.classList.add('as-default');
            main.textContent = '统计';
        } else {
            const c = getTagColor(first.label);
            main.style.background = c.bg;
            main.style.color = c.fg;
            main.style.borderColor = c.border;
            const n = document.createElement('div');
            n.className = 'tag-name';
            n.textContent = first.label;
            const v = document.createElement('div');
            v.className = 'tag-count';
            v.textContent = '×' + first.count;
            main.append(n, v);
        }
        floatEl.appendChild(main);

        for (const item of rest) {
            const el = document.createElement('div');
            el.className = 'as-shape as-shape-extra';
            if (item.type === 'default') {
                el.classList.add('as-default');
                el.textContent = '统计';
            } else {
                const c = getTagColor(item.label);
                el.style.background = c.bg;
                el.style.color = c.fg;
                el.style.borderColor = c.border;
                el.textContent = `${item.label} ×${item.count}`;
            }
            floatEl.appendChild(el);
        }
    }

    /* ==================== 初始化 UI ==================== */
    function initUI() {
        if (!document.body) return;
        if (document.getElementById('audit-stats-host')) return;

        const host = document.createElement('div');
        host.id = 'audit-stats-host';
        host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });

        const CSS = `
        :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.5; color: #1f2330; }
        *, *::before, *::after { box-sizing: border-box; }

        .as-float {
            position: fixed; right: 24px; top: 45%;
            display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
            cursor: pointer; user-select: none; -webkit-user-select: none;
            touch-action: none; z-index: 2147483646;
        }
        .as-panel {
            position: fixed; width: 400px; height: 480px;
            max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
            background: #fff; border-radius: 14px;
            box-shadow: 0 18px 50px rgba(20,30,70,.22), 0 0 0 1px rgba(20,30,70,.06);
            display: none; flex-direction: column; overflow: hidden;
            z-index: 2147483647;
        }
        .as-shape {
            display: flex; align-items: center; justify-content: center;
            border: 1px solid;
            box-shadow: 0 4px 12px rgba(20,30,70,.16);
            transition: transform .12s, box-shadow .15s;
            white-space: nowrap;
        }
        .as-shape:hover { box-shadow: 0 6px 18px rgba(20,30,70,.22); }
        .as-shape:active { transform: scale(.96); }
        .as-shape-main {
            width: 76px; height: 76px; border-radius: 16px;
            font-size: 13px; font-weight: 700;
            flex-direction: column; line-height: 1.15; text-align: center;
            padding: 4px; overflow: hidden;
        }
        .as-shape-main .tag-name {
            font-size: 11px; max-width: 68px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .as-shape-main .tag-count { font-size: 18px; font-weight: 800; margin-top: 2px; }
        .as-shape-main.as-default {
            background: linear-gradient(135deg, #6f8dff, #4a6bff);
            color: #fff; border-color: #4a6bff;
        }
        .as-shape-extra {
            padding: 4px 10px; border-radius: 8px;
            font-size: 11px; font-weight: 600;
        }
        .as-shape-extra.as-default {
            background: #eef2ff; color: #4a6bff; border-color: #c7d2fe;
        }
        .as-panel.show { display: flex; }
        .as-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
            background: linear-gradient(135deg, #f7f9ff, #eef2ff); border-bottom: 1px solid #e7ebf7; flex-shrink: 0; }
        .as-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .as-title::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #4a6bff; box-shadow: 0 0 0 3px rgba(74,107,255,.18); }
        .as-close { width: 24px; height: 24px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
            cursor: pointer; color: #8b93ad; font-size: 14px; transition: background .15s, color .15s; }
        .as-close:hover { background: #e4e9f8; color: #333; }
        .as-tools { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid #eef1f9; flex-shrink: 0; }
        .as-btn { flex: 1; padding: 7px 8px; border: 1px solid #dde3f2; border-radius: 8px; background: #fff;
            color: #2c3450; font-size: 12px; font-family: inherit; cursor: pointer; transition: all .15s; }
        .as-btn:hover { background: #f4f7ff; border-color: #bcc9f0; }
        .as-btn.primary { background: #4a6bff; border-color: #4a6bff; color: #fff; }
        .as-btn.primary:hover { background: #3c5cf0; }
        .as-btn.danger { color: #d64545; border-color: #f0d5d5; }
        .as-btn.danger:hover { background: #fff5f5; border-color: #e8b4b4; }
        .as-list { flex: 1; overflow-y: auto; padding: 8px 10px; background: #fafbff; scrollbar-width: thin; min-height: 0; }
        .as-list::-webkit-scrollbar { width: 6px; }
        .as-list::-webkit-scrollbar-thumb { background: #ccd4ea; border-radius: 3px; }
        .as-empty { text-align: center; color: #a9b1c7; font-size: 12px; padding: 50px 20px; line-height: 2; }
        .as-item { background: #fff; border: 1px solid #e9edf9; border-radius: 10px; padding: 8px 10px; margin-bottom: 7px; transition: border-color .15s, box-shadow .15s; }
        .as-item:hover { border-color: #c6d2f5; box-shadow: 0 2px 8px rgba(74,107,255,.08); }
        .as-item.current { border-color: #4a6bff; background: #f5f8ff; }
        .as-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
        .as-item-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #939bb4; min-width: 0; }
        .as-item-uid { background: #eef2ff; color: #4a6bff; font-weight: 600; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }
        .as-item-total { background: #e8f8ee; color: #2c9e5f; font-weight: 600; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }
        .as-item-time { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .as-item-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .15s; flex-shrink: 0; }
        .as-item:hover .as-item-actions { opacity: 1; }
        .as-item-btn { border: none; background: transparent; font-family: inherit; font-size: 11px; color: #98a1bb;
            padding: 2px 6px; border-radius: 5px; cursor: pointer; transition: all .15s; }
        .as-item-btn:hover { background: #eef2ff; color: #4a6bff; }
        .as-item-btn.del:hover { background: #fff0f0; color: #e04b4b; }
        .as-item-tags { display: flex; flex-wrap: wrap; gap: 4px; }
        .as-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; display: inline-flex; gap: 4px; align-items: center; border: 1px solid; }
        .as-tag b { font-weight: 700; }
        .as-tag.none { background: #f3f4f8; border-color: #e3e6ee; color: #98a1bb; }
        .as-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 14px;
            border-top: 1px solid #eef1f9; background: #fff; font-size: 11px; color: #939bb4; flex-shrink: 0; }
        .as-status.ok { color: #2c9e5f; }
        .as-status.err { color: #d64545; }
        `;

        const HTML = `
        <div class="as-float" id="as-float"></div>
        <div class="as-panel" id="as-panel">
            <div class="as-head">
                <div class="as-title">审核提交统计（按作者）</div>
                <div class="as-close" id="as-close" title="关闭">✕</div>
            </div>
            <div class="as-tools">
                <button class="as-btn primary" id="as-import">导入</button>
                <button class="as-btn" id="as-export">导出</button>
                <button class="as-btn danger" id="as-clear">清空</button>
            </div>
            <div class="as-list" id="as-list"></div>
            <div class="as-status" id="as-status">
                <span id="as-status-text">就绪</span>
                <span id="as-count">0 位作者</span>
            </div>
        </div>
        `;

        shadow.innerHTML = `<style>${CSS}</style>${HTML}`;

        const $ = id => shadow.getElementById(id);
        floatEl = $('as-float');
        const panel = $('as-panel');
        const listEl = $('as-list');

        paintShapes([{ type: 'default' }]);

        let statusTimer = null;
        function setStatus(msg, type) {
            const el = $('as-status');
            const txt = $('as-status-text');
            txt.textContent = msg;
            el.className = 'as-status' + (type ? ' ' + type : '');
            clearTimeout(statusTimer);
            if (type) {
                statusTimer = setTimeout(() => {
                    txt.textContent = '就绪';
                    el.className = 'as-status';
                }, 4000);
            }
        }

        const pos = { right: 0, top: 0 };
        let drag = null;
        const placeFloat = () => {
            floatEl.style.left = 'auto';
            floatEl.style.bottom = 'auto';
            floatEl.style.right = pos.right + 'px';
            floatEl.style.top = pos.top + 'px';
        };
        function initBall() {
            const rect = floatEl.getBoundingClientRect();
            pos.right = Math.max(4, window.innerWidth - rect.right);
            pos.top = rect.top;
            placeFloat();
        }
        function positionPanel() {
            if (!panel.classList.contains('show')) return;
            const rect = floatEl.getBoundingClientRect();
            const pw = panel.offsetWidth;
            const ph = panel.offsetHeight;
            let left = rect.right - pw;
            let top = rect.top + rect.height / 2 > window.innerHeight / 2
                ? rect.top - ph - 12
                : rect.bottom + 12;
            left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
            top = Math.max(12, Math.min(top, window.innerHeight - ph - 12));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        }

        floatEl.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
                originRight: pos.right, originTop: pos.top, moved: false };
            try { floatEl.setPointerCapture(e.pointerId); } catch (_) {}
        });
        floatEl.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
            if (!drag.moved) return;
            const fw = floatEl.offsetWidth || 76;
            const fh = floatEl.offsetHeight || 76;
            pos.right = Math.max(4, Math.min(drag.originRight - dx, window.innerWidth - fw - 4));
            pos.top = Math.max(4, Math.min(drag.originTop + dy, window.innerHeight - fh - 4));
            placeFloat();
            positionPanel();
        });
        function endDrag(e) {
            if (!drag || (e && e.pointerId !== drag.pointerId)) return;
            const moved = drag.moved;
            drag = null;
            if (e) { try { floatEl.releasePointerCapture(e.pointerId); } catch (_) {} }
            if (!moved) togglePanel();
        }
        floatEl.addEventListener('pointerup', endDrag);
        floatEl.addEventListener('pointercancel', () => { drag = null; });

        function togglePanel(force) {
            const show = typeof force === 'boolean' ? force : !panel.classList.contains('show');
            if (show) { panel.classList.add('show'); positionPanel(); refreshPanel(); }
            else panel.classList.remove('show');
        }

        window.addEventListener('resize', () => {
            const fw = floatEl.offsetWidth || 76;
            const fh = floatEl.offsetHeight || 76;
            pos.right = Math.max(4, Math.min(pos.right, window.innerWidth - fw - 4));
            pos.top = Math.min(pos.top, window.innerHeight - fh - 4);
            placeFloat(); positionPanel();
        });

        $('as-close').addEventListener('click', () => togglePanel(false));

        function renderItem(row) {
            const item = document.createElement('div');
            item.className = 'as-item' + (row.uid === currentUid ? ' current' : '');

            const head = document.createElement('div');
            head.className = 'as-item-head';

            const meta = document.createElement('div');
            meta.className = 'as-item-meta';

            const uidEl = document.createElement('span');
            uidEl.className = 'as-item-uid';
            uidEl.textContent = 'UID ' + row.uid;

            const totalEl = document.createElement('span');
            totalEl.className = 'as-item-total';
            totalEl.textContent = '×' + (row.total || 0);

            const timeEl = document.createElement('span');
            timeEl.className = 'as-item-time';
            timeEl.textContent = fmtTime(row.lastAt || row.updatedAt);

            meta.append(uidEl, totalEl, timeEl);

            const actions = document.createElement('div');
            actions.className = 'as-item-actions';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'as-item-btn';
            copyBtn.textContent = '复制';
            copyBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const text = safeStringify(row);
                try {
                    await navigator.clipboard.writeText(text);
                    setStatus('已复制 UID ' + row.uid, 'ok');
                } catch (_) {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
                    document.body.appendChild(ta); ta.select();
                    try { document.execCommand('copy'); setStatus('已复制', 'ok'); }
                    catch (__) { setStatus('复制失败', 'err'); }
                    ta.remove();
                }
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'as-item-btn del';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', async e => {
                e.stopPropagation();
                await DB.del(row.uid);
                await refreshPanel();
                if (row.uid === currentUid) renderFloat();
                setStatus('已删除 UID ' + row.uid, 'ok');
            });

            actions.append(copyBtn, delBtn);
            head.append(meta, actions);

            const tagsWrap = document.createElement('div');
            tagsWrap.className = 'as-item-tags';
            const entries = Object.entries(row.tags || {});
            if (!entries.length) {
                const none = document.createElement('span');
                none.className = 'as-tag none';
                none.textContent = '无标签';
                tagsWrap.appendChild(none);
            } else {
                entries.sort((a, b) => b[1] - a[1]);
                for (const [k, v] of entries) {
                    const c = getTagColor(k);
                    const t = document.createElement('span');
                    t.className = 'as-tag';
                    t.style.background = c.bg;
                    t.style.color = c.fg;
                    t.style.borderColor = c.border;
                    t.append(document.createTextNode(k + ' '));
                    const b = document.createElement('b');
                    b.textContent = '×' + v;
                    t.appendChild(b);
                    tagsWrap.appendChild(t);
                }
            }

            item.append(head, tagsWrap);
            return item;
        }

        function renderList(rows) {
            listEl.innerHTML = '';
            if (!rows.length) {
                const empty = document.createElement('div');
                empty.className = 'as-empty';
                empty.innerHTML = '暂无数据<br>正常做题提交后会自动记录';
                listEl.appendChild(empty);
                return;
            }
            rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            const frag = document.createDocumentFragment();
            rows.forEach(r => frag.appendChild(renderItem(r)));
            listEl.appendChild(frag);
        }

        async function refreshPanel() {
            const rows = await DB.getAll();
            renderList(rows);
            $('as-count').textContent = rows.length + ' 位作者';
            return rows;
        }
        panelRefresh = refreshPanel;

        async function doImport(json) {
            let records;
            if (Array.isArray(json)) records = json;
            else if (json && typeof json === 'object') records = [json];
            else { setStatus('导入内容格式不支持', 'err'); return; }

            let okCount = 0;
            for (const r of records) {
                if (!r || typeof r !== 'object') continue;
                if (r.uid == null || typeof r.tags !== 'object') continue;
                const uid = String(r.uid);
                const existing = await DB.get(uid);
                if (existing) {
                    existing.tags = existing.tags || {};
                    for (const [k, v] of Object.entries(r.tags || {})) {
                        existing.tags[k] = (existing.tags[k] || 0) + (Number(v) || 0);
                    }
                    existing.total = (existing.total || 0) + (Number(r.total) || 0);
                    existing.firstAt = Math.min(existing.firstAt || Infinity, r.firstAt || Date.now());
                    existing.lastAt = Math.max(existing.lastAt || 0, r.lastAt || 0);
                    existing.updatedAt = Date.now();
                    await DB.put(existing);
                } else {
                    const now = Date.now();
                    await DB.put({
                        uid,
                        tags: r.tags || {},
                        total: Number(r.total) || 0,
                        firstAt: Number(r.firstAt) || now,
                        lastAt: Number(r.lastAt) || now,
                        updatedAt: Number(r.updatedAt) || now
                    });
                }
                okCount++;
            }
            await refreshPanel();
            if (currentUid) renderFloat();
            setStatus('已导入 ' + okCount + ' 条', 'ok');
        }

        $('as-import').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            shadow.appendChild(input);
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                input.remove();
                if (!file) return;
                try {
                    const text = await file.text();
                    await doImport(JSON.parse(text));
                } catch (err) {
                    console.error('[审计统计] 导入失败', err);
                    setStatus('导入失败：' + (err.message || err), 'err');
                }
            });
            input.click();
        });

        $('as-export').addEventListener('click', async () => {
            try {
                const rows = await DB.getAll();
                if (!rows.length) { setStatus('没有数据可导出', 'err'); return; }
                rows.sort((a, b) => a.uid.localeCompare(b.uid));
                download(JSON.stringify(rows, null, 2), 'audit-stats-' + stamp() + '.json');
                setStatus('已导出 ' + rows.length + ' 条', 'ok');
            } catch (err) {
                console.error('[审计统计] 导出失败', err);
                setStatus('导出失败：' + (err.message || err), 'err');
            }
        });

        $('as-clear').addEventListener('click', async () => {
            const n = await DB.count();
            if (!n) { setStatus('当前没有数据', 'err'); return; }
            if (!window.confirm(`确定清空全部 ${n} 位作者的统计数据？此操作不可恢复。`)) return;
            await DB.clear();
            await refreshPanel();
            if (currentUid) renderFloat();
            setStatus('已清空', 'ok');
        });

        /* ==================== Home 键开关（仅视觉） ==================== */
        let uiVisible = true;
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Home') return;
            // 正在输入框里编辑时不抢 Home 键（保留光标到行首功能）
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

            e.preventDefault();   // 只挡浏览器"滚到页首"，不 stopPropagation，不影响其他脚本

            uiVisible = !uiVisible;
            if (uiVisible) {
                floatEl.style.display = '';
            } else {
                floatEl.style.display = 'none';
                panel.classList.remove('show');   // 隐藏时顺手收起面板
            }
        });

        requestAnimationFrame(() => {
            initBall();
            renderFloat();
        });

        refreshPanel().catch(err => {
            console.error('[审计统计]', err);
            setStatus('初始化失败：' + (err.message || err), 'err');
        });
    }

    /* ==================== 启动 ==================== */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

    //console.log('[审计统计 v3] 已加载，拦截已启用');
})();