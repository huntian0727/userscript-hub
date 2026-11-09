// ==UserScript==
// @name         98堂搜索加强版
// @namespace    etai2019
// @version      1.9.5
// @description  98堂搜索筛选、搜索历史与断点续搜、已读标记、近7天热搜、方案收藏、合并分页、图片预览与划词搜索
// @author       etai2019；优化修改 Codex
// @license      GPL-3.0-only
// @match        https://*.sehuatang.net/*
// @match        https://*.sehuatang.org/*
// @match        https://*.30fjp.com/*
// @match        https://dmn12.vip/*
// @match        https://*.jq2t4.com/*
// @match        https://*.kpqq4.com/*
// @match        https://*.xo6c5.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      self
// @connect      uqpmlqbufzltjalvwydl.supabase.co
// @noframes
// @run-at       document-end
// @updateURL   https://huntian0727.github.io/userscript-hub/userscripts/98tang-search-enhanced.meta.js
// @downloadURL https://huntian0727.github.io/userscript-hub/userscripts/98tang-search-enhanced.user.js
// ==/UserScript==

/* 基于 etai2019 的 98搜索增强 1.2.4 改写，沿用 GPL-3.0。
 * 已更名为「98堂搜索加强版」。在原脚本编辑器中替换可保留配置，另装新版时请关闭旧版。
 */
