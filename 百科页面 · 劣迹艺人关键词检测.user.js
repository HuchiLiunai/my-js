// ==UserScript==
// @name         百科页面 · 劣迹艺人关键词检测
// @namespace    https://github.com/yourname/ljy-check
// @version      1.1.1
// @description  在百科/影视剧介绍页面自动检测是否包含预设的人名关键词，命中即高亮并在右上角提示
// @author       you
// @match        *://*/*
// @exclude      https://cn.bing.com/*
// @exclude      *://*.feishu.cn/*
// @exclude      https://test.baidu.com/*
// @exclude      *://*.deepseek.com/*
// @exclude      *://feishu.cn/*
// @exclude      *://www.kdocs.cn/*
// @exclude      *://github.com/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const IGNORE_SELECTORS = ['#J-lemma-starmap', '#J-bottom-tashuo'];
  const IGNORE_SELECTOR = IGNORE_SELECTORS.join(',');
  /* ==========================================================
   * 1. 默认关键词（第一次用请改成你自己的 ~40 个人名）
   *    改完之后保存即可；也可以在面板上点“编辑”随时改。
   * ========================================================== */
  const DEFAULT_KEYWORDS = [
  // 第一批
  '黄秋生', '林夕', '何韵诗', '黄耀明', '舒琪', '王喜', '郭臻', '周冠威', '伍嘉良', '叶德娴',
  '马健贤', '杜汶泽', '张敬轩', '陈升', '徐若瑄', '陈宣裕', '吴念真', '陈莱维', '九把刀', '波特王',
  '陈之汉', '比约克', '理查·基尔陈', '卢广仲', '周子瑜', '张悬', '林耶凡', '崔永元', '毕福剑', '赵立新',
  '李志',

  // 第二批
  '吴亦凡', '郑爽', '霍尊', '张哲瀚', '赵薇', '李易峰', '邓伦', '范冰冰', '高晓松', '黄旭熙',
  '马蓉', '吴秀波', '罗志祥', '姚笛', '高云翔', '许志安', '高天鹤', '翟天临', '仝卓', '陈一发',
  '杨凯莉', '李天佑', '平荣', '薇娅', '朱宸慧', '林珊珊', '王乐乐', '杨清柠', '郭蓓蓓', '铁山靠',
  '卢本伟', '薛蛮子', '周立齐', '谢和弦',

  // 第三批
  '贾宏声', '张元', '满文军', '房祖名', '柯震东', '陈万宁', '宁财神', '李代沫', '高虎', '尹相杰',
  '张默', '王学兵', '卡姆', '黄毅清', '何盛东', '何沛东', '东来东往', '陈羽凡', '陈涛', '周立波',
  '毛宁', '牛萌萌', '孙兴', '王柳雯', '傅艺伟', '宋冬野', '张耀扬', '胡东', '祝钒刚', 'PG One',
  '郭美美', '李云迪', '王全安', '黄海波', '黄智博', '蒋劲夫', '李昊石', '宋祖儿', '王大陆', '张嘉倪'
];

  const KEY_STORE = 'ljy_keywords_v1';

  /* ==========================================================
   * 2. 存储
   * ========================================================== */
  function loadKeywords() {
    try {
      const raw = GM_getValue(KEY_STORE, null);
      if (Array.isArray(raw) && raw.length) return raw.filter(Boolean);
    } catch (e) { /* ignore */ }
    return DEFAULT_KEYWORDS.slice();
  }
  function saveKeywords(list) {
    try { GM_setValue(KEY_STORE, list); } catch (e) { /* ignore */ }
  }

  /* ==========================================================
   * 3. 样式
   * ========================================================== */
  const CSS = `
  #ljy-panel{
    position:fixed;top:12px;right:12px;z-index:2147483647;width:264px;
    font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:rgba(28,30,36,.96);color:#e8eaed;border-radius:10px;
    box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;
  }
  #ljy-panel *{box-sizing:border-box;}
  #ljy-head{
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    padding:8px 10px;background:rgba(255,255,255,.07);cursor:move;user-select:none;
  }
  #ljy-head b{font-weight:600;font-size:13px;}
  #ljy-head .ljy-btns{display:flex;gap:6px;}
  #ljy-head button{
    all:unset;cursor:pointer;font-size:12px;padding:2px 7px;border-radius:5px;
    background:rgba(255,255,255,.13);color:#e8eaed;
  }
  #ljy-head button:hover{background:rgba(255,255,255,.26);}
  #ljy-body{padding:10px;max-height:52vh;overflow:auto;}
  #ljy-body .ok{color:#52d273;font-weight:600;}
  #ljy-body .bad{color:#ff6b6b;font-weight:600;}
  .ljy-item{
    display:flex;justify-content:space-between;gap:8px;padding:3px 7px;margin:3px 0;
    border-radius:5px;background:rgba(255,107,107,.14);cursor:pointer;
  }
  .ljy-item:hover{background:rgba(255,107,107,.30);}
  .ljy-item .n{color:#ffb3b3;font-size:12px;white-space:nowrap;}
  .ljy-tip{margin-top:8px;font-size:11px;color:#9aa0a6;line-height:1.5;}

  mark.ljy-hl{
    background:#ff3b30 !important;color:#fff !important;
    padding:0 2px !important;border-radius:3px !important;
    box-shadow:0 0 0 1px rgba(255,255,255,.75) !important;
  }
  mark.ljy-flash{outline:2px solid #ffd60a !important;outline-offset:2px;}

  #ljy-editor{
    position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;
  }
  #ljy-editor .box{
    width:min(540px,92vw);background:#1c1e24;border-radius:10px;padding:14px;
    color:#e8eaed;font:13px/1.6 sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.55);
  }
  #ljy-editor textarea{
    width:100%;height:280px;margin:8px 0;padding:8px;border-radius:8px;
    border:1px solid #3c4043;background:#111317;color:#e8eaed;
    font:13px/1.6 ui-monospace,Consolas,monospace;resize:vertical;
  }
  #ljy-editor .row{display:flex;justify-content:flex-end;gap:8px;}
  #ljy-editor button{
    padding:5px 14px;border-radius:6px;border:1px solid #3c4043;background:#2a2d34;
    color:#e8eaed;cursor:pointer;font-size:13px;
  }
  #ljy-editor button.primary{background:#3b82f6;border-color:#3b82f6;color:#fff;}
  `;

  function injectCSS() {
    if (document.getElementById('ljy-style')) return;
    const s = document.createElement('style');
    s.id = 'ljy-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ==========================================================
   * 4. 工具函数
   * ========================================================== */
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'IFRAME', 'CANVAS', 'SVG', 'TITLE', 'HEAD', 'META', 'LINK'
  ]);

  /* ==========================================================
   * 5. 高亮 & 清除
   * ========================================================== */
  function clearHighlights() {
    const marks = document.querySelectorAll('mark.ljy-hl');
    if (!marks.length) return;
    const parents = new Set();
    marks.forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(m.textContent), m);
      parents.add(p);
    });
    parents.forEach((p) => { try { p.normalize(); } catch (e) {} });
  }

  function highlightNode(node, keywords) {
    const text = node.nodeValue;
    let matches = null;

    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      let idx = text.indexOf(kw);
      while (idx !== -1) {
        if (!matches) matches = [];
        matches.push({ s: idx, e: idx + kw.length, kw });
        idx = text.indexOf(kw, idx + kw.length);
      }
    }
    if (!matches) return [];

    // 按位置排序，重叠时取更长的那个
    matches.sort((a, b) => a.s - b.s || b.e - a.e);

    const chosen = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.s >= lastEnd) { chosen.push(m); lastEnd = m.e; }
    }

    const frag = document.createDocumentFragment();
    const found = [];
    let pos = 0;

    for (const m of chosen) {
      if (m.s > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.s)));
      const mark = document.createElement('mark');
      mark.className = 'ljy-hl';
      mark.textContent = text.slice(m.s, m.e);
      frag.appendChild(mark);
      found.push(m.kw);
      pos = m.e;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));

    const parent = node.parentNode;
    if (!parent) return [];
    parent.replaceChild(frag, node);
    return found;
  }

  /* ==========================================================
   * 6. 文本节点收集
   * ========================================================== */
  function collectTextNodes() {
    if (!document.body) return [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest(`#ljy-panel,#ljy-editor,mark.ljy-hl,${IGNORE_SELECTOR}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  // 整页纯文本（用来兜底检测被标签拆散的关键词）
  function getFlatText() {
    if (!document.body) return '';
    const hideList = ['#ljy-panel', '#ljy-editor', ...IGNORE_SELECTORS]
      .map((s) => document.querySelector(s))
      .filter(Boolean);
    const prev = hideList.map((el) => el.style.display);
    hideList.forEach((el) => { el.style.display = 'none'; });
    let t = '';
    try {
      t = document.body.innerText || document.body.textContent || '';
    } catch (e) { t = ''; }
    hideList.forEach((el, i) => { el.style.display = prev[i]; });
    return t;
  }

  /* ==========================================================
   * 7. 界面
   * ========================================================== */
  let panel = null;
  let bodyEl = null;

  function buildUI() {
    injectCSS();
    if (document.getElementById('ljy-panel')) {
      panel = document.getElementById('ljy-panel');
      bodyEl = panel.querySelector('#ljy-body');
      return;
    }

    panel = document.createElement('div');
    panel.id = 'ljy-panel';
    panel.innerHTML = `
      <div id="ljy-head">
        <b>关键词检测</b>
        <div class="ljy-btns">
          <button data-act="rescan" title="重新扫描">重扫</button>
          <button data-act="edit" title="编辑关键词">编辑</button>
          <button data-act="hide" title="隐藏面板（可用油猴菜单恢复）">×</button>
        </div>
      </div>
      <div id="ljy-body"></div>
    `;
    document.documentElement.appendChild(panel);
    bodyEl = panel.querySelector('#ljy-body');

    panel.querySelector('#ljy-head').addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (act === 'rescan') fullScan();
      else if (act === 'edit') openEditor();
      else if (act === 'hide') panel.style.display = 'none';
    });

    makeDraggable(panel, panel.querySelector('#ljy-head'));
  }

  function makeDraggable(el, handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = el.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.style.right = 'auto';
      el.style.left = ox + 'px';
      el.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      el.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function render(hits, missed, total) {
    if (!bodyEl) return;
    const items = [...hits.entries()].sort((a, b) => b[1] - a[1]);
    const totalHit = items.length + missed.length;

    if (!totalHit) {
      bodyEl.innerHTML =
        `<div class="ok">✅ 未发现目标关键词</div>` +
        `<div class="ljy-tip">已检测 ${total} 个关键词</div>`;
      return;
    }

    let html = `<div class="bad">⚠️ 命中 ${totalHit} 个关键词</div>`;
    for (const [k, c] of items) {
      html += `<div class="ljy-item" data-kw="${escapeHtml(k)}">
                 <span>${escapeHtml(k)}</span><span class="n">${c} 处</span>
               </div>`;
    }
    for (const k of missed) {
      html += `<div class="ljy-item" data-kw="${escapeHtml(k)}" data-miss="1">
                 <span>${escapeHtml(k)}</span><span class="n">被标签拆开</span>
               </div>`;
    }
    html += `<div class="ljy-tip">点击条目可跳转到页面中的命中位置</div>`;
    bodyEl.innerHTML = html;

    bodyEl.querySelectorAll('.ljy-item').forEach((el) => {
      el.addEventListener('click', () => {
        const kw = el.dataset.kw;
        const mark = [...document.querySelectorAll('mark.ljy-hl')]
          .find((m) => m.textContent === kw);
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          mark.classList.add('ljy-flash');
          setTimeout(() => mark.classList.remove('ljy-flash'), 1500);
        } else if (window.find) {
          // 兜底：浏览器原生查找（文字被 HTML 拆开时）
          try { window.find(kw, false, false, true); } catch (e) {}
        }
      });
    });
  }

  function openEditor() {
    injectCSS();
    if (document.getElementById('ljy-editor')) return;

    const list = loadKeywords();
    const wrap = document.createElement('div');
    wrap.id = 'ljy-editor';
    wrap.innerHTML = `
      <div class="box">
        <div>编辑关键词（<b>每行一个</b>，也支持用逗号 / 空格分隔）</div>
        <textarea spellcheck="false"></textarea>
        <div class="row">
          <button data-act="cancel">取消</button>
          <button data-act="reset">恢复默认</button>
          <button class="primary" data-act="save">保存并重扫</button>
        </div>
      </div>`;
    wrap.querySelector('textarea').value = list.join('\n');
    document.documentElement.appendChild(wrap);

    wrap.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (!act) return;
      if (act === 'cancel') wrap.remove();
      else if (act === 'reset') wrap.querySelector('textarea').value = DEFAULT_KEYWORDS.join('\n');
      else if (act === 'save') {
        const raw = wrap.querySelector('textarea').value;
        const arr = [...new Set(
          raw.split(/[\n,，、;；|\s]+/).map((s) => s.trim()).filter(Boolean)
        )];
        saveKeywords(arr);
        wrap.remove();
        fullScan();
      }
    });
  }

  /* ==========================================================
   * 8. 主流程
   * ========================================================== */
  let observer = null;
  let scanTimer = null;
  let scanning = false;

  function fullScan() {
    if (scanning) return;
    scanning = true;
    if (observer) observer.disconnect();

    try {
      buildUI();
      clearHighlights();

      const keywords = loadKeywords();
      const hits = new Map();

      if (keywords.length) {
        const nodes = collectTextNodes();
        for (let i = 0; i < nodes.length; i++) {
          const found = highlightNode(nodes[i], keywords);
          for (let j = 0; j < found.length; j++) {
            hits.set(found[j], (hits.get(found[j]) || 0) + 1);
          }
        }
      }

      // 兜底：文字被 HTML 标签拆开，无法直接高亮的情况
      const flat = getFlatText();
      const missed = keywords.filter((k) => !hits.has(k) && flat.includes(k));

      render(hits, missed, keywords.length);
    } catch (err) {
      console.error('[关键词检测] 扫描出错：', err);
    } finally {
      scanning = false;
      observe();
    }
  }

  function scheduleScan(delay = 700) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; fullScan(); }, delay);
  }

  function observe() {
    if (!document.body) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ==========================================================
   * 9. 油猴菜单 & 启动
   * ========================================================== */
  try {
    GM_registerMenuCommand('🔍 立即重新扫描', () => fullScan());
    GM_registerMenuCommand('📝 编辑关键词名单', () => { buildUI(); openEditor(); });
    GM_registerMenuCommand('👁 显示检测面板', () => {
      buildUI();
      if (panel) panel.style.display = '';
    });
  } catch (e) { /* ignore */ }

  function boot() {
    fullScan();
  }

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
