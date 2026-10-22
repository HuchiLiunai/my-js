// ==UserScript==
// @name         自定义关键词
// @namespace    local.highlight.inject
// @version      2.1
// @description  将自定义关键词注入到高亮代码里（固定词 + 正则，大小写不敏感，显示原文大小写，支持上下文排除、词库外置、审核员浮层）
// @match        https://test.baidu.com/argus/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      cdn.jsdelivr.net           // ★ 新增
// @require      https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/t2cn.js
// ==/UserScript==

(function() {
	'use strict';

	// ============================================================
	// ① 默认配置（首次运行 / 重置时使用；之后以持久化配置为准）
	// ============================================================
	const CONFIG_KEY = 'argus_custom_keywords_v1';

	// ★ 新增：远端词库配置
	const REMOTE_URL = 'https://cdn.jsdelivr.net/gh/HuchiLiunai/my-js@main/argus-keywords.json'; // 换成你自己的
	const REMOTE_CACHE_KEY = 'argus_keywords_remote_v1';
	const REMOTE_TIME_KEY = 'argus_keywords_remote_v1_time';
	const USER_EDITED_KEY = 'argus_keywords_user_edited_v1';
	const REMOTE_TTL = 10 * 60 * 1000;
	const REMOTE_OVERWRITE_LOCAL = false; // 审核员编辑过之后，远端是否还能强制覆盖

	const DEFAULT_CONFIG = {
		version: 1,
		// words    : 固定词数组，精确匹配
		// patterns : 正则数组，序列化为 { source, flags }
		// fields   : 可选，限定在哪些字段参与门禁/注入（不填=全部）
		// require  : 可选，同段必须共现这些词（norm 后包含）
		// excludeIf: 可选，匹配位置前后窗口命中该正则则跳过该位置
		rules: [
			// {
			//   group: '重要监管事业单位',
			//   category: '媒体新闻',
			//   certaintyLevel: 8,
			//  words: ['第一财经', '东营网络电视台'],
			//},
			//{
			//   group: '金额',
			//  category: '货币',
			//  certaintyLevel: 8,
			//  patterns: [
			//    { source: '[0-9０-９零〇一二三四五六七八九十百千万亿两兆]+元', flags: 'g' },
			//  ],
			// },
		],
		// 命中即删除服务端结果、同时作为 blocker
		excludedWords: [],
		// 仅作为 blocker（不删除服务端结果）
		contextExcludedWords: [],
		// 上下文排除规则：命中 word 且前后窗口满足条件时视为 blocker
		// { word: '抖', excludeIfAfter: '^(动|腿|音|落|擞|然|开|店)' }
		contextRules: [],
	};

	// ============================================================
	// ② 运行时配置
	// ============================================================
	let CONFIG = loadConfig();
	let CUSTOM_RULES = CONFIG.rules;
	let EXCLUDED_WORDS = new Set(CONFIG.excludedWords);
	let CONTEXT_EXCLUDED_WORDS = new Set(CONFIG.contextExcludedWords);
	let CONTEXT_RULES = CONFIG.contextRules;

	let EXCLUDED_WORDS_NORM = new Set();
	let CONTEXT_EXCLUDED_WORDS_NORM = new Set();
	let BLOCKER_WORDS = new Set();
	let CONTEXT_RULES_COMPILED = [];
	let CERTAINTY_WORD_MAP = new Map(); // 归一词 -> { level, rule }
	let CERTAINTY_PATTERN_RULES = []; // { re(无 g), level, rule }
	// ============================================================
	// ③ 门禁开关 / 注入范围（保持原样）
	// ============================================================
	const REQUIRE_IN_ASR_TEXT = true;
	const INJECT_FIELDS = null;

	// ============================================================
	// ④ URL 匹配（保持原样）
	// ============================================================
	const RE_REFERENCES = /\/argus\/api\/video\/project\/\d+\/base-queue\/\d+\/page\/\d+\/references/;
	const RE_LOAD = /\/result\/verify\/project\/[^/]+\/base-queue\/[^/]+\/get(\?|$)/;
	const RE_QUEUE_LIST = /\/result\/verify\/queue\/[^/]+\/list(\?|$)/;

	// ============================================================
	// ⑤ 工具函数
	// ============================================================
	let toSimplified;
	try {
		if (typeof OpenCC !== 'undefined' && OpenCC && typeof OpenCC.Converter === 'function') {
			toSimplified = OpenCC.Converter({
				from: 't',
				to: 'cn'
			});
		} else {
			throw new Error('OpenCC not available');
		}
	} catch (e) {
		console.warn('[自定义关键词] OpenCC 加载失败，繁简转换降级', e);
		toSimplified = s => String(s || '');
	}

	const norm = s => toSimplified(String(s || ''))
		.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
		.replace(/[\uFE0E\uFE0F]/g, '')
		.replace(/[\s\u3000]+/g, '')
		.toLowerCase();

	const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const RE_ASCII_WORD_CHAR = /[A-Za-z0-9_]/;

	function isAsciiWordChar(ch) {
		return typeof ch === 'string' && ch.length === 1 && RE_ASCII_WORD_CHAR.test(ch);
	}

	// 仅当 word 首/尾是 ASCII 字母数字或下划线时，才要求对应一侧有边界
	function hasWordBoundary(text, start, end, word) {
		const w = word || '';
		if (!w) return true;
		if (isAsciiWordChar(w[0])) {
			if (start > 0 && isAsciiWordChar(text[start - 1])) return false;
		}
		if (isAsciiWordChar(w[w.length - 1])) {
			if (end < text.length && isAsciiWordChar(text[end])) return false;
		}
		return true;
	}

	// 带边界的包含判断（用于门禁/共现）
	function containsWord(normText, word) {
		if (!normText || !word) return false;
		let idx = normText.indexOf(word);
		while (idx !== -1) {
			if (hasWordBoundary(normText, idx, idx + word.length, word)) return true;
			idx = normText.indexOf(word, idx + 1);
		}
		return false;
	}

	function rebuildDerivedSets() {
		EXCLUDED_WORDS_NORM = new Set(Array.from(EXCLUDED_WORDS, norm));
		CONTEXT_EXCLUDED_WORDS_NORM = new Set(Array.from(CONTEXT_EXCLUDED_WORDS, norm));
		BLOCKER_WORDS = new Set([...EXCLUDED_WORDS, ...CONTEXT_EXCLUDED_WORDS]);
	}

	const isExcluded = w => EXCLUDED_WORDS.has(w) || EXCLUDED_WORDS_NORM.has(norm(w));
	const isContextExcluded = w => CONTEXT_EXCLUDED_WORDS.has(w) || CONTEXT_EXCLUDED_WORDS_NORM.has(norm(w));

	// 归一化 + 索引映射（长度一致时 indexMap 可用，display 可保真）
	function normalizeWithIndex(text) {
		const s = String(text || '');
		const chars = [];
		const origIdx = [];
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (/[\u200B-\u200D\uFEFF\u2060\uFE0E\uFE0F]/.test(ch)) continue;
			if (/[\s\u3000]/.test(ch)) continue;
			chars.push(ch);
			origIdx.push(i);
		}
		const cleaned = chars.join('');
		let simplified = '';
		try {
			simplified = toSimplified(cleaned);
		} catch {
			simplified = cleaned;
		}
		const lowered = simplified.toLowerCase();
		const aligned = simplified.length === chars.length && lowered.length === chars.length;
		const indexMap = aligned ? origIdx : null;
		return {
			normText: lowered,
			indexMap,
			chars,
			aligned
		};
	}
	// ★ 新增：存储 & 远端缓存工具
	function getStorage(key, def) {
		try {
			if (typeof GM_getValue === 'function') {
				const v = GM_getValue(key);
				return v === undefined ? def : v;
			}
			const raw = localStorage.getItem(key);
			if (raw == null) return def;
			try {
				return JSON.parse(raw);
			} catch {
				return raw;
			}
		} catch {
			return def;
		}
	}

	function setStorage(key, val) {
		try {
			if (typeof GM_setValue === 'function') GM_setValue(key, val);
			else localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
		} catch (e) {
			console.warn('[自定义关键词] 存储失败', key, e);
		}
	}

	function readRemoteCache() {
		const cfg = getStorage(REMOTE_CACHE_KEY, null);
		if (!cfg) return null;
		try {
			const parsed = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
			return (parsed && typeof parsed === 'object') ? parsed : null;
		} catch {
			return null;
		}
	}

	function readRemoteCacheTime() {
		const t = getStorage(REMOTE_TIME_KEY, 0);
		return typeof t === 'number' ? t : (Number(t) || 0);
	}

	function isUserEdited() {
		return !!getStorage(USER_EDITED_KEY, 0);
	}

	function markUserEdited() {
		setStorage(USER_EDITED_KEY, Date.now());
	}

	function clearUserEdited() {
		setStorage(USER_EDITED_KEY, 0);
	}

	// ============================================================
	// ⑥ Aho-Corasick（固定词多模式匹配，含重叠）
	// ============================================================
	class AhoCorasick {
		constructor() {
			this.children = [new Map()];
			this.fail = [0];
			this.out = [
				[]
			];
		}
		add(word, payload) {
			let cur = 0;
			for (let i = 0; i < word.length; i++) {
				const ch = word[i];
				let next = this.children[cur].get(ch);
				if (next === undefined) {
					next = this.children.length;
					this.children[cur].set(ch, next);
					this.children.push(new Map());
					this.fail.push(0);
					this.out.push([]);
				}
				cur = next;
			}
			this.out[cur].push({
				word,
				payload
			});
		}
		build() {
			const queue = [];
			for (const [, next] of this.children[0]) {
				this.fail[next] = 0;
				queue.push(next);
			}
			let head = 0;
			while (head < queue.length) {
				const cur = queue[head++];
				for (const [ch, next] of this.children[cur]) {
					let f = this.fail[cur];
					while (f !== 0 && !this.children[f].has(ch)) f = this.fail[f];
					const fNext = this.children[f].get(ch);
					this.fail[next] = (fNext !== undefined && fNext !== next) ? fNext : 0;
					if (this.out[this.fail[next]].length) {
						this.out[next] = this.out[next].concat(this.out[this.fail[next]]);
					}
					queue.push(next);
				}
			}
		}
		search(text) {
			const results = [];
			let cur = 0;
			for (let i = 0; i < text.length; i++) {
				const ch = text[i];
				while (cur !== 0 && !this.children[cur].has(ch)) cur = this.fail[cur];
				const next = this.children[cur].get(ch);
				cur = next !== undefined ? next : 0;
				for (const item of this.out[cur]) {
					const len = item.word.length;
					if (len > 0) {
						results.push({
							start: i - len + 1,
							end: i + 1,
							word: item.word,
							payload: item.payload
						});
					}
				}
			}
			return results;
		}
	}

	// ============================================================
	// ⑦ 词索引（WORD_INDEX + AC + 上下文规则编译）
	// ============================================================
	let WORD_INDEX = new Map();
	let AC = new AhoCorasick();
	let AC_ENTRIES = new Map();

	function toRegExp(p) {
		if (p instanceof RegExp) return p;
		if (typeof p === 'string') {
			const idx = p.lastIndexOf('|');
			if (idx > 0 && /^[gimsuy]*$/.test(p.slice(idx + 1))) {
				try {
					return new RegExp(p.slice(0, idx), p.slice(idx + 1));
				} catch {}
			}
			try {
				return new RegExp(p);
			} catch {}
			return null;
		}
		if (p && typeof p === 'object' && typeof p.source === 'string') {
			try {
				return new RegExp(p.source, p.flags || '');
			} catch {
				return null;
			}
		}
		return null;
	}

	function compileContextRules(rules) {
		if (!Array.isArray(rules)) return [];
		return rules.map(r => {
			if (!r || !r.word) return null;
			const nw = norm(r.word);
			if (!nw) return null;
			let after = null,
				before = null;
			try {
				if (r.excludeIfAfter) after = new RegExp(r.excludeIfAfter, 'u');
			} catch {}
			try {
				if (r.excludeIfBefore) before = new RegExp(r.excludeIfBefore, 'u');
			} catch {}
			if (!after && !before) return null;
			return {
				word: r.word,
				normWord: nw,
				after,
				before
			};
		}).filter(Boolean);
	}

	function rebuildIndexes() {
		WORD_INDEX = new Map();
		AC = new AhoCorasick();
		AC_ENTRIES = new Map();

		CUSTOM_RULES.forEach(rule => {
			const fields = Array.isArray(rule.fields) ? new Set(rule.fields) : null;
			const requireNorms = Array.isArray(rule.require) ?
				rule.require.map(norm).filter(Boolean) :
				null;
			let excludeIfRe = null;
			if (rule.excludeIf) {
				try {
					excludeIfRe = new RegExp(rule.excludeIf, 'u');
				} catch {}
			}
			const compiledRule = Object.assign({}, rule, {
				_fields: fields,
				_requireNorms: requireNorms,
				_excludeIfRe: excludeIfRe,
			});

			(rule.words || []).forEach(w => {
				if (!w) return;
				const nw = norm(w);
				if (!nw) return;
				if (isExcluded(w)) return;
				if (isContextExcluded(w)) return;
				const key = 'word:' + nw;
				const prev = WORD_INDEX.get(key);
				if (!prev || rule.certaintyLevel > prev.rule.certaintyLevel) {
					WORD_INDEX.set(key, {
						type: 'word',
						word: w,
						rule: compiledRule
					});
					const prevAC = AC_ENTRIES.get(nw);
					if (!prevAC || rule.certaintyLevel > prevAC.rule.certaintyLevel) {
						AC_ENTRIES.set(nw, {
							word: w,
							rule: compiledRule
						});
					}
				}
			});

			(rule.patterns || []).forEach(p => {
				const re = toRegExp(p);
				if (!re) return;
				const key = 'pattern:' + re.source + '|' + re.flags;
				const prev = WORD_INDEX.get(key);
				if (!prev || rule.certaintyLevel > prev.rule.certaintyLevel) {
					WORD_INDEX.set(key, {
						type: 'pattern',
						pattern: re,
						rule: compiledRule
					});
				}
			});
		});

		AC_ENTRIES.forEach((entry, nw) => {
			AC.add(nw, entry);
		});
		AC.build();

		CONTEXT_RULES_COMPILED = compileContextRules(CONTEXT_RULES);
		rebuildCertaintyIndex();
	}

	function rebuildCertaintyIndex() {
		CERTAINTY_WORD_MAP = new Map();
		CERTAINTY_PATTERN_RULES = [];
		CUSTOM_RULES.forEach(rule => {
			const level = rule.certaintyLevel;
			if (typeof level !== 'number' || !isFinite(level)) return;

			(rule.words || []).forEach(w => {
				const nw = norm(w);
				if (!nw) return;
				const prev = CERTAINTY_WORD_MAP.get(nw);
				if (!prev || level > prev.level) {
					CERTAINTY_WORD_MAP.set(nw, {
						level,
						rule
					});
				}
			});

			(rule.patterns || []).forEach(p => {
				const re = toRegExp(p);
				if (!re) return;
				let flagLess;
				try {
					flagLess = new RegExp(re.source, re.flags.replace(/g/g, ''));
				} catch {
					return;
				}
				CERTAINTY_PATTERN_RULES.push({
					re: flagLess,
					level,
					rule
				});
			});
		});
	}

	function resolveCertaintyForHit(word) {
		if (!word) return null;
		const nw = norm(word);
		let best = null;
		const fromMap = CERTAINTY_WORD_MAP.get(nw);
		if (fromMap) best = fromMap;
		for (const {
				re,
				level,
				rule
			}
			of CERTAINTY_PATTERN_RULES) {
			try {
				if (re.test(nw) || re.test(word)) {
					if (!best || level > best.level) best = {
						level,
						rule
					};
				}
			} catch {}
		}
		return best;
	}
	// ============================================================
	// ⑧ 配置持久化
	// ============================================================
	function normalizeConfig(cfg) {
		const base = {
			version: 1,
			rules: [],
			excludedWords: [],
			contextExcludedWords: [],
			contextRules: []
		};
		if (!cfg || typeof cfg !== 'object') return base;
		return {
			version: cfg.version || 1,
			rules: Array.isArray(cfg.rules) ? cfg.rules : [],
			excludedWords: Array.isArray(cfg.excludedWords) ? cfg.excludedWords : [],
			contextExcludedWords: Array.isArray(cfg.contextExcludedWords) ? cfg.contextExcludedWords : [],
			contextRules: Array.isArray(cfg.contextRules) ? cfg.contextRules : [],
		};
	}

	function loadConfig() {
		try {
			let raw = null;
			if (typeof GM_getValue === 'function') {
				raw = GM_getValue(CONFIG_KEY, null);
			} else {
				raw = localStorage.getItem(CONFIG_KEY);
			}
			if (raw) {
				const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
				return normalizeConfig(parsed);
			}
		} catch (e) {
			console.warn('[自定义关键词] 配置加载失败，使用默认', e);
		}
		// ★ 新增：无本地配置时，优先使用远端缓存
		const remote = readRemoteCache();
		if (remote) {
			console.info('[自定义关键词] 无本地配置，使用远端词库缓存 v%s', remote.version);
			return normalizeConfig(remote);
		}
		return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	}

	function saveConfig(cfg, opts = {}) {
		CONFIG = normalizeConfig(cfg);
		CUSTOM_RULES = CONFIG.rules;
		EXCLUDED_WORDS = new Set(CONFIG.excludedWords);
		CONTEXT_EXCLUDED_WORDS = new Set(CONFIG.contextExcludedWords);
		CONTEXT_RULES = CONFIG.contextRules;
		rebuildDerivedSets();
		rebuildIndexes();
		try {
			const raw = JSON.stringify(CONFIG);
			if (typeof GM_setValue === 'function') GM_setValue(CONFIG_KEY, raw);
			else localStorage.setItem(CONFIG_KEY, raw);
		} catch (e) {
			console.warn('[自定义关键词] 配置保存失败', e);
		}
		// ★ 新增：区分来源，避免远端覆盖时误标"用户已编辑"
		if (opts.fromRemote || opts.reset) {
			clearUserEdited();
		} else {
			markUserEdited();
		}
	}

	// 初始化派生集合 + 索引
	rebuildDerivedSets();
	rebuildIndexes();
	// ============================================================
	// ★ 新增：⑧.5 远端词库加载
	// ============================================================
	function applyRemoteConfig(remote) {
		if (!remote || typeof remote !== 'object') return;
		if (CONFIG && CONFIG.version === remote.version) return; // 版本相同不折腾
		if (!REMOTE_OVERWRITE_LOCAL && isUserEdited()) {
			console.info(
				'[自定义关键词] 审核员已编辑本地配置，跳过远端覆盖（远端 v%s，本地 v%s）',
				remote.version, CONFIG.version
			);
			return;
		}
		saveConfig(remote, {
			fromRemote: true
		});
		console.info('[自定义关键词] 已应用远端词库 v%s', remote.version);
	}

	function refreshRemoteKeywords() {
		const now = Date.now();
		if (now - readRemoteCacheTime() < REMOTE_TTL) return; // 缓存新鲜，跳过

		const onSuccess = (text) => {
			try {
				const remote = JSON.parse(text);
				if (!remote || typeof remote !== 'object') throw new Error('非对象');
				setStorage(REMOTE_CACHE_KEY, remote);
				setStorage(REMOTE_TIME_KEY, now);
				applyRemoteConfig(remote);
			} catch (e) {
				console.warn('[自定义关键词] 远端词库解析失败', e);
			}
		};
		const onError = () => {
			console.warn('[自定义关键词] 远端词库请求失败，继续使用本地/缓存');
		};

		if (typeof GM_xmlhttpRequest === 'function') {
			GM_xmlhttpRequest({
				method: 'GET',
				url: REMOTE_URL + '?ts=' + now,
				noCache: true,
				onload(resp) {
					if (resp.status < 200 || resp.status >= 300) {
						console.warn('[自定义关键词] 远端词库 HTTP 状态异常', resp.status);
						return;
					}
					onSuccess(resp.responseText);
				},
				onerror: onError,
				ontimeout: onError,
			});
		} else {
			fetch(REMOTE_URL + '?ts=' + now, {
					cache: 'no-store'
				})
				.then(r => r.text())
				.then(onSuccess)
				.catch(onError);
		}
	}
	// ============================================================
	// ⑨ 位置查找 / 区间竞争
	// ============================================================
	function findAllPositions(normText, target, opts) {
		const positions = [];
		const wordBoundary = !!(opts && opts.wordBoundary);
		const wordForBoundary = (opts && opts.word) || (typeof target === 'string' ? target : '');

		if (target instanceof RegExp) {
			const re = target.global ?
				new RegExp(target.source, target.flags) :
				new RegExp(target.source, target.flags + 'g');
			let m;
			while ((m = re.exec(normText)) !== null) {
				if (m[0].length === 0) {
					re.lastIndex++;
					continue;
				}
				const s = m.index,
					e = m.index + m[0].length;
				if (wordBoundary && !hasWordBoundary(normText, s, e, m[0])) continue;
				positions.push([s, e]);
			}
			return positions;
		}

		if (!target) return positions;
		let idx = normText.indexOf(target);
		while (idx !== -1) {
			const end = idx + target.length;
			if (!wordBoundary || hasWordBoundary(normText, idx, end, wordForBoundary || target)) {
				positions.push([idx, end]);
			}
			idx = normText.indexOf(target, idx + 1);
		}
		return positions;
	}

	function isFullyCovered(covered, [s, e]) {
		for (let i = s; i < e; i++) {
			if (!covered[i]) return false;
		}
		return true;
	}

	function isContextExcludedAt(normText, s, e, re) {
		const before = normText.slice(Math.max(0, s - 10), s);
		const after = normText.slice(e, Math.min(normText.length, e + 10));
		return re.test(before + after);
	}

	function expandContextRules(normText, all) {
		if (!CONTEXT_RULES_COMPILED.length) return;
		CONTEXT_RULES_COMPILED.forEach(rule => {
			if (!rule.normWord) return;
			let idx = normText.indexOf(rule.normWord);
			while (idx !== -1) {
				const end = idx + rule.normWord.length;

				// ★ 词边界过滤
				if (!hasWordBoundary(normText, idx, end, rule.normWord)) {
					idx = normText.indexOf(rule.normWord, idx + 1);
					continue;
				}

				let excluded = false;
				if (rule.after) {
					const after = normText.slice(end, Math.min(normText.length, end + 20));
					if (rule.after.test(after)) excluded = true;
				}
				if (!excluded && rule.before) {
					const before = normText.slice(Math.max(0, idx - 20), idx);
					if (rule.before.test(before)) excluded = true;
				}
				if (excluded) all.push({
					start: idx,
					end,
					kind: 'blocker'
				});
				idx = normText.indexOf(rule.normWord, idx + 1);
			}
		});
	}

	function collectAlready(results) {
		const set = new Set();
		results.forEach(r => (r.hits || []).forEach(h => set.add(h)));
		return set;
	}

	/**
	 * 展开所有匹配区间 → 按长度降序 → 贪心占用
	 * @param {{normText:string, indexMap:number[]|null, chars:string[]|null, aligned:boolean}} gate
	 * @param {Array<{type:'word'|'pattern', word?, pattern?, rule}>} candidates
	 * @param {Iterable<string>} existingWords
	 * @param {Map<string, Array<[number,number]>>|null} wordPositions AC 预计算结果
	 */
	function filterByCoverage(gate, candidates, existingWords, wordPositions) {
		const normText = gate.normText;
		const all = [];

		// 1) existing
		for (const w of existingWords) {
			const nw = norm(w);
			if (!nw) continue;
			for (const [s, e] of findAllPositions(normText, nw)) {
				all.push({
					start: s,
					end: e,
					kind: 'existing'
				});
			}
		}

		// 2) candidates
		for (const c of candidates) {
			if (c.type === 'pattern') {
				for (const [s, e] of findAllPositions(normText, c.pattern)) {
					if (c.rule._excludeIfRe && isContextExcludedAt(normText, s, e, c.rule._excludeIfRe)) continue;
					const display = (gate.aligned && gate.chars) ?
						gate.chars.slice(s, e).join('') :
						normText.slice(s, e);
					all.push({
						start: s,
						end: e,
						kind: 'candidate',
						rule: c.rule,
						display
					});
				}
			} else {
				const nw = norm(c.word);
				if (!nw) continue;
				const positions = (wordPositions && wordPositions.get(nw)) ||
					findAllPositions(normText, nw, {
						wordBoundary: true,
						word: nw
					});
				for (const [s, e] of positions) {
					if (c.rule._excludeIfRe && isContextExcludedAt(normText, s, e, c.rule._excludeIfRe)) continue;
					const display = (gate.aligned && gate.chars) ?
						gate.chars.slice(s, e).join('') :
						c.word;
					all.push({
						start: s,
						end: e,
						kind: 'candidate',
						rule: c.rule,
						display
					});
				}
			}
		}

		// 3) blockers（排除词 + 上下文排除词 + 上下文规则）
		for (const w of BLOCKER_WORDS) {
			if (!w) continue;
			const nw = norm(w);
			if (!nw) continue;
			for (const [s, e] of findAllPositions(normText, nw, {
					wordBoundary: true,
					word: nw
				})) {
				all.push({
					start: s,
					end: e,
					kind: 'blocker'
				});
			}
		}
		expandContextRules(normText, all);

		// 4) 长匹配优先；同长度 existing > blocker > candidate
		const order = {
			existing: 0,
			blocker: 1,
			candidate: 2
		};
		all.sort((a, b) => {
			const la = a.end - a.start;
			const lb = b.end - b.start;
			if (lb !== la) return lb - la;
			return (order[a.kind] || 0) - (order[b.kind] || 0);
		});

		// 5) 贪心占用
		const covered = new Uint8Array(normText.length);
		const accepted = [];
		const acceptedSet = new Set();

		for (const item of all) {
			const {
				start,
				end,
				kind
			} = item;

			if (kind === 'candidate') {
				if (isFullyCovered(covered, [start, end])) continue;
				const key = item.rule.group + '\u0000' + norm(item.display);
				if (acceptedSet.has(key)) {
					for (let i = start; i < end; i++) covered[i] = 1;
					continue;
				}
				acceptedSet.add(key);
				accepted.push({
					display: item.display,
					rule: item.rule
				});
			}

			for (let i = start; i < end; i++) covered[i] = 1;
		}

		return accepted;
	}

	// ============================================================
	// ⑩ 注入
	// ============================================================
	function injectIntoResultsArray(results, gateText, injectedHits, fieldKey) {
		if (!Array.isArray(results)) return;

		const already = collectAlready(results);
		const alreadyNorm = new Set(Array.from(already, norm));

		const gate = REQUIRE_IN_ASR_TEXT ?
			normalizeWithIndex(gateText) :
			{
				normText: '',
				indexMap: null,
				chars: null,
				aligned: false
			};
		const gateNorm = gate.normText;

		const candidates = [];
		WORD_INDEX.forEach(entry => {
			const rule = entry.rule;

			// per-rule 字段限定
			if (rule._fields && fieldKey && !rule._fields.has(fieldKey)) return;

			// per-rule 共现要求（全文级）
			if (rule._requireNorms) {
				for (const rq of rule._requireNorms) {
					if (!containsWord(gateNorm, rq)) return;
				}
			}
			if (entry.type === 'pattern') {
				if (!REQUIRE_IN_ASR_TEXT || !gateNorm) return;
				candidates.push({
					type: 'pattern',
					pattern: entry.pattern,
					rule
				});
				return;
			}

			const word = entry.word;
			const nw = norm(word);
			if (!nw) return;
			if (already.has(word) || alreadyNorm.has(nw)) return;
			if (REQUIRE_IN_ASR_TEXT) {
				if (!gateNorm) return;
				if (!containsWord(gateNorm, nw)) return;
			}
			candidates.push({
				type: 'word',
				word,
				rule
			});
		});
		if (!candidates.length) return;

		// AC 预计算固定词位置（一次扫描，减少 indexOf 次数）
		let wordPositions = null;
		if (REQUIRE_IN_ASR_TEXT && gateNorm && AC && AC.out.length > 1) {
			wordPositions = new Map();
			const matches = AC.search(gateNorm);
			for (const m of matches) {
				if (!hasWordBoundary(gateNorm, m.start, m.end, m.word)) continue;
				let arr = wordPositions.get(m.word);
				if (!arr) {
					arr = [];
					wordPositions.set(m.word, arr);
				}
				arr.push([m.start, m.end]);
			}
		}

		let accepted;
		if (REQUIRE_IN_ASR_TEXT && gateText) {
			accepted = filterByCoverage(gate, candidates, already, wordPositions);
		} else {
			accepted = candidates
				.filter(c => c.type === 'word')
				.map(c => ({
					display: c.word,
					rule: c.rule
				}));
		}
		if (!accepted.length) return;

		const buckets = new Map();
		accepted.forEach(({
			display,
			rule
		}) => {
			if (!buckets.has(rule)) buckets.set(rule, []);
			buckets.get(rule).push(display);
		});

		buckets.forEach((words, rule) => {
			results.push({
				tip: '',
				hits: words,
				type: 'keywords',
				extra: {},
				group: rule.group,
				category: rule.category,
				certaintyLevel: rule.certaintyLevel,
			});
			if (injectedHits) {
				words.forEach(w => injectedHits.push({
					word: w,
					rule
				}));
			}
		});
	}

	function processTarget(target, gateText, frameHits, otherHits, fieldKey) {
		if (!target || typeof target !== 'object') return;
		if (Array.isArray(target.results)) {
			injectIntoResultsArray(target.results, gateText, otherHits, fieldKey);
		}
		if (Array.isArray(target.frames)) {
			target.frames.forEach(f => {
				if (f && Array.isArray(f.results)) {
					const frameText = typeof f.text === 'string' ? f.text : '';
					injectIntoResultsArray(f.results, frameText, frameHits, fieldKey);
				}
			});
		}
	}

	function syncHitCount(target) {
		if (!target || typeof target !== 'object') return;
		if (Array.isArray(target.results)) target.hitCount = target.results.length;
		if (Array.isArray(target.frames)) {
			target.frames.forEach(f => {
				if (f && Array.isArray(f.results)) f.hitCount = f.results.length;
			});
		}
	}

	function injectIntoViolationInfos(ref, injectedHits) {
		if (!ref || !Array.isArray(ref.violationInfos)) return;
		if (!injectedHits || !injectedHits.length) return;

		const seen = new Set();
		const unique = [];
		injectedHits.forEach(item => {
			const key = item.rule.group + '\u0000' + norm(item.word);
			if (seen.has(key)) return;
			seen.add(key);
			unique.push(item);
		});

		const byGroup = new Map();
		unique.forEach(item => {
			if (!byGroup.has(item.rule.group)) {
				byGroup.set(item.rule.group, {
					rule: item.rule,
					words: []
				});
			}
			byGroup.get(item.rule.group).words.push(item.word);
		});

		byGroup.forEach(({
			rule,
			words
		}, group) => {
			let groupEntry = ref.violationInfos.find(g => g && g.group === group);
			if (!groupEntry) {
				groupEntry = {
					group,
					certaintyLevel: rule.certaintyLevel,
					details: []
				};
				ref.violationInfos.push(groupEntry);
			}
			words.forEach(word => {
				const exists = groupEntry.details.some(d => d && d.hit && norm(d.hit) === norm(word));
				if (exists) return;
				groupEntry.details.push({
					group,
					certaintyLevel: rule.certaintyLevel,
					hits: [word],
					hit: word,
					count: 1,
					startTime: 0,
					endTime: 0,
				});
			});
		});
	}

	function updateAutoVerifyTop(ref, injectedHits) {
		if (!ref || typeof ref.autoVerifyTop !== 'string') return;
		if (!injectedHits || !injectedHits.length) return;

		// 结构化解析：group -> Set<word>；无法解析的保留原样
		const groups = new Map();
		const otherParts = [];
		const parts = ref.autoVerifyTop.split('、').filter(Boolean);
		for (const part of parts) {
			const m = part.match(/^([^(]+)\(([^)]+)\)$/);
			if (m) {
				const g = m[1].trim();
				const words = m[2].split('/').map(s => s.trim()).filter(Boolean);
				if (!groups.has(g)) groups.set(g, new Set());
				words.forEach(w => groups.get(g).add(w));
			} else {
				otherParts.push(part);
			}
		}

		injectedHits.forEach(({
			word,
			rule
		}) => {
			const g = rule.group;
			if (!groups.has(g)) groups.set(g, new Set());
			groups.get(g).add(word);
		});

		const rebuilt = otherParts.slice();
		groups.forEach((words, g) => {
			if (!words.size) return;
			rebuilt.push(g + '(' + Array.from(words).join('/') + ')');
		});
		ref.autoVerifyTop = rebuilt.join('、');
	}

	// ============================================================
	// ⑪ 删除排除词相关（保持原逻辑）
	// ============================================================
	// 覆盖 results[].certaintyLevel
	function overrideCertaintyInResultsArray(results) {
		if (!Array.isArray(results)) return;
		results.forEach(r => {
			if (!r || !Array.isArray(r.hits) || !r.hits.length) return;
			let maxLevel = -Infinity;
			let matched = false;
			r.hits.forEach(h => {
				const entry = resolveCertaintyForHit(h);
				if (entry && entry.level > maxLevel) {
					maxLevel = entry.level;
					matched = true;
				}
			});
			if (matched) r.certaintyLevel = maxLevel;
		});
	}

	function overrideCertaintyInTarget(target) {
		if (!target || typeof target !== 'object') return;
		if (Array.isArray(target.results)) overrideCertaintyInResultsArray(target.results);
		if (Array.isArray(target.frames)) {
			target.frames.forEach(f => {
				if (f && Array.isArray(f.results)) overrideCertaintyInResultsArray(f.results);
			});
		}
	}

	// 覆盖 violationInfos[].details[].certaintyLevel
	function overrideCertaintyInViolationInfos(ref) {
		if (!ref || !Array.isArray(ref.violationInfos)) return;
		ref.violationInfos.forEach(group => {
			if (!group || !Array.isArray(group.details)) return;
			group.details.forEach(d => {
				if (!d) return;
				const words = [];
				if (typeof d.hit === 'string') words.push(d.hit);
				if (Array.isArray(d.hits)) {
					d.hits.forEach(h => {
						if (typeof h === 'string') words.push(h);
					});
				}
				let maxLevel = -Infinity;
				let matched = false;
				words.forEach(w => {
					const entry = resolveCertaintyForHit(w);
					if (entry && entry.level > maxLevel) {
						maxLevel = entry.level;
						matched = true;
					}
				});
				if (matched) d.certaintyLevel = maxLevel;
			});
		});
	}

	// 统一入口
	function applyCertaintyOverride(ref) {
		if (!ref || typeof ref !== 'object') return;
		Object.keys(ref).forEach(k => {
			if (k === 'violationInfos' || k === 'autoVerifyTop') return;
			overrideCertaintyInTarget(ref[k]);
		});
		overrideCertaintyInViolationInfos(ref);
	}

	function removeExcludedFromResults(results) {
		if (!Array.isArray(results)) return;
		for (let i = results.length - 1; i >= 0; i--) {
			const r = results[i];
			if (r && Array.isArray(r.hits)) {
				r.hits = r.hits.filter(h => !isExcluded(h));
				if (r.hits.length === 0) results.splice(i, 1);
			}
		}
	}

	function removeExcludedFromTarget(target) {
		if (!target || typeof target !== 'object') return;
		if (Array.isArray(target.results)) {
			removeExcludedFromResults(target.results);
			if (typeof target.hitCount === 'number') target.hitCount = target.results.length;
		}
		if (Array.isArray(target.frames)) {
			target.frames.forEach(f => {
				if (f && Array.isArray(f.results)) {
					removeExcludedFromResults(f.results);
					if (typeof f.hitCount === 'number') f.hitCount = f.results.length;
				}
			});
		}
	}

	function removeExcludedFromViolationInfos(ref) {
		if (!ref || !Array.isArray(ref.violationInfos)) return;
		for (let i = ref.violationInfos.length - 1; i >= 0; i--) {
			const group = ref.violationInfos[i];
			if (group && Array.isArray(group.details)) {
				for (let j = group.details.length - 1; j >= 0; j--) {
					const detail = group.details[j];
					if (detail && Array.isArray(detail.hits)) {
						detail.hits = detail.hits.filter(h => !isExcluded(h));
						if (detail.hits.length === 0) group.details.splice(j, 1);
					}
				}
				if (group.details.length === 0) ref.violationInfos.splice(i, 1);
			}
		}
	}

	function removeExcludedFromAutoVerifyTop(ref) {
		if (!ref || typeof ref.autoVerifyTop !== 'string') return;
		const groups = new Map();
		const otherParts = [];
		const parts = ref.autoVerifyTop.split('、').filter(Boolean);
		for (const part of parts) {
			const m = part.match(/^([^(]+)\(([^)]+)\)$/);
			if (m) {
				const g = m[1].trim();
				const words = m[2].split('/').map(w => w.trim()).filter(Boolean);
				const remaining = words.filter(w => !isExcluded(w));
				if (remaining.length) {
					if (!groups.has(g)) groups.set(g, new Set());
					remaining.forEach(w => groups.get(g).add(w));
				}
			} else {
				otherParts.push(part);
			}
		}
		const rebuilt = otherParts.slice();
		groups.forEach((words, g) => {
			if (!words.size) return;
			rebuilt.push(g + '(' + Array.from(words).join('/') + ')');
		});
		ref.autoVerifyTop = rebuilt.join('、');
	}

	// ============================================================
	// ⑫ get / list：抽取标题文本 + LRU(24)
	// ============================================================
	const TITLE_BY_PAGEID = new Map();
	const TITLE_MAX = 24;

	function setTitle(pageId, text) {
		if (TITLE_BY_PAGEID.has(pageId)) TITLE_BY_PAGEID.delete(pageId);
		TITLE_BY_PAGEID.set(pageId, text);
		while (TITLE_BY_PAGEID.size > TITLE_MAX) {
			const first = TITLE_BY_PAGEID.keys().next().value;
			TITLE_BY_PAGEID.delete(first);
		}
	}

	function extractTitleText(obj) {
		if (!obj || typeof obj !== 'object') return '';
		const tb = obj.textBody;
		if (!Array.isArray(tb)) return '';
		return tb
			.filter(item => item && typeof item.text === 'string')
			.map(item => item.text)
			.join('\n');
	}

	function handleGetResponse(data) {
		const d = data && data.data;
		if (!d) return false;
		const pageId = d.pageId;
		if (!pageId) return false;
		const text = extractTitleText(d.data);
		if (!text) return false;
		setTitle(pageId, text);
		return true;
	}

	function handleListResponse(data) {
		const d = data && data.data;
		if (!d || !Array.isArray(d.pageList)) return false;
		let any = false;
		d.pageList.forEach(item => {
			if (!item || !item.pageId) return;
			const text = extractTitleText(item.data);
			if (!text) return;
			setTitle(item.pageId, text);
			any = true;
		});
		return any;
	}

	// ============================================================
	// ⑬ 处理 references 响应
	// ============================================================
	function processResponse(data) {
		const ref = data && data.data && data.data.referenceData;
		if (!ref) return false;

		const pageId = data.data.pageId;
		const titleText = TITLE_BY_PAGEID.get(pageId) || '';
		const asrText = (ref.asr && typeof ref.asr.text === 'string' && ref.asr.text) || '';

		Object.keys(ref).forEach(k => removeExcludedFromTarget(ref[k]));
		removeExcludedFromViolationInfos(ref);
		removeExcludedFromAutoVerifyTop(ref);

		applyCertaintyOverride(ref);

		const frameHits = [];
		const otherHits = [];

		(INJECT_FIELDS || Object.keys(ref)).forEach(k => {
			if (k === 'asr') return;
			if (k === 'title') {
				if (!titleText) return;
				processTarget(ref[k], titleText, frameHits, otherHits, k);
				return;
			}
			processTarget(ref[k], asrText, frameHits, otherHits, k);
		});

		// 只把 frameHits 灌进 violationInfos / autoVerifyTop
		injectIntoViolationInfos(ref, frameHits);
		updateAutoVerifyTop(ref, frameHits);

		// 注入后同步 hitCount
		Object.keys(ref).forEach(k => syncHitCount(ref[k]));

		// 面板按需：想只显示 frame 命中就用 frameHits；想显示全部就保留 allInjected
		const allInjected = frameHits.concat(otherHits);
		if (panelApi && allInjected.length) {
			panelApi.updateHits(allInjected, pageId);
		}

		return true;
	}

	function classifyUrl(url) {
		const u = String(url || '');
		if (RE_REFERENCES.test(u)) return 'references';
		if (RE_LOAD.test(u)) return 'get';
		if (RE_QUEUE_LIST.test(u)) return 'list';
		return null;
	}

	// ============================================================
	// ⑭ 状态
	// ============================================================
	let refsModifyPaused = false;
	let panelApi = null;

	// ============================================================
	// ⑮ XHR 拦截（保持原结构）
	// ============================================================
	const OrigOpen = XMLHttpRequest.prototype.open;
	const OrigSend = XMLHttpRequest.prototype.send;

	XMLHttpRequest.prototype.open = function(method, url, ...rest) {
		this.__custom_url = url;
		this.__custom_patched = false;
		this.__custom_kind = classifyUrl(url);
		return OrigOpen.call(this, method, url, ...rest);
	};

	XMLHttpRequest.prototype.send = function(...args) {
		const self = this;
		self.addEventListener('readystatechange', function() {
			if (self.readyState !== 4) return;
			if (self.__custom_patched) return;

			const kind = self.__custom_kind || classifyUrl(self.__custom_url);
			if (!kind) return;

			let data;
			try {
				if (self.responseType === 'json') {
					data = self.response;
				} else if (self.responseType === '' || self.responseType === 'text') {
					data = JSON.parse(self.responseText);
				} else {
					return;
				}
			} catch (e) {
				return;
			}

			if (kind === 'get') {
				handleGetResponse(data);
				return;
			}
			if (kind === 'list') {
				handleListResponse(data);
				return;
			}

			if (refsModifyPaused) return;
			if (!processResponse(data)) return;
			self.__custom_patched = true;

			console.log(
				'[REFERENCES 修改后响应] ' + self.__custom_url,
				JSON.parse(JSON.stringify(data))
			);

			if (self.responseType === 'json') return;

			const modified = JSON.stringify(data);
			Object.defineProperty(self, 'responseText', {
				configurable: true,
				get: () => modified,
			});
			Object.defineProperty(self, 'response', {
				configurable: true,
				get: () => modified,
			});
		});
		return OrigSend.apply(this, args);
	};

	// ============================================================
	// ⑯ fetch 兜底（加 URL 级去重）
	// ============================================================
	const FETCH_DONE = new Map();
	const FETCH_DONE_TTL = 60000;
	const FETCH_DONE_MAX = 100;

	function isFetchDone(key) {
		const t = FETCH_DONE.get(key);
		if (!t) return false;
		if (Date.now() - t > FETCH_DONE_TTL) {
			FETCH_DONE.delete(key);
			return false;
		}
		return true;
	}

	function markFetchDone(key) {
		if (FETCH_DONE.size >= FETCH_DONE_MAX) {
			let oldestKey = null,
				oldestT = Infinity;
			for (const [k, t] of FETCH_DONE) {
				if (t < oldestT) {
					oldestT = t;
					oldestKey = k;
				}
			}
			if (oldestKey) FETCH_DONE.delete(oldestKey);
		}
		FETCH_DONE.set(key, Date.now());
	}

	const origFetch = window.fetch;
	window.fetch = async function(...args) {
		const resp = await origFetch.apply(this, args);
		const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
		const kind = classifyUrl(url);
		if (!kind) return resp;
		try {
			const ct = resp.headers.get('content-type') || '';
			if (!ct.includes('application/json')) return resp;
			const data = await resp.clone().json();

			if (kind === 'get') {
				handleGetResponse(data);
				return resp;
			}
			if (kind === 'list') {
				handleListResponse(data);
				return resp;
			}

			if (refsModifyPaused) return resp;
			const doneKey = url + '|' + (data && data.data && data.data.pageId || '');
			if (isFetchDone(doneKey)) return resp;
			if (!processResponse(data)) return resp;
			markFetchDone(doneKey);

			console.log(
				'[REFERENCES 修改后响应] ' + url,
				JSON.parse(JSON.stringify(data))
			);

			const headers = new Headers(resp.headers);
			headers.delete('content-length');
			return new Response(JSON.stringify(data), {
				status: resp.status,
				statusText: resp.statusText,
				headers,
			});
		} catch (e) {
			return resp;
		}
	};

	// ============================================================
	// ⑰ Home 键（保持原样）
	// ============================================================
	document.addEventListener('keydown', function(e) {
		if (e.key !== 'Home') return;
		const ae = document.activeElement;
		if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
		e.preventDefault();
		refsModifyPaused = !refsModifyPaused;
		console.log('[REFERENCES 修改] ' + (refsModifyPaused ? '已暂停' : '已恢复'));
		if (panelApi) panelApi.updateStatus(refsModifyPaused);
	});

	// ============================================================
	// ⑱ 仅保留一个 GM 菜单：清远端缓存 & 用户编辑标记
	// ============================================================
	if (typeof GM_registerMenuCommand === 'function') {
		GM_registerMenuCommand('🗑 清远端缓存', () => {
			if (!confirm(
					'将清空：\n' +
					'  • 远端缓存 (argus_keywords_remote_v1)\n' +
					'  • 远端缓存时间 (argus_keywords_remote_v1_time)\n' +
					'  • 用户编辑标记 (argus_keywords_user_edited_v1)\n\n' +
					'下次刷新会重新从 jsDelivr 拉取。继续？'
				)) return;
			try {
				GM_setValue('argus_keywords_remote_v1', null);
				GM_setValue('argus_keywords_remote_v1_time', 0);
				GM_setValue('argus_keywords_user_edited_v1', 0);
				console.log('[自定义关键词] 已清空远端缓存 & 用户编辑标记');
				alert('已清空，请刷新页面');
			} catch (e) {
				console.error('[自定义关键词] 清缓存失败', e);
			}
		});
	}
	// ★ 新增：启动远端词库异步刷新（不阻塞主流程）

	refreshRemoteKeywords();
})();