(() => {
    'use strict';
    if (document.getElementById('s98-installed')) return;
    const marker = document.createElement('meta');
    marker.id = 's98-installed';
    document.head.append(marker);

    // 启动失败时恢复原生搜索列表，保留原始节点和由论坛绑定的事件。
    let startupRollback = null, startupCommit = null;
    const startupObservers = [];
    function reportStartupFailure(error) {
        for (const observer of startupObservers) { try { observer.disconnect(); } catch { /* 避免异常后继续改动原生列表。 */ } }
        startupObservers.length = 0;
        try { startupRollback?.(); } catch { /* 即使恢复出错也必须显示失败原因。 */ }
        startupRollback = startupCommit = null;
        document.querySelectorAll('.s98-toolbar, .s98-footer').forEach(node => node.remove());
        document.getElementById('s98-installed')?.remove();
        const existing = document.getElementById('s98-startup-error');
        const notice = existing || document.createElement('div');
        notice.id = 's98-startup-error';
        notice.setAttribute('role', 'alert');
        notice.style.cssText = 'border:1px solid #db8b34;background:#fff3df;color:#6b3d00;padding:10px;margin:8px 0;border-radius:6px';
        notice.textContent = '98堂搜索加强版启动失败：' + (error?.message || String(error));
        if (!existing) (document.getElementById('threadlist') || document.body).before(notice);
    }
    try {
    const STORE = '_98enhanced_settings_v2';
    const DEFAULTS = {
        autoPage: true, previewMode: 'manual', previewHeight: 240, resultLayout: '1',
        mergePages: true, resultsPerPage: 30, maxFillPages: 20, pageIntervalMs: 5000,
        includes: ['综合讨论区', '高清中文字幕'],
        excludes: ['资源出售', '求片问答', '内容隐藏', '搬运', 'SHA1'], banned: [],
        included: [], excluded: [], includeMode: 'any', filterScope: 'all',
        quickIncludeBoards: [], quickExcludeBoards: [], includedBoards: [], excludedBoards: [], boardKeywordsMigrated: false,
        selectSearch: true, wheelZoom: true, shareHotwords: false,
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const words = value => Array.isArray(value)
        ? [...new Set(value.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))]
            .slice(0, 100).map(x => x.slice(0, 160)) : [];
    const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
    const boardIDs = value => Array.isArray(value) ? [...new Set(value.filter(x => typeof x === 'string' && /^[1-9]\d{0,9}$/.test(x)))].slice(0, 1000) : [];
    function validate(value) {
        const s = clone(DEFAULTS);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return s;
        for (const key of ['autoPage', 'selectSearch', 'wheelZoom', 'mergePages', 'boardKeywordsMigrated', 'shareHotwords']) {
            if (typeof value[key] === 'boolean') s[key] = value[key];
        }
        for (const key of ['includes', 'excludes', 'banned', 'included', 'excluded']) {
            if (Array.isArray(value[key])) s[key] = words(value[key]);
        }
        for (const key of ['quickIncludeBoards', 'quickExcludeBoards', 'includedBoards', 'excludedBoards']) {
            if (Array.isArray(value[key])) s[key] = boardIDs(value[key]);
        }
        if (['manual', 'hover', 'auto', 'all'].includes(value.previewMode)) s.previewMode = value.previewMode;
        if (['auto', '1', '2', '3'].includes(value.resultLayout)) s.resultLayout = value.resultLayout;
        if (['any', 'all'].includes(value.includeMode)) s.includeMode = value.includeMode;
        if (['all', 'title'].includes(value.filterScope)) s.filterScope = value.filterScope;
        if (Number.isFinite(value.previewHeight)) s.previewHeight = Math.min(600, Math.max(120, value.previewHeight));
        if (Number.isFinite(value.pageIntervalMs)) s.pageIntervalMs = Math.min(60000, Math.max(1000, Math.round(value.pageIntervalMs)));
        for (const [key, max] of [['resultsPerPage', 100], ['maxFillPages', 100]]) {
            if (Number.isFinite(value[key])) s[key] = Math.min(max, Math.max(1, Math.round(value[key])));
        }
        s.included = s.included.filter(x => s.includes.includes(x));
        s.excluded = s.excluded.filter(x => s.excludes.includes(x));
        return s;
    }
    function readSettings() {
        const saved = GM_getValue(STORE, null);
        if (saved && typeof saved === 'object') return validate(saved);
        const old = GM_getValue('_98settings', {}) || {};
        const state = GM_getValue('_98settings2', {}) || {};
        const migrated = validate({
            autoPage: old.AutoScroll?.Enable, selectSearch: old.SelectSearch?.Enable,
            previewMode: old.PreviewImage?.Enable ? 'auto' : 'manual',
            includes: old.Includes?.Keywords, excludes: old.Excludes?.Keywords, banned: old.Banned?.Keywords,
            included: state.IncludedValues, excluded: state.ExcludedValues,
            wheelZoom: old.ScaleImageByWheel?.Enable,
        });
        GM_setValue(STORE, migrated);
        return migrated;
    }
    let settings = readSettings();
    const persist = () => GM_setValue(STORE, clone(settings));
    const HOTWORD_URL = 'https://uqpmlqbufzltjalvwydl.supabase.co/functions/v1/hotwords/v1/keywords';
    function hotwordRequest(options) {
        let handle, settled = false;
        const finish = (name, result) => { if (settled) return; settled = true; clearTimeout(timer); options[name]?.(result); };
        const timer = setTimeout(() => { finish('ontimeout', {}); try { handle?.abort(); } catch {} }, options.timeout || 15000);
        const wrapped = { ...options, redirect: 'error', nocache: true };
        for (const name of ['onload','onerror','ontimeout','onabort']) wrapped[name] = result => finish(name, result);
        try { handle = GM_xmlhttpRequest(wrapped); } catch { finish('onerror', {}); }
        return { abort() { finish('onabort', {}); try { handle?.abort(); } catch {} } };
    }
    const HOTWORD_RECENT_STORE = '_98enhanced_hotword_recent_v1';
    const HOTWORD_INSTALL_STORE = '_98enhanced_hotword_install_v1';
    const HOTWORD_DAILY_SEARCH_STORE = '_98enhanced_hotword_daily_search_v1';
    const HOTWORD_UPLOAD_WAIT_STORE = '_98enhanced_hotword_upload_wait_v1';
    const HOTWORD_RANK_STORE = '_98enhanced_hotword_rank_v1';
    const HOTWORD_RANK_ATTEMPT_STORE = '_98enhanced_hotword_rank_attempt_supabase_v1';
    const HOTWORD_DEFAULT_REFRESH = 900;
    const HOTWORD_MAX_ITEMS = 1000;
    const hotwordRefreshSeconds = value => [60, 300, 600, 900, 1800].includes(value) ? value : HOTWORD_DEFAULT_REFRESH;
    let hotwordMemoryCache = null, hotwordMemoryAttempt = null, hotwordGeneration = 0, cancelHotwordLoad = null;
    function validHotwordRanking(data) {
        const seen = new Set();
        return data?.days === 7 && Array.isArray(data.items) && data.items.length <= HOTWORD_MAX_ITEMS && !data.items.some(item => {
            if (!item || hotwordKeyword(item.keyword) !== item.keyword || !Number.isSafeInteger(item.hits) || item.hits <= 0 || seen.has(item.keyword)) return true;
            seen.add(item.keyword); return false;
        });
    }
    function readHotwordCache(now, accessTag) {
        let cached = hotwordMemoryCache;
        try { const saved = GM_getValue(HOTWORD_RANK_STORE, null); if (!cached || saved?.fetchedAt > cached.fetchedAt) cached = saved; } catch { /* 存储异常使用本页面内存。 */ }
        if (!cached || cached.accessTag !== accessTag || !Number.isSafeInteger(cached.fetchedAt) || cached.fetchedAt > now || now - cached.fetchedAt > 86400000 || !validHotwordRanking(cached.data)) return null;
        return { ...cached, refreshAfterSeconds: hotwordRefreshSeconds(cached.refreshAfterSeconds) };
    }
    function readHotwordAttempt(now) {
        let attempt = hotwordMemoryAttempt;
        try { const saved = GM_getValue(HOTWORD_RANK_ATTEMPT_STORE, null); if (!attempt || saved?.at > attempt.at) attempt = saved; } catch { /* 存储异常使用本页面内存。 */ }
        return attempt && Number.isSafeInteger(attempt.at) && attempt.at <= now && now - attempt.at < HOTWORD_DEFAULT_REFRESH * 1000 ? attempt : null;
    }
    function hotwordSharingEnabled() {
        try { return settings.shareHotwords && GM_getValue(STORE, null)?.shareHotwords === true; }
        catch { return false; }
    }
    async function hotwordDigest(value) {
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
    }
    function ensureHotwordInstallSeed() {
        let seed = GM_getValue(HOTWORD_INSTALL_STORE, '');
        if (!/^[a-f0-9]{64}$/.test(seed)) {
            seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
            GM_setValue(HOTWORD_INSTALL_STORE, seed);
            if (GM_getValue(HOTWORD_INSTALL_STORE, '') !== seed) throw new Error('storage_unavailable');
        }
        return seed;
    }
    const hotwordDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    function dailyContributionBucket(day) {
        const value = GM_getValue(HOTWORD_DAILY_SEARCH_STORE, null);
        return value?.day === day && value.items && typeof value.items === 'object' && !Array.isArray(value.items) ? value.items : {};
    }
    async function hotwordContributionId(keyword, day) {
        const seed = ensureHotwordInstallSeed();
        const bytes = Uint8Array.from(seed.match(/../g), pair => parseInt(pair, 16));
        const key = await crypto.subtle.importKey('raw', bytes, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
        return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('daily-search-v1:' + day + ':' + keyword))),b=>b.toString(16).padStart(2,'0')).join('');
    }
    // 与 Worker 保持一致：这里只接收普通短关键词，疑似隐私信息宁可漏计。
    function hotwordKeyword(raw) {
        if (typeof raw !== 'string' || raw.length > 200 || /[\p{C}]/u.test(raw)) return null;
        const word = raw.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
        if ([...word].length < 2 || [...word].length > 80 || !/^[\p{L}\p{N} _-]+$/u.test(word)
            || !/\p{L}/u.test(word) || /\d{7,}/u.test(word) || /[a-z0-9_-]{32,}/u.test(word)) return null;
        return word;
    }
    function queueHotword(raw, source = 'search') {
        // 不挂入原站请求队列、不等待响应、不重试；重新检查开关以免关闭后仍发送。
        if (!hotwordSharingEnabled() || !['search', 'hotword'].includes(source)) return;
        const keyword = hotwordKeyword(raw);
        if (!keyword) return;
        setTimeout(async () => {
            try {
                if (!hotwordSharingEnabled()) return;
                const day = hotwordDay();
                // 日期参与摘要与凭证，零点前的10分钟尝试记录不拦住次日主动搜索。
                const digest = await hotwordDigest(source === 'search' ? 'daily-search-v1:' + day + ':' + keyword : 'source-v1:hotword:' + keyword);
                if (source === 'search' && dailyContributionBucket(day)[digest] === 1) return;
                // 主动搜索按北京时间自然日去重；热榜每次提交使用独立幂等凭证。
                const receipt = source === 'search' ? await hotwordContributionId(keyword, day)
                    : Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
                const send = () => {
                    if (!hotwordSharingEnabled()) return;
                    if (source === 'search' && (hotwordDay() !== day || dailyContributionBucket(day)[digest] === 1)) return;
                    const now = Date.now();
                    const wait = GM_getValue(HOTWORD_UPLOAD_WAIT_STORE, 0);
                    if (Number.isFinite(wait) && wait > now && wait - now <= 86400000) return;
                    const saved = GM_getValue(HOTWORD_RECENT_STORE, []);
                    const recent = (Array.isArray(saved) ? saved : []).filter(row => row && /^[a-f0-9]{64}$/.test(row.digest)
                        && Number.isFinite(row.at) && row.at <= now && now - row.at < 600000).slice(-60);
                    if (recent.some(row => row.digest === digest && now - row.at < (source === 'hotword' ? 3000 : 600000))) return;
                    recent.push({ digest, at: now }); GM_setValue(HOTWORD_RECENT_STORE, recent.slice(-60));
                    hotwordRequest({
                        method: 'POST', url: HOTWORD_URL, data: JSON.stringify({ keyword }),
                        headers: { 'Content-Type': 'application/json', 'X-Hotword-Contribution': receipt, 'X-Hotword-Source': source, ...(source === 'search' ? {'X-Hotword-Day':day} : {}), Referer: '' },
                        anonymous: true, timeout: 15000,
                        onload(response) {
                            try {
                                if (response.status === 202 && JSON.parse(response.responseText).accepted === true && source === 'search') {
                                    // 迟到的昨日回执不能覆盖今日已记录的贡献。
                                    if (hotwordDay() !== day) return;
                                    const bucket = dailyContributionBucket(day); bucket[digest] = 1;
                                    GM_setValue(HOTWORD_DAILY_SEARCH_STORE, {day,items:bucket});
                                } else if (response.status === 429) {
                                    const match = /^retry-after:\s*(\d+)\s*$/im.exec(response.responseHeaders || '');
                                    const seconds = match ? Math.min(86400, Math.max(1, Number(match[1]))) : 900;
                                    GM_setValue(HOTWORD_UPLOAD_WAIT_STORE, Date.now() + seconds * 1000);
                                }
                            } catch { /* 不记录请求或凭证；丢失回执时仍使用同一贡献凭证，服务器不会再次计数。 */ }
                        }, onerror() {}, ontimeout() {}, onabort() {},
                    });
                };
                // 同源标签页可用 Web Locks 时避免去重读写竞争，跨镜像仍由服务端限额兜底。
                if (navigator.locks?.request) await navigator.locks.request('s98-hotword-upload', send);
                else send();
            } catch { /* 上传和存储故障都不能影响搜索，也不向日志打印关键词。 */ }
        }, 0);
    }
    function setupHotwordForms() {
        document.addEventListener('submit', event => {
            try {
                const form = event.target;
                if (!(form instanceof HTMLFormElement) || form.closest('.s98')) return;
                const action = new URL(event.submitter?.hasAttribute('formaction') ? event.submitter.formAction : form.action, location.href);
                if (action.origin !== location.origin || !/\/search\.php$/.test(action.pathname)) return;
                const fields = new FormData(form);
                if ((fields.get('mod') || action.searchParams.get('mod')) !== 'forum') return;
                const keyword = fields.get('srchtxt');
                // 其他监听器仍可取消本次提交；不监听键入、URL、结果DOM或分页。
                queueMicrotask(() => { if (!event.defaultPrevented) { noteSearchAttempt(); rememberPendingSearch(keyword); queueHotword(keyword); } });
            } catch { /* 原站表单照常提交。 */ }
        }, true);
    }
    function setupHotwordPanel() {
        if (!hotwordSharingEnabled() || !/\/search\.php$/.test(location.pathname) || document.getElementById('s98-hotwords')) return;
        const mod = new URL(location.href).searchParams.get('mod');
        if (mod && mod !== 'forum') return;
        const form = [...document.forms].find(candidate => {
            try { return candidate.elements.namedItem('srchtxt') && !!searchURL(candidate.action); }
            catch { return false; }
        });
        const root = resultRoot(document);
        if (!form && !root) return; // 不在登录/验证页或普通帖子注入榜单。
        const panel = el('section', { id: 's98-hotwords', class: 's98 s98-hotwords', 'aria-label': '近7天热搜' });
        const generation = ++hotwordGeneration;
        const active = () => generation === hotwordGeneration && hotwordSharingEnabled() && panel.isConnected;
        const heading = el('div', { class: 's98-row' });
        heading.append(el('strong', {}, '近7天热搜'), el('span', { class: 's98-status' }, '点击词语搜索'));
        const status = el('div', { class: 's98-status', role: 'status' }, '正在加载热搜…');
        const list = el('div', { class: 's98-hotword-list' });
        const feedback = el('div');
        panel.append(heading, status, list, feedback);
        if (form) form.after(panel);
        else (toolbar?.isConnected ? toolbar : root).before(panel);
        let loading = false, searching = false;
        const retry = button('重试热搜', () => load()); retry.hidden = true; panel.append(retry);
        function fail() { if (!active()) return; list.replaceChildren(); status.hidden = false; status.textContent = '热搜暂不可用'; retry.hidden = false; }
        function render(data, stale = false) {
            if (!active()) return;
            list.replaceChildren();
            for (const [i, item] of data.items.entries()) {
                const chip = button('', async () => {
                    if (searching) return;
                    searching = true;
                    const output = el('div'); feedback.replaceChildren(output);
                    try { await searchSelected(item.keyword, output, chip, { respectCooldown: true, hotwordSource: 'hotword' }); }
                    finally { searching = false; }
                }, { class: 's98-hotword', 'aria-label': `搜索热词：${item.keyword}` });
                chip.append(el('span', { class: 's98-hotword-rank', 'aria-hidden': 'true' }, String(i + 1)),
                    el('span', { class: 's98-hotword-word' }, item.keyword));
                list.append(chip);
            }
            status.hidden = !stale && data.items.length > 0;
            status.textContent = stale ? '更新暂不可用，显示上次榜单；15分钟后可重试' : data.items.length ? '' : '近7天暂无热词';
        }
        async function load() {
            if (loading || !active()) return;
            loading = true; retry.hidden = true; status.hidden = false; status.textContent = '正在加载热搜…';
            const refresh = async () => {
                if (!active()) return;
                const accessTag = 'public-supabase-v1';
                if (!active()) return;
                const now = Date.now(), cached = readHotwordCache(now, accessTag);
                if (cached && now - cached.fetchedAt < cached.refreshAfterSeconds * 1000) { render(cached.data); return; }
                if (readHotwordAttempt(now)) {
                    if (cached) render(cached.data, true);
                    else { fail(); status.textContent = '热搜暂不可用；15分钟冷却结束后可重试'; }
                    retry.hidden = false; return;
                }
                // 先记录尝试，挂起或页面跳转也不会造成跨页面连续请求。
                hotwordMemoryAttempt = { at: now };
                try { GM_setValue(HOTWORD_RANK_ATTEMPT_STORE, hotwordMemoryAttempt); } catch { /* 仍保留本页冷却。 */ }
                try {
                    const response = await new Promise((resolve, reject) => {
                        let handle;
                        cancelHotwordLoad = { generation, cancel() { reject(new Error('cancelled')); try { handle?.abort(); } catch {} } };
                        handle = hotwordRequest({
                            method: 'GET', url: HOTWORD_URL.replace('/keywords', '/hotwords'),
                            anonymous: true, headers: { Referer: '' }, timeout: 15000,
                            onload: resolve, onerror: reject, ontimeout: reject, onabort: reject,
                        });
                    });
                    if (!active()) return;
                    if (response.status === 401 || response.status === 403) {
                        hotwordMemoryCache = null;
                        try { GM_setValue(HOTWORD_RANK_STORE, null); } catch {}
                        list.replaceChildren(); status.textContent = '热搜服务暂不可用，请稍后再试。'; status.hidden = false; return;
                    }
                    if (response.status !== 200 || typeof response.responseText !== 'string' || response.responseText.length > 512000) throw new Error('invalid_response');
                    const data = JSON.parse(response.responseText);
                    if (!validHotwordRanking(data)) throw new Error('invalid_response');
                    const receivedAt = Date.now();
                    hotwordMemoryCache = { fetchedAt: receivedAt, accessTag, refreshAfterSeconds: hotwordRefreshSeconds(data.refreshAfterSeconds), data };
                    // 成功时清除冷却，确保5/10分钟配置不会被15分钟失败兜底覆盖。
                    hotwordMemoryAttempt = null;
                    try { GM_setValue(HOTWORD_RANK_STORE, hotwordMemoryCache); GM_setValue(HOTWORD_RANK_ATTEMPT_STORE, null); } catch { /* 显示已收到的数据，不把存储失败当成取榜失败。 */ }
                    render(data);
                } catch {
                    if (!active()) return;
                    if (cached) render(cached.data, true); else fail();
                    retry.hidden = false;
                } finally {
                    if (cancelHotwordLoad?.generation === generation) cancelHotwordLoad = null;
                }
            };
            try {
                if (navigator.locks?.request) await navigator.locks.request('s98-hotword-ranking', refresh);
                else await refresh();
            } catch { fail(); }
            finally { loading = false; }
        }
        void load();
    }
    function syncHotwordPanel() {
        if (!hotwordSharingEnabled()) {
            ++hotwordGeneration;
            if (cancelHotwordLoad) {
                cancelHotwordLoad.cancel(); cancelHotwordLoad = null; hotwordMemoryAttempt = null;
                try { GM_setValue(HOTWORD_RANK_ATTEMPT_STORE, null); } catch {}
            }
            document.getElementById('s98-hotwords')?.remove();
        } else setupHotwordPanel();
    }
    const PRESET_STORE = '_98enhanced_filter_presets_v1';
    const FILTER_KEYS = ['includes', 'excludes', 'banned', 'included', 'excluded', 'includeMode', 'filterScope', 'includedBoards', 'excludedBoards'];
    const filterSnapshot = (value = settings) => Object.fromEntries(FILTER_KEYS.map(key => [key, clone(value[key])]));
    function readPresets() {
        const saved = GM_getValue(PRESET_STORE, []);
        if (!Array.isArray(saved)) return [];
        const ids = new Set();
        return saved.filter(p => {
            if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim()) return false;
            const f = p.filters;
            if (!f || !['includes', 'excludes', 'banned', 'included', 'excluded'].every(key => Array.isArray(f[key])) || !['any', 'all'].includes(f.includeMode) || !['all', 'title'].includes(f.filterScope)) return false;
            ids.add(p.id); return true;
        }).slice(0, 30).map(p => ({ id: p.id, name: p.name.trim().slice(0, 60), boardRulesVersion: p.boardRulesVersion === 0 ? 0 : p.boardRulesVersion === 1 || (Array.isArray(p.filters.includedBoards) && Array.isArray(p.filters.excludedBoards)) ? 1 : 0, filters: filterSnapshot(validate(p.filters)) }));
    }
    let presets = readPresets(), activePresetId = '';
    let presetSelect, presetStatus, managePresetsButton;
    const persistPresets = () => GM_setValue(PRESET_STORE, clone(presets));
    function refreshPresetControls() {
        if (!presetSelect?.isConnected) return;
        const snapshot = JSON.stringify(filterSnapshot());
        const active = presets.find(p => p.id === activePresetId);
        const matching = active && JSON.stringify(active.filters) === snapshot ? active : presets.find(p => JSON.stringify(p.filters) === snapshot);
        if (matching) activePresetId = matching.id;
        const options = JSON.stringify(presets.map(p => [p.id, p.name]));
        if (presetSelect.dataset.options !== options) {
            presetSelect.replaceChildren(el('option', { value: '', disabled: '' }, '当前自定义'), ...presets.map(p => el('option', { value: p.id }, p.name)));
            presetSelect.dataset.options = options;
        }
        if (presetSelect.value !== (matching?.id || '')) presetSelect.value = matching?.id || '';
        presetSelect.disabled = !presets.length;
        presetStatus.textContent = matching ? `当前方案：${matching.name}` : active ? `${active.name} · 已修改，尚未更新方案` : '可收藏当前筛选，下次直接选择';
        managePresetsButton.disabled = !presets.length;
    }
    function applyPreset(preset) {
        settings = validate({ ...settings, ...clone(preset.filters) });
        activePresetId = preset.id; showAll = false; autoBurst = 0;
        persist(); resetResultPage(); rebuildToolbar(); applyFilters(); noteSearchSessionActivity(true);
    }
    function savePresetDialog(existing = null) {
        const modal = dialog(existing ? '重命名筛选方案' : '收藏当前筛选');
        const form = el('form');
        const label = el('label', { class: 's98-field' });
        const name = el('input', { type: 'text', maxlength: '60', required: '', placeholder: '例如：只看中文字幕' });
        name.value = existing?.name || '';
        label.append(el('span', {}, '方案名称'), name);
        const message = el('p', { class: 's98-status', role: 'status' });
        form.append(label, el('p', { class: 's98-help' }, '保存当前板块筛选、关键词筛选、自动排除关键词及匹配方式。快捷项展示偏好、布局、预览和每页条数保持当前设置，最多收藏30个方案。'),
            message, el('button', { type: 'submit' }, existing ? '保存名称' : '保存方案'));
        modal.box.append(form); name.focus();
        form.addEventListener('submit', e => {
            e.preventDefault(); const title = name.value.trim();
            if (!title) { message.textContent = '请输入方案名称'; return; }
            if (presets.some(p => p.id !== existing?.id && normalize(p.name) === normalize(title))) {
                message.textContent = '已存在同名方案，请使用其他名称，或到管理方案中更新'; return;
            }
            if (existing) existing.name = title;
            else {
                if (presets.length >= 30) { message.textContent = '最多收藏30个方案，请先到管理方案中删除不再使用的方案'; return; }
                const preset = { id: crypto.randomUUID(), name: title, filters: filterSnapshot(), boardRulesVersion: 1 };
                presets.push(preset); activePresetId = preset.id;
            }
            persistPresets(); refreshPresetControls(); modal.close();
        });
    }
    function managePresets() {
        const modal = dialog('管理筛选方案');
        const list = el('div'); modal.box.append(list);
        const render = () => {
            list.replaceChildren(el('p', { class: 's98-help' }, '“更新为当前筛选”会用当前的筛选规则替换该方案；删除方案不会改变正在使用的筛选条件。'));
            if (!presets.length) list.append(el('p', {}, '暂无收藏的筛选方案'));
            for (const preset of presets) {
                const row = el('div', { class: 's98-row s98-preset-entry' });
                row.append(el('strong', {}, preset.name), button('应用', () => { modal.close(); applyPreset(preset); }),
                    button('更新为当前筛选', () => {
                        preset.filters = filterSnapshot(); preset.boardRulesVersion = 1; activePresetId = preset.id;
                        persistPresets(); refreshPresetControls(); render();
                    }), button('重命名', () => savePresetDialog(preset)), button('删除', () => {
                        const confirmation = el('div', { class: 's98-row' });
                        confirmation.append(el('span', {}, `删除“${preset.name}”？`), button('确认删除', () => {
                            presets = presets.filter(p => p.id !== preset.id);
                            if (activePresetId === preset.id) activePresetId = '';
                            persistPresets(); refreshPresetControls(); render();
                        }), button('取消', () => confirmation.remove()));
                        if (!row.querySelector('.s98-delete-confirm')) { confirmation.classList.add('s98-delete-confirm'); row.append(confirmation); }
                    }));
                list.append(row);
            }
        };
        render();
    }
    function el(tag, attrs = {}, text) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'class') node.className = value;
            else node.setAttribute(key, value);
        }
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function button(text, fn, attrs = {}) {
        const node = el('button', { type: 'button', ...attrs }, text);
        node.addEventListener('click', fn);
        return node;
    }
    const safeURL = (raw, base = location.href) => {
        try { const url = new URL(raw, base); return /^https?:$/.test(url.protocol) ? url.href : null; }
        catch { return null; }
    };
    const searchURL = (raw, base = location.href) => {
        const href = raw && safeURL(raw, base);
        if (!href) return null;
        const url = new URL(href);
        return url.origin === location.origin && /\/search\.php$/.test(url.pathname) ? url.href : null;
    };
    function request(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 15000, ...options,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(Object.assign(new Error(response.status === 522 ? '原站连接超时（HTTP 522）' : `请求失败（HTTP ${response.status}）`), {
                            status: response.status, retryable: response.status === 429 || response.status === 408 || response.status >= 500,
                            retryDelayMs: retryAfterMs(response.responseHeaders),
                        }));
                    } else resolve(response);
                },
                onerror: () => reject(Object.assign(new Error('网络请求失败'), { retryable: true })),
                ontimeout: () => reject(Object.assign(new Error('请求超时，未收到原站响应（不能据此确定是限频）'), { retryable: true })),
                onabort: () => reject(new Error('请求已取消')),
            });
        });
    }
    function retryAfterMs(headers = '') {
        const value = String(headers).match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
        if (!value) return 0;
        const wait = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
        return Number.isFinite(wait) ? Math.max(0, wait) : 0;
    }
    function searchResponseError(doc) {
        const message = (doc.querySelector('#messagetext, .alert_error, .alert_info, #cf-error-details')?.textContent || doc.body?.textContent || '').trim().replace(/\s+/g, ' ');
        if (/connection timed out|error (?:code[:：]?\s*)?522/i.test(message)) return Object.assign(new Error('原站连接超时（522）'), { retryable: true });
        if (/验证码|安全验证|人机验证|checking your browser|just a moment|captcha/i.test(message)) return new Error('原站需要验证，请打开原站失败页处理后重试');
        if (/尚未登录|未登录|请.{0,6}登录|log ?in/i.test(message) || doc.querySelector('input[type=password]')) return new Error('原站需要登录，请打开原站失败页确认');
        if (/搜索.{0,12}(?:过期|失效|不存在)/.test(message)) return new Error('原站搜索已过期，请重新搜索');
        if (/频繁|频率|间隔|过快|稍后再|too many|rate.?limit|try again.{0,12}later/i.test(message)) {
            let wait = 0;
            for (const match of message.matchAll(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|seconds?|minutes?|hours?)/gi)) {
                const unit = match[2].toLowerCase();
                wait = Math.max(wait, Number(match[1]) * (/小时|hour/.test(unit) ? 3600000 : /分钟|minute/.test(unit) ? 60000 : 1000));
            }
            return Object.assign(new Error(`原站限制访问频率：${message.slice(0, 160)}`), { retryable: true, retryDelayMs: wait });
        }
        // 无法识别的临时页面仅允许至多2次重试，并由已有30秒起的指数冷却限制请求频率。
        return Object.assign(new Error(message.slice(0, 160) || '返回页面没有可识别的搜索结果，请打开原站失败页确认'), { retryable: true });
    }
    const parse = html => new DOMParser().parseFromString(html, 'text/html');
    const resultRoot = doc => doc.querySelector('#threadlist, .slst');
    const titleLink = item => item.querySelector('h3 a[href], .xs3 a[href], a[href*="mod=viewthread"], a[href*="thread-"]');
    const resultItems = root => [...root.querySelectorAll('li')].filter(item => titleLink(item));
    // 仅在原生分页明确给出末页/数字页时安全推导下一页；绝不根据结果总数猜测。
    let knownLastSearchPage = 0;
    function nextLink(doc, base) {
        const source = searchURL(base);
        if (!source) return null;
        const currentPageNumber = Number(new URL(source).searchParams.get('page') || 1);
        if (!Number.isSafeInteger(currentPageNumber) || currentPageNumber < 1) return null;
        let directNext = null;
        for (const anchor of doc.querySelectorAll('.pg a[href], .pages a[href]')) {
            const href = searchURL(anchor.getAttribute('href'), base);
            if (!href || !sameSearchSessionURL(href, source)) continue;
            const number = Number(new URL(href).searchParams.get('page'));
            if (!Number.isSafeInteger(number) || number < 1 || number > 100000) continue;
            if (number > knownLastSearchPage) knownLastSearchPage = number;
            if (number === currentPageNumber + 1) directNext = href;
        }
        for (const a of doc.querySelectorAll('.pg a.nxt, .pages a.next, a.nxt, a.next')) {
            const href = searchURL(a.getAttribute('href'), base);
            if (href && sameSearchSessionURL(href, base)) return href;
        }
        if (directNext) return directNext;
        if (knownLastSearchPage <= currentPageNumber) return null;
        const next = new URL(source); next.searchParams.set('page', String(currentPageNumber + 1));
        return searchURL(next.href, source);
    }
    function parseSearchDocument(responseText) {
        const doc = parse(responseText);
        if (resultRoot(doc)) return doc;
        const source = String(responseText || '');
        const cdata = /^\s*<\?xml\b[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(source);
        if (!cdata || cdata[1].length > 1000000) return doc;
        const parsed = parse('<div id="threadlist">' + cdata[1] + '</div>');
        return resultItems(resultRoot(parsed)).length ? parsed : doc;
    }
    const BOARD_STORE = `_98enhanced_board_catalog_v1:${location.origin}`;
    const BOARD_CACHE_AGE = 24 * 60 * 60 * 1000;
    function cleanBoards(value) {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.filter(board => {
            if (!board || !boardIDs([board.id]).length || typeof board.name !== 'string' || !board.name.trim() || seen.has(board.id)) return false;
            seen.add(board.id); return true;
        }).slice(0, 1000).map(board => ({ id: board.id, name: board.name.trim().slice(0, 100), group: typeof board.group === 'string' && board.group.trim() ? board.group.trim().slice(0, 100) : '其他板块' }));
    }
    function readBoardCatalog() {
        const saved = GM_getValue(BOARD_STORE, {}) || {};
        const boards = cleanBoards(saved.boards);
        return { boards, complete: saved.complete === true && boards.length > 0, updatedAt: Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0 };
    }
    let boardCatalog = readBoardCatalog(), catalogLoading = false, catalogError = '', catalogRequest = null;
    let boardQuickHost, boardQuickMessage = '', settingsBoardView = null;
    const boardName = id => boardCatalog.boards.find(board => board.id === id)?.name || `板块 #${id}`;
    function boardFromLink(link, base = location.href) {
        const href = safeURL(link.getAttribute('href'), base);
        if (!href) return null;
        const url = new URL(href);
        if (url.origin !== location.origin) return null;
        const id = /\/forum\.php$/.test(url.pathname) && url.searchParams.get('mod') === 'forumdisplay'
            ? url.searchParams.get('fid') : url.pathname.match(/\/forum-([1-9]\d*)-\d+\.html$/)?.[1];
        if (!boardIDs([id]).length) return null;
        const name = (link.textContent || '').trim();
        return name ? { id, name: name.slice(0, 100), group: '搜索结果中的板块' } : null;
    }
    function resultBoard(item, base) {
        // 兼容板块链接单独放在 .xi1 信息行中的模板；.xg1 也可能仅包含回复/查看数。
        // 标题或摘要里的板块链接只是内容引用，不代表所属板块。
        const summary = summaryNode(item);
        for (const link of item.querySelectorAll('.xg1 a[href], a.xi1[href], .xi1 a[href]')) {
            if (link.closest('h3, .xs3, .searchsummary, .s98') || summary?.contains(link)) continue;
            const board = boardFromLink(link, base);
            if (board) return board;
        }
        return null;
    }
    function mergeDiscoveredBoards(boards) {
        const merged = new Map(boardCatalog.boards.map(board => [board.id, board]));
        let changed = false;
        for (const board of boards) if (board && !merged.has(board.id) && merged.size < 1000) { merged.set(board.id, board); changed = true; }
        if (changed) {
            boardCatalog.boards = [...merged.values()]; GM_setValue(BOARD_STORE, boardCatalog);
        }
        return changed;
    }
    function migrateBoardWords(value) {
        const draft = validate(value);
        for (const [candidates, selected, quick, active] of [['includes', 'included', 'quickIncludeBoards', 'includedBoards'], ['excludes', 'excluded', 'quickExcludeBoards', 'excludedBoards']]) {
            const activeBoardWords = draft[selected].filter(word => boardCatalog.boards.filter(board => normalize(board.name) === normalize(word)).length === 1);
            const keepMixedRule = candidates === 'includes' && ((draft.includeMode === 'any' && activeBoardWords.length && activeBoardWords.length < draft[selected].length) || (draft.includeMode === 'all' && activeBoardWords.length > 1));
            for (const word of [...draft[candidates]]) {
                if (keepMixedRule && draft[selected].includes(word)) continue;
                const boards = boardCatalog.boards.filter(board => normalize(board.name) === normalize(word));
                if (boards.length !== 1) continue;
                const id = boards[0].id;
                draft[quick] = boardIDs([...draft[quick], id]);
                if (draft[selected].includes(word)) draft[active] = boardIDs([...draft[active], id]);
                draft[candidates] = draft[candidates].filter(item => item !== word);
                draft[selected] = draft[selected].filter(item => item !== word);
            }
        }
        return draft;
    }
    function migrateBoardKeywords() {
        if (!boardCatalog.complete) return false;
        let changed = false;
        if (!settings.boardKeywordsMigrated) {
            settings = migrateBoardWords(settings); settings.boardKeywordsMigrated = true; persist(); changed = true;
        }
        const previous = JSON.stringify(presets);
        presets = presets.map(preset => preset.boardRulesVersion === 1 ? preset : ({ ...preset, boardRulesVersion: 1, filters: filterSnapshot(migrateBoardWords(preset.filters)) }));
        if (JSON.stringify(presets) !== previous) { persistPresets(); changed = true; }
        return changed;
    }
    function readIndexBoards(doc, base) {
        const roots = [...doc.querySelectorAll('.fl, #forumlist, .forumlist')];
        if (!roots.length) {
            const fallback = doc.querySelector('[id^="category_"]')?.parentElement;
            if (fallback) roots.push(fallback); else throw searchResponseError(doc);
        }
        const boards = [];
        for (const link of new Set(roots.flatMap(root => [...root.querySelectorAll('a[href]')]))) {
            const board = boardFromLink(link, base);
            if (!board) continue;
            const category = link.closest('[id^="category_"]') || link.closest('.bm');
            const heading = category?.querySelector('.bm_h h2, .bm_h h3') || category?.parentElement?.querySelector('.bm_h h2, .bm_h h3');
            board.group = heading?.textContent?.trim().slice(0, 100) || '其他板块';
            boards.push(board);
        }
        const cleaned = cleanBoards(boards);
        if (!cleaned.length) throw new Error('目录没有返回可识别的板块，已保留本地列表');
        return cleaned;
    }
    function refreshBoardViews() {
        renderBoardQuickFilters();
        if (settingsBoardView?.root.isConnected) settingsBoardView.render(); else settingsBoardView = null;
    }
    function refreshBoardCatalog() {
        if (catalogRequest) return catalogRequest;
        catalogLoading = true; catalogError = ''; refreshBoardViews();
        catalogRequest = (async () => {
            try {
                const response = await request(`${location.origin}/forum.php?mod=index`, { overrideMimeType: `text/html; charset=${document.characterSet || 'UTF-8'}` });
                const base = safeURL(response.finalUrl || `${location.origin}/forum.php`);
                if (!base || new URL(base).origin !== location.origin) throw new Error('目录跳转到了其他站点，请在当前站点重新打开后刷新列表');
                const boards = readIndexBoards(parse(response.responseText), base);
                const known = new Set(boards.map(board => board.id));
                // 保留已收藏或当前命中的缓存板块，避免刷新列表丢失用户快捷项。
                const kept = new Set([...settings.quickIncludeBoards, ...settings.quickExcludeBoards, ...settings.includedBoards, ...settings.excludedBoards]);
                boardCatalog = { boards: [...boards, ...boardCatalog.boards.filter(board => kept.has(board.id) && !known.has(board.id))].slice(0, 1000), complete: true, updatedAt: Date.now() };
                GM_setValue(BOARD_STORE, boardCatalog);
                if (migrateBoardKeywords()) { rebuildToolbar(); applyFilters(); }
            } catch (error) { catalogError = error.message; }
            finally { catalogLoading = false; catalogRequest = null; refreshBoardViews(); }
        })();
        return catalogRequest;
    }
    function threadKey(href) {
        const u = new URL(href);
        const tid = u.searchParams.get('tid') || u.pathname.match(/thread-(\d+)-/)?.[1];
        return tid ? `tid:${tid}` : u.href;
    }
    const READ_MODE_STORE = '_98enhanced_read_mark_mode_v1';
    const READ_TOPICS_STORE = '_98enhanced_read_topics_v1';
    const SEARCH_PENDING_STORE = '_98enhanced_search_pending_v1';
    const SEARCH_PENDING_SESSION_KEY = 's98-search-pending-v1';
    const SEARCH_RESTORE_STORE = '_98enhanced_search_restore_v1';
    const SEARCH_RESTORE_SESSION_KEY = 's98-search-restore-v1';
    const SEARCH_DB_NAME = 's98-search-enhanced-local-v1';
    const SEARCH_HISTORY_LIMIT = 20;
    const READ_MARK_MODES = new Set(['none', 'hide', 'strike', 'highlight']);
    let searchDBPromise = null;
    let searchKeyword = '', searchSessionKey = '', searchStartURL = '';
    let sessionInitializing = false, sessionRestoring = false, sessionHasUserActivity = false;
    let sessionReplaceCache = false, sessionSaveTimer = null, sessionSaveChain = Promise.resolve();
    let persistedRecordKeys = new Set(), searchSessionError = '';
    let searchSessionInitPromise = Promise.resolve();
    let searchSessionGeneration = '', searchSessionCreatedAt = 0;

    function readReadMarkMode() {
        try {
            const saved = GM_getValue(READ_MODE_STORE, 'none');
            return READ_MARK_MODES.has(saved) ? saved : 'none';
        } catch { return 'none'; }
    }
    function readVisitedTopics() {
        let saved = {};
        try { saved = GM_getValue(READ_TOPICS_STORE, {}); } catch { return new Map(); }
        const rows = Array.isArray(saved) ? saved : Array.isArray(saved?.items) ? saved.items : [];
        return new Map(rows.filter(row => row && typeof row.key === 'string' && row.key && Number.isFinite(row.at) && row.at >= 0)
            .sort((a, b) => a.at - b.at).slice(-5000).map(row => [row.key, row.at]));
    }
    let readMarkMode = readReadMarkMode();
    let visitedTopics = readVisitedTopics();
    let readMarkRevision = 0;
    function persistVisitedTopics() {
        const items = [...visitedTopics.entries()].map(([key, at]) => ({ key, at })).sort((a, b) => a.at - b.at).slice(-5000);
        visitedTopics = new Map(items.map(row => [row.key, row.at]));
        try { GM_setValue(READ_TOPICS_STORE, { version: 1, items }); } catch { /* 标记存储故障不能影响主题导航。 */ }
    }
    function applyReadMark(record) {
        if (!record?.item) return;
        const visited = visitedTopics.has(record.key);
        record.item.classList.toggle('s98-read-strike', visited && readMarkMode === 'strike');
        record.item.classList.toggle('s98-read-highlight', visited && readMarkMode === 'highlight');
    }
    function setReadMarkMode(mode) {
        if (!READ_MARK_MODES.has(mode) || mode === readMarkMode) return;
        readMarkMode = mode;
        try { GM_setValue(READ_MODE_STORE, mode); } catch { /* 当前页面仍应用新选择。 */ }
        readMarkRevision++;
        for (const record of mounted) applyReadMark(record);
        applyFilters();
    }
    function markTopicVisited(key) {
        if (typeof key !== 'string' || !key) return;
        visitedTopics.set(key, Date.now());
        persistVisitedTopics();
        readMarkRevision++;
        for (const record of records.values()) if (record.key === key) applyReadMark(record);
        // 先同步发起进度保存；GM 标记本身也已同步写入，可承受当前标签随即导航。
        noteSearchSessionActivity(true);
        // 隐藏模式延迟到点击默认导航之后再重新过滤，避免先移除链接而阻断打开主题。
        setTimeout(() => {
            if (readMarkMode === 'hide' && searchRoot) applyFilters();
            noteSearchSessionActivity(true);
        }, 0);
    }
    function searchKeyFor(keyword) {
        return normalize(String(keyword || '')).trim().replace(/\s+/g, ' ').slice(0, 200);
    }
    function makeSearchStartURL(raw) {
        try {
            const url = new URL(raw, location.href);
            url.searchParams.set('page', '1');
            url.hash = '';
            return url.href;
        } catch { return ''; }
    }
    function sameSearchSessionURL(left, right) {
        try {
            const a = new URL(left, location.href), b = new URL(right, location.href);
            if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
            const aid = a.searchParams.get('searchid'), bid = b.searchParams.get('searchid');
            if (aid || bid) return !!aid && aid === bid;
            const entries = url => [...url.searchParams.entries()].filter(([key]) => key !== 'page')
                .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
            return JSON.stringify(entries(a)) === JSON.stringify(entries(b));
        } catch { return false; }
    }
    function extractSearchKeywordFromURL() {
        try {
            const url = new URL(location.href);
            for (const name of ['kw', 'srchtxt', 'keyword', 'q', 'searchword']) {
                const value = url.searchParams.get(name)?.trim();
                if (value) return value.slice(0, 200);
            }
        } catch { /* 后续尝试读取搜索表单。 */ }
        const input = document.querySelector('input[name="srchtxt"]');
        return typeof input?.value === 'string' ? input.value.trim().slice(0, 200) : '';
    }
    function preciseTimestamp() {
        const perf = window.performance;
        const value = Number.isFinite(perf?.timeOrigin) && typeof perf?.now === 'function' ? perf.timeOrigin + perf.now() : Date.now();
        return Number.isFinite(value) ? value : Date.now();
    }
    function createSearchSessionGeneration(at = Date.now()) {
        return String(Math.max(0, Math.floor(at))).padStart(16, '0') + '-' + Math.random().toString(36).slice(2, 10);
    }
    function rememberPendingSearch(keyword, options = {}) {
        const value = String(keyword || '').trim().slice(0, 200);
        if (!value) return;
        const at = Date.now();
        const createdAt = Number.isFinite(options.createdAt) ? options.createdAt : preciseTimestamp();
        const pending = {
            keyword: value, at, createdAt,
            generation: typeof options.generation === 'string' && options.generation ? options.generation : createSearchSessionGeneration(createdAt),
            targetURL: typeof options.targetURL === 'string' ? options.targetURL : '',
            forceNew: options.forceNew !== false,
            filters: options.filters && typeof options.filters === 'object' ? clone(options.filters) : filterSnapshot(),
        };
        try { sessionStorage.setItem(SEARCH_PENDING_SESSION_KEY, JSON.stringify(pending)); } catch { /* 由 GM 存储作为新标签页的补充。 */ }
        try { GM_setValue(SEARCH_PENDING_STORE, pending); } catch { /* 搜索本身不能被历史记录故障阻断。 */ }
    }
    function clearPendingSearch(pending) {
        try {
            const saved = JSON.parse(sessionStorage.getItem(SEARCH_PENDING_SESSION_KEY) || 'null');
            if (!pending || saved?.at === pending.at) sessionStorage.removeItem(SEARCH_PENDING_SESSION_KEY);
        } catch { /* sessionStorage 可能不可用。 */ }
        try {
            const saved = GM_getValue(SEARCH_PENDING_STORE, null);
            if (!pending || saved?.at === pending.at) GM_setValue(SEARCH_PENDING_STORE, null);
        } catch { /* 不影响搜索。 */ }
    }
    function consumePendingSearch(currentURL) {
        const valid = value => value && typeof value.keyword === 'string' && value.keyword.trim()
            && Number.isFinite(value.at) && Date.now() - value.at >= 0 && Date.now() - value.at < 10 * 60 * 1000;
        const matches = value => valid(value) && (!value.targetURL || sameSearchSessionURL(value.targetURL, currentURL));
        let local = null;
        try { local = JSON.parse(sessionStorage.getItem(SEARCH_PENDING_SESSION_KEY) || 'null'); } catch { /* 使用 GM 备用记录。 */ }
        if (matches(local)) { clearPendingSearch(local); return local; }
        let shared = null;
        try { shared = GM_getValue(SEARCH_PENDING_STORE, null); } catch { /* 无法读取时按普通搜索处理。 */ }
        if (matches(shared) && (shared.targetURL || (resultRoot(document) && new URL(currentURL).searchParams.has('searchid')))) {
            clearPendingSearch(shared); return shared;
        }
        return null;
    }
    function readPendingRestore() {
        let local = null, shared = null;
        try { local = JSON.parse(sessionStorage.getItem(SEARCH_RESTORE_SESSION_KEY) || 'null'); } catch { /* 使用 GM 备用记录。 */ }
        try { shared = GM_getValue(SEARCH_RESTORE_STORE, null); } catch { /* 仅 sessionStorage 可用时仍可恢复。 */ }
        const valid = saved => saved && typeof saved.key === 'string' && saved.key
            && typeof saved.keyword === 'string' && typeof saved.initialURL === 'string'
            && Number.isFinite(saved.at) && Date.now() - saved.at >= 0 && Date.now() - saved.at <= 30 * 60 * 1000;
        const saved = valid(local) ? local : valid(shared) ? shared : null;
        if (!saved) {
            const expired = [local, shared].some(value => value && Number.isFinite(value.at)
                && (Date.now() - value.at < 0 || Date.now() - value.at > 30 * 60 * 1000));
            if (expired) clearPendingRestore();
            return null;
        }
        return saved;
    }
    function clearPendingRestore() {
        try { sessionStorage.removeItem(SEARCH_RESTORE_SESSION_KEY); } catch { /* sessionStorage 可能不可用。 */ }
        try { GM_setValue(SEARCH_RESTORE_STORE, null); } catch { /* 恢复完成不影响当前页面。 */ }
    }
    function openSearchDB() {
        if (!window.indexedDB) return Promise.reject(new Error('浏览器未提供 IndexedDB 本地存储'));
        if (!searchDBPromise) searchDBPromise = new Promise((resolve, reject) => {
            let request;
            try { request = window.indexedDB.open(SEARCH_DB_NAME, 1); }
            catch (error) { reject(error); return; }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('records')) {
                    const store = db.createObjectStore('records', { keyPath: 'id' });
                    store.createIndex('sessionKey', 'sessionKey', { unique: false });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); searchDBPromise = null; };
                resolve(db);
            };
            request.onerror = () => { searchDBPromise = null; reject(request.error || new Error('无法打开本地搜索数据库')); };
            request.onblocked = () => { searchDBPromise = null; reject(new Error('本地搜索数据库正被其他标签页占用，请稍后重试')); };
        });
        return searchDBPromise;
    }
    function readSearchDB(storeName, makeRequest) {
        return openSearchDB().then(db => new Promise((resolve, reject) => {
            let result;
            let tx;
            try {
                tx = db.transaction(storeName, 'readonly');
                const request = makeRequest(tx.objectStore(storeName));
                request.onsuccess = () => { result = request.result; };
                request.onerror = () => reject(request.error || tx.error || new Error('读取本地搜索记录失败'));
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error || new Error('读取本地搜索记录失败'));
                tx.onabort = () => reject(tx.error || new Error('读取本地搜索记录已中止'));
            } catch (error) { reject(error); }
        }));
    }
    function getSearchSession(key) {
        return readSearchDB('sessions', store => store.get(key)).then(value => value || null);
    }
    function listSearchSessions() {
        return readSearchDB('sessions', store => store.getAll()).then(rows => (Array.isArray(rows) ? rows : [])
            .filter(row => row && typeof row.key === 'string' && typeof row.keyword === 'string')
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, SEARCH_HISTORY_LIMIT));
    }
    function getSearchRecords(key) {
        return readSearchDB('records', store => store.index('sessionKey').getAll(key)).then(rows => (Array.isArray(rows) ? rows : [])
            .sort((a, b) => (a.order || 0) - (b.order || 0)));
    }
    function trimSearchHistory(tx, currentKey) {
        const sessions = tx.objectStore('sessions'), storedRecords = tx.objectStore('records');
        const request = sessions.getAll();
        request.onsuccess = () => {
            const stale = request.result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(SEARCH_HISTORY_LIMIT);
            for (const row of stale) {
                if (row.key === currentKey) continue;
                sessions.delete(row.key);
                const cursorRequest = storedRecords.index('sessionKey').openKeyCursor(window.IDBKeyRange.only(row.key));
                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (cursor) { storedRecords.delete(cursor.primaryKey); cursor.continue(); }
                };
            }
        };
    }
    function writeSearchSnapshot(snapshot, rows) {
        return openSearchDB().then(db => new Promise((resolve, reject) => {
            let tx, skipped = false;
            try {
                tx = db.transaction(['sessions', 'records'], 'readwrite');
                const sessions = tx.objectStore('sessions'), storedRecords = tx.objectStore('records');
                const existingRequest = sessions.get(snapshot.key);
                existingRequest.onsuccess = () => {
                    const existing = existingRequest.result;
                    // 同关键词被更新搜索覆盖后，旧标签页不能再把旧进度写回来。
                    if (existing && existing.generation && snapshot.generation && existing.generation !== snapshot.generation) { skipped = true; return; }
                    if (existing && Number.isFinite(existing.createdAt) && Number.isFinite(snapshot.createdAt) && existing.createdAt > snapshot.createdAt) { skipped = true; return; }
                    sessions.put(snapshot);
                    for (const row of rows) storedRecords.put(row);
                    trimSearchHistory(tx, snapshot.key);
                };
                existingRequest.onerror = () => reject(existingRequest.error || tx.error || new Error('检查搜索会话版本失败'));
                tx.oncomplete = () => resolve(!skipped);
                tx.onerror = () => reject(tx.error || new Error('保存搜索进度失败'));
                tx.onabort = () => reject(tx.error || new Error('保存搜索进度已中止'));
            } catch (error) { reject(error); }
        }));
    }
    function replaceSearchSnapshot(snapshot, rows) {
        return openSearchDB().then(db => new Promise((resolve, reject) => {
            let tx, skipped = false;
            try {
                tx = db.transaction(['sessions', 'records'], 'readwrite');
                const sessions = tx.objectStore('sessions'), storedRecords = tx.objectStore('records');
                const existingRequest = sessions.get(snapshot.key);
                existingRequest.onsuccess = () => {
                    const existing = existingRequest.result;
                    if (existing && Number.isFinite(existing.createdAt) && Number.isFinite(snapshot.createdAt)) {
                        if (existing.createdAt > snapshot.createdAt) { skipped = true; return; }
                        // 时间戳相同但代次不同无法可靠判定新旧；保留现有会话，避免随机令牌排序导致旧标签覆盖。
                        if (existing.createdAt === snapshot.createdAt && existing.generation && snapshot.generation
                            && existing.generation !== snapshot.generation) { skipped = true; return; }
                    }
                    const cursorRequest = storedRecords.index('sessionKey').openKeyCursor(window.IDBKeyRange.only(snapshot.key));
                    cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (cursor) { storedRecords.delete(cursor.primaryKey); cursor.continue(); return; }
                        sessions.put(snapshot);
                        for (const row of rows) storedRecords.put(row);
                        trimSearchHistory(tx, snapshot.key);
                    };
                    cursorRequest.onerror = () => reject(cursorRequest.error || tx.error || new Error('替换旧搜索缓存失败'));
                };
                existingRequest.onerror = () => reject(existingRequest.error || tx.error || new Error('检查搜索会话版本失败'));
                tx.oncomplete = () => resolve(!skipped);
                tx.onerror = () => reject(tx.error || new Error('保存新搜索缓存失败'));
                tx.onabort = () => reject(tx.error || new Error('保存新搜索缓存已中止'));
            } catch (error) { reject(error); }
        }));
    }
    function visibleRecordKey() {
        for (const record of mounted) {
            const rect = record.item?.getBoundingClientRect();
            if (rect && rect.bottom > 0 && rect.top < innerHeight) return record.key;
        }
        return '';
    }
    function searchSessionSnapshot() {
        return {
            key: searchSessionKey, keyword: searchKeyword, generation: searchSessionGeneration,
            createdAt: searchSessionCreatedAt || Date.now(), updatedAt: Date.now(), initialURL: searchStartURL,
            currentPage, resultPage, nextURL, loadedPages: [...loadedPages], filters: filterSnapshot(),
            mergePages: settings.mergePages, resultsPerPage: settings.resultsPerPage,
            scannedCount, duplicatesCount, sourceTotal,
            scrollY: Math.max(0, Number(window.scrollY) || 0), anchorKey: visibleRecordKey(), recordCount: allRecords.length,
        };
    }
    function persistSearchSession() {
        if (!searchSessionKey || !searchKeyword || sessionInitializing || sessionRestoring || !sessionHasUserActivity) return Promise.resolve();
        const snapshot = searchSessionSnapshot();
        const replaceCache = sessionReplaceCache;
        const selectedRecords = replaceCache ? allRecords : allRecords.filter(record => !persistedRecordKeys.has(record.key));
        const rows = selectedRecords.map((record, index) => ({
            id: searchSessionKey + '::' + record.key, sessionKey: searchSessionKey, key: record.key,
            order: Number.isFinite(record.order) ? record.order : index, html: record.html, url: record.url,
            boardId: record.boardId || '', title: record.title || '', text: record.text || '',
        }));
        sessionSaveChain = sessionSaveChain.catch(() => {}).then(() => replaceCache
            ? replaceSearchSnapshot(snapshot, rows) : writeSearchSnapshot(snapshot, rows))
            .then(saved => {
                if (saved === false) {
                    sessionReplaceCache = false;
                    sessionHasUserActivity = false;
                    searchSessionError = '该关键词已有更新的搜索会话，已忽略旧标签页的保存';
                    return;
                }
                for (const row of rows) persistedRecordKeys.add(row.key);
                if (replaceCache) sessionReplaceCache = false;
                searchSessionError = '';
            }).catch(error => { searchSessionError = error?.message || '本地保存失败'; });
        return sessionSaveChain;
    }
    function scheduleSearchSessionSave(immediate = false) {
        if (!searchSessionKey || !searchKeyword || sessionInitializing || sessionRestoring || !sessionHasUserActivity) return;
        clearTimeout(sessionSaveTimer);
        if (immediate) { void persistSearchSession(); return; }
        sessionSaveTimer = setTimeout(() => { void persistSearchSession(); }, 350);
    }
    function noteSearchSessionActivity(immediate = false) {
        if (!searchSessionKey || sessionInitializing || sessionRestoring) return;
        sessionHasUserActivity = true;
        scheduleSearchSessionSave(immediate);
    }
    function replaceRecordsFromCache(cached) {
        for (const record of [...mounted]) unmountRecord(record);
        records.clear(); allRecords.length = 0; matchingRecords = []; matchCursor = 0; matchSignature = '';
        for (const row of cached) {
            if (!row || typeof row.key !== 'string' || typeof row.html !== 'string' || typeof row.url !== 'string') continue;
            const record = {
                key: row.key, html: row.html, url: row.url, boardId: row.boardId || '',
                title: row.title || '', text: row.text || '', order: Number.isFinite(row.order) ? row.order : allRecords.length,
                item: null, nodeVersion: 0,
            };
            records.set(record.key, record); allRecords.push(record);
        }
        allRecords.sort((a, b) => a.order - b.order);
    }
    async function restoreSearchSession(session) {
        if (!session || typeof session.key !== 'string') throw new Error('搜索历史记录无效');
        const cached = await getSearchRecords(session.key);
        if (!cached.length) throw new Error('没有找到可恢复的主题缓存，请选择重新开始搜索');
        sessionRestoring = true; sessionInitializing = true;
        replaceRecordsFromCache(cached);
        scannedCount = Number.isFinite(session.scannedCount) ? Math.max(cached.length, session.scannedCount) : cached.length;
        duplicatesCount = Number.isFinite(session.duplicatesCount) ? session.duplicatesCount : 0;
        sourceTotal = Number.isFinite(session.sourceTotal) ? session.sourceTotal : sourceTotal;
        persistedRecordKeys = new Set(cached.map(row => row.key));
        searchKeyword = session.keyword; searchSessionKey = session.key; searchStartURL = session.initialURL;
        searchSessionGeneration = session.generation || searchSessionGeneration || createSearchSessionGeneration(session.createdAt || session.updatedAt || Date.now());
        searchSessionCreatedAt = Number.isFinite(session.createdAt) ? session.createdAt : (Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now());
        settings = validate({
            ...settings, ...(session.filters || {}),
            mergePages: typeof session.mergePages === 'boolean' ? session.mergePages : settings.mergePages,
            resultsPerPage: Number.isFinite(session.resultsPerPage) ? session.resultsPerPage : settings.resultsPerPage,
        });
        persist();
        resultPage = Math.max(1, Number.isFinite(session.resultPage) ? Math.floor(session.resultPage) : 1);
        currentPage = Math.max(1, Number.isFinite(session.currentPage) ? Math.floor(session.currentPage) : 1);
        nextURL = session.nextURL ? searchURL(session.nextURL, location.href) : null;
        loadedPages.clear();
        for (const url of Array.isArray(session.loadedPages) ? session.loadedPages : []) {
            const safe = searchURL(url, location.href); if (safe) loadedPages.add(safe);
        }
        loadedPages.add(location.href);
        sessionHasUserActivity = true; sessionRestoring = false; sessionInitializing = false;
        rebuildToolbar(); applyFilters();
        requestAnimationFrame(() => {
            const anchor = session.anchorKey && records.get(session.anchorKey);
            if (Number.isFinite(session.scrollY) && session.scrollY > 0) window.scrollTo(0, session.scrollY);
            else if (anchor?.item?.isConnected) anchor.item.scrollIntoView({ block: 'start' });
            scheduleSearchSessionSave(true);
        });
        clearPendingRestore();
    }
    async function initializeSearchSession({ restoreToken = null, pendingSearch = null } = {}) {
        if (!searchSessionKey) { sessionInitializing = false; sessionRestoring = false; return; }
        try {
            if (restoreToken) {
                const session = await getSearchSession(restoreToken.key);
                if (!session || !sameSearchSessionURL(session.initialURL, location.href)) throw new Error('当前页面与历史搜索不匹配');
                await restoreSearchSession(session);
                return;
            }
            const existing = await getSearchSession(searchSessionKey);
            const same = existing && sameSearchSessionURL(existing.initialURL, searchStartURL);
            if (pendingSearch?.forceNew || !same) {
                sessionReplaceCache = true; persistedRecordKeys = new Set();
                currentPage = 1; resultPage = 1; loadedPages.clear(); loadedPages.add(location.href);
                nextURL = nextLink(document, location.href);
                sessionHasUserActivity = true; sessionInitializing = false;
                applyFilters();
                await persistSearchSession();
                return;
            }
            searchSessionGeneration = existing.generation || searchSessionGeneration || createSearchSessionGeneration(existing.createdAt || existing.updatedAt || Date.now());
            searchSessionCreatedAt = Number.isFinite(existing.createdAt) ? existing.createdAt : (Number.isFinite(existing.updatedAt) ? existing.updatedAt : Date.now());
            const cached = await getSearchRecords(searchSessionKey);
            if (cached.length) {
                replaceRecordsFromCache(cached);
                scannedCount = Number.isFinite(existing.scannedCount) ? Math.max(cached.length, existing.scannedCount) : cached.length;
                duplicatesCount = Number.isFinite(existing.duplicatesCount) ? existing.duplicatesCount : 0;
                sourceTotal = Number.isFinite(existing.sourceTotal) ? existing.sourceTotal : sourceTotal;
                persistedRecordKeys = new Set(cached.map(row => row.key));
                currentPage = Math.max(1, Number.isFinite(existing.currentPage) ? existing.currentPage : 1);
                nextURL = existing.nextURL ? searchURL(existing.nextURL, location.href) : null;
                loadedPages.clear();
                for (const url of Array.isArray(existing.loadedPages) ? existing.loadedPages : []) {
                    const safe = searchURL(url, location.href); if (safe) loadedPages.add(safe);
                }
                loadedPages.add(location.href);
                // 普通重开从第一页展示；只有点击历史记录并选择“继续上次位置”才跳回上次页码。
                resultPage = 1;
            }
            sessionHasUserActivity = false; sessionInitializing = false; applyFilters();
        } catch (error) {
            searchSessionError = error?.message || '本地搜索历史初始化失败';
            sessionInitializing = false; sessionRestoring = false;
            if (restoreToken) {
                clearPendingRestore(); sessionHasUserActivity = false;
                if (toolbar?.isConnected) toolbar.append(el('p', { class: 's98-status s98-session-notice', role: 'status' }, '历史恢复失败：' + searchSessionError));
            } else if (searchSessionKey) {
                sessionReplaceCache = true; sessionHasUserActivity = true; scheduleSearchSessionSave(true);
            }
            applyFilters();
        }
    }
    function sanitizeImported(node, base) {
        node.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach(x => x.remove());
        for (const child of [node, ...node.querySelectorAll('*')]) {
            for (const attr of [...child.attributes]) {
                if (/^on/i.test(attr.name) || ['srcdoc', 'srcset'].includes(attr.name)) child.removeAttribute(attr.name);
            }
            for (const attr of ['href', 'src']) {
                if (!child.hasAttribute(attr)) continue;
                const href = safeURL(child.getAttribute(attr), base);
                if (href) child.setAttribute(attr, href);
                else child.removeAttribute(attr);
            }
        }
        return node;
    }

    GM_addStyle(`
        .s98{--s98-border:#b8c4cd;--s98-bg:#fff;--s98-text:#22303b;color:var(--s98-text);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;box-sizing:border-box;text-align:left}
        .s98 *{box-sizing:border-box}.s98 [hidden],.s98[hidden],.s98-hidden{display:none!important}
        .s98 button,.s98 select,.s98 input,.s98 textarea{font:inherit;color:inherit}
        .s98 button,.s98 select{border:1px solid var(--s98-border);background:#f6f8fa;border-radius:5px;padding:4px 9px;min-height:32px}
        .s98 button{cursor:pointer}.s98 button:hover{background:#eaf2fa}.s98 button:disabled{opacity:.6;cursor:wait}
        .s98 a{color:#1762a4}.s98 button:focus-visible,.s98 input:focus-visible,.s98 select:focus-visible,.s98 a:focus-visible{outline:2px solid #247cbb;outline-offset:2px}
        .s98-toolbar{background:var(--s98-bg);border:1px solid var(--s98-border);border-radius:7px;padding:10px;margin:12px 0;max-width:100%}
        .s98-toolbar-header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0}
        .s98 .s98-toolbar-toggle{background:#0969da;color:#fff;border:1px solid #0969da;border-radius:6px;min-height:44px;padding:9px 16px;font-size:15px;font-weight:700;box-shadow:0 2px 4px #0969da24}
        .s98 .s98-toolbar-toggle:hover{background:#0757b5;border-color:#0757b5}
        .s98 .s98-history-button,.s98 .s98-read-mark-button,.s98 .s98-hotword-settings-button{background:#2b73c7;color:#fff;border-color:#2b73c7}
        .s98 .s98-history-button:hover,.s98 .s98-read-mark-button:hover,.s98 .s98-hotword-settings-button:hover{background:#225fa7;border-color:#225fa7}
        .s98-filter-state{font-size:13px;padding:3px 9px;border-radius:4px;background:#edf4ff;color:#18569d;overflow-wrap:anywhere}
        .s98-filter-state.is-warning{background:#fff2d8;color:#805000}
        .s98-summary{margin-left:auto}.s98-toolbar-body{border-top:1px solid var(--s98-border);margin-top:10px;padding-top:6px}
        .s98-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0}.s98-row label{display:inline-flex;align-items:center;gap:4px;overflow-wrap:anywhere}
        .s98-keywords{display:flex;flex-wrap:wrap;gap:6px 12px;margin:6px 0}.s98-keywords strong{min-width:32px}
        .s98-hotwords{background:var(--s98-bg);border:1px solid var(--s98-border);border-radius:7px;padding:10px;margin:12px 0;max-width:100%;min-width:0;clear:both}
        .s98-hotword-list{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;min-width:0}
        .s98 .s98-hotword{display:inline-flex;align-items:center;gap:7px;max-width:100%;min-width:0;text-align:left;padding:5px 9px}
        .s98-hotword-rank{color:#1762a4;font-size:12px;flex-shrink:0}.s98-hotword-word{min-width:0;overflow-wrap:anywhere;white-space:normal}
        .s98-status{font-size:13px;color:#4b5c69;overflow-wrap:anywhere}.s98-footer{padding:14px 4px;background:var(--s98-bg);border-top:1px solid var(--s98-border);margin:12px 0}
        .s98-merged-pagination .pg,.s98-merged-pagination .pages{display:none!important}
        .s98-preview-button{margin-right:8px;border:1px solid #b8c4cd;border-radius:5px;background:#f6f8fa;padding:4px 9px;min-height:32px;cursor:pointer}.s98-inline{border-left:3px solid #b5cfe5;padding:6px 10px;margin:8px 0}
        /* 仅解除本脚本处理的结果区宽度，避免影响导航、帖子和站点其他列表。 */
        .s98-results{width:100%!important;max-width:none!important;min-width:0!important;margin:0!important;float:none!important;box-sizing:border-box}
        .s98-results .s98-result-list,.s98-results.s98-result-list{display:grid!important;grid-template-columns:repeat(var(--s98-columns,1),minmax(0,1fr));gap:16px;align-items:start;width:100%!important;max-width:none!important;min-width:0!important;margin:0!important;padding:0!important;float:none!important;list-style:none}
        .s98-results .s98-result-list>.s98-result,.s98-results.s98-result-list>.s98-result{width:auto!important;max-width:none!important;min-width:0!important;height:auto!important;margin:0!important;padding:12px!important;float:none!important;clear:none!important;box-sizing:border-box;list-style:none;border:1px solid rgba(128,140,150,.35);border-radius:7px;overflow-wrap:anywhere}
        .s98-result-list>.s98-result>h3,.s98-result-list>.s98-result>p{width:auto!important;max-width:100%!important;min-width:0!important;box-sizing:border-box;white-space:normal!important;overflow-wrap:anywhere}
        .s98-result-list>.s98-result h3 a{white-space:normal!important;overflow-wrap:anywhere}
        .s98-result.s98-read-strike h3 a{text-decoration:line-through!important;opacity:.72}
        .s98-result.s98-read-highlight h3 a{background:#fff0a8!important;color:#654b00!important;border-radius:3px;padding:0 2px}
        .s98-history-list{max-height:60vh;overflow:auto}
        .s98-history-entry{align-items:flex-start;border-bottom:1px solid var(--s98-border);padding:7px 0}
        .s98 .s98-history-keyword{font-weight:700;max-width:55%;overflow-wrap:anywhere}
        .s98-history-entry .s98-status{flex:1;min-width:160px}
        .s98-read-mode-list{border:1px solid var(--s98-border);border-radius:6px;padding:10px;margin:12px 0}
        .s98-read-mode-option{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 9px;align-items:start;padding:9px 4px;border-bottom:1px solid #e0e5e9}
        .s98-read-mode-option:last-child{border-bottom:0}
        .s98-read-mode-option input{grid-row:span 2;margin-top:5px}
        .s98-read-mode-option strong,.s98-read-mode-option .s98-help{min-width:0}
        .s98-session-notice{background:#fff2d8;padding:8px;border-radius:5px}
        @media(max-width:520px){.s98-history-entry .s98-status{flex-basis:100%}.s98 .s98-history-keyword{max-width:100%}}

        .s98-result-list>.s98-result>.s98-inline{max-width:100%;min-width:0}
        .s98-thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start}
        .s98-thumbs button{padding:0;background:transparent;width:100%;min-width:0;max-width:100%;border:0}
        .s98-thumbs button:only-child{grid-column:1/-1}
        .s98-thumbs img{display:block;max-width:100%;width:100%;height:auto;max-height:var(--s98-preview-height,240px);object-fit:contain}
        .s98-overlay{position:fixed;inset:0;z-index:2147483600;background:#0009;display:flex;align-items:center;justify-content:center;padding:12px}
        .s98-dialog{background:var(--s98-bg);border:1px solid var(--s98-border);border-radius:8px;padding:16px;width:650px;max-width:100%;max-height:94vh;overflow:auto;box-shadow:0 12px 60px #0006}
        .s98-dialog h2{font:600 19px/1.5 system-ui;margin:0 0 12px}.s98-dialog textarea{display:block;width:100%;min-height:76px;border:1px solid var(--s98-border);border-radius:4px;padding:6px;resize:vertical}
        .s98-field{display:block;margin:14px 0}.s98-field>span,.s98-field>label{display:block;font-weight:600}.s98-help{font-size:12px;color:#526574;margin:4px 0 7px}
        .s98-group-heading{flex-basis:100%;min-width:0}.s98-group-heading .s98-help{margin-bottom:0}
        .s98-presets label{max-width:100%;min-width:0}.s98-presets select{max-width:min(260px,100%);min-width:0}
        .s98-preset-entry{padding:8px 0;border-bottom:1px solid #b8c4cd}.s98-preset-entry strong{max-width:100%;overflow-wrap:anywhere}
        .s98-field input[type=text]{width:100%;padding:6px;border:1px solid #b8c4cd;border-radius:4px}
        .s98-board-shortcuts{border-top:1px solid var(--s98-border);margin-top:8px;padding-top:6px}
        .s98-more-keywords{border-top:1px solid var(--s98-border);margin-top:8px;padding-top:6px}.s98-more-keywords>summary{cursor:pointer;font-weight:600}
        .s98-board-preferences{margin:12px 0;padding:10px;border:1px solid var(--s98-border);border-radius:5px;min-width:0}
        .s98-board-search{display:block;width:100%;min-width:0;padding:6px;margin:8px 0}
        .s98-board-options{max-height:320px;overflow:auto;margin-top:8px}.s98-board-options fieldset{border:1px solid var(--s98-border);padding:8px;margin:8px 0;min-width:0}
        .s98-board-options legend{font-weight:600;overflow-wrap:anywhere;max-width:100%}
        .s98-board-choice{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;margin:6px 0;overflow-wrap:anywhere}.s98-board-choice label{white-space:nowrap}
        .s98-viewer{width:1100px}.s98-image-stage{display:flex;align-items:center;justify-content:center;overflow:auto;height:65vh;background:#192027;border-radius:4px}
        .s98-image-stage img{max-width:100%;max-height:100%;object-fit:contain;transform-origin:center center}
        .s98-popup{position:fixed;z-index:2147483599;max-width:calc(100vw - 16px);background:#fff;border:1px solid #b8c4cd;border-radius:6px;padding:8px;box-shadow:0 4px 20px #0003;overflow-wrap:anywhere}
        .s98-popup .s98-status{max-width:300px}
        @media(max-width:520px){.s98-toolbar{padding:8px}.s98-dialog{padding:12px}.s98-overlay{padding:6px}.s98-image-stage{height:60vh}.s98-summary{flex-basis:100%;margin-left:0}}
    `);

    let closeDialog = null;
    function dialog(title, viewer = false) {
        closeDialog?.();
        const previousFocus = document.activeElement;
        const overlay = el('div', { class: 's98 s98-overlay' });
        const box = el('div', { class: `s98-dialog${viewer ? ' s98-viewer' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' });
        const heading = el('div', { class: 's98-row' });
        heading.append(el('h2', {}, title));
        const close = () => {
            overlay.remove(); document.removeEventListener('keydown', keyHandler);
            if (closeDialog === close) closeDialog = null;
            if (previousFocus?.isConnected) previousFocus.focus();
        };
        if (title !== '热搜词') heading.append(button('关闭', close, { 'aria-label': '关闭弹窗' }));
        box.append(heading); overlay.append(box); document.body.append(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        function keyHandler(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            if (e.key !== 'Tab') return;
            const focusable = [...box.querySelectorAll('button, a[href], input, select, textarea')].filter(x => !x.disabled && !x.hidden && x.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (!first) { e.preventDefault(); box.focus(); }
            else if (e.shiftKey && (document.activeElement === first || document.activeElement === box || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
        document.addEventListener('keydown', keyHandler);
        closeDialog = close;
        box.focus();
        return { overlay, box, close };
    }

    // 两个帖子请求并发；同一帖子的弹窗和缩略图共享请求，成功缓存最多 80 帖。
    const previewCache = new Map();
    const previewQueue = [];
    let runningPreviews = 0;
    function drainPreviews() {
        while (runningPreviews < 2 && previewQueue.length) {
            const task = previewQueue.shift();
            runningPreviews++;
            task.run().then(task.resolve, task.reject).finally(() => { runningPreviews--; drainPreviews(); });
        }
    }
    function previewImages(url, { isNeeded = () => true, priority = false } = {}) {
        if (previewCache.has(url)) {
            const cached = previewCache.get(url);
            if (!cached.settled) {
                cached.consumers.push(isNeeded);
                const index = previewQueue.indexOf(cached.task);
                if (priority && index >= 0) { previewQueue.splice(index, 1); previewQueue.unshift(cached.task); }
            }
            previewCache.delete(url); previewCache.set(url, cached);
            return cached;
        }
        const consumers = [isNeeded]; let task;
        const promise = new Promise((resolve, reject) => {
            task = { resolve, reject, async run() {
                if (!consumers.some(needed => needed())) {
                    const error = new Error('预览已取消'); error.code = 'S98_PREVIEW_CANCELLED'; throw error;
                }
                const response = await request(url);
                const base = response.finalUrl || url;
                const doc = parse(response.responseText);
                const body = doc.querySelector('[id^="postmessage_"], .t_f');
                if (!body) throw new Error('未找到帖子正文，请确认已登录或打开原帖查看');
                const images = [];
                for (const img of body.querySelectorAll('img.zoom, img[zoomfile], img[file], img[data-src]')) {
                    for (const attr of ['zoomfile', 'file', 'data-src', 'src']) {
                        const raw = img.getAttribute(attr);
                        if (!raw) continue;
                        const href = safeURL(raw, base);
                        if (!href || /\/(?:static|smiley|smilies)\//i.test(new URL(href).pathname) || /(?:loading|placeholder)\.(?:gif|png)/i.test(href)) continue;
                        if (!images.includes(href)) images.push(href);
                        break;
                    }
                    if (images.length >= 12) break;
                }
                if (!images.length) throw new Error('正文没有可预览图片，可打开原帖查看');
                return images;
            } };
            if (priority) previewQueue.unshift(task); else previewQueue.push(task);
        });
        promise.consumers = consumers; promise.task = task;
        previewCache.set(url, promise);
        promise.then(() => {
            // 不移除排队中或执行中的条目，避免重复请求。
            promise.settled = true;
            promise.consumers.length = 0; promise.task = null;
            for (const [key, value] of previewCache) {
                if (previewCache.size <= 80) break;
                if (value.settled) previewCache.delete(key);
            }
        }, () => {
            promise.settled = true; promise.consumers.length = 0; promise.task = null;
            if (previewCache.get(url) === promise) previewCache.delete(url);
        });
        drainPreviews();
        return promise;
    }
    async function openPreview(record) {
        const modal = dialog('图片预览', true);
        const status = el('p', { class: 's98-status', role: 'status' }, '正在加载帖子图片…');
        modal.box.append(status);
        try {
            const images = await previewImages(record.url, { isNeeded: () => modal.overlay.isConnected, priority: true });
            if (!modal.overlay.isConnected) return;
            let index = 0, scale = 1;
            const stage = el('div', { class: 's98-image-stage' });
            const image = el('img', { alt: '帖子预览图片' });
            stage.append(image);
            const original = el('a', { target: '_blank', rel: 'noopener noreferrer' }, '打开原图');
            const post = el('a', { href: record.url, target: '_blank', rel: 'noopener noreferrer' }, '打开原帖');
            post.addEventListener('click', () => markTopicVisited(record.key));
            post.addEventListener('auxclick', event => { if (event.button === 1) markTopicVisited(record.key); });
            const count = el('span');
            function show(delta = 0) {
                index = (index + delta + images.length) % images.length; scale = 1;
                image.style.transform = ''; image.src = images[index]; original.href = images[index];
                count.textContent = `${index + 1} / ${images.length}`;
                status.textContent = settings.wheelZoom ? '按住 Ctrl 滚轮缩放；Esc 关闭' : '点击按钮切换图片；Esc 关闭';
            }
            image.addEventListener('error', () => { status.textContent = '图片加载失败，可打开原图或原帖查看'; });
            image.addEventListener('wheel', e => {
                if (!settings.wheelZoom || !e.ctrlKey) return;
                e.preventDefault(); scale = Math.max(1, Math.min(4, scale + (e.deltaY < 0 ? .2 : -.2)));
                image.style.transform = `scale(${scale})`;
            }, { passive: false });
            const controls = el('div', { class: 's98-row' });
            controls.append(button('上一张', () => show(-1)), count, button('下一张', () => show(1)),
                button('重置缩放', () => { scale = 1; image.style.transform = ''; }), original, post);
            modal.box.append(stage, controls); show();
        } catch (error) {
            if (!modal.overlay.isConnected) return;
            status.textContent = error.message;
            modal.box.append(button('重试', () => openPreview(record)));
        }
    }

    // 缓存纯文本与净化后的HTML；仅已挂载的记录持有DOM引用。
    const records = new Map(), allRecords = [], mounted = new Set();
    const mountedRecords = new WeakMap(), ingestedNodes = new WeakSet();
    let searchRoot, resultHost;
    function applyResultLayout() {
        if (!searchRoot) return;
        const width = searchRoot.getBoundingClientRect().width;
        const available = Math.max(1, Math.min(3, Math.floor((width + 16) / 436)));
        const desired = settings.resultLayout === 'auto' ? (width >= 1800 ? 3 : width >= 1000 ? 2 : 1) : Number(settings.resultLayout);
        const columns = String(Math.min(desired, available));
        if (searchRoot.style.getPropertyValue('--s98-columns') !== columns) searchRoot.style.setProperty('--s98-columns', columns);
    }
    let previewObserver;
    async function inlinePreview(record) {
        if (record.loading || record.previewReady || !record.item?.isConnected || record.item.hidden || settings.previewMode === 'manual') return;
        if (!record.panel) { record.panel = el('div', { class: 's98 s98-inline' }); record.item.append(record.panel); }
        const panel = record.panel, version = record.nodeVersion, mode = settings.previewMode;
        const isNeeded = () => record.nodeVersion === version && record.item?.isConnected && !record.item.hidden && settings.previewMode === mode;
        panel.hidden = false; panel.replaceChildren(el('span', { role: 'status' }, '正在加载预览…'));
        record.loading = true; record.previewAttempted = true;
        try {
            const images = await previewImages(record.url, { isNeeded });
            if (record.nodeVersion !== version || !panel.isConnected) return;
            if (!isNeeded()) { record.previewAttempted = false; panel.replaceChildren(); return; }
            const thumbs = el('div', { class: 's98-thumbs' });
            for (const href of images.slice(0, 2)) {
                const b = button('', () => openPreview(record), { 'aria-label': '放大预览图片' });
                b.append(el('img', { src: href, alt: '帖子缩略图', loading: mode === 'all' ? 'eager' : 'lazy', decoding: 'async' }));
                b.querySelector('img').addEventListener('error', () => { b.textContent = '图片加载失败，点击查看预览'; });
                thumbs.append(b);
            }
            panel.replaceChildren(thumbs); record.previewReady = true;
        } catch (error) {
            if (record.nodeVersion !== version || !panel.isConnected) return;
            if (error.code === 'S98_PREVIEW_CANCELLED' || !isNeeded()) { record.previewAttempted = false; panel.replaceChildren(); return; }
            panel.replaceChildren(el('span', {}, `${error.message} `), button('重试预览', () => inlinePreview(record)));
            // 等待用户重试，避免 IntersectionObserver 对失败请求反复触发。
        } finally {
            if (record.nodeVersion === version) {
                record.loading = false;
                panel.hidden = settings.previewMode === 'manual';
                if (!record.previewAttempted && settings.previewMode !== 'manual') observePreviews();
            }
        }
    }
    function observePreviews() {
        previewObserver?.disconnect();
        if (settings.previewMode === 'all') {
            for (const record of mounted) if (!record.item.hidden && !record.previewReady && !record.previewAttempted) inlinePreview(record);
            return;
        }
        if (settings.previewMode !== 'auto') return;
        if ('IntersectionObserver' in window) {
            previewObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    const record = mountedRecords.get(entry.target);
                    if (entry.isIntersecting && record && !record.item.hidden) {
                        previewObserver.unobserve(entry.target); inlinePreview(record);
                    }
                }
            }, { rootMargin: '350px' });
            for (const record of mounted) if (!record.item.hidden && !record.previewReady && !record.previewAttempted) previewObserver.observe(record.item);
        } else checkPreviewViewport();
    }
    function checkPreviewViewport() {
        if (settings.previewMode !== 'auto' || 'IntersectionObserver' in window) return;
        for (const record of mounted) {
            const rect = record.item.getBoundingClientRect();
            if (!record.item.hidden && !record.previewAttempted && rect.bottom >= -350 && rect.top <= innerHeight + 350) {
                record.previewAttempted = true; inlinePreview(record);
            }
        }
    }
    function summaryNode(item) {
        const link = titleLink(item);
        return item.querySelector('.searchsummary') || [...item.querySelectorAll('p')].find(p => !p.classList.contains('xg1') && !p.contains(link)) || null;
    }
    function mountRecord(record, original = null) {
        if (record.item?.isConnected) return record.item;
        const template = document.createElement('template');
        if (!original) template.innerHTML = record.html;
        const item = original || template.content.firstElementChild;
        const link = titleLink(item);
        Object.assign(record, { item, link, panel: null, loading: false, previewReady: false, previewAttempted: false, nodeVersion: (record.nodeVersion || 0) + 1 });
        mounted.add(record); mountedRecords.set(item, record);
        item.classList.add('s98-result');
        applyReadMark(record);
        const preview = button('预览图片', () => openPreview(record), { class: 's98 s98-preview-button' });
        link.before(preview);
        const hover = () => {
            clearTimeout(record.hoverTimer);
            if (settings.previewMode === 'hover') record.hoverTimer = setTimeout(() => inlinePreview(record), 250);
        };
        link.addEventListener('mouseenter', hover); link.addEventListener('focus', hover);
        link.addEventListener('mouseleave', () => clearTimeout(record.hoverTimer)); link.addEventListener('blur', () => clearTimeout(record.hoverTimer));
        link.addEventListener('click', () => { markTopicVisited(record.key); });
        link.addEventListener('auxclick', event => { if (event.button === 1) markTopicVisited(record.key); });
        if (!item.isConnected) resultHost.append(item);
        return item;
    }
    function unmountRecord(record) {
        clearTimeout(record.hoverTimer); previewObserver?.unobserve(record.item);
        mountedRecords.delete(record.item); record.item.remove(); mounted.delete(record);
        record.nodeVersion++;
        record.item = record.link = record.panel = null;
        record.loading = false; record.previewReady = false; record.previewAttempted = false;
    }
    let scannedCount = 0, duplicatesCount = 0, sourceTotal = null;
    function updateSourceTotal(doc) {
        const text = doc.querySelector('.sttl')?.textContent || '';
        const value = text.match(/([\d,]+)\s*(?:个|条|项)/)?.[1];
        const total = value ? Number(value.replace(/,/g, '')) : NaN;
        if (Number.isSafeInteger(total) && total >= 0) sourceTotal = total;
    }
    function addItems(items, base = location.href) {
        let added = 0; const discovered = [];
        for (const item of items) {
            if (mountedRecords.has(item) || ingestedNodes.has(item)) continue;
            ingestedNodes.add(item);
            const link = titleLink(item);
            const url = link && safeURL(link.getAttribute('href'), base);
            if (!url) continue;
            const key = threadKey(url);
            scannedCount++;
            if (records.has(key)) { duplicatesCount++; item.remove(); continue; }
            const summary = summaryNode(item);
            const title = link.textContent || '';
            const board = resultBoard(item, base);
            if (board) discovered.push(board);
            const forum = board?.name || item.querySelector('.xi1')?.textContent || '';
            const clean = sanitizeImported(item.cloneNode(true), base);
            const record = { key, html: clean.outerHTML, url, boardId: board?.id || '', title: normalize(title), text: normalize([title, forum, summary?.textContent || ''].join('\n')), order: allRecords.length, item: null, nodeVersion: 0 };
            records.set(key, record); allRecords.push(record); added++;
            if (settings.mergePages) item.remove(); else { item.parentElement?.classList.add('s98-result-list'); mountRecord(record, item); }
        }
        if (mergeDiscoveredBoards(discovered)) refreshBoardViews();
        return added;
    }

    let toolbar, footer, summaryStatus, pageStatus, loadButton, nextURL, currentPage = 1;
    let toolbarExpanded = false, toolbarBody, toolbarToggle, toolbarFilterStatus;
    function setToolbarExpanded(expanded) {
        toolbarExpanded = expanded;
        if (!toolbarBody || !toolbarToggle) return;
        const focusInside = toolbarBody.contains(document.activeElement);
        toolbarBody.hidden = !expanded;
        toolbarToggle.textContent = expanded ? '▼ 收起筛选与设置' : '▶ 展开筛选与设置';
        toolbarToggle.setAttribute('aria-expanded', String(expanded));
        if (!expanded && focusInside) toolbarToggle.focus();
    }
    let pageLoading = false, pageError = '', autoBurst = 0, autoTimer, showAll = false;
    let retryableFailure = false, retryAttempts = 0, pendingManual = false, manualTimer, statusTimer, lockBusyUntil = 0;
    const RATE_STORE = `_98enhanced_page_rate_v1:${location.origin}`;
    function readRate() {
        const saved = GM_getValue(RATE_STORE, {}) || {};
        const number = key => Number.isFinite(saved[key]) && saved[key] >= 0 ? saved[key] : 0;
        const failures = Math.min(10, number('failures')), savedPace = Math.min(60000, number('paceMs'));
        let nextAt = number('nextAt');
        // 旧版成功后只清了 failures，留下加倍后的 paceMs；仅修复这类陈旧普通等待。
        // 正在读取的其他标签占用和站点冷却均单独保留，不能因恢复设置而提前请求。
        if (!failures && savedPace && number('leaseUntil') <= Date.now()) nextAt = Math.min(nextAt, number('finishedAt') + settings.pageIntervalMs);
        return { nextAt, blockedUntil: number('blockedUntil'), finishedAt: number('finishedAt'), leaseUntil: number('leaseUntil'), paceMs: failures ? savedPace : 0, failures };
    }
    let rate = readRate();
    // 初始页面也是一次原站访问，首次补页也需留出间隔。
    rate.finishedAt = Date.now();
    rate.nextAt = Math.max(rate.nextAt, Date.now() + settings.pageIntervalMs);
    GM_setValue(RATE_STORE, rate);
    function pageWait() {
        rate = readRate();
        return Math.max(0, rate.nextAt - Date.now(), rate.blockedUntil - Date.now(), lockBusyUntil - Date.now());
    }
    function finishSourceRequest(error) {
        rate = readRate();
        if (error?.retryable) {
            rate.failures++;
            rate.paceMs = Math.min(60000, Math.max(settings.pageIntervalMs, rate.paceMs) * 2);
            rate.blockedUntil = Math.max(rate.blockedUntil, Date.now() + Math.max(Math.min(300000, 30000 * 2 ** Math.min(rate.failures - 1, 4)), error.retryDelayMs || 0));
        } else if (!error) { rate.failures = 0; rate.paceMs = 0; }
        rate.finishedAt = Date.now(); rate.leaseUntil = 0;
        rate.nextAt = rate.finishedAt + Math.max(settings.pageIntervalMs, rate.paceMs);
        GM_setValue(RATE_STORE, rate);
    }
    function refreshIntervalWait() {
        rate = readRate();
        // 仅重算普通等待，不清除服务器冷却或其他标签正在进行的请求占用。
        if (rate.leaseUntil <= Date.now()) {
            rate.nextAt = (rate.finishedAt || Date.now()) + Math.max(settings.pageIntervalMs, rate.paceMs);
            GM_setValue(RATE_STORE, rate);
        }
    }
    function changePageInterval(seconds) {
        settings.pageIntervalMs = Math.round(seconds * 1000); persist(); refreshIntervalWait();
        renderStatus(); scheduleFill(); scheduleAutoPage();
        if (pendingManual) scheduleManual();
    }
    let resultPage = 1, matchingRecords = [], resultPagers = [];
    let matchSignature = '', matchCursor = 0;
    let fillPaused = false, fillLimit = false, filling = false, fillTimer, fillSessionPages = 0;
    const loadedPages = new Set([location.href]);
    const pageGoal = () => resultPage * settings.resultsPerPage;
    const needsFill = () => !sessionInitializing && !sessionRestoring && settings.mergePages && matchingRecords.length < pageGoal() && !!nextURL;
    const mayRetry = () => retryableFailure && retryAttempts < 2;
    function resetResultPage() {
        resultPage = 1; fillPaused = false; fillLimit = false; fillSessionPages = 0;
        pendingManual = false; clearTimeout(manualTimer); clearTimeout(fillTimer);
    }
    function filterChanged() { resetResultPage(); applyFilters(); noteSearchSessionActivity(true); }
    function createResultPager() {
        const node = el('div', { class: 's98-row s98-result-pager', 'aria-label': '筛选结果分页' });
        const move = delta => {
            if (pageLoading || filling) return;
            if (delta < 0 && resultPage <= 1) return;
            if (delta > 0 && (matchingRecords.length < pageGoal() || (matchingRecords.length === pageGoal() && !nextURL))) return;
            resultPage += delta; fillPaused = false; fillLimit = false; fillSessionPages = 0;
            setToolbarExpanded(false);
            applyFilters(); noteSearchSessionActivity(true); toolbar?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        };
        const previous = button('上一页（筛选结果）', () => move(-1));
        const next = button('下一页（筛选结果）', () => move(1));
        const pause = button('暂停补齐', () => {
            if (pageError && mayRetry() && !fillPaused) fillPaused = true;
            else if (fillPaused || fillLimit || pageError) {
                fillPaused = false; fillLimit = false; fillSessionPages = 0;
                if (!mayRetry()) { pageError = ''; retryableFailure = false; retryAttempts = 0; }
            } else fillPaused = true;
            clearTimeout(fillTimer); renderStatus(); scheduleFill();
        });
        const status = el('span', { class: 's98-status', 'aria-live': 'polite' });
        const failureLink = el('a', { target: '_blank', rel: 'noopener noreferrer', hidden: '' }, '打开原站失败页');
        node.append(previous, next, pause, status, failureLink);
        resultPagers.push({ node, previous, next, pause, status, failureLink });
        return node;
    }
    function scheduleFill() {
        clearTimeout(fillTimer);
        if (!summaryStatus || !needsFill() || pageLoading || filling || fillPaused || fillLimit || (pageError && !mayRetry())) return;
        fillTimer = setTimeout(async () => {
            if (!needsFill() || pageLoading || filling || fillPaused || fillLimit || (pageError && !mayRetry())) return;
            if (pageWait() > 0) { scheduleFill(); return; }
            filling = true; renderStatus();
            const before = currentPage;
            await loadNextPage(false, true);
            filling = false;
            if (currentPage > before) fillSessionPages++;
            if (fillSessionPages >= settings.maxFillPages && needsFill()) fillLimit = true;
            renderStatus(); scheduleFill();
        }, Math.min(pageWait(), 1000));
    }
    function renderStatus() {
        if (!summaryStatus) return;
        const visible = [...mounted].filter(r => !r.item.hidden).length;
        const wait = Math.ceil(pageWait() / 1000);
        const cooling = rate.blockedUntil > Date.now();
        const nextWait = rate.leaseUntil > Date.now() ? '其他标签页正在读取，等待完成后继续' : cooling ? `异常后冷却 ${wait} 秒后读取下一页` : rate.paceMs > settings.pageIntervalMs ? `失败后延长等待 ${wait} 秒后读取下一页` : `等待 ${wait} 秒后读取下一页`;
        const filterCount = settings.included.length + settings.excluded.length + settings.banned.length + settings.includedBoards.length + settings.excludedBoards.length;
        const conflict = settings.includedBoards.some(id => settings.excludedBoards.includes(id));
        toolbarFilterStatus.textContent = showAll ? '临时显示全部 · 筛选已暂停' : conflict ? '筛选条件冲突 · 展开调整' : filterCount ? `筛选已启用 · ${filterCount} 项条件` : '未启用筛选';
        toolbarFilterStatus.classList.toggle('is-warning', showAll || conflict);
        summaryStatus.textContent = settings.mergePages
            ? `已读取 ${records.size} 条（去重），累计符合 ${matchingRecords.length} 条，排除 ${records.size - matchingRecords.length} 条；本页显示 ${visible} 条` +
                (sourceTotal === null ? '' : `；原站报告 ${sourceTotal} 条（未筛选）`) +
                `；共扫描 ${scannedCount} 条，重复 ${duplicatesCount} 条`
            : `已加载 ${records.size} 条，显示 ${visible} 条，过滤 ${records.size - visible} 条`;
        pageStatus.hidden = settings.mergePages; loadButton.hidden = settings.mergePages;
        pageStatus.textContent = pageLoading ? '正在加载下一页…' : pageError ||
            (!nextURL ? `已到底 · 已载入 ${currentPage} 页` : autoBurst >= 3 && settings.autoPage ? '已连续补充 3 页，可点击继续加载' : `已载入 ${currentPage} 页`);
        if (!settings.mergePages && wait && (pageError || pendingManual)) pageStatus.textContent += `；${cooling ? '冷却' : '等待'} ${wait} 秒${pendingManual ? '后加载' : '后可重试'}`;
        loadButton.disabled = pageLoading || !nextURL;
        loadButton.textContent = pendingManual ? '取消等待' : pageError ? '重试加载' : !nextURL ? '没有下一页' : '加载下一页';
        resultPagers = resultPagers.filter(pager => pager.node.isConnected);
        for (const pager of resultPagers) {
            pager.node.hidden = !settings.mergePages;
            pager.previous.disabled = resultPage <= 1 || pageLoading || filling;
            pager.next.disabled = pageLoading || filling || matchingRecords.length < pageGoal() || (matchingRecords.length === pageGoal() && !nextURL);
            pager.pause.disabled = !needsFill() && !pageLoading;
            pager.pause.textContent = fillPaused || fillLimit ? '继续补齐' : pageError && mayRetry() ? '暂停重试' : pageError ? '继续补齐' : '暂停补齐';
            const total = !nextURL ? ` / 共 ${Math.max(1, Math.ceil(matchingRecords.length / settings.resultsPerPage))} 页` : '';
            const state = pageLoading ? '正在读取原站下一页…' : fillPaused ? '已暂停（当前请求完成后停止）' : pageError ? `${pageError}${wait ? `；冷却 ${wait} 秒` : ''}${mayRetry() ? `；等待后自动重试（${retryAttempts + 1}/2）` : retryableFailure ? '；自动重试已达上限，请检查原站后继续' : '；请打开原站失败页确认'}` : fillLimit
                ? `本轮已读取 ${fillSessionPages} 页，点击继续补齐` : !nextURL ? '已到底，不足时按实际条数显示' : needsFill() ? (wait ? nextWait : '正在补齐本页…') : '本页已满';
            const remaining = Math.max(0, settings.resultsPerPage - visible);
            const gap = remaining > 0 && nextURL ? ` · 还差 ${remaining} 条` : '';
            pager.status.textContent = `第 ${resultPage} 页${total} · 本页 ${visible} / ${settings.resultsPerPage} 条 · 已读取原站 ${currentPage} 页${gap} · ${state}`;
            pager.failureLink.hidden = !pageError;
            if (pageError) pager.failureLink.href = nextURL || location.href;
        }
        clearTimeout(statusTimer);
        if (wait && (needsFill() || pendingManual || pageError)) statusTimer = setTimeout(renderStatus, 1000);
        refreshPresetControls();
    }
    function applyFilters() {
        if (!searchRoot || !resultHost) return;
        applyResultLayout();
        const include = settings.included.map(normalize), exclude = [...settings.excluded, ...settings.banned].map(normalize);
        const includeBoards = new Set(settings.includedBoards), excludeBoards = new Set(settings.excludedBoards);
        const signature = JSON.stringify([showAll, include, exclude, settings.includeMode, settings.filterScope, [...includeBoards], [...excludeBoards], readMarkMode, readMarkMode === 'hide' ? readMarkRevision : 0]);
        if (signature !== matchSignature) { matchSignature = signature; matchCursor = 0; matchingRecords = []; }
        // 规则未变时只匹配新增的数据；翻页、预览和改变布局都不重复扫描历史结果。
        for (; matchCursor < allRecords.length; matchCursor++) {
            const record = allRecords[matchCursor];
            const text = settings.filterScope === 'title' ? record.title : record.text;
            const matches = !include.length || (settings.includeMode === 'all' ? include.every(x => text.includes(x)) : include.some(x => text.includes(x)));
            const boardMatches = (!includeBoards.size || includeBoards.has(record.boardId)) && !excludeBoards.has(record.boardId);
            const hiddenAsRead = readMarkMode === 'hide' && visitedTopics.has(record.key);
            record.matches = !hiddenAsRead && (showAll || (boardMatches && matches && !exclude.some(x => text.includes(x))));
            if (record.matches) matchingRecords.push(record);
        }
        if (settings.mergePages && !nextURL && !pageLoading) resultPage = Math.min(resultPage, Math.max(1, Math.ceil(matchingRecords.length / settings.resultsPerPage)));
        const currentRecords = settings.mergePages ? matchingRecords.slice((resultPage - 1) * settings.resultsPerPage, pageGoal()) : matchingRecords;
        const currentItems = new Set(currentRecords);
        if (settings.mergePages) {
            for (const record of mounted) if (!currentItems.has(record)) unmountRecord(record);
            for (const record of currentRecords) mountRecord(record);
            const existing = [...resultHost.children].filter(node => mountedRecords.has(node));
            if (existing.length !== currentRecords.length || existing.some((node, i) => node !== currentRecords[i].item)) {
                const fragment = document.createDocumentFragment();
                for (const record of currentRecords) fragment.append(record.item);
                resultHost.append(fragment);
            }
        } else for (const record of allRecords) mountRecord(record);
        for (const record of mounted) {
            applyReadMark(record);
            record.item.hidden = !currentItems.has(record);
            record.item.classList.toggle('s98-hidden', record.item.hidden);
            if (record.panel) record.panel.hidden = settings.previewMode === 'manual';
            record.panel?.querySelectorAll('img').forEach(img => { img.loading = settings.previewMode === 'all' ? 'eager' : 'lazy'; });
            record.item.style.setProperty('--s98-preview-height', `${settings.previewHeight}px`);
        }
        document.documentElement.classList.toggle('s98-merged-pagination', settings.mergePages && !!toolbar);
        renderStatus(); observePreviews(); scheduleAutoPage(); scheduleFill(); scheduleSearchSessionSave();
    }
    function checkbox(text, checked, onChange) {
        const label = el('label'); const input = el('input', { type: 'checkbox' }); input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        label.append(input, document.createTextNode(text)); return label;
    }
    function select(options, value, onChange) {
        const node = el('select');
        for (const [key, title] of options) node.append(el('option', { value: key }, title));
        node.value = value; if (onChange) node.addEventListener('change', () => onChange(node.value));
        return node;
    }
    const previewModes = [['manual', '点击预览'], ['hover', '悬停加载缩略图'], ['auto', '滚动到附近加载缩略图'], ['all', '加载当页全部缩略图']];
    const resultLayouts = [['1', '单列'], ['2', '双列'], ['3', '三列'], ['auto', '自适应列数']];
    function filterHeading(title, explanation) {
        const heading = el('div', { class: 's98-group-heading' });
        heading.append(el('strong', {}, title), el('p', { class: 's98-help' }, explanation));
        return heading;
    }
    function openHelp() {
        const modal = dialog('搜索加强版使用说明');
        for (const [title, explanation] of [
            ['筛选与设置面板', '默认收起，点击蓝色“展开筛选与设置”按钮展开，再点击同一个按钮收起。新搜索或切换结果页后自动收起；修改条件和后台自动补齐不会打断当前展开状态。收起只隐藏控件，不停用筛选。分页、加载进度和重试入口继续显示。'],
            ['板块筛选', '只看板块：保留属于任意一个所选板块的帖子。排除板块：隐藏属于所选板块的帖子。同一板块不能同时选入两边；板块归属只认结果中的板块链接，不看标题或摘要是否提到板块名。'],
            ['选择快捷板块', '设置里勾选的是前台展示哪些快捷项，不是立即启用筛选。保存后，在搜索页勾选具体板块才开始筛选。取消展示某项时，也会取消对应的当前板块筛选，避免留下看不见的条件。'],
            ['关键词筛选', '在“更多筛选”中选择只看关键词或排除关键词。只看关键词可选任意或全部匹配；匹配范围可选仅标题，或标题、板块与摘要。板块筛选与关键词筛选同时启用时，需要同时满足。'],
            ['自动排除关键词（原黑名单）', '在设置中填写后自动生效，无须勾选。按当前关键词匹配范围隐藏命中的搜索结果，例如填写“广告”会自动排除命中该词的结果。这不是封禁作者或账号，也不会删除原帖。'],
            ['清空勾选与临时查看', '“清空勾选”会取消板块和关键词的当前勾选，保留快捷项、收藏方案和自动排除关键词。“临时显示全部”会暂时忽略上述所有筛选，包括自动排除词，取消临时查看后恢复筛选。'],
            ['合并分页', '自动连续读取后续原站页，将符合筛选条件的结果补齐到每页目标条数。补满当前页后停止，点击下一页再按需继续；已读结果可复用。'],
            ['每轮自动补齐上限', '为补满当前结果页，每轮最多继续读取多少个原站页面，不含进入搜索时已有的页面。默认20页，达到上限后暂停，可点击“继续补齐”；已读取结果会保留。失败重试不计入成功读取页数。'],
            ['自动加载间隔与滚动加载', '默认每次处理完成后等待5秒，工具栏可设置1～60秒并自动保存，站点要求的较长冷却优先。关闭合并分页后，“滚动加载更多”才用于在接近列表底部时追加结果。'],
            ['图片预览模式', '可点击预览、悬停加载、滚动到附近加载，或加载当页全部缩略图。全部模式会为当前展示的所有帖子加载缩略图，每帖显示前两张；关闭合并时处理当前已追加的结果。每次最多同时加载两帖，切换结果页后复用缓存并跳过旧页排队任务。'],
            ['筛选方案', '收藏方案会保存当前板块和关键词规则、自动排除词及匹配方式，不改变布局、每页条数、加载间隔或快捷板块展示偏好。'],
        ]) modal.box.append(el('h3', {}, title), el('p', { class: 's98-help' }, explanation));
    }
    function renderBoardQuickFilters() {
        if (!boardQuickHost?.isConnected) return;
        const focus = document.activeElement;
        const focusID = focus?.dataset.boardId, focusSide = focus?.dataset.boardSide;
        boardQuickHost.replaceChildren();
        const conflict = settings.includedBoards.filter(id => settings.excludedBoards.includes(id));
        for (const [title, quick, active, other] of [['只看板块', 'quickIncludeBoards', 'includedBoards', 'excludedBoards'], ['排除板块', 'quickExcludeBoards', 'excludedBoards', 'includedBoards']]) {
            const group = el('div', { class: 's98-keywords', role: 'group', 'aria-label': title });
            group.append(filterHeading(title, active === 'includedBoards' ? '保留属于任意一个已选板块的帖子，按实际板块归属判断。' : '隐藏属于任意一个已选板块的帖子；同一板块不能同时只看和排除。'));
            for (const id of boardIDs([...settings[quick], ...settings[active]])) {
                const control = checkbox(boardName(id), settings[active].includes(id), checked => {
                    if (checked && settings[other].includes(id)) {
                        boardQuickMessage = `“${boardName(id)}”已在另一侧勾选，请先取消另一侧条件。`;
                    } else {
                        settings[active] = checked ? boardIDs([...settings[active], id]) : settings[active].filter(value => value !== id);
                        boardQuickMessage = ''; persist(); filterChanged();
                    }
                    renderBoardQuickFilters();
                });
                const input = control.querySelector('input'); input.dataset.boardId = id; input.dataset.boardSide = active;
                group.append(control);
            }
            if (group.children.length === 1) group.append(el('span', { class: 's98-status' }, '暂无快捷项'));
            boardQuickHost.append(group);
        }
        const info = el('div', { class: 's98-row' });
        info.append(button('选择快捷板块', () => openSettings({ focusBoards: true })), el('span', { class: 's98-status' }, catalogLoading ? '正在读取板块目录…' : catalogError ? `目录读取失败，已保留本地列表：${catalogError}` : `已缓存 ${boardCatalog.boards.length} 个板块；显示哪些快捷项可在设置中调整`));
        boardQuickHost.append(info);
        if (conflict.length || boardQuickMessage) boardQuickHost.append(el('p', { class: 's98-help', role: 'alert' }, conflict.length ? `只看与排除存在冲突：${conflict.map(boardName).join('、')}。请取消其中一侧的勾选。` : boardQuickMessage));
        if (focusID && focusSide) [...boardQuickHost.querySelectorAll('input')].find(input => input.dataset.boardId === focusID && input.dataset.boardSide === focusSide)?.focus();
    }
    function createBoardPreferences() {
        const root = el('section', { class: 's98-board-preferences', 'aria-label': '快捷板块设置' });
        root.append(el('h3', {}, '快捷板块'), el('p', { class: 's98-help' }, '这里只决定前台显示哪些快捷项，不会直接启用筛选。板块列表来自当前账号可读取的论坛目录，使用本地缓存；不需要逐个打开板块。'));
        const chosen = { quickIncludeBoards: new Set([...settings.quickIncludeBoards, ...settings.includedBoards]), quickExcludeBoards: new Set([...settings.quickExcludeBoards, ...settings.excludedBoards]) };
        const touched = { quickIncludeBoards: new Set(), quickExcludeBoards: new Set() };
        const search = el('input', { type: 'search', placeholder: '搜索板块或分区名称', 'aria-label': '搜索板块', class: 's98-board-search' });
        const status = el('p', { class: 's98-status', role: 'status' });
        const refresh = button('刷新板块列表', () => refreshBoardCatalog());
        const list = el('div', { class: 's98-board-options' });
        root.append(search, refresh, status, list);
        function render() {
            refresh.disabled = catalogLoading;
            status.textContent = catalogLoading ? '正在读取当前账号可访问的板块目录…' : catalogError ? `读取失败，保留已有列表。${catalogError}` : `已缓存 ${boardCatalog.boards.length} 个板块。勾选展示位置后，点击“保存设置”生效。`;
            for (const key of Object.keys(chosen)) for (const id of settings[key]) if (!touched[key].has(id)) chosen[key].add(id);
            const boards = [...boardCatalog.boards]; const known = new Set(boards.map(board => board.id));
            for (const id of boardIDs([...chosen.quickIncludeBoards, ...chosen.quickExcludeBoards])) if (!known.has(id)) { known.add(id); boards.push({ id, name: boardName(id), group: '已选但当前目录未返回' }); }
            list.replaceChildren(); const groups = new Map(); const query = normalize(search.value.trim());
            for (const board of boards) {
                if (query && !normalize(`${board.name} ${board.group}`).includes(query)) continue;
                if (!groups.has(board.group)) {
                    const group = el('fieldset'); group.append(el('legend', {}, board.group)); list.append(group); groups.set(board.group, group);
                }
                const row = el('div', { class: 's98-board-choice' }); row.append(el('span', {}, board.name));
                for (const [key, text] of [['quickIncludeBoards', '只看'], ['quickExcludeBoards', '排除']]) {
                    const choice = checkbox(text, chosen[key].has(board.id), checked => { touched[key].add(board.id); if (checked) chosen[key].add(board.id); else chosen[key].delete(board.id); });
                    choice.querySelector('input').setAttribute('aria-label', `在${text}区显示${board.name}`); row.append(choice);
                }
                groups.get(board.group).append(row);
            }
            if (!list.children.length) list.append(el('p', { class: 's98-help' }, boards.length ? '没有匹配的板块，可换个名称搜索。' : '暂未取得板块列表，可点击刷新重试。'));
        }
        search.addEventListener('input', render);
        settingsBoardView = { root, render };
        render();
        return { root, chosen, reset(defaults) {
            for (const key of Object.keys(chosen)) {
                chosen[key].clear();
                for (const board of boardCatalog.boards) touched[key].add(board.id);
                for (const id of settings[key]) touched[key].add(id);
                for (const id of defaults[key]) chosen[key].add(id);
            }
            render();
        } };
    }
    function rebuildToolbar() {
        if (!toolbar) return;
        toolbar.replaceChildren();
        const header = el('div', { class: 's98-toolbar-header' });
        toolbarToggle = button('', () => setToolbarExpanded(!toolbarExpanded), { class: 's98-toolbar-toggle', 'aria-controls': 's98-toolbar-options' });
        toolbarFilterStatus = el('span', { class: 's98-filter-state', 'aria-live': 'polite' });
        summaryStatus = el('div', { class: 's98-status s98-summary', role: 'status' });
        header.append(toolbarToggle,
            button('搜索历史', openSearchHistory, { class: 's98-history-button', 'aria-label': '搜索历史' }),
            button('已读标记', openReadMarkPanel, { class: 's98-read-mark-button', 'aria-label': '已读标记' }),
            button('热搜词', openHotwordSettings, { class: 's98-hotword-settings-button', 'aria-label': '热搜词' }),
            toolbarFilterStatus, summaryStatus);
        toolbarBody = el('div', { class: 's98-toolbar-body', id: 's98-toolbar-options', role: 'region', 'aria-label': '筛选与设置面板' });
        toolbar.append(header, toolbarBody);
        toolbar.addEventListener('change', () => noteSearchSessionActivity(true));
        setToolbarExpanded(toolbarExpanded);
        const controls = el('div', { class: 's98-row' });
        const modeLabel = el('label', {}, '图片：');
        const modeSelect = select(previewModes, settings.previewMode, value => {
            settings.previewMode = value; persist(); applyFilters();
        });
        modeSelect.setAttribute('aria-label', '图片预览模式'); modeLabel.append(modeSelect);
        const layoutLabel = el('label', {}, '布局：');
        const layoutSelect = select(resultLayouts, settings.resultLayout, value => {
            settings.resultLayout = value; persist(); applyResultLayout(); scheduleAutoPage();
        });
        layoutSelect.setAttribute('aria-label', '搜索结果布局'); layoutLabel.append(layoutSelect);
        const autoPageControl = checkbox('滚动加载更多', settings.autoPage, value => {
            settings.autoPage = value; autoBurst = 0; persist(); renderStatus(); scheduleAutoPage();
        });
        autoPageControl.querySelector('input').disabled = settings.mergePages;
        autoPageControl.title = '关闭合并分页时，滚动接近底部会继续追加结果。开启合并分页后会自动补齐当前页，无需开启此项。';
        const pageSizeLabel = el('label', {}, '每页：');
        const sizes = [...new Set([10, 20, 30, 50, 100, settings.resultsPerPage])].sort((a, b) => a - b);
        const pageSize = select(sizes.map(n => [String(n), `${n} 条`]), String(settings.resultsPerPage), value => {
            settings.resultsPerPage = Number(value); persist(); filterChanged();
        });
        pageSize.setAttribute('aria-label', '筛选后每页条数'); pageSize.disabled = !settings.mergePages; pageSizeLabel.append(pageSize);
        const intervalLabel = el('label', {}, '自动加载间隔：');
        const interval = el('input', { type: 'number', min: '1', max: '60', step: 'any', required: '', value: settings.pageIntervalMs / 1000, 'aria-label': '自动加载间隔（秒）' });
        interval.style.width = '5em';
        intervalLabel.title = '连续读取原站页面时，两次加载之间的等待时间。1～60秒，默认5秒，修改后自动保存。站点冷却时间优先。';
        interval.addEventListener('change', () => {
            if (interval.reportValidity()) changePageInterval(Number(interval.value));
        });
        intervalLabel.append(interval, document.createTextNode('秒'));
        const mergeControl = checkbox('合并分页', settings.mergePages, value => {
            settings.mergePages = value; persist(); resetResultPage(); rebuildToolbar(); applyFilters();
        });
        mergeControl.title = '自动读取后续原站页面，将筛选后的结果补齐到每页设定条数。当前页补满后停止，下一页按需继续加载。';
        controls.append(mergeControl, pageSizeLabel, intervalLabel, autoPageControl, modeLabel, layoutLabel, button('设置', openSettings), button('使用说明', openHelp), button('清空勾选', () => {
            settings.included = []; settings.excluded = []; settings.includedBoards = []; settings.excludedBoards = []; boardQuickMessage = '';
            showAll = false; autoBurst = 0; persist(); resetResultPage(); rebuildToolbar(); applyFilters(); noteSearchSessionActivity(true);
        }), checkbox('临时显示全部（忽略筛选）', showAll, value => { showAll = value; autoBurst = 0; filterChanged(); }));
        toolbarBody.append(controls);
        const presetRow = el('div', { class: 's98-row s98-presets' });
        const presetLabel = el('label', {}, '筛选方案：');
        presetSelect = select([], '', id => { const preset = presets.find(p => p.id === id); if (preset) applyPreset(preset); });
        presetSelect.setAttribute('aria-label', '筛选方案'); presetLabel.append(presetSelect);
        managePresetsButton = button('管理方案', managePresets);
        presetStatus = el('span', { class: 's98-status', 'aria-live': 'polite' });
        presetRow.append(presetLabel, button('收藏当前筛选', () => savePresetDialog()), managePresetsButton, presetStatus);
        toolbarBody.append(presetRow);
        boardQuickHost = el('section', { class: 's98-board-shortcuts', 'aria-label': '板块快捷筛选' }); toolbarBody.append(boardQuickHost); renderBoardQuickFilters();
        const more = el('details', { class: 's98-more-keywords' });
        more.open = !!(settings.included.length || settings.excluded.length || settings.banned.length);
        more.append(el('summary', {}, '更多筛选：关键词与自动排除词'), el('p', { class: 's98-help' }, '下面按文字匹配；帖子所属板块请使用上方板块筛选。板块规则与关键词规则需要同时满足。'));
        for (const [label, dict, chosen] of [['排除关键词', 'excludes', 'excluded'], ['只看关键词', 'includes', 'included']]) {
            const group = el('div', { class: 's98-keywords', role: 'group', 'aria-label': label });
            group.append(filterHeading(label, chosen === 'included' ? '只显示匹配已选关键词的结果，可在下方选择满足任意词或全部词。' : '隐藏匹配任意一个已选关键词的结果。候选词可在设置中添加。'));
            if (!settings[dict].length) group.append(el('span', { class: 's98-status' }, '暂无关键词，可在设置中添加'));
            for (const word of settings[dict]) group.append(checkbox(word, settings[chosen].includes(word), checked => {
                settings[chosen] = checked ? [...new Set([...settings[chosen], word])] : settings[chosen].filter(x => x !== word);
                autoBurst = 0; persist(); filterChanged();
            }));
            more.append(group);
        }
        const modes = el('div', { class: 's98-row' });
        const includes = select([['any', '只看：满足任意关键词'], ['all', '只看：满足全部关键词']], settings.includeMode, value => {
            settings.includeMode = value; autoBurst = 0; persist(); filterChanged();
        });
        includes.setAttribute('aria-label', '只看匹配方式');
        const scope = select([['all', '匹配标题、板块和摘要'], ['title', '仅匹配标题']], settings.filterScope, value => {
            settings.filterScope = value; autoBurst = 0; persist(); filterChanged();
        });
        scope.setAttribute('aria-label', '关键词匹配范围'); modes.append(includes, scope);
        more.append(modes, el('p', { class: 's98-help' }, `自动排除关键词：${settings.banned.length} 个，无须勾选，始终按当前匹配范围排除；可在设置中编辑。`));
        toolbarBody.append(more); toolbar.append(createResultPager());
        renderStatus();
    }
    function openHotwordSettings() {
        const modal = dialog('热搜词');
        const form = el('form');
        form.append(el('p', { class: 's98-help' }, '开启后显示近7天热搜，并同意上传符合条件的关键词、来源和主动搜索的统计日期。榜单排序由后台设置，默认按主动搜索贡献；同一安装同词每天最多贡献一次，以北京时间零点换日。热榜点击单独按提交计数，同词3秒内连点去重，仍受服务器限流。'));
        form.append(el('p', { class: 's98-help' }, '显示条数和获取间隔由后台统一设置。缓存有效时直接使用已有榜单，不会反复请求；页面停留时不会定时自动刷新。'));
        const control = checkbox('开启热搜词（同时同意上传搜索关键词）', hotwordSharingEnabled(), () => {});
        const toggle = control.querySelector('input'); toggle.id = 's98-hotwords-consent';
        toggle.setAttribute('aria-describedby', 's98-setting-help-shareHotwords');
        form.append(control, el('p', { class: 's98-help', id: 's98-setting-help-shareHotwords' }, '热词上传不包含账号、Cookie、页面地址或筛选条件。请勿提交含个人信息或其他敏感内容的关键词。关闭后隐藏热搜模块，并停止获取和上传；已汇总的数据不会自动撤回。'));
        form.append(el('p', { class: 's98-help' }, '同一脚本安装同词每天最多成功贡献一次，以北京时间零点换日。本版热搜连接Supabase新后台，取榜和上传无需密钥。清除脚本数据、重装或更换设备会失去本地记录。'));
        const status = el('p', { class: 's98-status', role: 'status' });
        form.append(status, el('button', { type: 'submit' }, '保存热搜设置')); modal.box.append(form);
        form.addEventListener('submit', event => {
            event.preventDefault();
            try {
                if (toggle.checked) ensureHotwordInstallSeed();
                const next = validate({ ...GM_getValue(STORE, settings), shareHotwords: toggle.checked });
                GM_setValue(STORE, clone(next)); settings = next;
                syncHotwordPanel(); modal.close();
            } catch { status.textContent = '保存失败，请重试；当前开关未更改。'; }
        });
    }
    function openSettings(options = {}) {
        const modal = dialog('98堂搜索加强版设置');
        const form = el('form'); const fields = {};
        let resetSelections = false;
        let resetDefaults = null;
        const initiallyMigrated = settings.boardKeywordsMigrated;
        const help = el('p', { class: 's98-help' }, '各项说明位于对应标题下方。修改后需点击底部“保存设置”才生效。');
        form.append(help);
        const boardPreferences = createBoardPreferences(); form.append(boardPreferences.root);
        for (const [key, text, explanation] of [
            ['mergePages', '合并分页：自动补齐筛选后的每页条数', '连续读取后续原站页面，把符合筛选条件的结果补到每页目标条数；补满后停止，多余结果留给下一页。'],
            ['autoPage', '滚动加载更多（关闭合并时使用）', '关闭合并分页后，滚动接近列表底部时追加结果。合并分页开启时，由自动补齐负责加载，此开关不生效。'],
            ['selectSearch', '启用划词搜索', '在网页选中2～200个字符后显示搜索按钮，点击后用所选文字发起站内搜索。'],
            ['wheelZoom', '预览中按住 Ctrl 使用滚轮缩放', '在图片预览窗口内按住Ctrl滚动鼠标滚轮，可以放大或缩小图片；不影响列表缩略图。'],
        ]) {
            const control = checkbox(text, settings[key], () => {}); fields[key] = control.querySelector('input');
            const helpID = `s98-setting-help-${key}`;
            fields[key].setAttribute('aria-describedby', helpID);
            const row = el('div', { class: 's98-field' });
            row.append(control, el('p', { class: 's98-help', id: helpID }, explanation)); form.append(row);
        }
        function field(key, text, explanation, input, unit = '') {
            const id = `s98-setting-${key}`, helpID = `${id}-help`;
            input.id = id; input.setAttribute('aria-describedby', helpID);
            const row = el('div', { class: 's98-field' });
            row.append(el('label', { for: id }, text), el('p', { class: 's98-help', id: helpID }, explanation), input);
            if (unit) row.append(document.createTextNode(` ${unit}`));
            fields[key] = input; form.append(row);
        }
        field('previewMode', '图片预览模式', '可点击预览、悬停加载、滚动到附近加载，或加载当页全部缩略图。全部模式无需滚动，每帖显示前两张，每次最多同时加载两帖；关闭合并时处理当前已追加的结果。', select(previewModes, settings.previewMode));
        field('resultLayout', '搜索结果布局（窄屏自动减少列数）', '默认单列，也可选双列、三列或自适应。屏幕较窄时自动减少列数，避免卡片挤出屏幕。', select(resultLayouts, settings.resultLayout));
        field('resultsPerPage', '筛选后每页条数（1～100）', '合并分页时，每页期望显示的匹配结果条数，默认30条；最后一页不足时按实际数量显示。', el('input', { type: 'number', min: '1', max: '100', required: '', value: settings.resultsPerPage }));
        field('maxFillPages', '每轮自动补齐上限', '为补满当前结果页，每轮最多继续读取多少个原站页面（1～100，默认20），不含进入搜索时已有的页面。达到上限后暂停，可点击“继续补齐”；已读取的结果会保留。失败重试不计入成功读取页数。', el('input', { type: 'number', min: '1', max: '100', required: '', value: settings.maxFillPages }), '个原站页面');
        field('pageIntervalMs', '自动加载间隔（秒，1～60；默认5）', '连续读取原站页面时，从上一页处理完成后开始等待。切换已缓存的结果页无需等待；站点要求等待更久或发生超时时，冷却时间优先。工具栏修改会自动保存。', el('input', { type: 'number', min: '1', max: '60', step: 'any', required: '', value: settings.pageIntervalMs / 1000 }));
        field('previewHeight', '缩略图最大高度（120～600 像素）', '控制结果列表内缩略图的最大高度，默认240像素；保持图片比例，不裁切图片。', el('input', { type: 'number', min: '120', max: '600', required: '', value: settings.previewHeight }));
        for (const [key, title, explanation] of [
            ['includes', '“只看”候选关键词', '每行一个词。保存后在“更多筛选”里勾选才启用，可选择满足任意词或全部词；所属板块请使用上面的快捷板块。'],
            ['excludes', '“排除”候选关键词', '每行一个词。保存后在“更多筛选”里勾选才启用，隐藏匹配任意已选词的结果；所属板块请使用上面的快捷板块。'],
            ['banned', '自动排除关键词（原黑名单）', '每行一个词，保存后按当前匹配范围自动隐藏命中的结果，无须勾选；不会封禁账号或删除帖子。例如填“广告”，会自动排除命中该词的结果。“清空勾选”不会删除这些词，临时显示全部可查看隐藏内容。'],
        ]) {
            const textarea = el('textarea', { rows: '3' }); textarea.value = settings[key].join('\n'); field(key, title, explanation, textarea);
        }
        const actions = el('div', { class: 's98-row' });
        actions.append(button('还原默认设置', () => {
            resetSelections = true;
            resetDefaults = boardCatalog.complete ? { ...migrateBoardWords(DEFAULTS), boardKeywordsMigrated: true } : clone(DEFAULTS);
            boardPreferences.reset(resetDefaults);
            for (const [key, input] of Object.entries(fields)) {
                if (input.type === 'checkbox') input.checked = resetDefaults[key];
                else if (key === 'pageIntervalMs') input.value = resetDefaults[key] / 1000;
                else input.value = Array.isArray(resetDefaults[key]) ? resetDefaults[key].join('\n') : resetDefaults[key];
            }
        }), el('button', { type: 'submit' }, '保存设置'));
        form.append(actions); modal.box.append(form);
        form.addEventListener('submit', e => {
            e.preventDefault();
            const draft = clone(resetDefaults || settings);
            for (const [key, input] of Object.entries(fields)) {
                if (input.type === 'checkbox') draft[key] = input.checked;
                else if (input.tagName === 'TEXTAREA') draft[key] = input.value.split(/\r?\n/);
                else if (key === 'pageIntervalMs') draft[key] = Number(input.value) * 1000;
                else draft[key] = ['previewHeight', 'resultsPerPage', 'maxFillPages'].includes(key) ? Number(input.value) : input.value;
            }
            if (!initiallyMigrated && settings.boardKeywordsMigrated) Object.assign(draft, migrateBoardWords(draft));
            draft.quickIncludeBoards = [...boardPreferences.chosen.quickIncludeBoards];
            draft.quickExcludeBoards = [...boardPreferences.chosen.quickExcludeBoards];
            draft.includedBoards = draft.includedBoards.filter(id => draft.quickIncludeBoards.includes(id));
            draft.excludedBoards = draft.excludedBoards.filter(id => draft.quickExcludeBoards.includes(id));
            if (resetSelections) { draft.included = []; draft.excluded = []; draft.includedBoards = []; draft.excludedBoards = []; }
            const previousInterval = settings.pageIntervalMs;
            settings = validate(draft); persist();
            syncHotwordPanel();
            if (settings.pageIntervalMs !== previousInterval) refreshIntervalWait();
            autoBurst = 0; resetResultPage();
            if (!settings.selectSearch) { searchPopup?.remove(); searchPopup = null; }
            for (const record of mounted) record.previewAttempted = false;
            rebuildToolbar(); applyFilters(); modal.close();
            noteSearchSessionActivity(true);
        });
        if (!boardCatalog.complete || Date.now() - boardCatalog.updatedAt > BOARD_CACHE_AGE) refreshBoardCatalog();
        if (options?.focusBoards) boardPreferences.root.scrollIntoView({ block: 'start' });
    }
    GM_registerMenuCommand('设置', openSettings);
    GM_registerMenuCommand('热搜词', openHotwordSettings);

    function nearFooter() {
        if (!footer?.isConnected) return false;
        const rect = footer.getBoundingClientRect();
        return rect.top <= innerHeight + 600 && rect.bottom >= 0;
    }
    function scheduleAutoPage() {
        clearTimeout(autoTimer);
        if (!settings.mergePages && settings.autoPage && !pageLoading && !pageError && nextURL && autoBurst < 3 && nearFooter()) {
            autoTimer = setTimeout(() => { if (!settings.mergePages && settings.autoPage && nearFooter()) loadNextPage(true); }, Math.max(400, pageWait()));
        }
    }
    function scheduleManual() {
        clearTimeout(manualTimer);
        manualTimer = setTimeout(() => {
            if (!pendingManual || settings.mergePages) return;
            if (pageWait() > 0) { scheduleManual(); return; }
            pendingManual = false; loadNextPage(false, false, true);
        }, Math.min(pageWait(), 1000));
    }
    async function loadNextPage(automatic = false, forMerge = false, queued = false) {
        if (settings.mergePages && !forMerge) return;
        if (pageLoading || !nextURL || (automatic && (pageError || autoBurst >= 3))) return;
        if (!forMerge && !automatic && !queued && !pendingManual) setToolbarExpanded(false);
        if (!forMerge && !automatic && !queued && pendingManual) { pendingManual = false; clearTimeout(manualTimer); renderStatus(); return; }
        if (pageWait() > 0) {
            if (!forMerge && !automatic) { pendingManual = true; scheduleManual(); }
            renderStatus(); return;
        }
        if (!automatic) autoBurst = 0;
        const url = nextURL;
        if (loadedPages.has(url)) { nextURL = null; renderStatus(); return; }
        pageLoading = true; renderStatus();
        let deferred = false;
        const perform = async () => {
            if (pageWait() > 0) { deferred = true; return; }
            // 保留同源请求占用时间；Web Locks可用时，同源多个标签页也不会同时补页。
            rate = readRate(); rate.leaseUntil = Date.now() + 45000; rate.nextAt = rate.leaseUntil + settings.pageIntervalMs; GM_setValue(RATE_STORE, rate);
            const requestAt = Date.now();
            console.info(`[98搜索] 开始读取原站第 ${new URL(url).searchParams.get('page') || 1} 页；${new Date(requestAt).toISOString()}；最小间隔 ${settings.pageIntervalMs}ms`);
            if (pageError) retryAttempts++;
            pageError = ''; retryableFailure = false;
            try {
            const response = await request(url, { timeout: 45000, overrideMimeType: `text/html; charset=${document.characterSet || 'UTF-8'}` });
            const base = searchURL(response.finalUrl || url, url);
            if (!base) throw new Error('返回页面不是当前站点的搜索页，请确认登录状态');
            if (!sameSearchSessionURL(base, url)) throw new Error('返回页面的搜索编号与请求不一致，已拒绝混入结果');
            const doc = parseSearchDocument(response.responseText), root = resultRoot(doc);
            if (!root) throw searchResponseError(doc);
            const pageMarker = doc.querySelector('.pg strong, .pages strong')?.textContent?.trim();
            const expectedPage = Number(new URL(url).searchParams.get('page') || 1);
            if (pageMarker && /^\d+$/.test(pageMarker) && Number(pageMarker) !== expectedPage)
                throw new Error('返回页面的页码与请求不一致，已保留当前搜索进度');
            const items = resultItems(root);
            if (!items.length) throw searchResponseError(doc);
            const target = resultHost;
            if (!target?.isConnected || !searchRoot.contains(target)) throw new Error('当前结果容器已改变，请刷新页面');
            const fragment = document.createDocumentFragment(); const imported = [];
            for (const item of items) {
                const copy = sanitizeImported(document.importNode(item, true), base); imported.push(copy); fragment.append(copy);
            }
            // 先校验响应，再推进分页状态；失败保留同一下一页供重试。
            if (!settings.mergePages) target.append(fragment);
            updateSourceTotal(doc);
            addItems(imported, base);
            loadedPages.add(url); loadedPages.add(base); currentPage++;
            nextURL = nextLink(doc, base);
            if (nextURL && loadedPages.has(nextURL)) nextURL = null;
            const pagers = [...doc.querySelectorAll('.pg, .pages')];
            if (pagers.length) document.querySelectorAll('.pg, .pages').forEach((old, i) => {
                if (!old.closest('.s98')) old.replaceWith(sanitizeImported(document.importNode(pagers[i] || pagers[0], true), base));
            });
            if (automatic) autoBurst++;
            retryAttempts = 0; finishSourceRequest(null);
            console.info(`[98搜索] 原站分页成功；耗时 ${Date.now() - requestAt}ms；下一次至少等待 ${Math.ceil(pageWait() / 1000)} 秒`);
            } catch (error) {
                pageError = error.message; retryableFailure = error.retryable === true;
                finishSourceRequest(error);
                console.info(`[98搜索] 原站分页失败：${error.message}；耗时 ${Date.now() - requestAt}ms；等待 ${Math.ceil(pageWait() / 1000)} 秒`);
            }
        };
        try {
            if (navigator.locks?.request) await navigator.locks.request(`s98-source-page:${location.origin}`, { ifAvailable: true }, async lock => {
                if (!lock) { deferred = true; lockBusyUntil = Date.now() + 1000; return; }
                await perform();
            });
            else await perform();
        } catch (error) { pageError = `分页协调失败：${error.message}`; retryableFailure = false; }
        finally {
            pageLoading = false;
            if (deferred && !forMerge && !automatic) { pendingManual = true; scheduleManual(); }
            applyFilters();
            scheduleSearchSessionSave(true);
        }
    }
    function openHistoryChoice(session) {
        const modal = dialog('搜索历史操作');
        modal.box.append(
            el('p', {}, '关键词：' + session.keyword),
            el('p', { class: 's98-help' }, session.mergePages
                ? '上次筛选结果第 ' + (session.resultPage || 1) + ' 页 · 已读取原站 ' + (session.currentPage || 1) + ' 页。'
                : '上次已读取原站第 ' + (session.currentPage || 1) + ' 页 · 已缓存 ' + (session.recordCount || 0) + ' 条主题。')
        );
        const status = el('p', { class: 's98-status', role: 'status' });
        const actions = el('div', { class: 's98-row s98-history-actions' });
        const resume = button('继续上次位置', async () => {
            resume.disabled = true;
            status.textContent = '正在恢复本地搜索缓存…';
            if (sameSearchSessionURL(session.initialURL, location.href)) {
                try { await restoreSearchSession(session); modal.close(); }
                catch (error) { status.textContent = error?.message || '恢复失败，请重试或重新开始搜索。'; resume.disabled = false; }
                return;
            }
            try {
                const token = { key: session.key, keyword: session.keyword, initialURL: session.initialURL, at: Date.now(), generation: session.generation, createdAt: session.createdAt };
                GM_setValue(SEARCH_RESTORE_STORE, token);
                try { sessionStorage.setItem(SEARCH_RESTORE_SESSION_KEY, JSON.stringify(token)); } catch { /* 由 GM 存储补充。 */ }
                location.href = session.initialURL;
            } catch (error) {
                status.textContent = '无法打开历史搜索：' + (error?.message || '未知错误');
                resume.disabled = false;
            }
        });
        const restart = button('重新开始搜索', () => {
            void searchSelected(session.keyword, modal.box, restart, { forceNew: true, filters: session.filters });
        });
        actions.append(resume, restart, button('取消', () => modal.close()));
        modal.box.append(actions, status);
    }
    async function openSearchHistory() {
        const modal = dialog('搜索历史');
        const status = el('p', { class: 's98-status', role: 'status' }, '正在读取搜索历史…');
        const list = el('div', { class: 's98-history-list' });
        modal.box.append(el('p', { class: 's98-help' }, '同一个关键词只保留最近一次搜索。继续上次会恢复筛选条件、已加载结果和翻页位置；重新开始会重新获取结果并覆盖该关键词的旧进度。'), status, list);
        try {
            await searchSessionInitPromise.catch(() => {});
            await sessionSaveChain.catch(() => {});
            const sessions = await listSearchSessions();
            if (!modal.overlay.isConnected) return;
            list.replaceChildren();
            if (!sessions.length) {
                status.textContent = searchSessionError ? '本地搜索历史暂不可用：' + searchSessionError : '暂无搜索历史。完成一次关键词搜索后会自动记录。';
                return;
            }
            status.textContent = '最近 ' + sessions.length + ' 条关键词记录（最多保留 ' + SEARCH_HISTORY_LIMIT + ' 条）。' +
                (searchSessionError ? ' 最新进度保存异常：' + searchSessionError : '');
            for (const session of sessions) {
                const row = el('div', { class: 's98-row s98-history-entry' });
                const open = button(session.keyword, () => openHistoryChoice(session), { class: 's98-history-keyword' });
                const progress = session.mergePages
                    ? '筛选结果第 ' + (session.resultPage || 1) + ' 页'
                    : '已读取原站第 ' + (session.currentPage || 1) + ' 页';
                const details = el('span', { class: 's98-status' },
                    progress + ' · 已缓存 ' + (session.recordCount || 0) + ' 条 · ' +
                    new Date(session.updatedAt || Date.now()).toLocaleString());
                row.append(open, details);
                list.append(row);
            }
        } catch (error) {
            if (!modal.overlay.isConnected) return;
            status.textContent = '读取搜索历史失败：' + (error?.message || '本地数据库不可用');
        }
    }
    function openReadMarkPanel() {
        const modal = dialog('已读标记');
        modal.box.append(el('p', { class: 's98-help' }, '只有点击进入主题或点击“打开原帖”后才自动记录已访问，不提供手动标记主题的按钮。标记状态按主题 ID 跨关键词保留。'));
        modal.box.append(el('p', { class: 's98-status', role: 'status' }, '已自动记录访问主题 ' + visitedTopics.size + ' 条。'));
        const group = el('fieldset', { class: 's98-read-mode-list', role: 'radiogroup', 'aria-label': '已访问主题处理方式' });
        group.append(el('legend', {}, '已访问主题处理方式'));
        const options = [
            ['none', '不做标记', '已访问主题保持正常显示。'],
            ['hide', '直接隐藏', '已访问主题从所有关键词的搜索结果中排除，包括临时显示全部；切换其他模式后会恢复显示。'],
            ['strike', '文字删除线', '保留主题，已访问标题显示删除线。'],
            ['highlight', '文字高亮', '保留主题，已访问标题使用浅黄色背景高亮。'],
        ];
        for (const [mode, title, description] of options) {
            const label = el('label', { class: 's98-read-mode-option' });
            const radio = el('input', { type: 'radio', name: 's98-read-mode', value: mode });
            radio.checked = readMarkMode === mode;
            radio.addEventListener('change', () => setReadMarkMode(mode));
            label.append(radio, el('strong', {}, title), el('span', { class: 's98-help' }, description));
            group.append(label);
        }
        modal.box.append(group);
    }
    function setupSearch() {
        if (!/\/search\.php$/.test(location.pathname)) return true;
        const root = resultRoot(document);
        if (!root) return false; // 搜索首页、登录页、验证页不注入结果控件。
        const items = resultItems(root);
        if (!items.length) return false;
        // 在首次修改原站 DOM 之前验证模板机制，避免失败后原生事件和列表节点丢失。
        const preflight = document.createElement('template');
        preflight.innerHTML = '<li></li>';
        const nativeRootClass = root.className;
        const nativeHost = items[0].parentElement, nativeHostClass = nativeHost?.className;
        const originals = items.map(item => {
            const anchor = document.createComment('s98-native-position');
            item.before(anchor);
            return { item, anchor, className: item.className };
        });
        startupRollback = () => {
            const nativeItems = new Set(originals.map(({ item }) => item));
            // 合并分页已挂载的副本必须先移除，否则恢复原生节点会产生双份主题。
            for (const node of root.querySelectorAll('li.s98-result')) {
                if (!nativeItems.has(node)) node.remove();
            }
            for (const { item, anchor, className } of originals) {
                item.querySelectorAll('.s98-preview-button').forEach(node => node.remove());
                item.className = className;
                if (anchor.parentNode) anchor.replaceWith(item);
            }
            root.className = nativeRootClass;
            if (nativeHost) nativeHost.className = nativeHostClass;
            document.documentElement.classList.remove('s98-merged-pagination');
        };
        startupCommit = () => originals.forEach(({ anchor }) => anchor.remove());
        migrateBoardKeywords();
        const restoreCandidate = readPendingRestore();
        const restoreMatches = !!restoreCandidate && sameSearchSessionURL(restoreCandidate.initialURL, location.href);
        const pendingSearch = restoreMatches ? null : consumePendingSearch(location.href);
        const keywordFromURL = extractSearchKeywordFromURL();
        searchKeyword = restoreMatches ? restoreCandidate.keyword : (pendingSearch?.keyword || keywordFromURL || '');
        searchSessionKey = restoreMatches ? restoreCandidate.key : searchKeyFor(searchKeyword);
        searchStartURL = restoreMatches ? restoreCandidate.initialURL : makeSearchStartURL(location.href);
        searchSessionGeneration = restoreMatches ? (restoreCandidate.generation || '') : (pendingSearch?.generation || '');
        searchSessionCreatedAt = restoreMatches ? (restoreCandidate.createdAt || restoreCandidate.at || 0) : (pendingSearch?.createdAt || pendingSearch?.at || 0);
        if (!searchSessionGeneration) searchSessionGeneration = createSearchSessionGeneration(searchSessionCreatedAt || Date.now());
        if (!searchSessionCreatedAt) searchSessionCreatedAt = preciseTimestamp();
        sessionRestoring = restoreMatches;
        sessionInitializing = !!searchSessionKey;
        sessionHasUserActivity = false;
        if (pendingSearch?.filters && pendingSearch.forceNew) {
            settings = validate({ ...settings, ...pendingSearch.filters }); persist();
        }
        searchRoot = root; resultHost = items[0].parentElement;
        root.classList.add('s98-results'); resultHost.classList.add('s98-result-list');
        updateSourceTotal(document);
        addItems(items);
        if (!records.size) {
            // 当前原站列表不含可识别的主题：保留原生页面，不重复插入占位锚点。
            startupRollback?.();
            startupRollback = startupCommit = null;
            return true;
        }
        toolbar = el('section', { class: 's98 s98-toolbar', 'aria-label': '搜索增强' }); root.before(toolbar);
        footer = el('div', { class: 's98 s98-footer' });
        pageStatus = el('div', { class: 's98-status', role: 'status' });
        loadButton = button('加载下一页', () => { noteSearchSessionActivity(true); loadNextPage(); }); footer.append(pageStatus, loadButton, createResultPager()); root.after(footer);
        nextURL = nextLink(document, location.href); rebuildToolbar(); applyFilters();
        searchSessionInitPromise = initializeSearchSession({ restoreToken: restoreMatches ? restoreCandidate : null, pendingSearch });
        if (!boardCatalog.complete || Date.now() - boardCatalog.updatedAt > BOARD_CACHE_AGE) refreshBoardCatalog();
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver(() => scheduleAutoPage(), { rootMargin: '600px' });
            startupObservers.push(observer); observer.observe(footer);
        }
        // 兼容站点或其他脚本后来插入的结果；仅处理新增列表节点。
        const observer = new MutationObserver(mutations => {
            const candidates = new Set();
            for (const mutation of mutations) for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1 || !root.contains(node)) continue;
                if (node.matches('li') && !mountedRecords.has(node)) candidates.add(node);
                else if (!mountedRecords.has(node)) for (const item of node.querySelectorAll('li')) if (!mountedRecords.has(item)) candidates.add(item);
            }
            if (candidates.size && addItems([...candidates])) applyFilters();
        });
        startupObservers.push(observer); observer.observe(root, { childList: true, subtree: true });
        if ('ResizeObserver' in window) new ResizeObserver(() => applyResultLayout()).observe(root);
        return true;
    }

    let searchPopup = null, hashPromise = null, cachedHash = null;
    const SEARCH_MIN_INTERVAL_MS = 3000;
    const SEARCH_ATTEMPT_STORE = '_98enhanced_last_search_attempt_v1:' + location.origin;
    function lastSearchAttemptAt() {
        try {
            const value = Number(GM_getValue(SEARCH_ATTEMPT_STORE, 0));
            return Number.isFinite(value) && value > 0 && value <= Date.now() ? value : 0;
        } catch { return 0; }
    }
    function noteSearchAttempt() {
        const at = Date.now();
        try { GM_setValue(SEARCH_ATTEMPT_STORE, at); } catch { /* 限频记录不可用时仍允许用户搜索。 */ }
        return at;
    }
    async function waitForSearchInterval(onStatus) {
        const remaining = SEARCH_MIN_INTERVAL_MS - (Date.now() - lastSearchAttemptAt());
        if (remaining <= 0) return;
        onStatus?.('原站要求搜索间隔至少3秒，正在等待约 ' + Math.ceil(remaining / 1000) + ' 秒…');
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
    function searchRateLimitError(message) {
        const text = String(message || '').replace(/\s+/g, ' ').trim();
        if (!/频繁|频率|间隔|过快|稍后再|too many|rate.?limit|try again.{0,12}later/i.test(text)) return null;
        let wait = 0;
        for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|seconds?|minutes?|hours?)/gi)) {
            const unit = match[2].toLowerCase();
            wait = Math.max(wait, Number(match[1]) * (/小时|hour/.test(unit) ? 3600000 : /分钟|minute/.test(unit) ? 60000 : 1000));
        }
        return Object.assign(new Error('原站限制访问频率：' + text.slice(0, 160)), {
            retryable: true, rateLimited: true, retryDelayMs: wait || SEARCH_MIN_INTERVAL_MS,
        });
    }
    const currentSearchURL = new URL(location.href);
    if (/\/search\.php$/.test(currentSearchURL.pathname)
        && (currentSearchURL.searchParams.has('searchid') || currentSearchURL.searchParams.has('srchtxt'))) {
        // 结果页本身也是一次原站搜索请求；记录时间以免用户立即再搜触发“3秒后再试”。
        noteSearchAttempt();
    }
    async function getFormHash(force = false, onStatus = null, respectCooldown = false) {
        if (force) cachedHash = null;
        const current = document.querySelector('input[name="formhash"]')?.value;
        if (current && !force) return current;
        if (cachedHash && Date.now() - cachedHash.time < 600000) return cachedHash.value;
        if (hashPromise) return hashPromise;
        hashPromise = (async () => {
            if (respectCooldown) await waitForSearchInterval(onStatus);
            // 热词搜索缺少校验码时，额外读取搜索表单后仍需遵守原站间隔。
            if (respectCooldown) noteSearchAttempt();
            const response = await request(location.origin + '/search.php?mod=forum');
            if (new URL(response.finalUrl || location.href).origin !== location.origin) throw new Error('站点已跳转，请在新站点重新搜索');
            const doc = parse(response.responseText);
            const limited = searchRateLimitError(doc.querySelector('#messagetext, .alert_error, .alert_info')?.textContent);
            if (limited) throw limited;
            const hash = doc.querySelector('input[name="formhash"]')?.value;
            if (!hash) throw new Error('未取得搜索校验码，请确认登录状态');
            cachedHash = { value: hash, time: Date.now() }; return hash;
        })();
        try { return await hashPromise; } finally { hashPromise = null; }
    }
    function searchDestination(response) {
        const doc = parse(response.responseText);
        // 必须先识别限频错误，再信任最终URL；部分原站错误页也会保留searchid参数。
        const limited = searchRateLimitError(doc.querySelector('#messagetext, .alert_error, .alert_info')?.textContent);
        if (limited) throw limited;
        const urls = [response.finalUrl];
        for (const a of doc.querySelectorAll('a[href*="searchid="]')) urls.push(a.getAttribute('href'));
        // 只提取跳转地址，绝不执行响应中的脚本。
        const redirect = response.responseText.match(/(?:location\.href|location)\s*=\s*['"]([^'"]+)['"]/);
        if (redirect) urls.push(redirect[1].replace(/&amp;/g, '&'));
        for (const raw of urls) {
            const href = searchURL(raw, response.finalUrl || location.href);
            if (href && new URL(href).searchParams.has('searchid')) return href;
        }
        const message = doc.querySelector('#messagetext, .alert_error, .alert_info')?.textContent?.trim();
        throw new Error(message?.slice(0, 160) || '搜索没有返回结果地址，可能需要登录、验证或等待搜索间隔');
    }
    function showSearchLoadingPage(target, keyword) {
        if (!target) return () => {};
        try {
            const doc = target.document;
            doc.open();
            doc.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在搜索</title><style>body{margin:0;background:#111318;color:#e7eaf0;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;display:grid;min-height:100vh;place-items:center}main{width:min(520px,calc(100% - 48px));padding:28px;border:1px solid #343945;border-radius:12px;background:#191c23;box-sizing:border-box}.spinner{width:24px;height:24px;border:3px solid #454b59;border-top-color:#82b7ff;border-radius:50%;animation:spin .8s linear infinite}h1{font-size:19px;margin:18px 0 6px}p{color:#b5bdcc;overflow-wrap:anywhere}#s98-search-status{font-size:14px}@keyframes spin{to{transform:rotate(360deg)}}</style><main><div class="spinner" aria-hidden="true"></div><h1>正在搜索热词</h1><p id="s98-search-keyword"></p><p id="s98-search-status" role="status">正在连接原站…</p></main></html>');
            doc.close();
            const word = doc.getElementById('s98-search-keyword');
            if (word) word.textContent = keyword;
            return message => {
                try { const node = doc.getElementById('s98-search-status'); if (node) node.textContent = message; } catch { /* 页面可能已经开始跳转。 */ }
            };
        } catch { return () => {}; }
    }
    function findNativeSearchForm(doc) {
        return [...(doc?.forms || [])].find(form => {
            const input = form.elements?.namedItem('srchtxt');
            return input && !!searchURL(form.action, doc.URL || location.href);
        }) || null;
    }
    function nativeFormHash(form) {
        const doc = form?.ownerDocument;
        const value = form?.elements?.namedItem('formhash')?.value
            || doc?.querySelector('input[name="formhash"]')?.value;
        if (value) return String(value);
        return cachedHash && Date.now() - cachedHash.time < 600000 ? cachedHash.value : '';
    }
    function appendNativeHidden(form, name, value) {
        const input = form.ownerDocument.createElement('input');
        input.type = 'hidden'; input.name = name; input.value = value;
        form.append(input);
    }
    function createNativeHotwordForm(target, sourceForm, keyword) {
        const doc = target.document;
        const action = searchURL(sourceForm.action, sourceForm.ownerDocument?.URL || location.href);
        if (!action) throw new Error('无法确认原站搜索表单地址');
        const hash = nativeFormHash(sourceForm);
        if (!hash) throw new Error('原站搜索表单没有可用的 formhash');
        const form = doc.importNode(sourceForm, true);
        const nativeMethod = String(sourceForm.getAttribute('method') || 'get').toLowerCase();
        form.action = action; form.method = nativeMethod === 'post' ? 'post' : 'get'; form.target = '';
        form.style.display = 'none';
        const field = form.elements.namedItem('srchtxt');
        if (!field) throw new Error('原站搜索表单缺少关键词输入框');
        field.value = keyword;
        const hashField = form.elements.namedItem('formhash');
        if (hashField) hashField.value = hash;
        else appendNativeHidden(form, 'formhash', hash);
        const submitField = [...form.elements].find(control =>
            control.name === 'searchsubmit' && control.tagName === 'INPUT' && control.type === 'hidden');
        if (submitField) submitField.value = 'yes';
        else appendNativeHidden(form, 'searchsubmit', 'yes');
        doc.body.append(form);
        return form;
    }
    function submitNativeForm(target, form) {
        const submit = target.document.defaultView?.HTMLFormElement?.prototype?.submit;
        if (typeof submit === 'function') submit.call(form);
        else form.submit();
    }
    function closeHotwordSearchPopup(popup) {
        if (popup.closest?.('.s98-overlay')) closeDialog?.();
        else popup.remove();
    }
    async function submitHotwordNatively(text, target, popup, updateStatus, options = {}) {
        if (!target) throw new Error('浏览器阻止了新窗口，请允许弹出窗口后重试');
        const pendingOptions = {
            forceNew: options.forceNew !== false,
            filters: options.filters || filterSnapshot(),
        };
        const currentForm = findNativeSearchForm(document);
        if (currentForm && nativeFormHash(currentForm)) {
            await waitForSearchInterval(updateStatus);
            const form = createNativeHotwordForm(target, currentForm, text);
            noteSearchAttempt();
            rememberPendingSearch(text, pendingOptions);
            updateStatus('已通过原站网页表单提交；若原站仍限频，将直接显示原站提示。');
            submitNativeForm(target, form);
            queueHotword(text, options.hotwordSource || 'search');
            closeHotwordSearchPopup(popup);
            return;
        }
        updateStatus('当前页面没有可复用的搜索校验码，正在打开原站搜索表单…');
        await waitForSearchInterval(updateStatus);
        noteSearchAttempt();
        await new Promise((resolve, reject) => {
            let finished = false;
            const fail = error => {
                if (finished) return;
                finished = true;
                try { target.removeEventListener('load', onLoad); } catch { /* 窗口可能已关闭。 */ }
                error.keepTarget = true;
                reject(error);
            };
            const onLoad = async () => {
                try {
                    if (target.closed) throw new Error('搜索窗口已关闭');
                    const doc = target.document;
                    if (doc.URL === 'about:blank') return;
                    target.removeEventListener('load', onLoad);
                    const message = doc.querySelector('#messagetext, .alert_error, .alert_info, #cf-error-details')?.textContent
                        || doc.body?.textContent || '';
                    const limited = searchRateLimitError(message);
                    if (limited) { limited.keepTarget = true; throw limited; }
                    const form = findNativeSearchForm(doc);
                    if (!form || !nativeFormHash(form)) {
                        const error = new Error('原站没有返回可用的搜索表单或 formhash；已保留新窗口供核验');
                        error.keepTarget = true; throw error;
                    }
                    await waitForSearchInterval(updateStatus);
                    const nativeForm = createNativeHotwordForm(target, form, text);
                    noteSearchAttempt();
                    rememberPendingSearch(text, pendingOptions);
                    updateStatus('正在通过原站网页表单提交…');
                    submitNativeForm(target, nativeForm);
                    queueHotword(text, options.hotwordSource || 'search');
                    closeHotwordSearchPopup(popup);
                    finished = true; resolve();
                } catch (error) { fail(error); }
            };
            target.addEventListener('load', onLoad);
            try { target.location.replace(location.origin + '/search.php?mod=forum'); }
            catch (error) { fail(error); }
        });
    }
    async function searchSelected(text, popup, trigger, options = {}) {
        trigger.disabled = true;
        // 在用户点击时创建窗口，避免异步回调被浏览器当作弹窗拦截；立即显示进度，不留空白页。
        let target = null;
        try { target = window.open('about:blank', '_blank'); if (target) target.opener = null; } catch { /* 提供可点击链接 */ }
        const status = el('div', { class: 's98-status', role: 'status' }, '正在搜索…'); popup.append(status);
        const updateLoading = showSearchLoadingPage(target, text);
        const updateStatus = message => { status.textContent = message; updateLoading(message); };
        const fallback = new URL('/search.php?mod=forum', location.origin);
        fallback.searchParams.set('srchtxt', text);
        try {
            if (options.respectCooldown === true) {
                await submitHotwordNatively(text, target, popup, updateStatus, options);
                return;
            }
            let url = null;
            // 原站明确返回限频时最多自动等待后重试一次，不无限重复搜索。
            const respectCooldown = options.respectCooldown === true;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    if (respectCooldown) await waitForSearchInterval(updateStatus);
                    const hash = await getFormHash(false, updateStatus, respectCooldown);
                    if (respectCooldown) await waitForSearchInterval(updateStatus);
                    noteSearchAttempt();
                    const data = new URLSearchParams({ formhash: hash, srchtxt: text, searchsubmit: 'yes' }).toString();
                    updateStatus('正在提交搜索请求…');
                    const response = await request(location.origin + '/search.php?mod=forum', {
                        method: 'POST', data, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    });
                    url = searchDestination(response);
                    break;
                } catch (error) {
                    const rateLimited = error?.rateLimited || error?.status === 429;
                    if (!respectCooldown || attempt !== 0 || !rateLimited) throw error;
                    const wait = Math.max(SEARCH_MIN_INTERVAL_MS, Number(error.retryDelayMs) || 0) + 250;
                    noteSearchAttempt();
                    updateStatus('原站要求搜索间隔，等待约 ' + Math.ceil(wait / 1000) + ' 秒后自动重试一次…');
                    await new Promise(resolve => setTimeout(resolve, wait));
                }
            }
            if (!url) throw new Error('搜索没有返回结果地址，请重试');
            queueHotword(text, options.hotwordSource || 'search');
            rememberPendingSearch(text, { targetURL: url, forceNew: options.forceNew !== false, filters: options.filters || filterSnapshot() });
            if (target && !target.closed) {
                target.location.replace(url);
                if (popup.closest?.('.s98-overlay')) closeDialog?.(); else popup.remove();
            }
            else { status.textContent = '搜索完成：'; popup.append(el('a', { href: url, target: '_blank', rel: 'noopener' }, '打开搜索结果')); }
        } catch (error) {
            cachedHash = null; trigger.disabled = false;
            updateStatus(error.message);
            if (target && !target.closed && !error?.keepTarget) target.close();
            if (!error?.keepTarget && !popup.querySelector('a')) popup.append(el('a', { href: fallback.href, target: '_blank', rel: 'noopener' }, '打开站内搜索页'));
        } finally { trigger.disabled = false; }
    }
    document.addEventListener('mouseup', e => {
        if (!settings.selectSearch || e.button !== 0 || e.target.closest?.('.s98, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
        const selection = window.getSelection(); const text = selection?.toString().trim();
        searchPopup?.remove(); searchPopup = null;
        if (!text || text.length < 2 || text.length > 200 || !selection.rangeCount) return;
        if (selection.anchorNode?.parentElement?.closest('.s98, input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
        const popup = el('div', { class: 's98 s98-popup' });
        const trigger = button('搜索选中文字', () => searchSelected(text, popup, trigger));
        popup.append(trigger, el('div', { class: 's98-status' }, text.length > 45 ? `${text.slice(0, 45)}…` : text));
        document.body.append(popup); searchPopup = popup;
        const rect = popup.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, e.clientX))}px`;
        popup.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, e.clientY + 12))}px`;
    });
    document.addEventListener('pointerdown', e => {
        if (searchPopup && !searchPopup.contains(e.target)) { searchPopup.remove(); searchPopup = null; }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { searchPopup?.remove(); searchPopup = null; } });
    let scrollScheduled = false, lastScroll = window.scrollY;
    window.addEventListener('scroll', () => {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => {
            scrollScheduled = false;
            if (Math.abs(window.scrollY - lastScroll) > 100) { autoBurst = 0; lastScroll = window.scrollY; }
            scheduleAutoPage(); checkPreviewViewport();
            scheduleSearchSessionSave();
        });
    }, { passive: true });
    window.addEventListener('resize', () => { applyResultLayout(); scheduleAutoPage(); checkPreviewViewport(); });
    setupHotwordForms();
    const startSearchWhenReady = () => {
        if (document.querySelector('.s98-toolbar')) return true;
        try {
            const started = setupSearch();
            if (started) {
                startupCommit?.();
                startupCommit = startupRollback = null;
            }
            return started;
        } catch (error) {
            reportStartupFailure(error);
            return true;
        }
    };
    if (!startSearchWhenReady() && /\/search\.php$/.test(location.pathname)) {
        // 监听原站稍后插入完整结果；一旦初始化或发生错误即停止，避免重复工具栏。
        const pendingObserver = new MutationObserver(() => {
            if (startSearchWhenReady()) pendingObserver.disconnect();
        });
        pendingObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    setTimeout(() => { try { setupHotwordPanel(); } catch { /* 热搜不影响原站搜索和筛选。 */ } }, 0);
    } catch (error) { reportStartupFailure(error); }
})();
