// ==UserScript==
// @name         Recheck 视频预缓存
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  recheck：预取下一个视频，缓存上限 16 / 512MB，答题后清理
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
    const FAILED_TTL     = 60 * 1000;

    // ============ 状态 ============
    const cache   = new Map();    // url → { blobUrl, size, ts }
    const reverse = new Map();    // blobUrl → url
    const pending = new Set();
    const failed  = new Map();

    let totalSize = 0;
    let activeUrl = null;
    let prefetchInFlight = false;
    let lastPrefetchedResultId = null;
    let pendingPurgeUrl = null;   // answer 提交后待清理的 url

    const ctx = {
        projectId: null, baseQueueId: null, queueId: null, pageId: null,
        searchValues: null, role: null, resultId: null,
    };

    const short = u => !u ? '' : (u.length > 90 ? '...' + u.slice(-90) : u);
    const mb    = b => (b / 1024 / 1024).toFixed(2) + 'MB';

    function isFailed(url) {
        if (url === activeUrl) return false;
        const t = failed.get(url);
        if (!t) return false;
        if (Date.now() - t > FAILED_TTL) { failed.delete(url); return false; }
        return true;
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

        // 延迟 revoke，避免 video 还没释放引用
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

        // 1) 按总大小淘汰
        if (totalSize > MAX_TOTAL_SIZE) {
            const entries = [...cache.entries()]
                .filter(([u]) => canEvict(u))
                .sort((a, b) => a[1].ts - b[1].ts);
            for (const [url] of entries) {
                if (totalSize <= MAX_TOTAL_SIZE) break;
                purgeUrl(url);
            }
        }
        // 2) 按数量淘汰
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
        if (cache.has(url) || pending.has(url)) return;
        if (isFailed(url)) return;

        pending.add(url);
        const t0 = performance.now();
        log('⬇️ 下载:', short(url));

        try {
            const resp = await fetch(url, { credentials: 'omit', cache: 'default' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
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
            warn('❌ 失败:', short(url), e.message);
            failed.set(url, Date.now());
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
            const infoData = await infoResp.json();

            if (infoData.errorCode !== 0 || !infoData.data) return;

            const nextVideoUrl = extractVideoUrl(infoData.data);
            if (!nextVideoUrl) return;

            lastPrefetchedResultId = capturedResultId;
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
        const wasActive = url === activeUrl;
        activeUrl = url;
        failed.delete(url);

        // ★ answer 过的题，现在有新的 active 了 → 清理旧视频
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
        // answer 提交成功 → 记录当前 activeUrl 待清理
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
            pendingPurge: short(pendingPurgeUrl || ''),
            lastPrefetch: lastPrefetchedResultId,
        }),
        list:  () => [...cache.entries()].map(([u, m]) => ({
            url:    short(u),
            sizeMB: (m.size / 1024 / 1024).toFixed(2),
            age:    ((Date.now() - m.ts) / 1000).toFixed(0) + 's',
        })),
        prefetch: prefetchNext,
        purge:    purgeUrl,
        clear:    () => {
            for (const m of cache.values()) try { URL.revokeObjectURL(m.blobUrl); } catch {}
            cache.clear(); reverse.clear(); pending.clear(); failed.clear();
            totalSize = 0; activeUrl = null; pendingPurgeUrl = null;
            lastPrefetchedResultId = null; prefetchInFlight = false;
            log('已清空');
        },
    };

    log('已加载。__rc__.stats() / .list()');
})();
