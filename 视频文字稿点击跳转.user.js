// ==UserScript==
// @name         视频文字稿点击跳转
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  点击文本跳转视频进度（多段 ASR 支持）
// @match        https://test.baidu.com/argus/plaza/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const RE_REFS = /\/video\/project\/[^/]+\/base-queue\/[^/]+\/page\/(\d+)\/references/;

  let asrData = null;

  // 每一段：{ rawText, rawCharTimes[], start, end }
  let asrSegments = [];

  // 归一化后的全文（所有段拼接）
  let asrFullNormText = '';

  // asrFullNormText 的每个字符 -> { segIdx, rawIdx }
  let asrNormToSeg = [];

  // ---------- 1. 拦截 fetch ----------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (RE_REFS.test(url)) {
        resp.clone().json().then(handleAsrJson).catch(() => {});
      }
    } catch (e) {}
    return resp;
  };

  // ---------- 2. 拦截 XHR ----------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (RE_REFS.test(this._url)) {
          const json = JSON.parse(this.responseText);
          handleAsrJson(json);
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  function handleAsrJson(json) {
    const asr = json && json.data && json.data.referenceData && json.data.referenceData.asr;
    if (!asr || !asr.contents || !asr.contents.length) return;
    asrData = asr;
    console.log('[asr] captured, segments =', asr.contents.length);
    buildTimeline();
  }

  // ---------- 3. 构建多段时间轴 ----------
  function buildTimeline() {
    asrSegments = [];
    asrFullNormText = '';
    asrNormToSeg = [];

    const contents = asrData.contents || [];
    for (let s = 0; s < contents.length; s++) {
      const seg = contents[s];
      const rawText = seg.text || '';
      const start = seg.startTime || 0;
      // 末段若缺 endTime，用 duration 或 start+1
      const end = seg.endTime || asrData.duration || (start + 1);
      const rawLen = rawText.length;

      // 段内按字插值
      const rawCharTimes = new Array(rawLen);
      for (let i = 0; i < rawLen; i++) {
        rawCharTimes[i] = start + (end - start) * i / Math.max(1, rawLen - 1);
      }

      // 归一化 + 记录每个归一化字符回指 (segIdx, rawIdx)
      for (let i = 0; i < rawLen; i++) {
        const ch = rawText[i];
        if (/\s/.test(ch)) continue;
        if (/[\uD800-\uDFFF\u2600-\u27BF\uFE0F\u200D]/.test(ch)) continue;
        asrFullNormText += ch;
        asrNormToSeg.push({ segIdx: s, rawIdx: i });
      }

      asrSegments.push({ rawText, rawCharTimes, start, end });
    }

    console.log('[timeline] segments =', asrSegments.length,
                'norm len =', asrFullNormText.length);
  }

  // ---------- 4. DOM 文本节点 → 全局位置 ----------
  function collectDomMap() {
    // 只取有内容 span 的 td，跳过 measure-row 与时间列
    const tds = Array.from(document.querySelectorAll('td.ant-table-cell'))
      .filter(td => td.querySelector('span[data-v-ef93617c]'));

    const map = []; // { node, start }
    let cursor = 0;
    for (const td of tds) {
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        map.push({ node: n, start: cursor });
        cursor += n.nodeValue.length;
      }
    }
    return map;
  }

  // ---------- 5. 视频选择 + seek ----------
  function pickVideo() {
    const byId = document.getElementById('video-player_html5_api');
    if (byId && isFinite(byId.duration) && byId.duration > 0) return byId;

    const list = Array.from(document.querySelectorAll('video'));
    const valid = list.filter(v => isFinite(v.duration) && v.duration > 0);
    if (valid.length) {
      valid.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
      return valid[0];
    }
    return byId || list[0] || null;
  }

  function seekTo(video, seconds) {
    const doSeek = () => {
      try {
        video.currentTime = seconds;
        console.log('[seek] set to', seconds, 'actual =', video.currentTime,
                    'readyState =', video.readyState, 'duration =', video.duration);
      } catch (err) {
        console.warn('[seek] failed', err);
      }
    };
    if (video.readyState >= 1) doSeek();
    else {
      video.addEventListener('loadedmetadata', doSeek, { once: true });
      setTimeout(() => { if (video.readyState >= 1) doSeek(); }, 300);
    }
  }

  // ---------- 6. 点击处理 ----------
  document.addEventListener('click', function (e) {
    console.log('[click] fired', e.clientX, e.clientY, e.target.tagName);

    if (e.target.closest('a')) return; // 时间列 <a> 不处理

    const video = pickVideo();
    if (!video) { console.log('[click] no video'); return; }
    if (!asrSegments.length) { console.log('[click] no timeline'); return; }

    const td = e.target.closest('td.ant-table-cell');
    if (!td || !td.querySelector('span[data-v-ef93617c]')) {
      console.log('[click] not content cell');
      return;
    }

    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) { console.log('[click] no range'); return; }

    const node = range.startContainer;
    const offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      console.log('[click] not text node');
      return;
    }

    const map = collectDomMap();
    const entry = map.find(m => m.node === node);
    if (!entry) { console.log('[click] node not in dom map'); return; }
    const domGlobalIdx = entry.start + offset;

    // 用点击处前后 12 字做锚点，在 ASR 全文中定位
    const nodeText = node.nodeValue;
    const left = Math.max(0, offset - 12);
    const right = Math.min(nodeText.length, offset + 12);
    const snippetRaw = nodeText.slice(left, right);
    const snippet = norm(snippetRaw);
    const anchorInSnippet = norm(nodeText.slice(left, offset)).length;

    let asrPos = -1;
    if (snippet) {
      asrPos = asrFullNormText.indexOf(snippet);
      if (asrPos >= 0) asrPos += anchorInSnippet;
    }

    // 兜底：按 DOM 全局比例估算
    if (asrPos < 0) {
      console.log('[click] snippet not found, fallback by ratio');
      const totalDomLen = map.reduce((a, m) => a + m.node.nodeValue.length, 0);
      const ratio = domGlobalIdx / Math.max(1, totalDomLen);
      asrPos = Math.round(ratio * (asrFullNormText.length - 1));
    }

    asrPos = Math.max(0, Math.min(asrPos, asrNormToSeg.length - 1));
    const { segIdx, rawIdx } = asrNormToSeg[asrPos];
    const t = asrSegments[segIdx].rawCharTimes[rawIdx];

    console.log('[click] domIdx =', domGlobalIdx,
                'asrPos =', asrPos,
                'seg =', segIdx,
                'rawIdx =', rawIdx,
                't =', t);

    if (t != null) {
      seekTo(video, t / 1000);
    }
  }, true);

  function norm(s) {
    if (!s) return '';
    return s
      .replace(/[\uD800-\uDFFF]/g, '')                 // emoji / 代理对
      .replace(/[\u2600-\u27BF\uFE0F\u200D]/g, '')     // 符号 / 变体 / ZWJ
      .replace(/\s+/g, '');
  }
})();