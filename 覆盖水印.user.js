// ==UserScript==
// @name         覆盖水印
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  将主要内容区域置顶并加默认背景，覆盖水印，Home键开关
// @match        https://test.baidu.com/argus/plaza/project/1/verify/baseQueueId/*
// @match        https://test.baidu.com/argus/plaza/project/1/recheck/*
// @match        https://test.baidu.com/argus/plaza/project/mt/verify/baseQueueId/*
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const style = document.createElement('style');
    style.textContent = `
        .ant-layout-content, .main-wrap, .layout-content {
            position: relative !important;
            z-index: 2 !important;
            background: #f5f5f5 !important;
        }
    `;

    let on = true;
    const toggle = () => {
        on = !on;
        if (on) document.head.appendChild(style);
        else style.remove();
    };

    document.addEventListener('keydown', e => {
        if (e.key === 'Home') toggle();
    });

    // 默认开启
    document.head.appendChild(style);
})();