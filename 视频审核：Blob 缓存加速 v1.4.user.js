// ==UserScript==
// @name         视频审核：Blob 缓存加速
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  active 独占 + 中断续传；通过/不通过 1 分钟后清缓存；释放降优先级；失败分级 TTL（404/410/403 永久失效，5xx 短退避）；active 失败退避防死循环
// @match        https://test.baidu.com/argus/*
// @exclude      https://test.baidu.com/argus/plaza/*/recheck/*
// @exclude      https://test.baidu.com/argus/plaza/*/appeal/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ============ 配置 ============
    const MAX_TOTAL_SIZE     = 1024 * 1024 * 1024;
    const MAX_CONCURRENT     = 2;
    const MAX_PROGRESS_SIZE  = 300 * 1024 * 1024;
    const PRELOAD_AHEAD      = 15;
    const PRELOAD_BEHIND     = 15;
    const AGGRESSIVE_AHEAD   = 5;    // config/list 触发的激进预加载
    const AGGRESSIVE_BEHIND  = 3;
    const AGGRESSIVE_WINDOW  = 30 * 1000;
    const PASS_FAIL_TTL      = 60 * 1000;
    const FAILED_TTL         = 3 * 60 * 1000;    // 网络 / 5xx / 超时：可重试
    const NOT_FOUND_TTL      = 30 * 60 * 1000;   // 404 / 410 / 403：长时间不再碰
    const ACTIVE_BACKOFF     = 5 * 1000;         // active 失败后的最小退避
    const DEBUG              = true;

    const log  = DEBUG ? console.log.bind(console,  '[video-cache]') : () => {};
    const warn = console.warn.bind(console, '[video-cache]');

    // ============ 状态 ============
    const cache   = new Map();          // origUrl → { blobUrl, size, ts }
    const reverse = new Map();          // blobUrl → origUrl
    const queue   = [];                 // 待下载队列
    const pending = new Set();          // 正在下载
    const failed  = new Map();          // url → { until, status }
    const downloadStates = new Map();   // url → { chunks, received, controller, ... }
    const pendingCleanup = new Map();   // url → expireAt（通过/不通过 1 分钟后清）
    let aggressiveUntil = 0;            // 激进预加载截止时间
    let activeRetryTimer = null;        // active 失败退避重试

    let downloading = 0;
    let totalSize = 0;
    let progressSize = 0;
    let activeUrl = null;
    let processing = false;

    // ============ 工具 ============
    const short = u => !u ? '' : (u.length > 60 ? u.slice(-60) : u);
    const mb    = b => (b / 1024 / 1024).toFixed(2) + 'MB';

    function isFailed(url) {
        const e = failed.get(url);
        if (!e) return false;
        if (Date.now() > e.until) { failed.delete(url); return false; }
        return true;
    }

    function markFailed(url, ttl, status) {
        failed.set(url, { until: Date.now() + ttl, status: status || 0 });
    }

    // ============ 安全撤销 ============
    function safeRevoke(blobUrl) {
        const inUse = [...document.querySelectorAll('video')].some(v => {
            const s = v.getAttribute('src') || v.src;
            return s === blobUrl;
        });
        if (inUse) setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
        else URL.revokeObjectURL(blobUrl);
        reverse.delete(blobUrl);
    }

    // ============ LRU ============
    function evictIfNeeded() {
        if (totalSize <= MAX_TOTAL_SIZE) return;
        const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (const [url, meta] of entries) {
            if (totalSize <= MAX_TOTAL_SIZE) break;
            if (url === activeUrl) continue;
            safeRevoke(meta.blobUrl);
            cache.delete(url);
            totalSize -= meta.size;
            log('LRU 淘汰', short(url), mb(meta.size));
        }
    }

    function evictProgressIfNeeded() {
        if (progressSize <= MAX_PROGRESS_SIZE) return;
        const entries = [...downloadStates.entries()]
            .filter(([url]) => url !== activeUrl)
            .sort((a, b) => a[1].ts - b[1].ts);
        for (const [url, state] of entries) {
            if (progressSize <= MAX_PROGRESS_SIZE) break;
            if (pending.has(url)) continue;
            progressSize -= state.received;
            downloadStates.delete(url);
            log('淘汰中断进度', short(url), mb(state.received));
        }
    }

    // ============ active 失败退避重试 ============
    function scheduleActiveRetry(url) {
        clearTimeout(activeRetryTimer);
        activeRetryTimer = setTimeout(() => {
            if (activeUrl !== url) return;
            if (cache.has(url) || pending.has(url)) return;
            failed.delete(url);
            if (!queue.includes(url)) queue.unshift(url);
            log('active 退避结束，重试', short(url));
            processQueue();
        }, ACTIVE_BACKOFF + 200);
    }

    // ============ 下载 ============
    async function download(url) {
        if (!url || url.startsWith('blob:')) return;
        if (cache.has(url) || pending.has(url)) return;
        if (isFailed(url)) return;

        downloading++;
        pending.add(url);
        const t0 = performance.now();

        let state = downloadStates.get(url);
        if (!state) {
            state = {
                chunks: [],
                received: 0,
                total: 0,
                controller: null,
                supportsRange: true,
                purged: false,
                ts: Date.now(),
            };
            downloadStates.set(url, state);
        }
        state.purged = false;
        state.ts = Date.now();
        state.controller = new AbortController();
        const { controller } = state;

        try {
            const headers = {};
            if (state.received > 0) headers['Range'] = `bytes=${state.received}-`;

            const resp = await fetch(url, {
                signal: controller.signal,
                headers,
                credentials: 'omit',
                cache: 'default',
            });

            if (!resp.ok && resp.status !== 206) {
                // 尽量把 body 消费掉，避免连接悬挂
                try { await resp.body?.cancel(); } catch {}
                const err = new Error('HTTP ' + resp.status);
                err.status = resp.status;
                throw err;
            }

            if (resp.status === 206) {
                const cr = resp.headers.get('Content-Range');
                if (cr) {
                    const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
                    if (m) {
                        const start = parseInt(m[1], 10);
                        const total = m[3] === '*' ? 0 : parseInt(m[3], 10);
                        if (start !== state.received) {
                            log('续传起点不符，重头下载', short(url));
                            progressSize -= state.received;
                            state.chunks = [];
                            state.received = 0;
                        }
                        state.total = total;
                    }
                }
            } else {
                if (state.received > 0) {
                    progressSize -= state.received;
                    state.chunks = [];
                    state.received = 0;
                }
                const len = resp.headers.get('Content-Length');
                if (len) state.total = parseInt(len, 10) || 0;
            }

            const reader = resp.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                state.chunks.push(value);
                state.received += value.length;
                progressSize += value.length;
            }

            if (!pending.has(url) || state.purged) {
                progressSize -= state.received;
                downloadStates.delete(url);
                return;
            }

            const blob = new Blob(state.chunks);
            const blobUrl = URL.createObjectURL(blob);
            cache.set(url, { blobUrl, size: blob.size, ts: Date.now() });
            reverse.set(blobUrl, url);
            totalSize += blob.size;

            progressSize -= state.received;
            downloadStates.delete(url);

            // 成功后清掉失败标记（防止旧标记影响后续判断）
            failed.delete(url);

            evictIfNeeded();
            log('完成', short(url), mb(blob.size), ((performance.now() - t0) / 1000).toFixed(1) + 's');
        } catch (e) {
            if (e.name === 'AbortError') {
                if (state.purged || !pending.has(url)) {
                    progressSize -= state.received;
                    downloadStates.delete(url);
                } else {
                    log('已中止，保留进度', short(url), mb(state.received));
                    if (!queue.includes(url) && !cache.has(url)) queue.push(url);
                }
            } else {
                const s = e.status;
                const isGone = s === 404 || s === 410 || s === 403;

                const ttl = isGone
                    ? NOT_FOUND_TTL
                    : (url === activeUrl ? ACTIVE_BACKOFF : FAILED_TTL);

                warn(
                    '失败',
                    short(url),
                    e.message,
                    isGone ? '(永久失效，冷却 ' + (NOT_FOUND_TTL / 60000) + ' 分钟)' : ''
                );
                markFailed(url, ttl, s);

                progressSize -= state.received;
                downloadStates.delete(url);

                // active 的临时失败：安排一次退避重试
                if (url === activeUrl && !isGone) {
                    scheduleActiveRetry(url);
                }
            }
        } finally {
            downloading--;
            pending.delete(url);
            evictProgressIfNeeded();
            processQueue();
        }
    }

    // ============ 抢占 ============
    function abortNonActive() {
        for (const [url, state] of downloadStates) {
            if (url === activeUrl) continue;
            if (!pending.has(url)) continue;
            if (!state.controller) continue;
            log('抢占中止非 active', short(url), mb(state.received));
            try { state.controller.abort(); } catch {}
            if (!queue.includes(url) && !cache.has(url)) queue.push(url);
        }
    }

    // ============ 调度 ============
    function processQueue() {
        if (processing) return;
        processing = true;
        try {
            // 1) active 独占（若 active 正处于失败冷却期，则跳过这一步，允许其它任务并发）
            if (activeUrl && !cache.has(activeUrl) && !pending.has(activeUrl) && !isFailed(activeUrl)) {
                abortNonActive();
                if (downloading > 0) {
                    const i = queue.indexOf(activeUrl);
                    if (i > -1) queue.splice(i, 1);
                    queue.unshift(activeUrl);
                    return;
                }
                const i = queue.indexOf(activeUrl);
                if (i > -1) queue.splice(i, 1);
                download(activeUrl);
                return;
            }

            // 2) active 正在下载：其它等待
            if (activeUrl && pending.has(activeUrl)) return;

            // 3) 正常并发
            while (queue.length && downloading < MAX_CONCURRENT) {
                const url = queue.shift();
                if (cache.has(url) || pending.has(url) || isFailed(url)) continue;
                download(url);
            }
        } finally {
            processing = false;
        }
    }

    // ============ 劫持 src ============
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const origSetter = desc.set;
    const origGetter = desc.get;

    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get() { return origGetter.call(this); },
        set(value) {
            if (!value || typeof value !== 'string' || value.startsWith('blob:')) {
                return origSetter.call(this, value);
            }
            if (value !== activeUrl) {
                activeUrl = value;
                failed.delete(value);
                log('active 切换（src）', short(value));
                abortNonActive();
            }
            const hit = cache.get(value);
            if (hit) {
                hit.ts = Date.now();
                log('命中', short(value));
                return origSetter.call(this, hit.blobUrl);
            }
            processQueue();
            return origSetter.call(this, value);
        }
    });

    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (name === 'src' && this.tagName === 'VIDEO' &&
            value && typeof value === 'string' && !value.startsWith('blob:')) {
            if (value !== activeUrl) {
                activeUrl = value;
                failed.delete(value);
                log('active 切换（setAttribute）', short(value));
                abortNonActive();
            }
            const hit = cache.get(value);
            if (hit) {
                hit.ts = Date.now();
                return origSetAttr.call(this, name, hit.blobUrl);
            }
            processQueue();
        }
        return origSetAttr.call(this, name, value);
    };

    // ============ 卡片状态 ============
    function getCardStatus(card) {
        const tag = card.querySelector(':scope > .tag');
        if (!tag) return 'pending';
        const text = (tag.textContent || '').trim();
        if (text === '通过') return 'pass';
        if (text === '不通过') return 'fail';
        if (text === '释放') return 'released';
        return 'pending';
    }

    function getCardUrl(card) {
        const v = card.querySelector('video');
        if (!v) return null;
        let src = v.getAttribute('src') || v.src;
        if (!src) return null;
        if (src.startsWith('blob:')) src = reverse.get(src) || null;
        return src;
    }

    function buildUrlStatus(cards) {
        const map = new Map();
        for (const card of cards) {
            const url = getCardUrl(card);
            if (!url) continue;
            const status = getCardStatus(card);
            if (!map.has(url)) map.set(url, { hasReleased: false, hasPending: false, hasPassOrFail: false });
            const e = map.get(url);
            if (status === 'released') e.hasReleased = true;
            else if (status === 'pending') e.hasPending = true;
            else e.hasPassOrFail = true;
        }
        return map;
    }

    // ============ 通过/不通过清理 ============
    function processCleanup(cards) {
        const now = Date.now();

        for (const card of cards) {
            const status = getCardStatus(card);
            if (status !== 'pass' && status !== 'fail') continue;
            const url = getCardUrl(card);
            if (!url) continue;
            if (!cache.has(url)) continue;
            if (pendingCleanup.has(url)) continue;
            pendingCleanup.set(url, now + PASS_FAIL_TTL);
            log('登记清理', short(url), '60s 后清除');
        }

        for (const [url, expireAt] of [...pendingCleanup]) {
            if (now < expireAt) continue;
            pendingCleanup.delete(url);
            if (url === activeUrl) continue;
            purgeUrl(url);
        }
    }

    // ============ 预加载 ============
    function preloadAroundActive() {
        const cards = [...document.querySelectorAll('.slid-list .video-card')];
        if (!cards.length) return;

        const activeIdx = cards.findIndex(c => c.classList.contains('active'));
        if (activeIdx < 0) return;

        const newActiveUrl = getCardUrl(cards[activeIdx]);
        if (newActiveUrl && newActiveUrl !== activeUrl) {
            activeUrl = newActiveUrl;
            failed.delete(activeUrl);
            log('active 切换（list）', short(activeUrl));
            abortNonActive();
        }

        const urlStatus = buildUrlStatus(cards);

        processCleanup(cards);

        const aggressive = Date.now() < aggressiveUntil;
        const ahead  = aggressive ? AGGRESSIVE_AHEAD  : PRELOAD_AHEAD;
        const behind = aggressive ? AGGRESSIVE_BEHIND : PRELOAD_BEHIND;

        const activeCards    = [];
        const normalPending  = [];
        const releasedOnly   = [];

        const pushActive = i => {
            if (i < 0 || i >= cards.length) return;
            const url = getCardUrl(cards[i]);
            if (url && !activeCards.includes(url)) activeCards.push(url);
        };
        pushActive(activeIdx);
        for (let i = 1; i <= ahead;  i++) pushActive(activeIdx + i);
        for (let i = 1; i <= behind; i++) pushActive(activeIdx - i);

        for (let i = 0; i < cards.length; i++) {
            if (i === activeIdx) continue;
            const url = getCardUrl(cards[i]);
            if (!url) continue;
            if (activeCards.includes(url)) continue;
            const stat = urlStatus.get(url);
            if (!stat) continue;

            if (stat.hasPending) {
                if (!normalPending.includes(url)) normalPending.push(url);
            } else if (stat.hasReleased && !stat.hasPassOrFail) {
                if (!releasedOnly.includes(url)) releasedOnly.push(url);
            }
        }

        const order = [...activeCards, ...normalPending, ...releasedOnly];

        for (let i = order.length - 1; i >= 0; i--) {
            const u = order[i];
            const idx = queue.indexOf(u);
            if (idx >= 0) queue.splice(idx, 1);
            if (!cache.has(u) && !pending.has(u) && !isFailed(u)) queue.unshift(u);
        }
        processQueue();
    }

    // ============ 清理 ============
    function purgeUrl(url) {
        if (!url || url.startsWith('blob:')) return;

        const meta = cache.get(url);
        if (meta) {
            if (url === activeUrl) {
                const v = document.querySelector('video.vjs-tech') || document.querySelector('video');
                if (v) {
                    const s = v.getAttribute('src') || v.src;
                    if (s === meta.blobUrl) origSetter.call(v, url);
                }
            }
            safeRevoke(meta.blobUrl);
            cache.delete(url);
            totalSize -= meta.size;
            log('清理缓存', short(url));
        }

        const qi = queue.indexOf(url);
        if (qi > -1) queue.splice(qi, 1);

        if (downloadStates.has(url)) {
            const state = downloadStates.get(url);
            state.purged = true;
            if (state.controller) { try { state.controller.abort(); } catch {} }
            progressSize -= state.received;
            downloadStates.delete(url);
            log('清理下载进度', short(url));
        }

        pending.delete(url);
        failed.delete(url);
        pendingCleanup.delete(url);

        if (url === activeUrl) activeUrl = null;
    }

    function purgeCurrentVideo() {
        const v = document.querySelector('video.vjs-tech') || document.querySelector('video');
        if (!v) return;
        let src = v.getAttribute('src') || v.src;
        if (src && src.startsWith('blob:')) src = reverse.get(src) || src;
        if (!src || src.startsWith('blob:')) return;
        purgeUrl(src);
    }

    // ============ 网络监听 ============
    let listTimer = null;
    function schedulePreload(delay, aggressive) {
        if (aggressive) aggressiveUntil = Date.now() + AGGRESSIVE_WINDOW;
        clearTimeout(listTimer);
        listTimer = setTimeout(preloadAroundActive, delay);
    }

    function handleUrl(url) {
        if (!url || typeof url !== 'string') return;

        if (/\/result\/verify\/queue\/\d+\/list/.test(url)) {
            schedulePreload(800, true);
            return;
        }
        if (/\/project\/\d+\/base\/\d+\/config/.test(url)) {
            schedulePreload(800, true);
            return;
        }
        if (/\/result\/(verify|recheck)\/queue\/\d+\/answer/.test(url)) {
            const v = document.querySelector('video.vjs-tech') || document.querySelector('video');
            let submittedSrc = v && (v.getAttribute('src') || v.src);
            if (submittedSrc && submittedSrc.startsWith('blob:')) {
                submittedSrc = reverse.get(submittedSrc) || null;
            }
            setTimeout(() => {
                if (submittedSrc && !submittedSrc.startsWith('blob:')) purgeUrl(submittedSrc);
                schedulePreload(500, false);
            }, 1500);
            return;
        }
    }
        // ============ 复制视频链接：右键菜单 + 快捷键 Alt+C ============
    const MENU_STYLE_ID = 'vc-ctx-style';
    const MENU_ID       = 'vc-ctx-menu';
    const TOAST_ID      = 'vc-toast';

    let ctxMenuEl  = null;
    let toastTimer = null;

    function ensureMenuStyle() {
        if (document.getElementById(MENU_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = MENU_STYLE_ID;
        style.textContent = `
#${MENU_ID}{position:fixed;z-index:2147483647;min-width:180px;padding:6px 0;background:#fff;
  border:1px solid rgba(0,0,0,.12);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.18);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#333;user-select:none;-webkit-user-select:none;}
#${MENU_ID} .vc-item{padding:8px 14px;cursor:pointer;white-space:nowrap;display:flex;
  align-items:center;justify-content:space-between;gap:16px;}
#${MENU_ID} .vc-item:hover{background:#f0f6ff;color:#1677ff;}
#${MENU_ID} .vc-item.disabled{color:#c2c2c2;cursor:default;pointer-events:none;}
#${MENU_ID} .vc-item .vc-kbd{font-size:11px;color:#aaa;}
#${MENU_ID} .vc-sep{height:1px;margin:5px 0;background:rgba(0,0,0,.08);}
#${MENU_ID} .vc-tip{padding:4px 14px 6px;font-size:11px;color:#aaa;}
#${TOAST_ID}{position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483647;
  padding:8px 16px;background:rgba(0,0,0,.82);color:#fff;border-radius:6px;
  font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  pointer-events:none;opacity:0;transition:opacity .18s;}
#${TOAST_ID}.show{opacity:1;}
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function showToast(msg) {
        ensureMenuStyle();
        if (!document.body) return;
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        void el.offsetWidth;             // 强制重排，保证连续调用也有淡入
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
    }

    // 复制到剪贴板（Clipboard API 失败时回退 execCommand）
    async function copyText(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {}
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ta.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch {
            return false;
        }
    }

    // 从 video 元素还原出原始 http(s) 地址
    function resolveOrigUrl(v) {
        if (!v) return null;
        let src = v.getAttribute('src') || v.src || '';
        if (!src) {
            const s = v.querySelector('source');
            if (s) src = s.getAttribute('src') || s.src || '';
        }
        if (!src) return null;
        if (src.startsWith('blob:')) return reverse.get(src) || null;
        return src;
    }

    // 从右键位置找到最近的 video
    function findVideoNear(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const v = target.closest('video');
        if (v) return v;
        const card = target.closest('.video-card, .slid-list li, [class*="video-card"]');
        if (card) {
            const cv = card.querySelector('video');
            if (cv) return cv;
        }
        return null;
    }

    // 当前正在播放的视频链接
    function currentVideoUrl() {
        const v = document.querySelector('video.vjs-tech') || document.querySelector('video');
        return resolveOrigUrl(v) || activeUrl || null;
    }

    function closeCtxMenu() {
        if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    }

    function showCtxMenu(x, y, target) {
        ensureMenuStyle();
        closeCtxMenu();
        if (!document.body) return;

        const hoverUrl = resolveOrigUrl(findVideoNear(target));
        const curUrl   = currentVideoUrl();

        const menu = document.createElement('div');
        menu.id = MENU_ID;

        const doCopy = async (url) => {
            if (!url) { showToast('未找到视频链接'); return; }
            const ok = await copyText(url);
            showToast(ok ? '已复制视频链接' : '复制失败，请手动复制');
            if (ok) log('已复制链接', short(url));
        };

        const addItem = (label, handler, disabled, kbd) => {
            const item = document.createElement('div');
            item.className = 'vc-item' + (disabled ? ' disabled' : '');
            const t = document.createElement('span');
            t.textContent = label;
            item.appendChild(t);
            if (kbd) {
                const k = document.createElement('span');
                k.className = 'vc-kbd';
                k.textContent = kbd;
                item.appendChild(k);
            }
            if (!disabled) {
                item.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeCtxMenu();
                    handler();
                });
            }
            menu.appendChild(item);
        };

        addItem('复制视频链接', () => doCopy(hoverUrl), !hoverUrl);
        if (curUrl && curUrl !== hoverUrl) {
            addItem('复制当前播放链接', () => doCopy(curUrl), false);
        }

        const sep = document.createElement('div');
        sep.className = 'vc-sep';
        menu.appendChild(sep);

        const tip = document.createElement('div');
        tip.className = 'vc-tip';
        tip.textContent = 'Alt + C 复制当前播放链接';
        menu.appendChild(tip);

        menu.style.left = '0px';
        menu.style.top  = '0px';
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
        // 原生菜单一般从光标位置向下展开，把自定义菜单放到光标上方，避免重叠
        let top = y - rect.height - 6;
        if (top < 8) {
            // 上方空间不足时退回光标下方（尽量错开一点）
            top = Math.min(y + 14, window.innerHeight - rect.height - 8);
        }
        menu.style.left = left-100 + 'px';
        menu.style.top  = top  + 'px';
        menu.style.visibility = 'visible';

        ctxMenuEl = menu;
    }

    function installCopyHelpers() {
        // 右键菜单：不阻止默认行为 → 原生菜单和自定义菜单同时出现
        window.addEventListener('contextmenu', e => {
            if (e.shiftKey) return;                 // Shift + 右键 只显示原生菜单
            if (!document.body) return;
            // 不调用 preventDefault / stopPropagation，让浏览器原生菜单正常弹出
            showCtxMenu(e.clientX, e.clientY, e.target);
        }, true);

        // 点击别处 / ESC / 滚动 / 失焦 关闭菜单
        document.addEventListener('mousedown', e => {
            if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
        }, true);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeCtxMenu();
        }, true);
        window.addEventListener('blur', closeCtxMenu);
        window.addEventListener('resize', closeCtxMenu);
        window.addEventListener('scroll', closeCtxMenu, true);

        // 快捷键 Alt + C：复制当前播放视频链接
        window.addEventListener('keydown', e => {
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.code !== 'KeyC' && e.key !== 'c' && e.key !== 'C') return;
            e.preventDefault();
            e.stopPropagation();
            const url = currentVideoUrl();
            if (!url) { showToast('未找到视频链接'); return; }
            copyText(url).then(ok => showToast(ok ? '已复制视频链接' : '复制失败，请手动复制'));
        }, true);

        log('复制助手已就绪：右键菜单 / Alt+C');
    }

    installCopyHelpers();
    function installHooks() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (m, url) {
            this.__vc_url = String(url || '');
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            const self = this;
            this.addEventListener('load', function () {
                try {
                    const url = self.__vc_url || '';
                    const resp = JSON.parse(self.responseText || '{}');
                    if (resp && resp.errorCode === 0) handleUrl(url);
                } catch {}
            });
            return origSend.apply(this, arguments);
        };

        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            return origFetch.apply(this, arguments).then(resp => {
                resp.clone().json()
                    .then(d => { if (d && d.errorCode === 0) handleUrl(url); })
                    .catch(() => {});
                return resp;
            });
        };
    }

    // ============ 用户点击 ============
    document.addEventListener('click', e => {
        if (e.target.closest('.slid-list .video-card')) schedulePreload(500, false);
    }, true);

    // ============ DOM 变化 ============
    let domTimer = null;
    function installDOMObserver() {
        new MutationObserver(() => {
            clearTimeout(domTimer);
            domTimer = setTimeout(preloadAroundActive, 1000);
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) installDOMObserver();
    else document.addEventListener('DOMContentLoaded', installDOMObserver, { once: true });

    // ============ 首次兜底 ============
    setTimeout(preloadAroundActive, 3000);

    // ============ 调试接口 ============
    unsafeWindow.__videoCache__ = {
        stats() {
            return {
                count:        cache.size,
                totalMB:      (totalSize / 1024 / 1024).toFixed(2),
                pending:      pending.size,
                queue:        queue.length,
                active:       short(activeUrl || ''),
                failed:       failed.size,
                progressMB:   (progressSize / 1024 / 1024).toFixed(2),
                progressJobs: downloadStates.size,
                cleanup:      pendingCleanup.size,
                aggressive:   Date.now() < aggressiveUntil,
            };
        },
        list() {
            return [...cache.entries()].map(([url, m]) => ({
                url:    short(url),
                sizeMB: (m.size / 1024 / 1024).toFixed(2),
                age:    ((Date.now() - m.ts) / 1000).toFixed(0) + 's',
            }));
        },
        progress() {
            return [...downloadStates.entries()].map(([url, s]) => ({
                url:      short(url),
                received: (s.received / 1024 / 1024).toFixed(2) + 'MB',
                total:    s.total ? (s.total / 1024 / 1024).toFixed(2) + 'MB' : '?',
                downloading: pending.has(url),
            }));
        },
        queueList() { return queue.map(short); },
        cleanupList() {
            return [...pendingCleanup.entries()].map(([url, t]) => ({
                url: short(url),
                remainMs: t - Date.now(),
            }));
        },
        failedList() {
            return [...failed.entries()].map(([url, e]) => ({
                url:      short(url),
                status:   e.status,
                remainMs: e.until - Date.now(),
            }));
        },
        clear() {
            for (const m of cache.values()) URL.revokeObjectURL(m.blobUrl);
            for (const s of downloadStates.values()) {
                if (s.controller) { try { s.controller.abort(); } catch {} }
            }
            clearTimeout(activeRetryTimer);
            cache.clear(); reverse.clear(); queue.length = 0;
            pending.clear(); failed.clear(); downloadStates.clear(); pendingCleanup.clear();
            totalSize = 0; progressSize = 0; downloading = 0; activeUrl = null;
            log('已清空缓存');
        },
        preload: preloadAroundActive,
        purgeCurrent: purgeCurrentVideo,
        setActive: (url) => { activeUrl = url; failed.delete(url); abortNonActive(); processQueue(); },
                copyCurrent() {
            const url = currentVideoUrl();
            if (!url) { showToast('未找到视频链接'); return Promise.resolve(false); }
            return copyText(url).then(ok => {
                showToast(ok ? '已复制视频链接' : '复制失败');
                return ok;
            });
        },
        copyUrl(url) {
            return copyText(url).then(ok => {
                showToast(ok ? '已复制' : '复制失败');
                return ok;
            });
        },
    };

    installHooks();

    log('已加载 v1.5。调试：__videoCache__.stats() / .failedList() / .cleanupList()');
})();
