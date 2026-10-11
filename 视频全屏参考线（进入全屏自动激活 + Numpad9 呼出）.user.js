// ==UserScript==
// @name         视频全屏参考线（进入全屏自动激活 + Numpad9 呼出）
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WRAP_ID = '__guide_wrap__';
  const SHOW_MS = 3000;        // 显示时长（毫秒）
  const HOTKEY  = 'Numpad9';   // 小键盘 9

  let hideTimer = null;

  function getBarHeight(fsEl) {
    const bar = fsEl.querySelector('.vjs-control-bar');
    if (!bar) return 0;
    return bar.getBoundingClientRect().height || 0;
  }

  function layout(fsEl) {
    const wrap = fsEl.querySelector('#' + WRAP_ID);
    if (!wrap) return;

    const totalH  = fsEl.getBoundingClientRect().height;
    const barH    = getBarHeight(fsEl);
    const usableH = Math.max(0, totalH - barH);

    wrap.querySelectorAll('[data-h]').forEach(el => {
      el.style.top = (usableH * parseFloat(el.dataset.h)) + 'px';
    });
  }

  function inject(fsEl) {
    if (fsEl.querySelector('#' + WRAP_ID)) return;

    if (getComputedStyle(fsEl).position === 'static') {
      fsEl.style.position = 'relative';
    }

    const wrap = document.createElement('div');
    wrap.id = WRAP_ID;
    Object.assign(wrap.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
      display: 'none',
    });

    [1 / 3, 2 / 3].forEach(r => {
      const line = document.createElement('div');
      line.dataset.h = r;
      Object.assign(line.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        borderTop: '1px dashed rgba(255, 0, 0, .85)',
      });
      wrap.appendChild(line);
    });

    [1 / 20, 19 / 20].forEach(r => {
      const line = document.createElement('div');
      Object.assign(line.style, {
        position: 'absolute',
        top: '0',
        bottom: '0',
        left: (r * 100).toFixed(4) + '%',
        borderLeft: '1px dashed rgba(255, 0, 0, .85)',
      });
      wrap.appendChild(line);
    });

    fsEl.appendChild(wrap);
    layout(fsEl);
  }

  function remove() {
    clearTimeout(hideTimer);
    hideTimer = null;
    document.getElementById(WRAP_ID)?.remove();
  }

  function flashGuide() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) return;

    inject(fsEl);
    layout(fsEl);

    const wrap = fsEl.querySelector('#' + WRAP_ID);
    if (!wrap) return;

    wrap.style.display = 'block';

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      wrap.style.display = 'none';
      hideTimer = null;
    }, SHOW_MS);
  }

  function onKeyDown(e) {
    if (e.code !== HOTKEY) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    flashGuide();
  }

  function onFsChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      // 进入全屏自动激活一次
      //flashGuide();
    } else {
      remove();
    }
  }

  function onResize() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) layout(fsEl);
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  window.addEventListener('resize', onResize);
})();