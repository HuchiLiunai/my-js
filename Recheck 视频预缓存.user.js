// ==UserScript==
// @name         Recheck 视频预缓存
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  recheck：预取下一个视频，缓存上限 16 / 512MB，答题后清理；404/403/410 永久拉黑
// @match        https://test.baidu.com/argus/plaza/project/*/recheck/baseQueueId/*/queue/*/pageId/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    const log  = console.log.bind(console, '[rc]');
    const warn = console.warn.bind(console, '[rc]');
    const API  = '/argus/api';

    // ============ 配置 ============
    const MAX_CACHE      = 16;
    const MAX_TOTAL_SIZE = 512 * 1024 * 1024;   // 512MB
    const FAILED_TTL     = 60 * 1000;           // 临时失败重试间隔
    const GONE_STATUS    = new Set([404, 403, 410]);   // 视为永久失效

    // ============ 状态 ============
    const cache   = new Map();    // url → { blobUrl, size, ts }
    const reverse = new Map();    // blobUrl → url
    const pending = new Set();    // 正在下载
    const failed  = new Map();    // 临时失败：url → ts
    const gone    = new Set();    // 永久失败（404/403/410）：url

    let totalSize = 0;
    let activeUrl = null;
    let prefetchInFlight = false;
    let lastPrefetchedResultId = null;
    let pendingPurgeUrl = null;

    const ctx = {
        projectId: null, baseQueueId: null, queueId: null, pageId: null,
        searchValues: null, role: null, resultId: null,
    };

    const short = u => !u ? '' : (u.length > 90 ? '...' + u.slice(-90) : u);
    const mb    = b => (b / 1024 / 1024).toFixed(2) + 'MB';

    // ============ 失败判定 ============
    function isFailed(url) {
        if (gone.has(url)) return true;              // ★ 永久失效优先，连 activeUrl 也拦
        if (url === activeUrl) return false;
        const t = failed.get(url);
        if (!t) return false;
        if (Date.now() - t > FAILED_TTL) { failed.delete(url); return false; }
        return true;
    }

    function markGone(url, status) {
        if (!url) return;
        if (gone.has(url)) return;
        gone.add(url);
        failed.delete(url);
        pending.delete(url);
        if (pendingPurgeUrl === url) pendingPurgeUrl = null;
        // 顺手清掉可能存在的同 url 缓存
        const meta = cache.get(url);
        if (meta) {
            cache.delete(url);
            reverse.delete(meta.blobUrl);
            totalSize -= meta.size;
            setTimeout(() => {
                try { URL.revokeObjectURL(meta.blobUrl); } catch {}
            }, 1000);
        }
        log('🚫 永久失效 [' + status + ']，拉黑:', short(url));
    }

    // ============ 清理 ============
    function purgeUrl(url) {
        if (!url || url === activeUrl) return;
        const meta = cache.get(url);
        if (!meta) return;

        const { blobUrl, size } = meta;
        cache.delete(url);
        reverse.delete(blobUrl);
        totalSize -= size;

        setTimeout(() => {
            try { URL.revokeObjectURL(blobUrl); } catch {}
        }, 1000);

        pending.delete(url);
        failed.delete(url);
        log('🗑️ 清理:', short(url), mb(size),
            '| 剩余=' + cache.size + ', ' + mb(totalSize));
    }

    // ============ LRU ============
    function evictIfNeeded() {
        const canEvict = u => u !== activeUrl && u !== pendingPurgeUrl;

        if (totalSize > MAX_TOTAL_SIZE) {
            const entries = [...cache.entries()]
                .filter(([u]) => canEvict(u))
                .sort((a, b) => a[1].ts - b[1].ts);
            for (const [url] of entries) {
                if (totalSize <= MAX_TOTAL_SIZE) break;
                purgeUrl(url);
            }
        }
        if (cache.size > MAX_CACHE) {
            const entries = [...cache.entries()]
                .filter(([u]) => canEvict(u))
                .sort((a, b) => a[1].ts - b[1].ts);
            for (const [url] of entries) {
                if (cache.size <= MAX_CACHE) break;
                purgeUrl(url);
            }
        }
    }

    // ============ 下载 ============
    async function download(url) {
        if (!url || url.startsWith('blob:')) return;
        if (gone.has(url)) return;                     // ★ 已拉黑，直接跳过
        if (cache.has(url) || pending.has(url)) return;
        if (isFailed(url)) return;

        pending.add(url);
        const t0 = performance.now();
        log('⬇️ 下载:', short(url));

        try {
            const resp = await fetch(url, { credentials: 'omit', cache: 'default' });
            if (!resp.ok) {
                const err = new Error('HTTP ' + resp.status);
                err.status = resp.status;              // ★ 把状态码带出来
                throw err;
            }
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            cache.set(url, { blobUrl, size: blob.size, ts: Date.now() });
            reverse.set(blobUrl, url);
            totalSize += blob.size;
            failed.delete(url);

            log('✅ 完成:', short(url), mb(blob.size),
                ((performance.now() - t0) / 1000).toFixed(1) + 's',
                '| 缓存=' + cache.size + ', ' + mb(totalSize));

            evictIfNeeded();

            if (url === activeUrl) setTimeout(prefetchNext, 100);
        } catch (e) {
            if (e.status && GONE_STATUS.has(e.status)) {
                markGone(url, e.status);               // ★ 永久失败
            } else {
                warn('❌ 临时失败:', short(url), e.message);
                failed.set(url, Date.now());           // 5xx / 网络错误 → 允许 60s 后重试
            }
        } finally {
            pending.delete(url);
        }
    }

    function extractVideoUrl(pageData) {
        if (!pageData) return null;
        const d = pageData.data || pageData;
        return d.videoBody || d.videoUrl || d.video_url || null;
    }

    // ============ 预取下一个 ============
    async function prefetchNext() {
        if (prefetchInFlight) return;
        if (!ctx.projectId || !ctx.searchValues || !ctx.resultId) return;
        if (lastPrefetchedResultId === ctx.resultId) return;

        const capturedResultId = ctx.resultId;
        prefetchInFlight = true;
        log('>>> 预取下一个 resultId=' + capturedResultId);

        try {
            let sv;
            try { sv = JSON.parse(ctx.searchValues); }
            catch {
                try { sv = JSON.parse(decodeURIComponent(ctx.searchValues)); }
                catch { log('❌ searchValues 解析失败'); return; }
            }

            // 1) getChangeRecord
            const payload = { ...sv, stage: 'RECHECK', resultId: capturedResultId, operateType: 'next' };
            const recResp = await fetch(`${API}/result/project/${ctx.projectId}/record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            if (!recResp.ok) {
                warn('record HTTP ' + recResp.status);
                lastPrefetchedResultId = capturedResultId;   // ★ 打断死循环
                return;
            }
            const recData = await recResp.json();

            if (recData.errorCode !== 0 || !recData.data) {
                lastPrefetchedResultId = capturedResultId;
                return;
            }

            const nextPageId  = recData.data.pageId;
            const nextQueueId = recData.data.queueId || ctx.queueId;

            // 2) page_info
            const infoUrl = `${API}/result/queue/${nextQueueId}/page_info?role=${ctx.role || 'RECHECK'}&pageId=${nextPageId}`;
            const infoResp = await fetch(infoUrl, {
                headers: { 'x-requested-with': 'XMLHttpRequest' },
                credentials: 'include',
            });
            if (!infoResp.ok) {
                warn('page_info HTTP ' + infoResp.status);
                lastPrefetchedResultId = capturedResultId;
                return;
            }
            const infoData = await infoResp.json();

            if (infoData.errorCode !== 0 || !infoData.data) {
                lastPrefetchedResultId = capturedResultId;
                return;
            }

            const nextVideoUrl = extractVideoUrl(infoData.data);
            if (!nextVideoUrl) {
                lastPrefetchedResultId = capturedResultId;
                return;
            }

            lastPrefetchedResultId = capturedResultId;

            if (gone.has(nextVideoUrl)) {
                log('🚫 预取目标已拉黑，跳过:', short(nextVideoUrl));
                return;
            }
            log('🎬 预取:', short(nextVideoUrl));
            download(nextVideoUrl);

        } catch (e) {
            warn('预取失败:', e);
        } finally {
            prefetchInFlight = false;
        }
    }

    // ============ video 激活 ============
    function handleVideoActivated(url) {
        if (!url || url.startsWith('blob:')) return;

        // ★ 永久失效：不下载、不重试，让原生 src 自己走（浏览器会显示错误）
        if (gone.has(url)) {
            log('🚫 已知永久失效，跳过:', short(url));
            activeUrl = url;
            return;
        }

        const wasActive = url === activeUrl;
        activeUrl = url;
        failed.delete(url);

        // answer 过的题，现在有新的 active 了 → 清理旧视频
        if (pendingPurgeUrl && pendingPurgeUrl !== url) {
            purgeUrl(pendingPurgeUrl);
            pendingPurgeUrl = null;
        }

        if (wasActive) return;

        if (cache.has(url)) {
            log('★ 命中缓存');
            setTimeout(prefetchNext, 100);
        } else {
            download(url);
        }
    }

    // ============ 网络拦截 ============
    function capture(url, resp) {
        if (/\/result\/(verify|recheck)\/queue\/\d+\/answer/.test(url)) {
            if (resp && resp.errorCode === 0 && activeUrl) {
                pendingPurgeUrl = activeUrl;
                log('📝 answer 成功，待清理:', short(activeUrl));
            }
            return;
        }

        if (!resp || resp.errorCode !== 0 || !resp.data) return;
        if (!/\/result\/queue\/\d+\/page_info/.test(url)) return;

        try {
            const u = new URL(url, location.origin);
            const role = u.searchParams.get('role');
            if (role) ctx.role = role;
        } catch {}

        if (resp.data.resultId) ctx.resultId = resp.data.resultId;
        if (resp.data.pageId)   ctx.pageId   = resp.data.pageId;

        const videoUrl = extractVideoUrl(resp.data);
        if (videoUrl) handleVideoActivated(videoUrl);
    }
        // ============ 复制视频链接：右键菜单 + 快捷键 Alt+C ============
    const MENU_STYLE_ID = 'rc-ctx-style';
    const MENU_ID       = 'rc-ctx-menu';
    const TOAST_ID      = 'rc-toast';

    let ctxMenuEl  = null;
    let toastTimer = null;

    function ensureMenuStyle() {
        if (document.getElementById(MENU_STYLE_ID)) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;
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
        parent.appendChild(style);
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
        void el.offsetWidth;             // 强制重排，保证连续调用也能淡入
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
    }

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

    // 从 video 元素还原原始 http(s) 地址（blob: 走 reverse 反查）
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

    function findVideoNear(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const v = target.closest('video');
        if (v) return v;
        const card = target.closest('[class*="video-card"], [class*="videoCard"], li');
        if (card) {
            const cv = card.querySelector('video');
            if (cv) return cv;
        }
        return null;
    }

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
        // 原生菜单一般从光标位置向下展开，自定义菜单放到光标上方错开
        let top = y - rect.height - 6;
        if (top < 8) {
            top = Math.min(y + 14, window.innerHeight - rect.height - 8);
        }
        menu.style.left = left-100 + 'px';
        menu.style.top  = top  + 'px';
        menu.style.visibility = 'visible';

        ctxMenuEl = menu;
    }

    function installCopyHelpers() {
        // 与原生菜单共存：不阻止默认行为 → 两边同时出现
        window.addEventListener('contextmenu', e => {
            if (e.shiftKey) return;                 // Shift + 右键 只显示原生菜单
            if (!document.body) return;
            showCtxMenu(e.clientX, e.clientY, e.target);
        }, true);

        // 点击别处 / ESC / 滚动 / 失焦 关闭自定义菜单
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
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
        this.__u = String(u || '');
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        const self = this;
        this.addEventListener('load', function () {
            try { capture(self.__u || '', JSON.parse(self.responseText || '{}')); } catch {}
        });
        return origSend.apply(this, arguments);
    };
    const origFetch = window.fetch;
    window.fetch = function (input) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        return origFetch.apply(this, arguments).then(resp => {
            resp.clone().json().then(d => capture(url, d)).catch(() => {});
            return resp;
        });
    };

    // ============ video.src setter hook ============
    function installVideoHooks() {
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (!desc || !desc.set) return;
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
                handleVideoActivated(value);
                const hit = cache.get(value);
                if (hit) {
                    hit.ts = Date.now();
                    log('★ setter 命中缓存');
                    return origSetter.call(this, hit.blobUrl);
                }
                return origSetter.call(this, value);
            }
        });
    }

    // ============ URL 解析 ============
    function parseLocation() {
        const href = location.href;
        const re = /\/argus\/plaza\/project\/([^/]+)\/recheck\/baseQueueId\/(\d+)\/queue\/(\d+)\/pageId\/(\d+)/;
        const m = href.match(re);
        if (!m) return;
        ctx.projectId   = m[1];
        ctx.baseQueueId = parseInt(m[2], 10);
        ctx.queueId     = parseInt(m[3], 10);
        ctx.pageId      = parseInt(m[4], 10);
        try {
            const u = new URL(href);
            ctx.searchValues = u.searchParams.get('searchValues');
        } catch {}
    }

    // ============ URL 变化 ============
    let lastHref = location.href;
    function onUrlChange() {
        if (location.href === lastHref) return;
        lastHref = location.href;
        log('🔄 切页');
        parseLocation();
        ctx.resultId = null;
        ctx.role     = null;
        prefetchInFlight = false;
    }

    parseLocation();
    installVideoHooks();
    installCopyHelpers();
    setInterval(onUrlChange, 300);

    // ============ 调试 ============
    unsafeWindow.__rc__ = {
        ctx:   () => ({ ...ctx }),
        stats: () => ({
            cacheSize:    cache.size,
            totalMB:      (totalSize / 1024 / 1024).toFixed(2),
            pending:      pending.size,
            active:       short(activeUrl || ''),
            failed:       failed.size,
            gone:         gone.size,
            pendingPurge: short(pendingPurgeUrl || ''),
            lastPrefetch: lastPrefetchedResultId,
        }),
        list:  () => [...cache.entries()].map(([u, m]) => ({
            url:    short(u),
            sizeMB: (m.size / 1024 / 1024).toFixed(2),
            age:    ((Date.now() - m.ts) / 1000).toFixed(0) + 's',
        })),
        goneList: () => [...gone].map(short),
        prefetch: prefetchNext,
        purge:    purgeUrl,
        clear:    () => {
            for (const m of cache.values()) try { URL.revokeObjectURL(m.blobUrl); } catch {}
            cache.clear(); reverse.clear(); pending.clear();
            failed.clear(); gone.clear();
            totalSize = 0; activeUrl = null; pendingPurgeUrl = null;
            lastPrefetchedResultId = null; prefetchInFlight = false;
            log('已清空');
        },
        clearGone: () => {
            const n = gone.size;
            gone.clear();
            log('已清空永久黑名单:', n);
        },
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

    log('已加载。__rc__.stats() / .list() / .goneList()');
})();
