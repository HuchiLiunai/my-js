// ==UserScript==
// @name         播放首尾30秒（按1键）
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  按 1 键：根据当前播放进度，播前30秒或直接跳后30秒；小于1分钟不做任何操作
// @match        https://test.baidu.com/argus/plaza/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const KEY = '1';        // 触发键
  const CHUNK = 30;       // 前后各 30 秒

  // 当前会话的 timeupdate 监听器引用，用于清理
  let currentHandler = null;

  function pickVideo() {
    const byId = document.getElementById('video-player_html5_api');
    if (byId && isFinite(byId.duration) && byId.duration > 0) return byId;

    const list = Array.from(document.querySelectorAll('video'))
      .filter(v => isFinite(v.duration) && v.duration > 0);
    if (list.length) {
      list.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
      return list[0];
    }
    return byId || document.querySelector('video');
  }

  function clearHandler(video) {
    if (currentHandler && video) {
      video.removeEventListener('timeupdate', currentHandler);
    }
    currentHandler = null;
  }

  function playHeadTail() {
    const video = pickVideo();
    if (!video) {
      console.warn('[headtail] 未找到视频');
      return;
    }

    if (!isFinite(video.duration) || video.duration <= 0) {
      console.warn('[headtail] 视频时长未知，等待 loadedmetadata');
      video.addEventListener('loadedmetadata', playHeadTail, { once: true });
      return;
    }

    clearHandler(video);

    const duration = video.duration;
    console.log('[headtail] duration =', duration);

    // 小于 1 分钟：什么都不做
    if (duration <= 60) {
      console.log('[headtail] 视频小于 1 分钟，不执行任何操作');
      return;
    }

    const tailStart = duration - CHUNK;   // 后 30 秒开始位置
    const currentTime = video.currentTime;
    console.log('[headtail] 当前进度 =', currentTime, '，后30秒起点 =', tailStart);

    // 已经在后 30 秒内：什么都不做
    if (currentTime >= tailStart) {
      console.log('[headtail] 已在后 30 秒内，不执行任何操作');
      return;
    }

    // 当前在前 30 秒内：播放到第 30 秒，再跳到后 30 秒
    if (currentTime < CHUNK) {
      console.log('[headtail] 当前在前 30 秒内，播放至', CHUNK, '秒后跳转到', tailStart);
      video.play().catch(() => {});

      currentHandler = function () {
        if (video.currentTime >= CHUNK) {
          video.removeEventListener('timeupdate', currentHandler);
          currentHandler = null;
          console.log('[headtail] 已到达', CHUNK, '秒，跳转到', tailStart);
          video.currentTime = tailStart;
          video.play().catch(() => {});
        }
      };
      video.addEventListener('timeupdate', currentHandler);
      return;
    }

    // 当前在中间部分：直接跳转到后 30 秒
    console.log('[headtail] 当前在中间部分，直接跳转到', tailStart);
    video.currentTime = tailStart;
    video.play().catch(() => {});
  }

  document.addEventListener('keydown', function (e) {
    const el = e.target;
    const tag = (el && el.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (el && el.isContentEditable)) {
      return;
    }

    if (e.key === KEY || e.key === KEY.toUpperCase()) {
      e.preventDefault();
      playHeadTail();
    }
  });
})();