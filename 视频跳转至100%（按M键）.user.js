// ==UserScript==
// @name         视频跳转至100%（按M键）
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  按下V键将主视频进度跳转到100%，没什么价值，就当快速静音了
// @author       YourName
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/1/recheck/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    document.addEventListener('keydown', function(e) {
        // 忽略输入框中的按键（避免在输入文字时误触发）
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            return;
        }

        // 按下 M 键（不区分大小写）
        if (e.key === 'm' || e.key === 'M') {
            const video = document.getElementById('video-player_html5_api');
            if (video && video.duration && isFinite(video.duration)) {
                video.currentTime = video.duration;
                console.log(' ⏩ 视频进度跳转到100%');
                // 注意：跳转到末尾后，如果视频正在播放，会自动触发 ended 事件并暂停。
            } else {
                console.warn('主视频未找到或无有效时长');
            }
        }
    });
})();