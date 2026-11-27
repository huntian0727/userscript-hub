// ==UserScript==
// @name         飞书管理后台 · 我的常用
// @namespace    feishu-admin-favorites.local
// @version      0.10.7
// @description  飞书后台辅助工具，支持 AI 额度查询、用量时间快捷切换、用量日志默认查询、命中日志决策筛选与每页条数切换、常用入口和侧栏管理。
// @match        https://baili-pharm.feishu.cn/admin*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @updateURL   https://huntian0727.github.io/userscript-hub/userscripts/feishu-admin-favorites.meta.js
// @downloadURL https://huntian0727.github.io/userscript-hub/userscripts/feishu-admin-favorites.user.js
// ==/UserScript==

(() => {
    'use strict';

    const storageKey = 'favorites';
    const positionKey = 'launcherPosition';
    const menuKey = 'hiddenSidebarMenus';
    const menuFilterKey = 'sidebarFilteringEnabled';
    const connectionKey = 'githubConnection';
    const baselineKey = 'githubSyncBaseline';
    const hitLogPageSizeKey = 'hitLogPageSize';
    const hitLogFetchSettingsKey = 'hitLogFetchSettings';
    const defaultGitHubRepo = 'huntian0727/personal-sync';
    const githubFile = 'projects/feishu-admin-favorites/config.json';
    const legacyGitHubFile = 'feishu-admin-favorites.json';
    const backupFormat = 'feishu-admin-favorites';
    const backupSizeLimit = 1024 * 1024;
    const defaults = [
        { name: 'AI 限额管理', path: '/admin/aibilling/quota-manage?tab=member' },
    ];
    const hostId = 'feishu-admin-favorites';

    function adminPath(value) {
        if (typeof value !== 'string') return null;
        try {
            const url = new URL(value, location.origin);
            if (url.origin !== location.origin) return null;
            if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return null;
            return url.pathname + url.search + url.hash;
        } catch {
            return null;
        }
    }

    if (!adminPath(location.href) || document.getElementById(hostId)) return;

    const datePresetPending = 'data-feishu-usage-preset-pending';
    const datePresetTransition = 'data-feishu-usage-preset-transition';
    const datePresetStyle = document.createElement('style');
    datePresetStyle.textContent = `
        [${datePresetPending}] .ud__picker-dropdown, .ud__picker-dropdown[${datePresetTransition}] {
            visibility: hidden !important; pointer-events: none !important;
        }
    `;

    installQuotaLookup();
    installUsagePresets();
    installUsageLogDefaults();
    installHitLogDecisionFilter();
    installDeviceOldDeepLink();

    function findDatePreset(picker, label) {
        if (!picker.classList.contains('ud__picker-open')) return null;
        const anchor = picker.getBoundingClientRect();
        const matches = [];
        for (const dropdown of document.querySelectorAll('.ud__picker-dropdown')) {
            if (!dropdown.getClientRects().length || /(?:^|\s)ud-slide-up-leave(?:\s|-|$)/.test(dropdown.className)) continue;
            const button = [...dropdown.querySelectorAll('.ud__picker__footer__range__preset-btn')]
                .find(element => !element.matches(':disabled, [aria-disabled="true"]') && element.textContent.trim() === label);
            if (!button) continue;
            const box = dropdown.getBoundingClientRect();
            const distance = Math.min(Math.abs(box.top - anchor.bottom), Math.abs(box.bottom - anchor.top));
            matches.push({ dropdown, button, distance });
        }
        return matches.sort((first, second) => first.distance - second.distance)[0];
    }

    function chooseDatePreset(input, label, active) {
        const picker = input?.closest('.ud__picker');
        const body = document.body;
        if (!picker || input.disabled || !active() || body.hasAttribute(datePresetPending)) return Promise.resolve(false);
        if (!datePresetStyle.isConnected) document.head.append(datePresetStyle);
        body.setAttribute(datePresetPending, '');

        return new Promise(resolve => {
            const started = performance.now();
            function choose() {
                if (!active() || !picker.isConnected || performance.now() - started > 1000) {
                    body.removeAttribute(datePresetPending);
                    resolve(false);
                    return;
                }
                const match = findDatePreset(picker, label);
                if (!match) {
                    requestAnimationFrame(choose);
                    return;
                }
                match.dropdown.setAttribute(datePresetTransition, '');
                match.button.click();
                body.removeAttribute(datePresetPending);
                window.setTimeout(() => match.dropdown.removeAttribute(datePresetTransition), 300);
                requestAnimationFrame(() => resolve(true));
            }
            if (!picker.classList.contains('ud__picker-open')) {
                input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
            }
            requestAnimationFrame(choose);
        });
    }

    function installUsagePresets() {
        const labels = ['近一周', '近一月', '近三月', '近半年', '近一年'];
        const cards = new Map();
        const onUsagePage = () => location.pathname.replace(/\/$/, '') === '/admin/aibilling/usage-overview';
        let frame = 0;

        const style = document.createElement('style');
        style.textContent = `
            [data-feishu-usage-preset-host] { flex-wrap: wrap; gap: 4px 12px; align-items: center; }
            [data-feishu-usage-presets] {
                display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px;
                width: var(--feishu-usage-filter-width); max-width: 100%; margin-inline-start: auto;
            }
            [data-feishu-usage-presets][data-feishu-usage-preset-standalone] { margin-block-start: 8px; }
            [data-feishu-usage-presets] button {
                height: 24px; min-width: 0; padding: 0 8px; font-size: 13px;
            }
            [data-feishu-usage-presets] button[aria-pressed="true"] {
                background: var(--ud-token-primary-fill-solid-01, #eaf0ff);
            }
        `;

        function currentRange(filters) {
            const start = filters.querySelector('.ud__picker-input-start');
            const end = filters.querySelector('.ud__picker-input-end');
            return start && end ? `${start.value}|${end.value}` : null;
        }

        function refreshPressed(card) {
            const current = currentRange(card.filters);
            for (const button of card.toolbar.querySelectorAll('button')) {
                const pressed = card.selected?.label === button.textContent && card.selected.range === current;
                button.setAttribute('aria-pressed', String(pressed));
            }
        }

        async function applyPreset(card, button, label) {
            const input = card.filters.querySelector('.ud__picker-input-start');
            if (!await chooseDatePreset(input, label, onUsagePage) || !button.isConnected) return;
            button.focus({ preventScroll: true });
            card.selected = { label, range: currentRange(card.filters) };
            refreshPressed(card);
        }

        function createToolbar(filters, divider) {
            const toolbar = document.createElement('div');
            toolbar.setAttribute('data-feishu-usage-presets', '');
            toolbar.setAttribute('role', 'group');
            toolbar.setAttribute('aria-label', '时间范围快捷选项');
            const features = divider.previousElementSibling;
            const host = features?.matches('[class*="enableFeatureWrap-"]') ? features : null;
            const card = { filters, toolbar, host };
            for (const label of labels) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ud__button ud__button--text ud__button--text-primary ud__button--size-md';
                button.textContent = label;
                button.addEventListener('click', () => applyPreset(card, button, label));
                toolbar.append(button);
            }
            if (host) {
                host.setAttribute('data-feishu-usage-preset-host', '');
                host.append(toolbar);
            } else {
                toolbar.setAttribute('data-feishu-usage-preset-standalone', '');
                divider.before(toolbar);
            }
            resize.observe(filters);
            return card;
        }

        function refresh() {
            frame = 0;
            const active = onUsagePage();
            for (const [section, card] of cards) {
                if (active && section.isConnected && card.filters.isConnected && card.toolbar.isConnected) continue;
                card.toolbar.remove();
                card.host?.removeAttribute('data-feishu-usage-preset-host');
                resize.unobserve(card.filters);
                cards.delete(section);
            }
            if (!active) return;
            if (!style.isConnected) document.head.append(style);
            for (const section of document.querySelectorAll('[class*="usageWrap-"]')) {
                const filters = section.querySelector('[class*="usageTop-"]');
                const divider = section.previousElementSibling;
                if (!filters?.querySelector('.ud__picker-input-start') || !divider?.matches('[class*="splitLine-"]')) continue;
                if (!cards.has(section)) cards.set(section, createToolbar(filters, divider));
                const card = cards.get(section);
                card.toolbar.style.setProperty('--feishu-usage-filter-width', `${filters.offsetWidth}px`);
                refreshPressed(card);
            }
        }

        function schedule() {
            if (!frame && (onUsagePage() || cards.size)) frame = requestAnimationFrame(refresh);
        }

        const resize = new ResizeObserver(schedule);
        new MutationObserver(schedule).observe(document.body, {
            subtree: true, childList: true, attributes: true, attributeFilter: ['value'],
        });
        window.addEventListener('popstate', schedule);
        schedule();
    }

    function installUsageLogDefaults() {
        const organization = '百利天恒集团';
        const modalSelector = '.ud__modal[role="dialog"]';
        const autoPickerAttribute = 'data-feishu-usage-log-auto-picker';
        const onLogPage = () => location.pathname.replace(/\/$/, '') === '/admin/aibilling/usage-log';
        const visible = element => Boolean(element?.getClientRects().length) && getComputedStyle(element).visibility === 'visible';
        let visit = null;
        let frame = 0;

        const style = document.createElement('style');
        style.textContent = `[${autoPickerAttribute}] { opacity: 0 !important; pointer-events: none !important; }`;

        function enabledButton(scope, label) {
            return scope && [...scope.querySelectorAll('button')].find(button =>
                button.textContent.trim() === label && visible(button) && !button.matches(':disabled, [aria-disabled="true"]'));
        }

        function active(state) {
            return visit === state && onLogPage() && state.form.isConnected && !state.cancelled;
        }

        function waitFor(state, read, timeout = 6000) {
            const deadline = performance.now() + timeout;
            return new Promise(resolve => {
                function check() {
                    if (!active(state) || performance.now() >= deadline) {
                        resolve(null);
                        return;
                    }
                    const value = read();
                    if (value) resolve(value);
                    else window.setTimeout(check, 40);
                }
                check();
            });
        }

        function organizationRow(row) {
            return [...row.querySelectorAll('[class*="title_"]')].some(label => label.textContent.trim() === organization);
        }

        function organizationCheckbox(dialog) {
            const rows = [...dialog.querySelectorAll('[role="tree"] [role="treeitem"]')].filter(row => visible(row) && organizationRow(row));
            return rows.length === 1 && rows[0].querySelector('input[type="checkbox"]:not(:disabled)');
        }

        function selectedRows(dialog) {
            return [...dialog.querySelectorAll('[class*="selected-area_"] [class*="entity-item_"]')];
        }

        function onlyOrganization(dialog) {
            const rows = selectedRows(dialog);
            return rows.length === 1 && organizationRow(rows[0]);
        }

        async function setMemberMode(state) {
            const readMode = () => state.object.querySelector('.ai-billing-log-entity-select .ud__select__selector__selectItem')?.textContent.trim();
            if (readMode() === '成员') return true;
            const trigger = state.object.querySelector('.ai-billing-log-entity-select .ud__select__selector');
            if (!trigger) return false;
            trigger.click();
            const option = await waitFor(state, () => [...document.querySelectorAll('.ud__select__dropdown .ud__select__list__item')]
                .find(element => visible(element) && element.textContent.trim() === '成员'));
            if (!option) return false;
            option.click();
            return Boolean(await waitFor(state, () => readMode() === '成员'));
        }

        function displayedMemberPicker(object) {
            return [...object.querySelectorAll('.admin__entity-picker-select')].find(visible);
        }

        function displayedOrganization(object) {
            const picker = displayedMemberPicker(object);
            return picker && [...picker.querySelectorAll('.ud__tag')].some(tag => visible(tag) && tag.textContent.trim() === organization);
        }

        async function setOrganization(state) {
            if (!await setMemberMode(state) || !active(state)) return false;
            const picker = await waitFor(state, () => displayedMemberPicker(state.object));
            const opener = picker?.querySelector('button[class*="edit-icon_"]');
            if (!opener) return false;
            const previous = new Set(document.querySelectorAll(modalSelector));
            opener.click();
            const dialog = await waitFor(state, () => [...document.querySelectorAll(modalSelector)].find(el =>
                !previous.has(el) && visible(el) && [...el.querySelectorAll('[class*="modal__title"]')]
                    .some(title => title.textContent.trim() === '请选择')));
            if (!dialog) return false;
            state.dialog = dialog;
            const portal = dialog.closest('.ud__dialog__root');
            if (portal?.querySelectorAll('[role="dialog"]').length === 1) {
                if (!style.isConnected) document.head.append(style);
                portal.setAttribute(autoPickerAttribute, '');
                state.portal = portal;
            }
            if (!onlyOrganization(dialog)) {
                let checkbox = await waitFor(state, () => organizationCheckbox(dialog));
                if (!checkbox) return false;
                if (selectedRows(dialog).length) {
                    const clear = enabledButton(dialog, '清空');
                    if (!clear) return false;
                    clear.click();
                    checkbox = await waitFor(state, () => !selectedRows(dialog).length && organizationCheckbox(dialog));
                    if (!checkbox) return false;
                }
                if (!checkbox.checked) checkbox.click();
                if (!await waitFor(state, () => onlyOrganization(dialog))) return false;
            }
            const confirm = await waitFor(state, () => enabledButton(dialog, '确定'));
            if (!confirm) return false;
            confirm.click();
            return Boolean(await waitFor(state, () => !visible(dialog) && displayedOrganization(state.object)));
        }

        async function initialize(state) {
            try {
                if (!await setOrganization(state)) return;
                const start = state.form.querySelector('.ud__picker-input-start');
                if (!await chooseDatePreset(start, '近一周', () => active(state))) return;
                const query = await waitFor(state, () => {
                    const end = state.form.querySelector('.ud__picker-input-end');
                    return start.value && end?.value && displayedOrganization(state.object) && enabledButton(state.form, '查询');
                });
                if (query && active(state)) query.click();
            } finally {
                state.done = true;
                if (state.dialog && visible(state.dialog) && active(state)) enabledButton(state.dialog, '取消')?.click();
                state.portal?.removeAttribute(autoPickerAttribute);
            }
        }

        function refresh() {
            frame = 0;
            if (!onLogPage()) {
                visit = null;
                return;
            }
            if (visit || [...document.querySelectorAll(modalSelector)].some(visible)) return;
            const object = document.querySelector('label[title="对象"]')?.closest('.ud__form__item');
            const form = object?.closest('[class*="filterWrap-"]');
            if (!form?.querySelector('.ud__picker-input-start') || !enabledButton(form, '查询')) return;
            visit = { form, object };
            void initialize(visit).catch(error => console.warn('飞书后台助手：用量日志自动查询未完成。', error.message));
        }

        function schedule() {
            if (!frame && (onLogPage() || visit)) frame = requestAnimationFrame(refresh);
        }

        function preserveManualFilters(event) {
            if (event.isTrusted && visit && !visit.done && (visit.form.contains(event.target) || visit.dialog?.contains(event.target))) {
                visit.cancelled = true;
                visit.portal?.removeAttribute(autoPickerAttribute);
            }
        }

        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('pointerdown', preserveManualFilters, true);
        document.addEventListener('keydown', preserveManualFilters, true);
        window.addEventListener('popstate', schedule);
        window.addEventListener('pageshow', event => {
            if (event.persisted && onLogPage()) {
                visit = null;
                schedule();
            }
        });
        schedule();
    }

    function installHitLogDecisionFilter() {
        const filterAttr = 'data-feishu-hitlog-filter';
        const presetsAttr = 'data-feishu-hitlog-presets';
        const sizeAttr = 'data-feishu-hitlog-pagesize';
        const rowAttr = 'data-feishu-hitlog-row';
        const hiddenAttr = 'data-feishu-hitlog-hidden';
        const nativeHiddenAttr = 'data-feishu-hitlog-native-hidden';
        const bigAttr = 'data-feishu-hitlog-big';
        const emptyAttr = 'data-feishu-hitlog-empty';
        const detailAttr = 'data-feishu-hitlog-detail';
        const userDevicesAttr = 'data-feishu-hitlog-user-devices';
        const endpoint = '/suite/admin/cond_access/query_policy_log';
        const deviceSearchEndpoint = '/suite/admin/device/search';
        const pageSizeOptions = [20, 100, 200, 500, 1000, 2000, 5000, 10000];
        const batchSizeOptions = [100, 200, 500];
        const maxPersistOptions = [20, 100, 200, 500, 10000];
        const defaultFetchSettings = {
            batchSize: 500,
            concurrency: 1,
            delayMinMs: 400,
            delayMaxMs: 800,
            backoffMs: 2500,
            maxPersistedSize: 500,
        };
        const viewPageSize = 200;
        const timePresets = [
            { key: '15m', label: '15分钟', ms: 15 * 60 * 1000 },
            { key: '1h', label: '1小时', ms: 60 * 60 * 1000 },
            { key: '1d', label: '1天', ms: 24 * 60 * 60 * 1000 },
            { key: '3d', label: '3天', ms: 3 * 24 * 60 * 60 * 1000 },
            { key: '7d', label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
        ];
        const onStrategyPage = () => location.pathname.replace(/\/$/, '') === '/admin/security/condition-access/strategy';
        const visible = element => Boolean(element?.getClientRects().length) && getComputedStyle(element).visibility === 'visible';
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        function normalizeFetchSettings(raw) {
            const src = raw && typeof raw === 'object' ? raw : {};
            const clampInt = (val, min, max, fallback) => {
                const n = Math.trunc(Number(val));
                return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
            };
            const batchSize = batchSizeOptions.includes(Number(src.batchSize)) ? Number(src.batchSize) : defaultFetchSettings.batchSize;
            const concurrency = clampInt(src.concurrency, 1, 3, defaultFetchSettings.concurrency);
            const delayMinMs = clampInt(src.delayMinMs, 0, 10000, defaultFetchSettings.delayMinMs);
            const delayMaxMs = Math.max(delayMinMs, clampInt(src.delayMaxMs, 0, 10000, defaultFetchSettings.delayMaxMs));
            const backoffMs = clampInt(src.backoffMs, 0, 30000, defaultFetchSettings.backoffMs);
            const maxPersistedSize = maxPersistOptions.includes(Number(src.maxPersistedSize))
                ? Number(src.maxPersistedSize)
                : defaultFetchSettings.maxPersistedSize;
            return { batchSize, concurrency, delayMinMs, delayMaxMs, backoffMs, maxPersistedSize };
        }

        let fetchSettings = normalizeFetchSettings(GM_getValue(hitLogFetchSettingsKey, defaultFetchSettings));
        const savedSize = Number(GM_getValue(hitLogPageSizeKey, 20));
        let desiredPageSize = pageSizeOptions.includes(savedSize)
            ? Math.min(savedSize, fetchSettings.maxPersistedSize)
            : 20;
        if (!pageSizeOptions.includes(desiredPageSize)) desiredPageSize = 20;

        const denyDecision = '拒绝访问';
        let onlyDeny = false;
        const learnedDecisionLabels = new Map();
        const learnedEventLabels = new Map();

        let activeTimePreset = null;
        let lastXhrTemplate = null;
        let override = null;
        let requestSeq = 0;
        let loading = false;
        let batchAbort = null;
        let bigData = null;
        let localPage = 1;
        let lastFilteredLogs = [];
        let afterNativeLoad = null;
        let autoTriggered = false;

        let presetsWrap = null;
        let container = null;
        let trigger = null;
        let valueNode = null;
        let clearBtn = null;
        let menu = null;
        let summaryNode = null;
        let resetBtn = null;
        let optionsList = null;
        let pageSizeWrap = null;
        let pageSizeSelect = null;
        let stopBtn = null;
        let exportBtn = null;
        let settingsBtn = null;
        let settingsPopover = null;
        let settingsFields = null;
        let settingsOpen = false;
        let pageSizeStatus = null;
        let emptyBanner = null;
        let bigWrap = null;
        let bigTableHost = null;
        let pagerInfo = null;
        let appendBtn = null;
        let localPagerGroup = null;
        let localPagerInfo = null;
        let localPrevBtn = null;
        let localNextBtn = null;
        let remotePagerGroup = null;
        let pagerInput = null;
        let pagerButtons = {};
        let detailBackdrop = null;
        let menuOpen = false;
        let frame = 0;
        let lastRenderKey = '';
        let lastBigKey = '';

        const style = document.createElement('style');
        style.textContent = `
            [${rowAttr}] { flex-wrap: wrap !important; gap: 8px 12px !important; align-items: center; }
            [${rowAttr}] > :first-child { margin-right: 0 !important; }
            [${hiddenAttr}], [${nativeHiddenAttr}] { display: none !important; }
            [${presetsAttr}], [${filterAttr}], [${sizeAttr}] {
                position: relative; display: inline-flex; align-items: center; font-size: 14px;
            }
            [${presetsAttr}] {
                gap: 4px; height: 32px; padding: 2px;
                border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 6px;
                background: var(--bg-body, #fff); box-sizing: border-box;
            }
            [${presetsAttr}] button {
                height: 26px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent;
                color: var(--text-caption, #646a73); font-size: 13px; cursor: pointer; white-space: nowrap;
            }
            [${presetsAttr}] button:hover { background: var(--fill-hover, #f2f3f5); color: var(--text-title, #1f2329); }
            [${presetsAttr}] button[aria-pressed="true"] {
                background: var(--ud-token-primary-fill-solid-01, #eaf0ff);
                color: var(--ud-token-primary-text-default, #3370ff); font-weight: 500;
            }
            [${filterAttr}] .feishu-hitlog-deny-btn {
                display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
                border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 6px;
                background: var(--bg-body, #fff); color: var(--text-title, #1f2329);
                font-size: 13px; cursor: pointer; user-select: none; white-space: nowrap;
                transition: border-color .15s, background-color .15s, color .15s;
            }
            [${filterAttr}] .feishu-hitlog-deny-btn:hover {
                border-color: #d83931; color: #d83931;
            }
            [${filterAttr}] .feishu-hitlog-deny-btn[aria-pressed="true"] {
                background: #fff0ef; border-color: #d83931; color: #d83931; font-weight: 500;
            }
            [${filterAttr}] .feishu-hitlog-deny-dot {
                width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: none;
            }
            [${filterAttr}] .feishu-hitlog-deny-btn[aria-pressed="true"] .feishu-hitlog-deny-dot { opacity: 1; }
            [${filterAttr}] .feishu-hitlog-trigger, [${sizeAttr}] .feishu-hitlog-size-box {
                display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 12px;
                border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 6px;
                background: var(--bg-body, #fff); color: var(--text-title, #1f2329);
                box-sizing: border-box; transition: border-color .15s, box-shadow .15s;
            }
            [${filterAttr}] .feishu-hitlog-trigger { min-width: 156px; max-width: 280px; cursor: pointer; user-select: none; }
            [${filterAttr}] .feishu-hitlog-trigger:hover, [${sizeAttr}] .feishu-hitlog-size-box:hover {
                border-color: var(--ud-token-primary-border-default, #3370ff);
            }
            [${filterAttr}][data-open="true"] .feishu-hitlog-trigger,
            [${filterAttr}] .feishu-hitlog-trigger:focus-visible,
            [${sizeAttr}] .feishu-hitlog-size-box:focus-within {
                outline: none; border-color: var(--ud-token-primary-border-default, #3370ff);
                box-shadow: 0 0 0 2px rgba(51, 112, 255, .18);
            }
            [${filterAttr}] .feishu-hitlog-label, [${sizeAttr}] .feishu-hitlog-label { color: var(--text-caption, #646a73); flex: none; }
            [${sizeAttr}] { gap: 8px; flex-wrap: wrap; }
            [${sizeAttr}] select { border: 0; outline: none; background: transparent; color: inherit; font: inherit; cursor: pointer; }
            [${sizeAttr}] .feishu-hitlog-action-btn {
                height: 32px; padding: 0 10px; border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 6px;
                background: var(--bg-body, #fff); color: var(--text-title, #1f2329); font-size: 13px; cursor: pointer;
                white-space: nowrap;
            }
            [${sizeAttr}] .feishu-hitlog-action-btn:hover:not(:disabled) {
                border-color: var(--ud-token-primary-border-default, #3370ff); color: #3370ff;
            }
            [${sizeAttr}] .feishu-hitlog-action-btn:disabled { color: var(--text-disabled, #bbbfc4); cursor: default; }
            [${sizeAttr}] .feishu-hitlog-stop-btn { color: #d83931; border-color: #f5b8b4; }
            [${sizeAttr}] .feishu-hitlog-stop-btn:hover { background: #fff0ef; border-color: #d83931; color: #d83931; }
            [${sizeAttr}] .feishu-hitlog-size-status { font-size: 12px; color: var(--text-caption, #646a73); white-space: nowrap; }
            [${sizeAttr}] .feishu-hitlog-size-status:empty { display: none; }
            [${sizeAttr}] .feishu-hitlog-settings-wrap { position: relative; display: inline-flex; }
            [${sizeAttr}] .feishu-hitlog-settings-popover {
                position: absolute; top: calc(100% + 4px); right: 0; z-index: 1060; width: 300px; padding: 12px 14px;
                border-radius: 8px; background: var(--bg-float, #fff); color: var(--text-title, #1f2329);
                box-shadow: 0 4px 16px rgba(31, 35, 41, .16), 0 0 0 1px var(--line-border-card, #dee0e3);
                font-size: 13px;
            }
            [${sizeAttr}] .feishu-hitlog-settings-title { font-weight: 600; margin-bottom: 10px; font-size: 14px; }
            [${sizeAttr}] .feishu-hitlog-settings-grid {
                display: grid; grid-template-columns: 108px minmax(0, 1fr); align-items: center; gap: 8px 10px;
            }
            [${sizeAttr}] .feishu-hitlog-settings-grid label { color: var(--text-caption, #646a73); font-size: 12px; }
            [${sizeAttr}] .feishu-hitlog-settings-grid select,
            [${sizeAttr}] .feishu-hitlog-settings-grid input {
                width: 100%; height: 28px; padding: 0 8px; box-sizing: border-box;
                border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 5px;
                background: var(--bg-body, #fff); color: inherit; font-size: 13px;
            }
            [${sizeAttr}] .feishu-hitlog-delay-pair { display: flex; align-items: center; gap: 4px; }
            [${sizeAttr}] .feishu-hitlog-delay-pair input { min-width: 0; }
            [${sizeAttr}] .feishu-hitlog-settings-foot {
                display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px;
                border-top: 1px solid var(--line-divider-default, #eff0f1);
            }
            [${sizeAttr}] .feishu-hitlog-settings-foot button {
                height: 28px; padding: 0 10px; border: 1px solid var(--line-border-component, #d0d3d6);
                border-radius: 5px; background: var(--bg-body, #fff); color: var(--text-title, #1f2329);
                font-size: 12px; cursor: pointer;
            }
            [${sizeAttr}] .feishu-hitlog-settings-foot .feishu-hitlog-save-btn {
                background: #3370ff; border-color: #3370ff; color: #fff;
            }
            [${filterAttr}] .feishu-hitlog-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
            [${filterAttr}] .feishu-hitlog-value[data-placeholder="true"] { color: var(--text-placeholder, #8f959e); }
            [${filterAttr}] .feishu-hitlog-clear {
                display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0;
                border: 0; border-radius: 50%; background: var(--fill-tag, #eff0f1); color: var(--text-caption, #646a73);
                font-size: 12px; line-height: 1; cursor: pointer; flex: none;
            }
            [${filterAttr}] .feishu-hitlog-clear:hover { background: var(--fill-hover, #dee0e3); color: var(--text-title, #1f2329); }
            [${filterAttr}] .feishu-hitlog-caret { color: var(--text-caption, #8f959e); font-size: 11px; flex: none; transition: transform .15s; }
            [${filterAttr}][data-open="true"] .feishu-hitlog-caret { transform: rotate(180deg); }
            [${filterAttr}] .feishu-hitlog-menu {
                position: absolute; top: calc(100% + 4px); left: 0; z-index: 1050; min-width: 100%; width: max-content;
                max-width: 320px; padding: 6px; border-radius: 8px; background: var(--bg-float, #fff);
                box-shadow: 0 4px 16px rgba(31, 35, 41, .14), 0 0 0 1px var(--line-border-card, #dee0e3);
            }
            [${filterAttr}] [hidden], [${sizeAttr}] [hidden], [${emptyAttr}][hidden], [${bigAttr}][hidden], [${bigAttr}] [hidden], [${detailAttr}][hidden] {
                display: none !important;
            }
            [${filterAttr}] .feishu-hitlog-menu-head {
                display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 8px 6px; margin-bottom: 4px;
                border-bottom: 1px solid var(--line-divider-default, #eff0f1); font-size: 12px; color: var(--text-caption, #646a73);
            }
            [${filterAttr}] .feishu-hitlog-reset {
                padding: 2px 6px; border: 0; border-radius: 4px; background: transparent;
                color: var(--ud-token-primary-text-default, #3370ff); font-size: 12px; cursor: pointer;
            }
            [${filterAttr}] .feishu-hitlog-reset:hover:not(:disabled) { background: var(--ud-token-primary-fill-solid-01, #eaf0ff); }
            [${filterAttr}] .feishu-hitlog-reset:disabled { color: var(--text-disabled, #bbbfc4); cursor: default; }
            [${filterAttr}] .feishu-hitlog-options { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; }
            [${filterAttr}] .feishu-hitlog-option {
                display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px;
                cursor: pointer; color: var(--text-title, #1f2329); font-size: 13px;
            }
            [${filterAttr}] .feishu-hitlog-option:hover { background: var(--fill-hover, #f5f6f7); }
            [${filterAttr}] .feishu-hitlog-option input { margin: 0; accent-color: #3370ff; cursor: pointer; }
            [${filterAttr}] .feishu-hitlog-option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            [${filterAttr}] .feishu-hitlog-option-count { font-size: 12px; color: var(--text-caption, #8f959e); flex: none; }
            [${filterAttr}] .feishu-hitlog-no-options { padding: 10px 8px; font-size: 13px; color: var(--text-caption, #8f959e); text-align: center; }
            [${emptyAttr}] {
                display: flex; align-items: center; justify-content: center; gap: 10px; padding: 22px 16px;
                border-bottom: 1px solid var(--line-divider-default, #eff0f1); color: var(--text-caption, #646a73); font-size: 13px;
            }
            [${emptyAttr}] button, [${bigAttr}] .feishu-hitlog-pager button {
                padding: 3px 10px; border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 5px;
                background: var(--bg-body, #fff); color: var(--text-title, #1f2329); font-size: 13px; cursor: pointer;
            }
            [${emptyAttr}] button { color: var(--ud-token-primary-text-default, #3370ff); }
            [${emptyAttr}] button:hover, [${bigAttr}] .feishu-hitlog-pager button:hover:not(:disabled) {
                border-color: var(--ud-token-primary-border-default, #3370ff); color: #3370ff;
            }
            [${bigAttr}] .feishu-hitlog-pager button:disabled { color: var(--text-disabled, #bbbfc4); cursor: default; }
            [${bigAttr}] { display: flex; flex-direction: column; width: 100%; min-height: 0; }
            [${bigAttr}] .feishu-hitlog-table-host {
                overflow: auto; max-height: var(--feishu-hitlog-table-height, calc(100vh - 340px));
                border-bottom: 1px solid var(--line-divider-default, #eff0f1);
            }
            [${bigAttr}] .feishu-hitlog-table-host[data-loading="true"] { opacity: .65; }
            [${bigAttr}] table { width: 100%; min-width: 960px; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
            [${bigAttr}] th {
                text-align: left; font-weight: 500; color: var(--text-caption, #646a73); padding: 12px 16px;
                background: var(--bg-body-overlay, #f5f6f7); position: sticky; top: 0; z-index: 1;
            }
            [${bigAttr}] td {
                padding: 14px 16px; color: var(--text-title, #1f2329); border-bottom: 1px solid var(--line-divider-default, #eff0f1);
                overflow: hidden; text-overflow: ellipsis; word-break: break-all;
            }
            [${bigAttr}] tbody tr:hover td { background: var(--fill-hover, #f5f6f7); }
            [${bigAttr}] .feishu-hitlog-user { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
            [${bigAttr}] .feishu-hitlog-avatar {
                width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; background: #eaf0ff; color: #3370ff;
                font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
            }
            [${bigAttr}] .feishu-hitlog-user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            [${bigAttr}] .feishu-hitlog-link { border: 0; background: none; padding: 0; color: #3370ff; cursor: pointer; font: inherit; }
            [${bigAttr}] .feishu-hitlog-pager {
                display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 14px;
                padding: 12px 0; font-size: 13px; color: var(--text-caption, #646a73); flex: none;
            }
            [${bigAttr}] .feishu-hitlog-pager-group { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
            [${bigAttr}] .feishu-hitlog-pager input {
                width: 56px; height: 28px; padding: 0 6px; text-align: center; box-sizing: border-box;
                border: 1px solid var(--line-border-component, #d0d3d6); border-radius: 5px; font: inherit;
            }
            [${detailAttr}] {
                position: fixed; inset: 0; z-index: 2147482000; display: flex; align-items: center; justify-content: center;
                padding: 20px; background: rgba(31, 35, 41, .45);
            }
            [${detailAttr}] .feishu-hitlog-detail-card {
                width: min(680px, 100%); max-height: 82vh; overflow: auto; border-radius: 10px; background: var(--bg-body, #fff);
                color: var(--text-title, #1f2329); box-shadow: 0 12px 36px rgba(31, 35, 41, .24); padding: 18px 20px;
                font-size: 13px; line-height: 1.6;
            }
            [${detailAttr}] .feishu-hitlog-detail-head {
                display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; margin-bottom: 12px;
                border-bottom: 1px solid var(--line-divider-default, #eff0f1);
            }
            [${detailAttr}] h3 { margin: 0; font-size: 16px; font-weight: 600; }
            [${detailAttr}] .feishu-hitlog-detail-close {
                width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; font-size: 18px; cursor: pointer;
            }
            [${detailAttr}] .feishu-hitlog-detail-grid { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px 12px; margin-bottom: 14px; }
            [${detailAttr}] .feishu-hitlog-detail-key { color: var(--text-caption, #646a73); }
            [${detailAttr}] .feishu-hitlog-detail-val { word-break: break-all; }
            [${detailAttr}] .feishu-hitlog-policy-item { padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; background: #f5f6f7; }
            [${detailAttr}] pre { margin: 8px 0 0; padding: 10px; border-radius: 6px; overflow: auto; max-height: 240px; font-size: 12px; background: #f5f6f7; }
            [${userDevicesAttr}] {
                margin-top: 20px; padding-top: 16px;
                border-top: 1px solid var(--line-divider-default, #eff0f1);
                font-size: 13px; color: var(--text-title, #1f2329);
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-head {
                display: flex; align-items: center; justify-content: space-between; gap: 8px;
                margin-bottom: 12px;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-title {
                display: inline-flex; align-items: center; gap: 8px;
                font-size: 14px; font-weight: 600; color: var(--text-title, #1f2329);
                border-left: 3px solid #3370ff; padding-left: 8px; line-height: 1.3;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-count {
                font-size: 12px; font-weight: 400; color: var(--text-caption, #646a73);
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-more {
                font-size: 12px; color: #3370ff; text-decoration: none;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-more:hover { text-decoration: underline; }
            [${userDevicesAttr}] table {
                width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px;
                border: 1px solid var(--line-divider-default, #eff0f1); border-radius: 6px; overflow: hidden;
            }
            [${userDevicesAttr}] th {
                text-align: left; font-weight: 500; padding: 8px 10px;
                background: var(--bg-body-overlay, #f5f6f7); color: var(--text-caption, #646a73);
                border-bottom: 1px solid var(--line-divider-default, #eff0f1);
            }
            [${userDevicesAttr}] td {
                padding: 8px 10px; border-bottom: 1px solid var(--line-divider-default, #eff0f1);
                word-break: break-all; vertical-align: middle;
            }
            [${userDevicesAttr}] tbody tr:last-child td { border-bottom: 0; }
            [${userDevicesAttr}] .feishu-hitlog-dev-tag {
                display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 12px; line-height: 18px;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-tag[data-tone="ok"] { background: #e8f7ed; color: #1f8b4c; }
            [${userDevicesAttr}] .feishu-hitlog-dev-tag[data-tone="bad"] { background: #fdecec; color: #d83931; }
            [${userDevicesAttr}] .feishu-hitlog-dev-tag[data-tone="muted"] { background: #f0f1f5; color: #646a73; }
            [${userDevicesAttr}] .feishu-hitlog-dev-cur {
                display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px;
                font-size: 11px; line-height: 17px; background: #eaf0ff; color: #3370ff;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-msg {
                padding: 12px; border-radius: 6px; background: var(--bg-body-overlay, #f5f6f7);
                color: var(--text-caption, #646a73); text-align: center;
            }
            [${userDevicesAttr}] .feishu-hitlog-dev-retry {
                margin-left: 8px; padding: 2px 8px; border: 1px solid #d0d3d6; border-radius: 4px;
                background: #fff; color: #3370ff; font-size: 12px; cursor: pointer;
            }
        `;

        function parseContext(log) {
            try {
                const value = JSON.parse(log?.contextParam || '{}');
                return value && typeof value === 'object' ? value : {};
            } catch {
                return {};
            }
        }

        function actionList(log) {
            let actions = Array.isArray(log?.actions) ? log.actions : [];
            if (!actions.length && Array.isArray(log?.enablePolicies)) {
                const executed = log.enablePolicies.find(policy => policy?.isExecuted) ?? log.enablePolicies[0];
                actions = Array.isArray(executed?.decision?.actions) ? executed.decision.actions : [];
            }
            return actions.map(item => (typeof item === 'string' ? item : item?.type ?? JSON.stringify(item)));
        }

        function decisionKey(log) {
            return `${String(log?.effect ?? '').toUpperCase()}|${[...new Set(actionList(log))].sort().join(',')}`;
        }

        function eventKey(log) {
            return String(parseContext(log).FUNC_SCOPE ?? '');
        }

        function decisionLabel(log) {
            const key = decisionKey(log);
            if (learnedDecisionLabels.has(key)) return learnedDecisionLabels.get(key);
            const [effect, actions] = key.split('|');
            if (effect === 'PERMIT') return actions.includes('ACCESS_MFA') ? '允许访问需验证身份' : actions ? `允许访问（${actions}）` : '允许访问';
            if (['DENY', 'BLOCK', 'REJECT'].includes(effect)) return '拒绝访问';
            return effect || '-';
        }

        const terminalLabels = { '1': '桌面端', '2': '网页版', '3': '移动端', '4': '移动端' };

        function clientTypeLabel(log) {
            const raw = parseContext(log).DEVICE_TERMINAL;
            if (raw === undefined || raw === null || raw === '' || String(raw) === '0') return '-';
            return terminalLabels[String(raw)] ?? String(raw);
        }

        function eventLabel(log) {
            const key = eventKey(log);
            if (learnedEventLabels.has(key)) return learnedEventLabels.get(key);
            return key === 'LARK_ADMIN' ? '访问飞书管理后台' : '访问飞书';
        }

        function formatTime(value) {
            let ms = Number(value);
            if (!Number.isFinite(ms) || ms <= 0) return String(value ?? '-');
            if (ms < 1e12) ms *= 1000;
            const date = new Date(ms);
            const pad = number => String(number).padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
                `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        }

        function deviceText(log) {
            const profile = log?.deviceProfile ?? {};
            const value = profile.deviceID || (profile.webDID ? String(profile.webDID) : '') || parseContext(log).DEVICE_ID || '';
            return value && value !== '0' ? value : '-';
        }

        function learnLabels(nativeRows, headers) {
            if (!bigData?.logs?.length || !nativeRows.length) return;
            const column = name => headers.indexOf(name);
            const [eventIndex, decisionIndex, timeIndex] = [column('事件名称'), column('决策'), column('时间')];
            if (decisionIndex < 0 || timeIndex < 0) return;
            nativeRows.forEach((row, index) => {
                const log = bigData.logs[index];
                if (!log || row.cells[timeIndex]?.textContent.trim() !== formatTime(log.evaluateTime)) return;
                const decision = row.cells[decisionIndex]?.textContent.trim();
                if (decision) learnedDecisionLabels.set(decisionKey(log), decision);
                const event = eventIndex >= 0 ? row.cells[eventIndex]?.textContent.trim() : '';
                if (event) learnedEventLabels.set(eventKey(log), event);
            });
        }

        function setStatus(text) {
            if (pageSizeStatus) pageSizeStatus.textContent = text || '';
        }

        function abortableSleep(ms, token) {
            if (!ms || ms <= 0 || token?.cancelled) return Promise.resolve();
            return new Promise(resolve => {
                const timer = window.setTimeout(() => {
                    token?.timers?.delete(timer);
                    resolve();
                }, ms);
                token?.timers?.add(timer);
                token?.resolvers?.add(resolve);
            });
        }

        function randomBatchDelay(cfg) {
            if (!cfg.delayMaxMs) return 0;
            const span = Math.max(0, cfg.delayMaxMs - cfg.delayMinMs);
            return cfg.delayMinMs + (span ? Math.floor(Math.random() * (span + 1)) : 0);
        }

        function isRateLimited(res) {
            if (!res) return false;
            if (res.status === 429) return true;
            const msg = String(res.json?.message || res.json?.msg || '');
            return /429|limit|freq|too many|频繁|限流|过快/i.test(msg);
        }

        function cancelActiveFetch() {
            if (!batchAbort) return;
            batchAbort.cancelled = true;
            for (const timer of batchAbort.timers ?? []) clearTimeout(timer);
            batchAbort.timers?.clear();
            for (const resolve of batchAbort.resolvers ?? []) resolve();
            batchAbort.resolvers?.clear();
            for (const sub of batchAbort.subs) {
                try { sub.abort(); } catch {}
            }
            batchAbort.subs.clear();
            batchAbort = null;
            if (stopBtn) stopBtn.hidden = true;
        }

        function nativePagination() {
            return document.querySelector('.ud__table-pagination');
        }

        function nativeActivePage() {
            const value = Number(nativePagination()?.querySelector('.ud__pagination-item-active')?.textContent.trim());
            return Number.isInteger(value) && value > 0 ? value : 1;
        }

        function clickNativePage(number) {
            const item = [...(nativePagination()?.querySelectorAll('li') ?? [])].find(li => li.textContent.trim() === String(number));
            if (!item) return false;
            (item.querySelector('a, button') ?? item).click();
            return true;
        }

        function readResponse(xhr) {
            try {
                if (xhr.responseType === 'json') return xhr.response;
                return JSON.parse(xhr.responseText);
            } catch {
                return null;
            }
        }

        function sendSubBatch(template, payload, token) {
            return new Promise((resolve, reject) => {
                if (token.cancelled) {
                    reject(new Error('cancelled'));
                    return;
                }
                const NativeXHR = pageWindow.XMLHttpRequest;
                const sub = new NativeXHR();
                sub.__feishuHitLogSub = true;
                token.subs.add(sub);
                sub.open(template.method, template.url, true);
                sub.withCredentials = template.withCredentials;
                for (const [name, value] of template.headers) {
                    try { sub.setRequestHeader(name, value); } catch {}
                }
                const finish = () => token.subs.delete(sub);
                sub.onload = () => {
                    finish();
                    resolve({ status: sub.status, json: readResponse(sub) });
                };
                sub.onerror = () => { finish(); reject(new Error('network')); };
                sub.onabort = () => { finish(); reject(new Error('cancelled')); };
                sub.ontimeout = () => { finish(); reject(new Error('timeout')); };
                sub.send(JSON.stringify(payload));
            });
        }

        async function continueBatchFetch(seq, template, basePayload, logicalPage, targetSize, firstLogs, total, startedAt = performance.now(), scanAll = false) {
            const cfg = { ...fetchSettings };
            const effectiveTarget = scanAll ? Math.max(total, firstLogs.length) : targetSize;
            const batchSize = scanAll ? cfg.batchSize : Math.min(effectiveTarget, cfg.batchSize);
            const batchesPerBlock = Math.max(1, Math.ceil(effectiveTarget / batchSize));
            const firstBackendPage = scanAll ? 1 : (logicalPage - 1) * batchesPerBlock + 1;
            const remainingBudget = scanAll
                ? total
                : Math.min(effectiveTarget, Math.max(0, total - (logicalPage - 1) * effectiveTarget));

            const seenIds = new Set(firstLogs.map(log => log?.logid).filter(Boolean));
            const merged = [...firstLogs];
            let completedBatches = 1;
            let nextBackendPage = firstBackendPage + 1;
            const countDeny = list => list.reduce((acc, item) => acc + (decisionLabel(item) === denyDecision ? 1 : 0), 0);

            bigData = {
                logs: merged,
                total,
                page: logicalPage,
                size: effectiveTarget,
                batchSize,
                nextBackendPage,
                template,
                basePayload,
                scanAll,
                exhausted: firstLogs.length < batchSize || merged.length >= total,
            };

            if (merged.length >= remainingBudget || firstLogs.length < batchSize || batchesPerBlock <= 1) {
                loading = false;
                if (stopBtn) stopBtn.hidden = true;
                if (scanAll) {
                    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
                    setStatus(`扫描完成：共 ${merged.length} 条，命中拒绝访问 ${countDeny(merged)} 条（1 批，${elapsed}s）`);
                } else {
                    setStatus('');
                }
                schedule();
                return;
            }

            const token = { cancelled: false, subs: new Set(), timers: new Set(), resolvers: new Set() };
            batchAbort = token;
            if (stopBtn) stopBtn.hidden = false;
            setStatus(scanAll
                ? `扫描拒绝访问：已拉取 ${merged.length} / ${remainingBudget} 条 · 命中 ${countDeny(merged)} 条…`
                : `已拉取 ${merged.length} / ${remainingBudget} 条…`);

            const nextPages = [];
            for (let offset = 1; offset < batchesPerBlock; offset++) {
                if (offset * batchSize >= remainingBudget) break;
                nextPages.push(firstBackendPage + offset);
            }

            let failed = false;
            let rateLimited = false;
            let reachedEnd = false;
            for (let i = 0; i < nextPages.length && !token.cancelled && !reachedEnd && !failed; i += cfg.concurrency) {
                const delay = randomBatchDelay(cfg);
                if (delay > 0) await abortableSleep(delay, token);
                if (token.cancelled || seq !== requestSeq) break;

                const wave = nextPages.slice(i, i + cfg.concurrency);
                const runWave = () => Promise.all(wave.map(pageNum => {
                    const payload = { ...basePayload, pageSize: batchSize, pageNumber: pageNum };
                    return sendSubBatch(template, payload, token)
                        .then(res => ({ pageNum, res }))
                        .catch(err => ({ pageNum, err }));
                }));

                let results = await runWave();
                if (seq !== requestSeq) return;

                if (!token.cancelled && cfg.backoffMs > 0 && results.some(({ res }) => isRateLimited(res))) {
                    setStatus(`触发限流，退避 ${(cfg.backoffMs / 1000).toFixed(1)}s 后重试…`);
                    await abortableSleep(cfg.backoffMs, token);
                    if (token.cancelled || seq !== requestSeq) break;
                    const retryTargets = results.filter(({ res }) => isRateLimited(res)).map(item => item.pageNum);
                    const retried = await Promise.all(retryTargets.map(pageNum => {
                        const payload = { ...basePayload, pageSize: batchSize, pageNumber: pageNum };
                        return sendSubBatch(template, payload, token)
                            .then(res => ({ pageNum, res }))
                            .catch(err => ({ pageNum, err }));
                    }));
                    if (seq !== requestSeq) return;
                    const byPage = new Map(retried.map(item => [item.pageNum, item]));
                    results = results.map(item => byPage.get(item.pageNum) ?? item);
                }

                results.sort((a, b) => a.pageNum - b.pageNum);
                for (const { pageNum, res, err } of results) {
                    if (err || res?.status !== 200 || res.json?.code !== 0 || !Array.isArray(res.json?.data?.logs)) {
                        if (!token.cancelled) {
                            failed = true;
                            if (isRateLimited(res)) rateLimited = true;
                        }
                        continue;
                    }
                    completedBatches++;
                    nextBackendPage = Math.max(nextBackendPage, pageNum + 1);
                    const chunk = res.json.data.logs;
                    for (const item of chunk) {
                        const id = item?.logid;
                        if (id && seenIds.has(id)) continue;
                        if (id) seenIds.add(id);
                        if (scanAll || merged.length < effectiveTarget) merged.push(item);
                    }
                    if (chunk.length < batchSize) reachedEnd = true;
                }
                bigData = {
                    logs: merged,
                    total,
                    page: logicalPage,
                    size: effectiveTarget,
                    batchSize,
                    nextBackendPage,
                    template,
                    basePayload,
                    scanAll,
                    exhausted: reachedEnd || merged.length >= total,
                };
                lastBigKey = '';
                setStatus(scanAll
                    ? `扫描拒绝访问：已拉取 ${merged.length} / ${remainingBudget} 条 · 命中 ${countDeny(merged)} 条…`
                    : `已拉取 ${merged.length} / ${remainingBudget} 条…`);
                schedule();
            }

            if (seq !== requestSeq) return;
            loading = false;
            if (batchAbort === token) batchAbort = null;
            if (stopBtn) stopBtn.hidden = true;
            const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
            const denyCount = countDeny(merged);
            if (token.cancelled) setStatus(scanAll ? `已停止：已扫描 ${merged.length} 条，命中拒绝访问 ${denyCount} 条` : `已停止，保留 ${merged.length} 条`);
            else if (rateLimited) setStatus(scanAll ? `触发限流已熔断：已扫描 ${merged.length} 条，命中拒绝访问 ${denyCount} 条` : `触发限流已熔断，保留 ${merged.length} 条（建议调大间隔）`);
            else if (failed) setStatus(scanAll ? `部分批次受限：已扫描 ${merged.length} 条，命中拒绝访问 ${denyCount} 条` : `部分批次受限，已保留 ${merged.length} 条`);
            else setStatus(scanAll ? `扫描完成：共 ${merged.length} 条，命中拒绝访问 ${denyCount} 条（${completedBatches} 批，${elapsed}s）` : `已拉取 ${merged.length} 条（${completedBatches} 批，${elapsed}s）`);
            schedule();
        }

        async function appendNextBatch() {
            if (!bigData || loading || bigData.exhausted) return;
            const template = bigData.template ?? lastXhrTemplate;
            const basePayload = bigData.basePayload ?? lastXhrTemplate?.payload;
            if (!template || !basePayload) {
                setStatus('请先切换一次时间或拉取条数再追加');
                return;
            }
            const cfg = { ...fetchSettings };
            const batchSize = bigData.batchSize || cfg.batchSize;
            const pageNum = bigData.nextBackendPage || (Math.ceil(bigData.logs.length / batchSize) + 1);
            const token = { cancelled: false, subs: new Set(), timers: new Set(), resolvers: new Set() };
            batchAbort = token;
            const seq = ++requestSeq;
            loading = true;
            if (stopBtn) stopBtn.hidden = false;
            setStatus(`正在追加 +${batchSize} 条…`);
            schedule();
            try {
                const payload = { ...basePayload, pageSize: batchSize, pageNumber: pageNum };
                let res = await sendSubBatch(template, payload, token);
                if (seq !== requestSeq) return;
                if (!token.cancelled && cfg.backoffMs > 0 && isRateLimited(res)) {
                    setStatus(`触发限流，退避 ${(cfg.backoffMs / 1000).toFixed(1)}s 后重试…`);
                    await abortableSleep(cfg.backoffMs, token);
                    if (!token.cancelled && seq === requestSeq) res = await sendSubBatch(template, payload, token);
                }
                if (seq !== requestSeq) return;
                if (res.status === 200 && res.json?.code === 0 && Array.isArray(res.json.data?.logs)) {
                    const chunk = res.json.data.logs;
                    const seenIds = new Set(bigData.logs.map(item => item?.logid).filter(Boolean));
                    let added = 0;
                    for (const item of chunk) {
                        const id = item?.logid;
                        if (id && seenIds.has(id)) continue;
                        if (id) seenIds.add(id);
                        bigData.logs.push(item);
                        added++;
                    }
                    bigData.nextBackendPage = pageNum + 1;
                    bigData.exhausted = chunk.length < batchSize || bigData.logs.length >= bigData.total;
                    lastBigKey = '';
                    setStatus(added ? `已追加 ${added} 条（共 ${bigData.logs.length} 条）` : '没有更多新记录了');
                } else {
                    setStatus(isRateLimited(res) ? '触发限流，请稍后再试' : `追加失败：${res.json?.message || res.json?.msg || `HTTP ${res.status}`}`);
                }
            } catch {
                if (seq !== requestSeq) return;
                setStatus(token.cancelled ? '已取消追加' : '追加失败，请重试');
            } finally {
                if (seq === requestSeq) {
                    loading = false;
                    if (batchAbort === token) batchAbort = null;
                    if (stopBtn) stopBtn.hidden = true;
                    schedule();
                }
            }
        }

        async function runDirectBigFetch(logicalPage) {
            if (!lastXhrTemplate) return false;
            cancelActiveFetch();
            const seq = ++requestSeq;
            const startedAt = performance.now();
            const scanAll = onlyDeny;
            const size = desiredPageSize;
            const batchSize = scanAll ? fetchSettings.batchSize : Math.min(size, fetchSettings.batchSize);
            const batchesPerBlock = Math.max(1, Math.ceil(size / batchSize));
            const firstBackendPage = scanAll ? 1 : (logicalPage - 1) * batchesPerBlock + 1;
            const payload = { ...lastXhrTemplate.payload, pageSize: batchSize, pageNumber: firstBackendPage };
            if (activeTimePreset) {
                payload.evaluateTimeStart = String(activeTimePreset.startMs);
                payload.evaluateTimeEnd = String(activeTimePreset.endMs);
            }
            const token = { cancelled: false, subs: new Set(), timers: new Set(), resolvers: new Set() };
            batchAbort = token;
            loading = true;
            localPage = 1;
            setStatus(scanAll ? `正在扫描最近${activeTimePreset?.label ?? '7天'}的全部拒绝访问记录…` : `加载中（目标 ${size} 条）…`);
            schedule();
            try {
                const res = await sendSubBatch(lastXhrTemplate, payload, token);
                if (seq !== requestSeq) return true;
                if (batchAbort === token) batchAbort = null;
                if (res.status === 200 && res.json?.code === 0 && Array.isArray(res.json.data?.logs)) {
                    const firstLogs = res.json.data.logs;
                    const total = Number(res.json.data.total) || firstLogs.length;
                    bigData = { logs: firstLogs, total, page: logicalPage, size: scanAll ? total : size, batchSize, nextBackendPage: firstBackendPage + 1, template: lastXhrTemplate, basePayload: payload, scanAll };
                    lastBigKey = '';
                    schedule();
                    void continueBatchFetch(seq, lastXhrTemplate, payload, logicalPage, size, firstLogs, total, startedAt, scanAll);
                } else {
                    loading = false;
                    setStatus(`加载失败：${res.json?.message || res.json?.msg || `HTTP ${res.status}`}`);
                    schedule();
                }
            } catch {
                if (seq !== requestSeq) return true;
                loading = false;
                if (batchAbort === token) batchAbort = null;
                setStatus(token.cancelled ? '已取消加载' : '加载失败，请重试');
                schedule();
            }
            return true;
        }

        function requestThroughPage(logicalPage) {
            cancelActiveFetch();
            override = { pageNumber: logicalPage };
            const target = nativeActivePage() === 1 ? 2 : 1;
            if (clickNativePage(target)) return true;
            override = null;
            return false;
        }

        function triggerBigQuery(logicalPage) {
            if (requestThroughPage(logicalPage)) return true;
            if (lastXhrTemplate) {
                void runDirectBigFetch(logicalPage);
                return true;
            }
            return false;
        }

        function installXhrHook() {
            const proto = pageWindow.XMLHttpRequest?.prototype;
            if (!proto || proto.__feishuHitLogHook) return;
            proto.__feishuHitLogHook = true;
            const open = proto.open;
            const setHeader = proto.setRequestHeader;
            const send = proto.send;
            const headersMap = new WeakMap();

            proto.open = function (method, url) {
                if (!this.__feishuHitLogSub && typeof url === 'string' && url.includes(endpoint)) {
                    this.__feishuHitLog = { method, url };
                    headersMap.set(this, []);
                } else {
                    this.__feishuHitLog = null;
                }
                return open.apply(this, arguments);
            };
            proto.setRequestHeader = function (name, value) {
                const list = headersMap.get(this);
                if (list) list.push([name, value]);
                return setHeader.apply(this, arguments);
            };
            proto.send = function (body) {
                const info = this.__feishuHitLog;
                if (!info || typeof body !== 'string') return send.apply(this, arguments);
                let payload = null;
                try { payload = JSON.parse(body); } catch {}
                if (!payload || !('pageSize' in payload) || !('pageNumber' in payload)) return send.apply(this, arguments);

                const template = {
                    method: info.method,
                    url: info.url,
                    withCredentials: this.withCredentials,
                    headers: [...(headersMap.get(this) ?? [])],
                    payload: JSON.parse(JSON.stringify(payload)),
                };
                lastXhrTemplate = template;

                afterNativeLoad = null;
                cancelActiveFetch();
                const scanAll = onlyDeny;
                const logicalPage = scanAll ? 1 : (override?.pageNumber ?? 1);
                override = null;
                const size = desiredPageSize;
                const batchSize = scanAll ? fetchSettings.batchSize : Math.min(size, fetchSettings.batchSize);
                const batchesPerBlock = Math.max(1, Math.ceil(size / batchSize));
                const firstBackendPage = scanAll ? 1 : (logicalPage - 1) * batchesPerBlock + 1;

                payload.pageSize = batchSize;
                payload.pageNumber = firstBackendPage;
                if (activeTimePreset) {
                    payload.evaluateTimeStart = String(activeTimePreset.startMs);
                    payload.evaluateTimeEnd = String(activeTimePreset.endMs);
                }
                const sentPayload = JSON.parse(JSON.stringify(payload));
                const seq = ++requestSeq;
                const startedAt = performance.now();
                loading = true;
                localPage = 1;
                setStatus(scanAll ? `正在扫描最近${activeTimePreset?.label ?? '7天'}的全部拒绝访问记录…` : (size > batchSize ? `加载中 0 / ${size} 条…` : `加载中（${size} 条）…`));
                schedule();

                this.addEventListener('loadend', () => {
                    if (seq !== requestSeq) return;
                    const json = readResponse(this);
                    if (this.status === 200 && json?.code === 0 && Array.isArray(json.data?.logs)) {
                        const firstLogs = json.data.logs;
                        const total = Number(json.data.total) || firstLogs.length;
                        bigData = { logs: firstLogs, total, page: logicalPage, size: scanAll ? total : size, batchSize, nextBackendPage: firstBackendPage + 1, template, basePayload: sentPayload, scanAll };
                        lastBigKey = '';
                        schedule();
                        void continueBatchFetch(seq, template, sentPayload, logicalPage, size, firstLogs, total, startedAt, scanAll);
                    } else {
                        loading = false;
                        setStatus(`加载失败：${json?.message || json?.msg || `HTTP ${this.status}`}`);
                        schedule();
                    }
                }, { once: true });
                return send.call(this, JSON.stringify(payload));
            };
        }

        function setMenuOpen(open) {
            menuOpen = open;
        }

        function clearSelection() {
            if (!onlyDeny) return;
            onlyDeny = false;
            cancelActiveFetch();
            localPage = 1;
            lastRenderKey = '';
            lastBigKey = '';
            setStatus('');
            refresh();
        }

        function toggleOnlyDeny() {
            onlyDeny = !onlyDeny;
            localPage = 1;
            lastRenderKey = '';
            lastBigKey = '';
            if (!onlyDeny) {
                cancelActiveFetch();
                setStatus('');
                refresh();
                return;
            }
            const now = Date.now();
            const targetPreset = (activeTimePreset && timePresets.find(p => p.key === activeTimePreset.key))
                ?? timePresets.find(p => p.key === '7d');
            if (targetPreset) {
                activeTimePreset = { key: targetPreset.key, label: targetPreset.label, startMs: now - targetPreset.ms, endMs: now };
                updatePresetButtons();
            }
            if (!triggerBigQuery(1)) {
                setStatus('请先点一次页面时间或翻页以初始化请求');
                refresh();
            }
        }

        function updatePresetButtons() {
            if (!presetsWrap) return;
            for (const button of presetsWrap.querySelectorAll('button')) {
                const active = activeTimePreset?.key === button.dataset.presetKey;
                button.setAttribute('aria-pressed', String(active));
                button.title = active
                    ? `${formatTime(activeTimePreset.startMs)} ~ ${formatTime(activeTimePreset.endMs)}（再次点击刷新）`
                    : `快捷筛选最近${button.textContent}`;
            }
        }

        function applyTimePreset(preset) {
            const now = Date.now();
            activeTimePreset = { key: preset.key, label: preset.label, startMs: now - preset.ms, endMs: now };
            updatePresetButtons();
            localPage = 1;
            if (!triggerBigQuery(1)) {
                setStatus('请先点一次页面时间或翻页以初始化请求');
            }
        }

        function changePageSize(next) {
            if (!pageSizeOptions.includes(next) || next === desiredPageSize) return;
            desiredPageSize = next;
            if (next <= fetchSettings.maxPersistedSize) {
                GM_setValue(hitLogPageSizeKey, next);
            }
            cancelActiveFetch();
            bigData = null;
            localPage = 1;
            lastBigKey = '';
            if (!triggerBigQuery(1)) setStatus('当前结果不超过 20 条');
            schedule();
        }

        function exportFilteredCsv() {
            const rowsToExport = [];
            if (bigData) {
                for (const log of lastFilteredLogs) {
                    const ctx = parseContext(log);
                    const policies = [
                        ...(log?.enablePolicies ?? []).map(p => p?.policyName || p?.policyID || ''),
                        ...(log?.repOnlyPolicies ?? []).map(p => `[上报]${p?.policyName || p?.policyID || ''}`),
                    ].filter(Boolean).join('; ');
                    rowsToExport.push([
                        log?.userProfile?.name || '-',
                        eventLabel(log),
                        decisionLabel(log),
                        formatTime(log?.evaluateTime),
                        ctx.SOURCE_IP || '-',
                        clientTypeLabel(log),
                        deviceText(log),
                        policies,
                        log?.logid || '',
                    ]);
                }
            } else {
                const nativeRows = [...document.querySelectorAll('.ud__table-container .ud__table-body tbody tr:not(.ud__table-measure-row)')]
                    .filter(row => !row.hasAttribute(hiddenAttr) && row.cells.length >= 6);
                for (const row of nativeRows) {
                    rowsToExport.push([
                        row.cells[0]?.textContent.trim() || '-',
                        row.cells[1]?.textContent.trim() || '-',
                        row.cells[2]?.textContent.trim() || '-',
                        row.cells[3]?.textContent.trim() || '-',
                        row.cells[4]?.textContent.trim() || '-',
                        '-',
                        row.cells[5]?.textContent.trim() || '-',
                        '',
                        '',
                    ]);
                }
            }
            if (!rowsToExport.length) {
                setStatus('当前没有可导出的记录');
                window.setTimeout(() => setStatus(''), 2000);
                return;
            }
            const escapeCell = value => {
                const str = String(value ?? '');
                return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
            };
            const header = ['用户', '事件名称', '决策', '时间', 'IP地址', '客户端类型', '设备', '命中策略', '日志ID'];
            const csv = '\uFEFF' + [header, ...rowsToExport].map(line => line.map(escapeCell).join(',')).join('\r\n') + '\r\n';
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `feishu-hit-log-${stamp}.csv`;
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            setStatus(`已导出 ${rowsToExport.length} 条`);
            window.setTimeout(() => { if (!loading) setStatus(''); }, 2500);
        }

        function ensureControls() {
            if (container) return;

            presetsWrap = document.createElement('div');
            presetsWrap.setAttribute(presetsAttr, '');
            presetsWrap.setAttribute('role', 'group');
            presetsWrap.setAttribute('aria-label', '时间范围快捷选项');
            for (const preset of timePresets) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.dataset.presetKey = preset.key;
                btn.textContent = preset.label;
                btn.setAttribute('aria-pressed', 'false');
                btn.addEventListener('click', () => applyTimePreset(preset));
                presetsWrap.append(btn);
            }

            container = document.createElement('div');
            container.setAttribute(filterAttr, '');
            trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'feishu-hitlog-deny-btn';
            trigger.setAttribute('aria-pressed', 'false');
            trigger.title = '开启后默认拉取最近 7 天全部记录并筛选「拒绝访问」（若已选快捷时间则按所选时间拉取）';
            const dot = document.createElement('span');
            dot.className = 'feishu-hitlog-deny-dot';
            dot.setAttribute('aria-hidden', 'true');
            valueNode = document.createElement('span');
            valueNode.textContent = '仅看拒绝访问';
            trigger.append(dot, valueNode);
            trigger.addEventListener('click', toggleOnlyDeny);
            container.append(trigger);

            pageSizeWrap = document.createElement('div');
            pageSizeWrap.setAttribute(sizeAttr, '');
            const box = document.createElement('label');
            box.className = 'feishu-hitlog-size-box';
            const sizeLabel = document.createElement('span');
            sizeLabel.className = 'feishu-hitlog-label';
            sizeLabel.textContent = '拉取';
            pageSizeSelect = document.createElement('select');
            pageSizeSelect.setAttribute('aria-label', '单次拉取条数');
            for (const size of pageSizeOptions) pageSizeSelect.add(new Option(`${size} 条`, String(size)));
            pageSizeSelect.value = String(desiredPageSize);
            box.append(sizeLabel, pageSizeSelect);

            stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'feishu-hitlog-action-btn feishu-hitlog-stop-btn';
            stopBtn.textContent = '停止';
            stopBtn.hidden = true;
            stopBtn.addEventListener('click', cancelActiveFetch);

            exportBtn = document.createElement('button');
            exportBtn.type = 'button';
            exportBtn.className = 'feishu-hitlog-action-btn';
            exportBtn.textContent = '导出 CSV';
            exportBtn.addEventListener('click', exportFilteredCsv);

            const settingsWrap = document.createElement('div');
            settingsWrap.className = 'feishu-hitlog-settings-wrap';
            settingsBtn = document.createElement('button');
            settingsBtn.type = 'button';
            settingsBtn.className = 'feishu-hitlog-action-btn';
            settingsBtn.textContent = '⚙ 拉取设置';
            settingsBtn.setAttribute('aria-haspopup', 'dialog');
            settingsBtn.setAttribute('aria-expanded', 'false');

            settingsPopover = document.createElement('div');
            settingsPopover.className = 'feishu-hitlog-settings-popover';
            settingsPopover.hidden = true;
            const sTitle = document.createElement('div');
            sTitle.className = 'feishu-hitlog-settings-title';
            sTitle.textContent = '拉取限速与风控参数';
            const sGrid = document.createElement('div');
            sGrid.className = 'feishu-hitlog-settings-grid';

            const batchSel = document.createElement('select');
            for (const n of batchSizeOptions) batchSel.add(new Option(`${n} 条/批`, String(n)));
            const concSel = document.createElement('select');
            concSel.add(new Option('1（串行，最稳）', '1'));
            concSel.add(new Option('2（低并发）', '2'));
            concSel.add(new Option('3（高并发）', '3'));
            const delayPair = document.createElement('div');
            delayPair.className = 'feishu-hitlog-delay-pair';
            const delayMinInput = document.createElement('input');
            delayMinInput.type = 'number';
            delayMinInput.min = '0';
            delayMinInput.max = '10000';
            delayMinInput.step = '50';
            delayMinInput.title = '批间最小等待毫秒数';
            const delaySep = document.createElement('span');
            delaySep.textContent = '~';
            const delayMaxInput = document.createElement('input');
            delayMaxInput.type = 'number';
            delayMaxInput.min = '0';
            delayMaxInput.max = '10000';
            delayMaxInput.step = '50';
            delayMaxInput.title = '批间最大等待毫秒数';
            delayPair.append(delayMinInput, delaySep, delayMaxInput);

            const backoffInput = document.createElement('input');
            backoffInput.type = 'number';
            backoffInput.min = '0';
            backoffInput.max = '30000';
            backoffInput.step = '500';
            backoffInput.title = '遇到 429/限流时等待毫秒数，0 表示不重试直接停止';

            const persistSel = document.createElement('select');
            for (const n of maxPersistOptions) {
                persistSel.add(new Option(n >= 10000 ? '不限制' : `≤ ${n} 条`, String(n)));
            }

            settingsFields = { batchSel, concSel, delayMinInput, delayMaxInput, backoffInput, persistSel };
            const addSettingRow = (labelText, control) => {
                const lb = document.createElement('label');
                lb.textContent = labelText;
                sGrid.append(lb, control);
            };
            addSettingRow('单批条数', batchSel);
            addSettingRow('并发请求数', concSel);
            addSettingRow('批间间隔 (ms)', delayPair);
            addSettingRow('限流退避 (ms)', backoffInput);
            addSettingRow('默认记住上限', persistSel);

            const sFoot = document.createElement('div');
            sFoot.className = 'feishu-hitlog-settings-foot';
            const sReset = document.createElement('button');
            sReset.type = 'button';
            sReset.textContent = '恢复默认';
            const sSave = document.createElement('button');
            sSave.type = 'button';
            sSave.className = 'feishu-hitlog-save-btn';
            sSave.textContent = '保存';
            sFoot.append(sReset, sSave);
            settingsPopover.append(sTitle, sGrid, sFoot);
            settingsWrap.append(settingsBtn, settingsPopover);

            const syncSettingsForm = () => {
                batchSel.value = String(fetchSettings.batchSize);
                concSel.value = String(fetchSettings.concurrency);
                delayMinInput.value = String(fetchSettings.delayMinMs);
                delayMaxInput.value = String(fetchSettings.delayMaxMs);
                backoffInput.value = String(fetchSettings.backoffMs);
                persistSel.value = String(fetchSettings.maxPersistedSize);
            };
            const setSettingsOpen = open => {
                settingsOpen = open;
                settingsPopover.hidden = !open;
                settingsBtn.setAttribute('aria-expanded', String(open));
                if (open) syncSettingsForm();
            };
            settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsOpen));
            sReset.addEventListener('click', () => {
                fetchSettings = { ...defaultFetchSettings };
                GM_setValue(hitLogFetchSettingsKey, fetchSettings);
                syncSettingsForm();
                setStatus('已恢复默认拉取参数');
            });
            sSave.addEventListener('click', () => {
                fetchSettings = normalizeFetchSettings({
                    batchSize: batchSel.value,
                    concurrency: concSel.value,
                    delayMinMs: delayMinInput.value,
                    delayMaxMs: delayMaxInput.value,
                    backoffMs: backoffInput.value,
                    maxPersistedSize: persistSel.value,
                });
                GM_setValue(hitLogFetchSettingsKey, fetchSettings);
                if (desiredPageSize > fetchSettings.maxPersistedSize) {
                    GM_setValue(hitLogPageSizeKey, fetchSettings.maxPersistedSize);
                }
                setSettingsOpen(false);
                setStatus(`已保存：${fetchSettings.batchSize}/批 · 并发${fetchSettings.concurrency} · 间隔${fetchSettings.delayMinMs}~${fetchSettings.delayMaxMs}ms`);
                schedule();
            });
            settingsWrap._close = () => setSettingsOpen(false);

            pageSizeStatus = document.createElement('span');
            pageSizeStatus.className = 'feishu-hitlog-size-status';
            pageSizeStatus.setAttribute('role', 'status');
            pageSizeWrap.append(box, stopBtn, exportBtn, settingsWrap, pageSizeStatus);

            pageSizeSelect.addEventListener('change', () => changePageSize(Number(pageSizeSelect.value)));
        }

        function ensureEmptyBanner() {
            if (emptyBanner) return emptyBanner;
            emptyBanner = document.createElement('div');
            emptyBanner.setAttribute(emptyAttr, '');
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = '清空筛选';
            button.addEventListener('click', clearSelection);
            emptyBanner.append(document.createElement('span'), button);
            return emptyBanner;
        }

        function pagerButton(text, handler) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.addEventListener('click', handler);
            return button;
        }

        function goToRemotePage(number) {
            if (!bigData || loading) return;
            const pages = Math.max(1, Math.ceil(bigData.total / bigData.size));
            const target = Math.min(Math.max(1, Math.trunc(number) || 1), pages);
            if (target === bigData.page) return;
            if (!triggerBigQuery(target)) setStatus('无法翻页，请刷新页面后重试');
        }

        function goToLocalPage(number) {
            const pages = Math.max(1, Math.ceil(lastFilteredLogs.length / viewPageSize));
            const target = Math.min(Math.max(1, Math.trunc(number) || 1), pages);
            if (target === localPage) return;
            localPage = target;
            lastBigKey = '';
            refresh();
        }

        function ensureBigWrap() {
            if (bigWrap) return bigWrap;
            bigWrap = document.createElement('div');
            bigWrap.setAttribute(bigAttr, '');
            bigTableHost = document.createElement('div');
            bigTableHost.className = 'feishu-hitlog-table-host';

            const pager = document.createElement('div');
            pager.className = 'feishu-hitlog-pager';
            pagerInfo = document.createElement('span');

            localPagerGroup = document.createElement('div');
            localPagerGroup.className = 'feishu-hitlog-pager-group';
            localPagerInfo = document.createElement('span');
            localPrevBtn = pagerButton('上一屏', () => goToLocalPage(localPage - 1));
            localNextBtn = pagerButton('下一屏', () => goToLocalPage(localPage + 1));
            localPagerGroup.append(localPagerInfo, localPrevBtn, localNextBtn);

            remotePagerGroup = document.createElement('div');
            remotePagerGroup.className = 'feishu-hitlog-pager-group';
            pagerInput = document.createElement('input');
            pagerInput.type = 'number';
            pagerInput.min = '1';
            pagerInput.setAttribute('aria-label', '跳转批次页码');
            pagerInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') goToRemotePage(Number(pagerInput.value));
            });
            pagerButtons = {
                first: pagerButton('首页', () => goToRemotePage(1)),
                prev: pagerButton('上一批', () => goToRemotePage(bigData.page - 1)),
                next: pagerButton('下一批', () => goToRemotePage(bigData.page + 1)),
                last: pagerButton('末页', () => goToRemotePage(Infinity)),
                jump: pagerButton('跳转', () => goToRemotePage(Number(pagerInput.value))),
            };
            appendBtn = pagerButton(`+追加 ${fetchSettings.batchSize} 条`, () => void appendNextBatch());
            remotePagerGroup.append(appendBtn, pagerButtons.first, pagerButtons.prev, pagerInput, pagerButtons.next, pagerButtons.last, pagerButtons.jump);

            pager.append(pagerInfo, localPagerGroup, remotePagerGroup);
            bigWrap.append(bigTableHost, pager);
            return bigWrap;
        }

        function syncBigTableHeight() {
            if (!bigWrap || bigWrap.hidden || !bigTableHost) return;
            const top = bigWrap.getBoundingClientRect().top;
            const pagerHeight = bigWrap.querySelector('.feishu-hitlog-pager')?.offsetHeight || 56;
            const available = Math.max(240, Math.floor(window.innerHeight - top - pagerHeight - 24));
            bigTableHost.style.setProperty('--feishu-hitlog-table-height', `${available}px`);
        }

        function renderBigTable(filteredLogs) {
            ensureBigWrap();
            const { logs, total, page, size } = bigData;
            const remotePages = Math.max(1, Math.ceil(total / size));
            const localPages = Math.max(1, Math.ceil(filteredLogs.length / viewPageSize));
            if (localPage > localPages) localPage = localPages;

            const timeTag = activeTimePreset ? ` · 最近${activeTimePreset.label}` : '';
            const filterTag = onlyDeny ? `拒绝访问命中 ${filteredLogs.length} / ` : '';
            pagerInfo.textContent = `${filterTag}已加载 ${logs.length} 条（总计 ${total} 条${timeTag}）${bigData.scanAll ? '' : ` · 第 ${page}/${remotePages} 批`}`;

            localPagerGroup.hidden = localPages <= 1;
            if (localPages > 1) {
                localPagerInfo.textContent = `当前视图 ${localPage}/${localPages} 页（每屏 ${viewPageSize} 条）`;
                localPrevBtn.disabled = localPage <= 1;
                localNextBtn.disabled = localPage >= localPages;
            }

            remotePagerGroup.hidden = remotePages <= 1 && Boolean(bigData.exhausted);
            if (appendBtn) {
                const nextChunk = bigData.batchSize || fetchSettings.batchSize;
                appendBtn.textContent = `+追加 ${nextChunk} 条`;
                appendBtn.hidden = Boolean(bigData.exhausted) || logs.length >= total;
                appendBtn.disabled = loading;
            }
            pagerInput.max = String(remotePages);
            if (document.activeElement !== pagerInput) pagerInput.value = String(page);
            pagerButtons.first.disabled = pagerButtons.prev.disabled = loading || page <= 1;
            pagerButtons.next.disabled = pagerButtons.last.disabled = loading || page >= remotePages;
            pagerButtons.jump.disabled = loading;
            bigTableHost.dataset.loading = String(loading);

            const start = (localPage - 1) * viewPageSize;
            const pageSlice = filteredLogs.slice(start, start + viewPageSize);
            const key = `${page}|${size}|${logs.length}|${filteredLogs.length}|${localPage}|${pageSlice[0]?.logid ?? ''}|${pageSlice[pageSlice.length - 1]?.logid ?? ''}|${learnedDecisionLabels.size}|${learnedEventLabels.size}`;
            if (key === lastBigKey) return;
            lastBigKey = key;

            const columns = [['用户', '135px'], ['事件名称', '165px'], ['决策', '155px'], ['时间', '175px'], ['IP 地址', '145px'], ['客户端类型', '110px'], ['设备', '166px'], ['操作', '66px']];
            const table = document.createElement('table');
            const colgroup = document.createElement('colgroup');
            const headRow = document.createElement('tr');
            for (const [title, width] of columns) {
                const col = document.createElement('col');
                col.style.width = width;
                colgroup.append(col);
                const th = document.createElement('th');
                th.textContent = title;
                headRow.append(th);
            }
            const thead = document.createElement('thead');
            thead.append(headRow);
            const tbody = document.createElement('tbody');
            for (const log of pageSlice) {
                const row = document.createElement('tr');
                const name = log?.userProfile?.name || '-';
                const userCell = document.createElement('td');
                const user = document.createElement('span');
                user.className = 'feishu-hitlog-user';
                const avatarUrl = log?.userProfile?.avatarURL;
                let avatar;
                if (typeof avatarUrl === 'string' && /^https:\/\//i.test(avatarUrl)) {
                    avatar = document.createElement('img');
                    avatar.src = avatarUrl;
                    avatar.alt = '';
                    avatar.loading = 'lazy';
                } else {
                    avatar = document.createElement('span');
                    avatar.textContent = name.slice(0, 1);
                }
                avatar.className = 'feishu-hitlog-avatar';
                const nameNode = document.createElement('span');
                nameNode.className = 'feishu-hitlog-user-name';
                nameNode.textContent = name;
                nameNode.title = name;
                user.append(avatar, nameNode);
                userCell.append(user);
                const cells = [eventLabel(log), decisionLabel(log), formatTime(log?.evaluateTime), parseContext(log).SOURCE_IP || '-', clientTypeLabel(log), deviceText(log)]
                    .map(text => {
                        const cell = document.createElement('td');
                        cell.textContent = text;
                        cell.title = text;
                        return cell;
                    });
                const actionCell = document.createElement('td');
                const detail = document.createElement('button');
                detail.type = 'button';
                detail.className = 'feishu-hitlog-link';
                detail.textContent = '详情';
                detail.addEventListener('click', () => openDetail(log));
                actionCell.append(detail);
                row.append(userCell, ...cells, actionCell);
                tbody.append(row);
            }
            table.append(colgroup, thead, tbody);
            bigTableHost.replaceChildren(table);
            bigTableHost.scrollTop = 0;
            bigTableHost.scrollLeft = 0;
        }

        function closeDetail() {
            if (detailBackdrop) detailBackdrop.hidden = true;
        }

        function readNativeTableProps() {
            try {
                const table = (pageWindow.document ?? document).querySelector('.ud__table');
                if (!table) return null;
                const fiberKey = Object.keys(table).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
                if (!fiberKey) return null;
                let fiber = table[fiberKey];
                for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
                    const props = fiber.memoizedProps;
                    if (Array.isArray(props?.columns) && props.columns.length) return props;
                }
                return null;
            } catch {
                return null;
            }
        }

        function openNativeDetail(log) {
            try {
                const columns = readNativeTableProps()?.columns;
                if (!Array.isArray(columns) || !columns.length) return false;
                const actionColumn = columns.find(col => col?.key === 'action' || col?.title === '操作') ?? columns[columns.length - 1];
                if (typeof actionColumn?.render !== 'function') return false;
                const findClick = node => {
                    if (!node || typeof node !== 'object') return null;
                    if (typeof node.props?.onClick === 'function') return node.props.onClick;
                    const children = node.props?.children;
                    if (Array.isArray(children)) {
                        for (const child of children) {
                            const handler = findClick(child);
                            if (handler) return handler;
                        }
                    } else if (children && typeof children === 'object') {
                        return findClick(children);
                    }
                    return null;
                };
                const handler = findClick(actionColumn.render(undefined, log, 0));
                if (!handler) return false;
                handler({ preventDefault() {}, stopPropagation() {} });
                return true;
            } catch {
                return false;
            }
        }

        const ownershipLabels = { '0': '未知', '1': '企业设备', '2': '个人设备' };
        const credibilityLabels = { '0': '未知', '1': '可信', '2': '不可信' };
        const userDevicesCache = new Map();
        const inflightDeviceQueries = new Map();
        let detailMountSeq = 0;

        function fetchUserDevices(uid, forceRefresh = false) {
            const key = String(uid ?? '').trim();
            if (!key) return Promise.resolve([]);
            const cached = userDevicesCache.get(key);
            if (!forceRefresh && cached && Date.now() - cached.time < 120000) {
                return Promise.resolve(cached.list);
            }
            if (!forceRefresh && inflightDeviceQueries.has(key)) {
                return inflightDeviceQueries.get(key);
            }
            const promise = new Promise((resolve, reject) => {
                const NativeXHR = pageWindow.XMLHttpRequest;
                const xhr = new NativeXHR();
                xhr.__feishuHitLogSub = true;
                xhr.open('POST', deviceSearchEndpoint, true);
                xhr.withCredentials = true;
                let hasCsrf = false;
                let hasContentType = false;
                let hasRequestedWith = false;
                for (const [name, value] of lastXhrTemplate?.headers ?? []) {
                    if (/^x-passport-dpop$/i.test(name)) continue;
                    if (/^x-csrf-token$/i.test(name)) hasCsrf = true;
                    if (/^content-type$/i.test(name)) hasContentType = true;
                    if (/^x-requested-with$/i.test(name)) hasRequestedWith = true;
                    try { xhr.setRequestHeader(name, value); } catch {}
                }
                if (!hasContentType) xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                if (!hasRequestedWith) xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                if (!hasCsrf) {
                    const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1];
                    if (csrf) xhr.setRequestHeader('X-Csrf-Token', decodeURIComponent(csrf));
                }
                xhr.onload = () => {
                    const json = readResponse(xhr);
                    if (xhr.status === 200 && json?.code === 0 && Array.isArray(json.data?.list)) {
                        const list = json.data.list.filter(item =>
                            !item?.lastLoginUser?.uid || String(item.lastLoginUser.uid) === key);
                        userDevicesCache.set(key, { list, time: Date.now() });
                        resolve(list);
                    } else {
                        reject(new Error(json?.message || json?.msg || `HTTP ${xhr.status}`));
                    }
                };
                xhr.onerror = () => reject(new Error('网络请求失败'));
                xhr.ontimeout = () => reject(new Error('请求超时'));
                xhr.send(JSON.stringify({ userIDList: [key], pageSize: 100 }));
            }).finally(() => {
                inflightDeviceQueries.delete(key);
            });
            inflightDeviceQueries.set(key, promise);
            return promise;
        }

        function createUserDevicesSection(log) {
            const uid = log?.userProfile?.uid || parseContext(log).USER_ID || '';
            const currentDid = deviceText(log);
            const section = document.createElement('div');
            section.setAttribute(userDevicesAttr, '');

            const head = document.createElement('div');
            head.className = 'feishu-hitlog-dev-head';
            const title = document.createElement('div');
            title.className = 'feishu-hitlog-dev-title';
            title.textContent = '该用户设备列表（最后登录）';
            const count = document.createElement('span');
            count.className = 'feishu-hitlog-dev-count';
            title.append(count);

            const more = document.createElement('a');
            more.className = 'feishu-hitlog-dev-more';
            more.href = '/admin/security/terminal-security/device_old';
            more.target = '_blank';
            more.rel = 'noopener noreferrer';
            more.textContent = '设备管理 ↗';
            head.append(title, more);

            const body = document.createElement('div');
            section.append(head, body);

            const renderMessage = (text, canRetry = false) => {
                const box = document.createElement('div');
                box.className = 'feishu-hitlog-dev-msg';
                box.textContent = text;
                if (canRetry) {
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'feishu-hitlog-dev-retry';
                    retry.textContent = '重试';
                    retry.addEventListener('click', () => load(true));
                    box.append(retry);
                }
                body.replaceChildren(box);
            };

            const load = (force = false) => {
                if (!uid) {
                    count.textContent = '';
                    renderMessage('当前日志缺少用户 ID，无法查询设备');
                    return;
                }
                count.textContent = '';
                renderMessage('正在查询该用户的最后登录设备…');
                fetchUserDevices(uid, force).then(list => {
                    if (!section.isConnected) return;
                    count.textContent = `（${list.length} 台）`;
                    if (!list.length) {
                        renderMessage('未查到最后登录为该用户的设备');
                        return;
                    }
                    const table = document.createElement('table');
                    const colgroup = document.createElement('colgroup');
                    for (const width of ['42%', '20%', '20%', '18%']) {
                        const col = document.createElement('col');
                        col.style.width = width;
                        colgroup.append(col);
                    }
                    const thead = document.createElement('thead');
                    const hr = document.createElement('tr');
                    for (const label of ['设备名称', '设备归属', '设备状态', '操作']) {
                        const th = document.createElement('th');
                        th.textContent = label;
                        hr.append(th);
                    }
                    thead.append(hr);
                    const tbody = document.createElement('tbody');
                    for (const item of list) {
                        const params = new URLSearchParams();
                        if (uid) params.set('uid', String(uid));
                        if (item?.id) params.set('id', String(item.id));
                        if (item?.did) params.set('did', String(item.did));
                        const detailHref = `/admin/security/terminal-security/device_old#feishu-device-detail&${params.toString()}`;

                        const tr = document.createElement('tr');
                        const tdName = document.createElement('td');
                        const nameLink = document.createElement('a');
                        nameLink.className = 'feishu-hitlog-dev-more';
                        nameLink.href = detailHref;
                        nameLink.target = '_blank';
                        nameLink.rel = 'noopener noreferrer';
                        nameLink.textContent = item?.deviceName || '-';
                        nameLink.title = '在新标签页打开该设备的详情页';
                        tdName.append(nameLink);
                        if (item?.did && String(item.did) === currentDid) {
                            const cur = document.createElement('span');
                            cur.className = 'feishu-hitlog-dev-cur';
                            cur.textContent = '当前';
                            tdName.append(cur);
                        }
                        const tdOwner = document.createElement('td');
                        tdOwner.textContent = ownershipLabels[String(item?.deviceOwnership)] ?? String(item?.deviceOwnership ?? '-');

                        const tdStatus = document.createElement('td');
                        const credCode = String(item?.deviceCredibility ?? '');
                        const tag = document.createElement('span');
                        tag.className = 'feishu-hitlog-dev-tag';
                        tag.dataset.tone = credCode === '1' ? 'ok' : credCode === '2' ? 'bad' : 'muted';
                        tag.textContent = credibilityLabels[credCode] ?? (credCode || '-');
                        tdStatus.append(tag);

                        const tdAction = document.createElement('td');
                        const detailLink = document.createElement('a');
                        detailLink.className = 'feishu-hitlog-dev-more';
                        detailLink.href = detailHref;
                        detailLink.target = '_blank';
                        detailLink.rel = 'noopener noreferrer';
                        detailLink.textContent = '详情 ↗';
                        tdAction.append(detailLink);

                        tr.append(tdName, tdOwner, tdStatus, tdAction);
                        tbody.append(tr);
                    }
                    table.append(colgroup, thead, tbody);
                    body.replaceChildren(table);
                }).catch(error => {
                    if (!section.isConnected) return;
                    renderMessage(`查询设备失败：${error.message}`, true);
                });
            };

            load(false);
            return section;
        }

        function mountDevicesInNativeDrawer(log) {
            const seq = ++detailMountSeq;
            const started = performance.now();
            function locate() {
                if (seq !== detailMountSeq || performance.now() - started > 3000) return;
                const dialog = [...document.querySelectorAll('[role="dialog"], .ud__drawer, .ud__modal')]
                    .find(el => visible(el) && el.textContent.includes('日志详情') && el.textContent.includes('日志基本信息'));
                if (!dialog) {
                    requestAnimationFrame(locate);
                    return;
                }
                const target = dialog.querySelector('.ud__drawer-body, .ud__drawer__body, .ud__modal-body, .ud__modal__body') ??
                    [...dialog.querySelectorAll('div')].find(el => el.textContent.includes('日志基本信息') && getComputedStyle(el).overflowY === 'auto') ??
                    dialog;
                dialog.querySelector(`[${userDevicesAttr}]`)?.remove();
                target.append(createUserDevicesSection(log));
            }
            requestAnimationFrame(locate);
        }

        function openDetail(log) {
            if (openNativeDetail(log)) {
                mountDevicesInNativeDrawer(log);
                return;
            }
            if (!detailBackdrop) {
                detailBackdrop = document.createElement('div');
                detailBackdrop.setAttribute(detailAttr, '');
                detailBackdrop.addEventListener('click', event => {
                    if (event.target === detailBackdrop) closeDetail();
                });
                document.body.append(detailBackdrop);
            }
            const context = parseContext(log);
            const card = document.createElement('div');
            card.className = 'feishu-hitlog-detail-card';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-label', '策略命中日志详情');
            const head = document.createElement('div');
            head.className = 'feishu-hitlog-detail-head';
            const title = document.createElement('h3');
            title.textContent = '策略命中日志详情';
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'feishu-hitlog-detail-close';
            close.setAttribute('aria-label', '关闭');
            close.textContent = '×';
            close.addEventListener('click', closeDetail);
            head.append(title, close);
            const grid = document.createElement('div');
            grid.className = 'feishu-hitlog-detail-grid';
            const fields = [
                ['用户', log?.userProfile?.name || '-'], ['事件名称', eventLabel(log)], ['决策', decisionLabel(log)],
                ['时间', formatTime(log?.evaluateTime)], ['IP 地址', context.SOURCE_IP || '-'], ['设备', deviceText(log)],
                ['设备系统', context.DEVICE_OS || '-'], ['设备归属', context.DEVICE_OWNERSHIP || '-'], ['日志 ID', log?.logid || '-'],
            ];
            for (const [key, value] of fields) {
                const keyNode = document.createElement('div');
                keyNode.className = 'feishu-hitlog-detail-key';
                keyNode.textContent = key;
                const valueNode = document.createElement('div');
                valueNode.className = 'feishu-hitlog-detail-val';
                valueNode.textContent = value;
                grid.append(keyNode, valueNode);
            }
            card.append(head, grid);
            const policies = [
                ...(log?.enablePolicies ?? []).map(policy => ['生效', policy]),
                ...(log?.repOnlyPolicies ?? []).map(policy => ['仅上报', policy]),
            ];
            for (const [mode, policy] of policies) {
                const item = document.createElement('div');
                item.className = 'feishu-hitlog-policy-item';
                const actions = policy?.decision?.actions?.length ? ` · ${policy.decision.actions.join(', ')}` : '';
                item.textContent = `[${mode}] ${policy?.policyName || policy?.policyID || '未命名策略'}（${policy?.isExecuted ? '已执行' : '未执行'} · ${policy?.decision?.effect ?? '-'}${actions}）`;
                card.append(item);
            }
            const raw = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = '原始日志 JSON';
            summary.style.cursor = 'pointer';
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(log, null, 2);
            raw.append(summary, pre);
            card.append(raw);
            detailBackdrop.replaceChildren(card);
            detailBackdrop.hidden = false;
            close.focus();
        }

        function findContext() {
            const timeRange = document.querySelector('.universe-abs__filter__time-range');
            if (!timeRange || !visible(timeRange)) return null;
            let slot = timeRange;
            let filterRow = null;
            while (slot.parentElement && slot.parentElement !== document.body) {
                const parent = slot.parentElement;
                if (getComputedStyle(parent).display.includes('flex') && parent.querySelector('.auc__admin-user-search-container')) {
                    filterRow = parent;
                    break;
                }
                slot = parent;
            }
            if (!filterRow) return null;
            const nativeTable = filterRow.parentElement?.querySelector('.ud__table-container');
            if (!nativeTable) return null;
            const headers = [...nativeTable.querySelectorAll('thead tr:first-child th')].map(th => th.textContent.trim());
            const decisionIndex = headers.indexOf('决策');
            if (decisionIndex < 0) return null;
            const nativeBlock = nativeTable.closest('.ud__loading__container') ?? nativeTable;
            return { filterRow, slot, nativeTable, nativeBlock, headers, decisionIndex };
        }

        function teardown(forget) {
            setMenuOpen(false);
            closeDetail();
            cancelActiveFetch();
            container?.parentElement?.removeAttribute(rowAttr);
            presetsWrap?.remove();
            container?.remove();
            pageSizeWrap?.remove();
            emptyBanner?.remove();
            bigWrap?.remove();
            for (const node of document.querySelectorAll(`[${nativeHiddenAttr}], [${hiddenAttr}]`)) {
                node.removeAttribute(nativeHiddenAttr);
                node.removeAttribute(hiddenAttr);
            }
            lastRenderKey = '';
            lastBigKey = '';
            if (forget) {
                onlyDeny = false;
                activeTimePreset = null;
                bigData = null;
                localPage = 1;
                lastFilteredLogs = [];
                autoTriggered = false;
            }
        }

        function renderMenu(_counts, matched, total) {
            trigger.setAttribute('aria-pressed', String(onlyDeny));
            valueNode.textContent = onlyDeny
                ? `仅看拒绝访问 (${matched}/${total})`
                : '仅看拒绝访问';
        }

        function refresh() {
            frame = 0;
            if (!onStrategyPage()) {
                teardown(true);
                return;
            }
            const context = findContext();
            if (!context) {
                teardown(false);
                return;
            }
            if (!style.isConnected) document.head.append(style);
            ensureControls();
            const { filterRow, slot, nativeTable, nativeBlock, headers, decisionIndex } = context;
            filterRow.setAttribute(rowAttr, '');
            if (slot.nextElementSibling !== presetsWrap) slot.after(presetsWrap);
            if (presetsWrap.nextElementSibling !== container) presetsWrap.after(container);
            if (container.nextElementSibling !== pageSizeWrap) container.after(pageSizeWrap);
            if (pageSizeSelect.value !== String(desiredPageSize)) pageSizeSelect.value = String(desiredPageSize);
            updatePresetButtons();

            const nativeRows = [...(nativeTable.querySelector('.ud__table-body') ?? nativeTable).querySelectorAll('tbody tr')]
                .filter(row => !row.matches('.ud__table-measure-row') && row.cells.length > decisionIndex);

            if (!bigData && !loading && desiredPageSize === 20) {
                const props = readNativeTableProps();
                if (Array.isArray(props?.dataSource) && props.dataSource.length) {
                    bigData = {
                        logs: props.dataSource,
                        total: Number(props.pagination?.total) || props.dataSource.length,
                        page: Number(props.pagination?.current) || 1,
                        size: 20,
                    };
                    lastBigKey = '';
                }
            }

            if (desiredPageSize > 20 && !bigData && !loading && !autoTriggered && nativeRows.length) {
                autoTriggered = true;
                triggerBigQuery(1);
            }

            const counts = new Map();
            const filtering = onlyDeny;
            let matched = 0;
            let totalLoaded = 0;

            if (bigData) {
                learnLabels(nativeRows, headers);
                nativeBlock.setAttribute(nativeHiddenAttr, '');
                ensureBigWrap();
                if (nativeBlock.nextElementSibling !== bigWrap) nativeBlock.after(bigWrap);
                bigWrap.hidden = false;

                const filtered = [];
                for (const log of bigData.logs) {
                    const label = decisionLabel(log);
                    if (!filtering || label === denyDecision) filtered.push(log);
                }
                lastFilteredLogs = filtered;
                matched = filtered.length;
                totalLoaded = bigData.logs.length;

                renderBigTable(filtered);
                syncBigTableHeight();

                if (filtering && !matched && totalLoaded > 0) {
                    const banner = ensureEmptyBanner();
                    banner.firstElementChild.textContent = loading
                        ? `正在扫描中（已拉取 ${totalLoaded} 条），暂未发现「拒绝访问」记录…`
                        : `已扫描 ${totalLoaded} 条记录，未发现「拒绝访问」日志`;
                    if (banner.previousElementSibling !== bigTableHost) bigTableHost.after(banner);
                    banner.hidden = false;
                } else if (emptyBanner) {
                    emptyBanner.hidden = true;
                }
            } else {
                nativeBlock.removeAttribute(nativeHiddenAttr);
                if (bigWrap) bigWrap.hidden = true;
                lastFilteredLogs = [];
                totalLoaded = nativeRows.length;
                for (const row of nativeRows) {
                    const decision = row.cells[decisionIndex]?.textContent.trim() ?? '';
                    const show = !filtering || decision === denyDecision;
                    if (show) matched++;
                    if (row.hasAttribute(hiddenAttr) === show) row.toggleAttribute(hiddenAttr, !show);
                }
                if (filtering && !matched && totalLoaded > 0) {
                    const banner = ensureEmptyBanner();
                    banner.firstElementChild.textContent = `当前页 ${totalLoaded} 条记录中未发现「拒绝访问」日志`;
                    if (banner.previousElementSibling !== nativeBlock) nativeBlock.after(banner);
                    banner.hidden = false;
                } else if (emptyBanner) {
                    emptyBanner.hidden = true;
                }
            }

            renderMenu(counts, matched, totalLoaded);
        }

        function schedule() {
            if (!frame && (onStrategyPage() || container?.isConnected)) frame = requestAnimationFrame(refresh);
        }

        installXhrHook();
        new MutationObserver(records => {
            if (records.some(record => {
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                return !target?.closest(`[${presetsAttr}], [${filterAttr}], [${sizeAttr}], [${emptyAttr}], [${bigAttr}], [${detailAttr}], [${userDevicesAttr}]`);
            })) schedule();
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
        document.addEventListener('pointerdown', event => {
            if (menuOpen && !container.contains(event.target)) setMenuOpen(false);
            if (settingsOpen && settingsPopover && !settingsPopover.parentElement?.contains(event.target)) {
                settingsPopover.parentElement?._close?.();
            }
            if (event.isTrusted && activeTimePreset && event.target.closest?.('.universe-abs__filter__time-range')) {
                activeTimePreset = null;
                updatePresetButtons();
            }
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (detailBackdrop && !detailBackdrop.hidden) closeDetail();
            else if (settingsOpen) {
                settingsPopover?.parentElement?._close?.();
                settingsBtn?.focus();
            } else if (menuOpen) {
                setMenuOpen(false);
                trigger.focus();
            }
        });
        GM_addValueChangeListener(hitLogPageSizeKey, (_key, _old, value, remote) => {
            if (remote && pageSizeOptions.includes(Number(value))) changePageSize(Number(value));
        });
        GM_addValueChangeListener(hitLogFetchSettingsKey, (_key, _old, value, remote) => {
            if (!remote) return;
            fetchSettings = normalizeFetchSettings(value);
            schedule();
        });
        window.addEventListener('popstate', schedule);
        window.addEventListener('hashchange', schedule);
        window.addEventListener('resize', syncBigTableHeight);
        schedule();
    }

    function installDeviceOldDeepLink() {
        const hashPrefix = '#feishu-device-detail';
        const onDeviceOldPage = () => location.pathname.replace(/\/$/, '') === '/admin/security/terminal-security/device_old';
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        let runSeq = 0;

        function readDeviceTableProps() {
            try {
                const table = (pageWindow.document ?? document).querySelector('.ud__table');
                if (!table) return null;
                const fiberKey = Object.keys(table).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
                if (!fiberKey) return null;
                let fiber = table[fiberKey];
                for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
                    const props = fiber.memoizedProps;
                    if (Array.isArray(props?.columns) && props.columns.length) return props;
                }
                return null;
            } catch {
                return null;
            }
        }

        function findDetailClick(node) {
            if (!node || typeof node !== 'object') return null;
            if (typeof node.props?.onClick === 'function') {
                const children = node.props?.children;
                if (children === '详情' || (Array.isArray(children) && children.includes('详情'))) {
                    return node.props.onClick;
                }
            }
            const children = node.props?.children;
            if (Array.isArray(children)) {
                for (const child of children) {
                    const fn = findDetailClick(child);
                    if (fn) return fn;
                }
            } else if (children && typeof children === 'object') {
                return findDetailClick(children);
            }
            return null;
        }

        function queryDeviceRecord(uid, id, did) {
            return new Promise(resolve => {
                if (!uid) {
                    resolve(null);
                    return;
                }
                const NativeXHR = pageWindow.XMLHttpRequest;
                const xhr = new NativeXHR();
                xhr.open('POST', '/suite/admin/device/search', true);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1];
                if (csrf) xhr.setRequestHeader('X-Csrf-Token', decodeURIComponent(csrf));
                xhr.onload = () => {
                    try {
                        const json = JSON.parse(xhr.responseText);
                        const list = Array.isArray(json?.data?.list) ? json.data.list : [];
                        const match = list.find(item => (id && String(item?.id) === id) || (did && String(item?.did) === did));
                        resolve(match ?? null);
                    } catch {
                        resolve(null);
                    }
                };
                xhr.onerror = () => resolve(null);
                xhr.ontimeout = () => resolve(null);
                xhr.send(JSON.stringify({ userIDList: [uid], pageSize: 100 }));
            });
        }

        async function openTargetDevice() {
            if (!onDeviceOldPage() || !location.hash.startsWith(hashPrefix)) return;
            const params = new URLSearchParams(location.hash.slice(hashPrefix.length).replace(/^&/, ''));
            const uid = params.get('uid') || '';
            const id = params.get('id') || '';
            const did = params.get('did') || '';
            if (!id && !did) return;

            const seq = ++runSeq;
            const deadline = performance.now() + 8000;
            let props = null;
            while (seq === runSeq && onDeviceOldPage() && performance.now() < deadline) {
                props = readDeviceTableProps();
                if (props?.columns?.length && Array.isArray(props.dataSource) && props.dataSource.length) break;
                await new Promise(resolve => window.setTimeout(resolve, 120));
            }
            if (seq !== runSeq || !onDeviceOldPage() || !props?.columns?.length) return;

            const actionColumn = props.columns.find(col => col?.key === 'action' || col?.title === '操作') ?? props.columns[props.columns.length - 1];
            if (typeof actionColumn?.render !== 'function') return;

            let record = (props.dataSource ?? []).find(item => (id && String(item?.id) === id) || (did && String(item?.did) === did));
            if (!record) record = await queryDeviceRecord(uid, id, did);
            if (seq !== runSeq || !onDeviceOldPage() || !record) return;

            const handler = findDetailClick(actionColumn.render(undefined, record, 0));
            if (!handler) return;
            handler({ preventDefault() {}, stopPropagation() {} });
            try {
                history.replaceState(null, '', location.pathname + location.search);
            } catch {}
        }

        window.addEventListener('hashchange', () => void openTargetDevice());
        window.addEventListener('popstate', () => void openTargetDevice());
        void openTargetDevice();
    }

    function installQuotaLookup() {
        const buttons = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
        const dialogs = 'dialog, [role="dialog"], [aria-modal="true"], .ud__modal, .arco-modal, .ant-modal, [data-quota-inline]';
        const selectControls = 'select, button, [role="combobox"], [aria-haspopup="listbox"], .ud__select, input';
        const scrollStyles = ['overflow-x', 'overflow-y', 'padding-right'];
        const geometryStyles = ['top', 'left', 'width'];
        const prefix = 'data-quota-';
        const defaultFeatures = ['豆包工作室', '豆包工作'];
        const compactText = value => (value ?? '').replace(/[\s\u200b-\u200f\ufeff]+/g, '');
        const textOf = element => compactText(element?.textContent);
        const controlName = element => textOf(element) || compactText(element?.getAttribute('aria-label')) || compactText(element?.value);
        const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
        const isQuotaPage = () => /^(\/admin\/aibilling\/quota-manage)\/?$/.test(location.pathname) &&
            [null, 'member'].includes(new URLSearchParams(location.search).get('tab'));
        const unavailable = new WeakSet();
        let opener = null;
        let lookup = null;
        let frame = 0;

        const styles = document.createElement('style');
        styles.textContent = `
            [data-quota-layer] {
                pointer-events: none !important; overflow: visible !important;
                transform: none !important; translate: none !important;
                filter: none !important; contain: none !important; will-change: auto !important;
                background: transparent !important; box-shadow: none !important; backdrop-filter: none !important;
                opacity: 1 !important;
            }
            [data-quota-layer]::before, [data-quota-layer]::after { content: none !important; }
            [data-quota-mask], [data-quota-skip], [data-quota-result]:not([data-quota-result-ready]) { display: none !important; }
            [data-quota-scroll] {
                overflow-x: var(--quota-overflow-x) !important;
                overflow-y: var(--quota-overflow-y) !important;
                padding-right: var(--quota-padding-right) !important;
            }
            [data-quota-inline] {
                position: fixed !important; right: auto !important; bottom: auto !important;
                display: block !important; box-sizing: border-box !important;
                min-width: 0 !important; max-width: none !important; min-height: 0 !important;
                height: auto !important; margin: 0 !important;
                transform: none !important; translate: none !important; pointer-events: none !important;
                padding: 0 !important; background: transparent !important; box-shadow: none !important;
                border: 0 !important; overflow: visible !important;
            }
            [data-quota-inline-wrapper] {
                display: block !important; width: 100% !important;
                margin: 0 !important; padding: 0 !important; flex: initial !important;
                min-width: 0 !important; max-width: 100% !important; overflow: visible !important;
                background: transparent !important;
            }
            [data-quota-caption] {
                position: absolute !important; width: 1px !important; height: 1px !important;
                padding: 0 !important; margin: -1px !important; overflow: hidden !important;
                clip-path: inset(50%) !important; white-space: nowrap !important;
            }
            [data-quota-fields] {
                display: grid !important; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
                align-items: center; gap: 6px !important; padding: 0 !important; margin: 0 !important;
                background: transparent !important;
            }
            [data-quota-field] { min-width: 0 !important; margin: 0 !important; pointer-events: auto !important; }
            [data-quota-field].ud__form__item { display: block !important; }
            [data-quota-field] > .ud__form__item__label { display: none !important; }
            [data-quota-field] > .ud__form__item__control { width: 100% !important; margin: 0 !important; }
            [data-quota-field] :is(div, input, select, [role="combobox"]) {
                min-width: 0 !important; max-width: 100% !important; box-sizing: border-box;
            }
            [data-quota-controls] {
                display: grid !important; grid-template-columns: minmax(0, 1fr) !important;
                align-items: center; gap: 6px !important; padding: 0 !important; margin: 0 !important;
                min-width: 0 !important; background: transparent !important;
            }
            [data-quota-fields][data-quota-controls] {
                grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) !important;
            }
            [data-quota-controls] > [data-quota-result] { grid-column: 1 / -1; }
            [data-quota-field-column] { min-width: 0 !important; margin: 0 !important; }
            [data-quota-query], [data-quota-query-column] { display: none !important; }
            [data-quota-result-ready] {
                margin: 6px 0 0 !important; padding: 10px !important; border-radius: 8px !important;
                max-height: min(45vh, 360px); overflow: auto; pointer-events: auto !important;
                background: var(--bg-body, #fff) !important;
                box-shadow: 0 0 0 1px var(--line-border-card, #dee0e3), 0 4px 16px #1f232923 !important;
            }
        `;

        function branch(ancestor, element) {
            while (element && element.parentElement !== ancestor) element = element.parentElement;
            return element;
        }

        function commonParent(first, second) {
            while (first && !first.contains(second)) first = first.parentElement;
            return first;
        }

        function mark(element, name) {
            if (!element) return;
            const attribute = prefix + name;
            if (element.hasAttribute(attribute)) return;
            element.setAttribute(attribute, '');
            lookup.marks.push([element, attribute]);
        }

        function coveringLayers() {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const stacks = [[4, 4], [width - 5, 4], [4, height - 5], [width - 5, height - 5]]
                .flatMap(([x, y]) => document.elementsFromPoint(x, y));
            // Some portaled masks have generated class names and ignore pointer events.
            const overlays = document.querySelectorAll('div, section, [class*="mask" i], [class*="backdrop" i], [class*="overlay" i]');
            const layers = new Map();
            for (const element of new Set([...stacks, ...overlays])) {
                if (element === document.body || element === document.documentElement) continue;
                const rect = element.getBoundingClientRect();
                if (rect.width < width * .82 || rect.height < height * .82) continue;
                const css = getComputedStyle(element);
                if (css.visibility !== 'visible' || !/^(fixed|absolute)$/.test(css.position)) continue;
                layers.set(element, [css.backgroundColor, css.backgroundImage, css.opacity, css.backdropFilter].join('|'));
            }
            return layers;
        }

        function pageScrollStyles(element) {
            const css = getComputedStyle(element);
            return scrollStyles.map(property => css.getPropertyValue(property));
        }

        function findOpener() {
            const matchesEntry = element => controlName(element) === '验证规则' && !element.closest(dialogs) && visible(element);
            const button = [...document.querySelectorAll(buttons)].find(matchesEntry);
            if (button) return button;
            const labels = [...document.querySelectorAll('div, span')].filter(element =>
                element.childElementCount === 0 && matchesEntry(element));
            const label = labels.find(element =>
                element.closest('[tabindex], [class*="button" i]') || getComputedStyle(element).cursor === 'pointer');
            return label?.closest('[tabindex], [class*="button" i]') ?? label;
        }

        function findDialog() {
            for (const query of document.querySelectorAll(buttons)) {
                if (controlName(query) !== '查询' || !visible(query)) continue;
                const candidates = [];
                for (let parent = query.parentElement; parent && !parent.contains(lookup.trigger); parent = parent.parentElement) {
                    candidates.push(parent);
                }
                const shells = candidates.filter(element => element.matches(dialogs));
                for (const dialog of [...shells, ...candidates.filter(element => !element.matches(dialogs))]) {
                    const content = textOf(dialog);
                    if (!/验证规则|规则验证/.test(content) || !content.includes('AI功能')) continue;
                    if (!dialog.matches(dialogs)) {
                        const css = getComputedStyle(dialog);
                        if (parseFloat(css.borderRadius) <= 0 ||
                            ['transparent', 'rgba(0, 0, 0, 0)'].includes(css.backgroundColor)) continue;
                    }
                    const labels = [...dialog.querySelectorAll('label, div, span, p, strong')];
                    const feature = labels.findLast(element => /^AI功能[:：*＊]*$/.test(textOf(element)));
                    const subject = labels.findLast(element => /^验证对象[:：*＊]*$/.test(textOf(element))) ??
                        dialog.querySelector('input[placeholder*="搜索成员"]');
                    if (feature && subject) return { dialog, query, feature, subject };
                }
            }
            return null;
        }

        function placeInline() {
            if (!lookup?.dialog) return;
            const { dialog, trigger, compact } = lookup;
            if (!compact) return;
            const anchor = trigger.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 16);
            const beside = anchor.left >= width + 16;
            const left = beside ? anchor.left - width - 8 : Math.max(8, anchor.right - width);
            const top = beside ? anchor.top + (anchor.height - 32) / 2 : anchor.bottom + 6;
            for (const [index, value] of [top, left, width].entries()) {
                dialog.style.setProperty(geometryStyles[index], value + 'px', 'important');
            }
        }

        function clearBackdrop(dialog) {
            const backdrop = coveringLayers();
            for (let layer = dialog.parentElement; layer && layer !== document.body && !layer.contains(lookup.trigger);
                layer = layer.parentElement) {
                for (const sibling of layer.children) {
                    if (!sibling.contains(dialog) && /mask|backdrop|overlay/i.test(sibling.getAttribute('class') ?? '') &&
                        !lookup.baseline.has(sibling)) backdrop.set(sibling, 'modal-mask');
                }
                const css = getComputedStyle(layer);
                if (css.position !== 'static' || css.transform !== 'none' || css.overflow !== 'visible' || css.opacity !== '1') {
                    mark(layer, 'layer');
                }
            }
            for (const [element, signature] of backdrop) {
                if (lookup.baseline.get(element) === signature || element.contains(lookup.trigger) || dialog.contains(element)) continue;
                if (element.contains(dialog)) {
                    mark(element, 'layer');
                } else if (!/watermark/i.test(`${element.id} ${element.getAttribute('class') ?? ''}`) &&
                    !textOf(element) && !element.querySelector('button, input, [role="dialog"], canvas, [class*="watermark" i]')) {
                    mark(element, 'mask');
                }
            }
        }

        function openInline(match) {
            const { dialog, feature, subject, query } = match;
            clearBackdrop(dialog);
            for (const [element, before] of lookup.scrollBaseline) {
                if (pageScrollStyles(element).every((value, index) => value === before[index])) continue;
                mark(element, 'scroll');
                scrollStyles.forEach((property, index) => element.style.setProperty('--quota-' + property, before[index]));
            }

            const fields = commonParent(feature.parentElement, subject);
            const featureField = feature.closest('.ud__form__item') ?? branch(fields, feature);
            const subjectField = subject.closest('.ud__form__item') ?? branch(fields, subject);
            const row = commonParent(fields, query);
            const queryColumn = branch(row, query);
            mark(fields, 'fields');
            mark(featureField, 'field');
            mark(subjectField, 'field');
            mark(row, 'controls');
            if (row !== fields) mark(branch(row, fields), 'field-column');
            if (queryColumn && !queryColumn.contains(feature) && !queryColumn.contains(subject)) mark(queryColumn, 'query-column');
            mark(query, 'query');
            mark(feature, 'caption');
            if (!subject.matches('input')) mark(subject, 'caption');
            for (let wrapper = row; wrapper !== dialog; wrapper = wrapper.parentElement) {
                mark(wrapper.parentElement, 'inline-wrapper');
            }
            const protectedNodes = [featureField, subjectField, feature, subject, query].filter(Boolean);
            const chrome = dialog.querySelectorAll('header, h1, h2, h3, [role="heading"], p, div, span, button, [role="button"]');
            for (const element of chrome) {
                if (protectedNodes.some(node => element.contains(node) || node.contains(element))) continue;
                const text = textOf(element);
                if (/^(?:[×✕✖])?(?:验证规则|规则验证)(?:可查询(?:成员|应用)[^×✕✖]{0,40})?[×✕✖]?$/.test(text) ||
                    /^可查询(?:成员|应用)[^。]{1,40}[。]?$/.test(text) || isCloseControl(element)) {
                    mark(element, 'skip');
                }
            }
            mark(dialog, 'inline');
            const geometry = geometryStyles.map(property => [dialog.style.getPropertyValue(property), dialog.style.getPropertyPriority(property)]);
            Object.assign(lookup, match, { featureField, subjectField, queryColumn, protectedNodes, geometry, modal: dialog.getAttribute('aria-modal') });
            if (lookup.modal === 'true') dialog.setAttribute('aria-modal', 'false');
            placeInline();
            resize.observe(dialog);
            // A portal can insert its mask at the end of the opening animation.
            const current = lookup;
            window.setTimeout(() => {
                if (lookup !== current || !current.compact) return;
                clearBackdrop(dialog);
                if (!inlineControlsVisible(current)) {
                    unavailable.add(current.trigger);
                    restorePresentation();
                    lookup = null;
                    closeDialog(dialog);
                    console.warn('飞书后台助手：无法显示行内额度查询，已恢复飞书页面。');
                }
            }, 260);
        }

        function inlineControlsVisible(current) {
            const feature = featureControls()[0] ?? current.featureField;
            const member = current.subjectField?.querySelector('input:not([type="hidden"]), [role="combobox"]') ?? current.subjectField;
            return [feature, member].every(element => {
                if (!element || !visible(element) || element.closest('[inert]') ||
                    element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) return false;
                const box = element.getBoundingClientRect();
                return box.width > 16 && box.height > 12 && box.right > 0 && box.left < window.innerWidth &&
                    box.bottom > 0 && box.top < window.innerHeight;
            });
        }

        function forEachResult(visit) {
            const { dialog, queryColumn, protectedNodes } = lookup;
            const seen = new Set();
            for (let wrapper = queryColumn; wrapper && wrapper !== dialog; wrapper = wrapper.parentElement) {
                for (const result of wrapper.parentElement.children) {
                    if (result === wrapper || seen.has(result) || result.hasAttribute(prefix + 'skip') ||
                        protectedNodes.some(node => result.contains(node) || node.contains(result))) continue;
                    const text = textOf(result);
                    if (result.hasAttribute(prefix + 'result') || /^(验证结果|选择条件[，,]查询)/.test(text) ||
                        /(?:^|[\s_-])(?:result|results)(?:$|[\s_-])/i.test(result.getAttribute('class') ?? '')) {
                        seen.add(result);
                        visit(result);
                    }
                }
            }
        }

        function updateResult() {
            forEachResult(result => {
                mark(result, 'result');
                const text = textOf(result);
                const updated = lookup.resultBefore?.get(result) !== text || lookup.resultsChanged?.has(result);
                const ready = lookup.resultRequested && updated && Boolean(text) && !/^选择条件[，,]查询/.test(text);
                result.toggleAttribute(prefix + 'result-ready', Boolean(ready));
            });
        }

        function isMemberOption(target) {
            const { subjectField, featureField, dialog } = lookup;
            const option = target.closest('[role="option"], [role="treeitem"], [data-option-index], ' +
                '[class*="option-item" i], [class*="select-option" i], [class*="select__option" i], ' +
                '.ud__select__list__item, [class*="member-item" i], [class*="search-result-item" i]');
            if (!option || featureField?.contains(option) || option.closest('[aria-disabled="true"], [disabled]')) return false;
            if (subjectField?.contains(option)) return true;
            if (!subjectField || dialog.contains(option)) return false;
            const menu = option.closest('[role="listbox"], [role="tree"], [class*="dropdown" i], [class*="option-list" i]') ?? option;
            const field = subjectField.getBoundingClientRect();
            const popup = menu.getBoundingClientRect();
            return popup.width > 0 && popup.left < field.right && popup.right > field.left &&
                (Math.abs(popup.top - field.bottom) < 48 || Math.abs(popup.bottom - field.top) < 48);
        }

        function querySelectedMember() {
            const { query } = lookup;
            const ready = !query.matches(':disabled, [aria-disabled="true"], [data-disabled="true"]');
            const becameReady = ready && lookup.memberReady === false;
            lookup.memberReady = ready;
            // Feishu only enables the original query after it accepts the selected member.
            if (!ready || !lookup.memberInteracted || (!becameReady && !lookup.memberPicked)) return;
            lookup.memberInteracted = false;
            lookup.memberPicked = false;
            query.click();
        }

        function restorePresentation() {
            const { dialog, geometry, modal, marks } = lookup;
            resize.disconnect();
            for (const [element, attribute] of marks) {
                element.removeAttribute(attribute);
                if (attribute === prefix + 'result') element.removeAttribute(prefix + 'result-ready');
                if (attribute === prefix + 'scroll') {
                    for (const property of scrollStyles) element.style.removeProperty('--quota-' + property);
                }
            }
            if (dialog) {
                geometry?.forEach(([value, priority], index) => dialog.style.setProperty(geometryStyles[index], value, priority));
                if (modal === 'true') dialog.setAttribute('aria-modal', modal);
            }
            marks.length = 0;
            lookup.compact = false;
        }

        function featureControls() {
            const { feature, subject, dialog } = lookup;
            const follows = Node.DOCUMENT_POSITION_FOLLOWING;
            const candidates = [...dialog.querySelectorAll(selectControls + ', div, span')].filter(element =>
                (feature.compareDocumentPosition(element) & follows) &&
                (element.compareDocumentPosition(subject) & follows) && !element.contains(subject) && visible(element));
            const native = candidates.find(element => element.matches('select'));
            if (native) return [native];
            const placeholder = candidates.findLast(element => /^请选择(?:AI功能)?$/.test(textOf(element)) || defaultFeatures.includes(textOf(element)));
            const trigger = placeholder?.closest('button, [role="combobox"], [aria-haspopup], [aria-expanded], [tabindex], .ud__select__selector, .ud__select, ' +
                '[class*="select-trigger"], [class*="select__trigger"], [class*="select-selector"]');
            const universeSelect = candidates.find(element => element.matches('.ud__select__selector'));
            return [...new Set([universeSelect, trigger, placeholder, candidates.findLast(element => element.matches(selectControls)),
                placeholder?.parentElement].filter(element => candidates.includes(element)))];
        }

        function visibleOptions() {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const matches = [];
            while (walker.nextNode()) {
                const name = compactText(walker.currentNode.nodeValue);
                if (!defaultFeatures.includes(name)) continue;
                const element = walker.currentNode.parentElement;
                const rect = element.getBoundingClientRect();
                if (!visible(element) || rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 ||
                    rect.left >= window.innerWidth || element.closest('[aria-hidden="true"], [hidden], [inert]')) continue;
                let wrapper = element;
                while (wrapper && getComputedStyle(wrapper).opacity !== '0') wrapper = wrapper.parentElement;
                if (!wrapper) matches.push({ name, element });
            }
            return matches;
        }

        function activate(element) {
            const rect = element.getBoundingClientRect();
            const point = {
                bubbles: true, cancelable: true, composed: true, detail: 1,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0,
            };
            element.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new MouseEvent('mousedown', { ...point, buttons: 1 }));
            element.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new MouseEvent('mouseup', point));
            element.dispatchEvent(new MouseEvent('click', point));
        }

        function defaultSelection() {
            const current = lookup;
            if (current.userInteracted || current.defaultFinished) return;
            if (current.optionBaseline) {
                const options = visibleOptions().filter(({ element }) => !current.optionBaseline.has(element) &&
                    !element.closest('[aria-disabled="true"], [disabled]'));
                const option = defaultFeatures.map(name => options.find(item => item.name === name)).find(Boolean);
                if (option) {
                    current.defaultFinished = true;
                    activate(option.element.closest('[role="option"], .ud__select__list__item') ?? option.element);
                }
                return;
            }
            const controls = featureControls();
            const [control] = controls;
            if (!control) return;
            if (control instanceof HTMLSelectElement) {
                const options = [...control.options].filter(option => !option.disabled);
                const option = defaultFeatures.map(name => options.find(item => textOf(item) === name)).find(Boolean);
                if (!option) return;
                current.defaultFinished = true;
                if (control.value === option.value) return;
                control.value = option.value;
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
            if (defaultFeatures.includes(textOf(control)) || defaultFeatures.includes(compactText(control.value))) {
                current.defaultFinished = true;
                return;
            }
            current.optionBaseline = new Set(visibleOptions().map(({ element }) => element));
            const attempts = [() => activate(control), ...controls.slice(1, 3).map(element => () => activate(element)), () => {
                control.focus({ preventScroll: true });
                control.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true,
                }));
            }];
            for (const [index, attempt] of attempts.entries()) {
                window.setTimeout(() => {
                    if (lookup !== current || current.defaultFinished || current.userInteracted) return;
                    const itemVisible = visibleOptions().some(({ element }) => !current.optionBaseline.has(element));
                    if (!itemVisible && (index === 0 || !control.closest('[aria-expanded="true"]'))) attempt();
                    schedule();
                }, index * 360);
            }
            window.setTimeout(() => {
                if (lookup !== current || current.defaultFinished || current.userInteracted) return;
                current.defaultFinished = true;
                if (control.closest('[aria-expanded="true"]')) activate(control);
            }, 1800);
        }

        function startLookup(trigger, compact) {
            const scrollBaseline = compact ? [document.documentElement, document.body].map(element => [element, pageScrollStyles(element)]) : [];
            const current = { trigger, compact, baseline: compact ? coveringLayers() : null, scrollBaseline, marks: [] };
            lookup = current;
            window.setTimeout(() => {
                if (lookup !== current || current.dialog) return;
                unavailable.add(trigger);
                const nativeDialog = [...document.querySelectorAll(dialogs)].find(dialog =>
                    !dialog.contains(trigger) && visible(dialog) && /验证规则|规则验证/.test(textOf(dialog)));
                lookup = null;
                if (compact && nativeDialog) closeDialog(nativeDialog);
            }, 2400);
        }

        function isCloseControl(element) {
            const label = element.getAttribute('aria-label') || element.getAttribute('title') || textOf(element);
            return /^(关闭|close|×|✕|✖)$/i.test(label) ||
                /(?:modal|dialog)[\w-]*close(?:$|[\s_-])|(?:^|\s)closeIcon-/i.test(element.getAttribute('class') ?? '');
        }

        function closeDialog(dialog) {
            const header = [...dialog.querySelectorAll('.ud__confirm__body > .ud__row')]
                .find(element => /^(验证规则|规则验证)/.test(textOf(element)));
            const close = [...dialog.querySelectorAll('button, [role="button"], [aria-label], [title], [class*="close" i]')]
                .find(element => isCloseControl(element) && visible(element)) ?? header?.querySelector('button.ud__button--icon');
            if (close) activate(close);
            else dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }

        function update() {
            frame = 0;
            const onQuotaPage = isQuotaPage();
            if (onQuotaPage) {
                if (!styles.isConnected) document.head.append(styles);
                if (!opener?.isConnected || !visible(opener)) opener = findOpener();
            } else {
                opener = null;
            }
            if (lookup && (!onQuotaPage || lookup.trigger !== opener || (lookup.dialog && !visible(lookup.dialog)))) {
                const { dialog } = lookup;
                restorePresentation();
                lookup = null;
                if (dialog && visible(dialog)) closeDialog(dialog);
                schedule();
                return;
            }
            if (!lookup && opener && !unavailable.has(opener) && !opener.matches(':disabled, [aria-disabled="true"]')) {
                startLookup(opener, true);
                activate(opener);
            }
            if (!lookup) return;
            if (!lookup.dialog) {
                const match = findDialog();
                if (!match) return;
                if (lookup.compact) openInline(match);
                else Object.assign(lookup, match);
            }
            if (lookup.compact) {
                updateResult();
                querySelectedMember();
            }
            defaultSelection();
            placeInline();
        }

        function schedule() {
            if (!frame && (lookup || isQuotaPage())) frame = requestAnimationFrame(update);
        }

        const resize = new ResizeObserver(placeInline);
        new MutationObserver(records => {
            if (lookup?.compact && lookup.resultRequested) {
                for (const record of records) {
                    if (record.type === 'attributes') continue;
                    const target = record.target instanceof Element ? record.target : record.target.parentElement;
                    const result = target?.closest('[data-quota-result]');
                    if (result && lookup.dialog.contains(result)) lookup.resultsChanged.add(result);
                }
            }
            if (records.some(record => record.attributeName !== 'style' || record.target !== lookup?.dialog)) schedule();
        }).observe(document.body, {
            subtree: true, childList: true, characterData: true, attributes: true,
            attributeFilter: ['hidden', 'disabled', 'aria-expanded', 'aria-hidden', 'style', 'class'],
        });
        document.addEventListener('click', event => {
            if (lookup?.compact && lookup.query?.contains(event.target)) {
                lookup.resultBefore = new Map();
                lookup.resultsChanged = new Set();
                forEachResult(result => lookup.resultBefore.set(result, textOf(result)));
                lookup.resultRequested = true;
                schedule();
                return;
            }
            if (lookup?.compact && lookup.memberInteracted && event.isTrusted && isMemberOption(event.target)) {
                lookup.memberPicked = true;
                schedule();
            }
            if (!event.isTrusted || !isQuotaPage() || !opener?.contains(event.target)) return;
            if (lookup?.compact && lookup.dialog) {
                event.preventDefault();
                event.stopPropagation();
                restorePresentation();
            } else if (!lookup) {
                startLookup(opener, false);
                schedule();
            }
        }, true);
        function preserveFeatureChoice(event) {
            if (event.isTrusted && lookup?.dialog && (lookup.featureField ?? featureControls()[0])?.contains(event.target)) {
                lookup.userInteracted = true;
            }
        }
        document.addEventListener('pointerdown', preserveFeatureChoice, true);
        document.addEventListener('keydown', preserveFeatureChoice, true);
        document.addEventListener('pointerdown', event => {
            if (event.isTrusted && lookup?.compact && lookup.subjectField?.contains(event.target)) lookup.memberInteracted = true;
        }, true);
        document.addEventListener('input', event => {
            if (!lookup?.compact || !lookup.subjectField?.contains(event.target)) return;
            if (event.isTrusted) {
                lookup.memberInteracted = true;
                lookup.memberPicked = false;
            }
            lookup.resultRequested = false;
            schedule();
        });
        window.addEventListener('popstate', schedule);
        window.addEventListener('scroll', placeInline, { passive: true, capture: true });
        window.addEventListener('resize', placeInline);
        schedule();
    }

    function favoriteAddress(value) {
        if (typeof value !== 'string') return null;
        const address = value.trim();
        if (address.startsWith('/admin')) return adminPath(address);
        if (!/^https?:\/\//i.test(address)) return null;
        try {
            const url = new URL(address);
            if (url.username || url.password) return null;
            return adminPath(url.href) ?? url.href;
        } catch {
            return null;
        }
    }

    function readFavorites() {
        const saved = GM_getValue(storageKey, defaults);
        if (!Array.isArray(saved)) return defaults;
        return normalizeFavorites(saved);
    }

    function normalizeFavorites(saved) {
        const favorites = [];
        const seen = new Set();
        for (const entry of saved) {
            const path = favoriteAddress(entry?.path);
            const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
            if (!path || !name || seen.has(path)) continue;
            seen.add(path);
            favorites.push({ name, path });
        }
        return favorites;
    }

    const host = document.createElement('div');
    host.id = hostId;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
        <style>
            :host { all: initial; }
            * { box-sizing: border-box; }
            [hidden] { display: none !important; }
            .widget {
                --surface: #fff; --subtle: #f5f7fb; --hover: #edf2fb; --line: #dce3ee;
                --text: #202633; --muted: #596477; --accent: #245bdb; --accent-dark: #1749b0;
                --active: #e9f0ff; --link: #1749b0; --off: #79879c;
                position: fixed; left: 0; top: 0; z-index: 2147483000;
                color: var(--text); font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif;
                color-scheme: light;
            }
            @media (prefers-color-scheme: dark) {
                .widget {
                    --surface: #181e2a; --subtle: #222a39; --hover: #2a3549; --line: #364158;
                    --text: #eef2fb; --muted: #b5c0d3; --accent: #3569df; --accent-dark: #2b57bf;
                    --active: #263d6d; --link: #aac6ff; --off: #65748c;
                    color-scheme: dark;
                }
            }
            button, input { font: inherit; }
            button {
                color: inherit; background: var(--surface); border: 1px solid var(--line);
                padding: 6px 10px; border-radius: 7px; cursor: pointer;
            }
            button:hover:not(:disabled), .favorite:hover { background: var(--hover); }
            button:disabled { opacity: .38; cursor: default; }
            :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
            .toggle {
                writing-mode: vertical-rl; padding: 9px 3px; letter-spacing: 2px;
                border-radius: 8px; color: var(--link); font-weight: 650;
                background: var(--subtle); box-shadow: 0 2px 8px #20263316;
                cursor: grab; touch-action: none; user-select: none;
            }
            .toggle.dragging { cursor: grabbing; }
            .panel {
                position: absolute; left: 0; top: 0; width: 416px;
                overflow: auto; overscroll-behavior: contain;
                border: 1px solid var(--line); border-radius: 14px;
                background: var(--surface); box-shadow: 0 12px 36px #0d19352e;
            }
            header, footer, .setting-row, .section-heading {
                display: flex; gap: 8px; align-items: center;
            }
            .panel-head {
                padding: 15px 16px 11px; background: var(--surface);
                border-bottom: 1px solid var(--line);
            }
            header, .setting-row, .section-heading { justify-content: space-between; }
            header { margin-bottom: 12px; }
            footer { flex-wrap: wrap; }
            h2 { margin: 0; font-size: 17px; font-weight: 700; }
            h3 { margin: 0; font-size: 14px; font-weight: 650; }
            .close {
                width: 30px; height: 30px; padding: 0;
                color: var(--muted); border-color: transparent; font-size: 18px;
            }
            .tabs {
                display: flex; gap: 4px; padding: 3px;
                border-radius: 9px; background: var(--subtle);
            }
            .tabs button {
                flex: 1; min-width: 0; padding: 6px 3px; border: 0;
                background: transparent; color: var(--muted); font-size: 13px;
            }
            .tabs button[aria-selected="true"] {
                background: var(--active); color: var(--link); font-weight: 650;
            }
            .panel-body { padding: 15px 16px 16px; }
            ul { list-style: none; margin: 0 0 12px; padding: 0; }
            li + li { margin-top: 6px; }
            .favorite {
                display: flex; justify-content: space-between; gap: 12px;
                color: var(--link); padding: 9px 11px; background: var(--subtle);
                border-radius: 8px; text-decoration: none; overflow-wrap: anywhere;
            }
            .favorite span + span { flex: none; }
            .actions { display: flex; flex-wrap: wrap; gap: 5px; margin: 5px 0 9px; }
            .actions button { padding: 3px 7px; font-size: 12px; }
            .primary { color: #fff; background: var(--accent); border-color: var(--accent); }
            .primary:hover:not(:disabled) { background: var(--accent-dark); }
            form { margin-top: 10px; }
            label { display: block; margin-bottom: 4px; }
            input {
                flex: 1; min-width: 0; padding: 7px 9px; color: inherit;
                background: var(--surface); border: 1px solid var(--line); border-radius: 7px;
            }
            .favorite-form input { width: 100%; margin-bottom: 8px; }
            .empty { color: var(--muted); margin: 0 0 12px; }
            .status {
                color: var(--muted); margin: 12px 0 0; padding-top: 10px;
                border-top: 1px solid var(--line); font-size: 12px; overflow-wrap: anywhere;
            }
            .status:empty { margin: 0; padding: 0; border: 0; }
            .setting-row { margin-bottom: 14px; }
            .setting-row strong { font-weight: 650; }
            .setting-detail, .menu-help, .connection-detail {
                margin: 3px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere;
            }
            .menu-help { margin: 0 0 12px; }
            button.filter-switch {
                display: inline-flex; align-items: center; flex: 0 0 42px;
                height: 24px; padding: 3px; border: 0; border-radius: 20px;
            }
            button.filter-switch, button.filter-switch:hover:not(:disabled) {
                background: var(--switch-track, var(--off));
            }
            button.filter-switch[aria-checked="true"] {
                justify-content: flex-end; --switch-track: var(--accent);
            }
            .filter-switch::before {
                content: ""; width: 18px; height: 18px; border-radius: 50%; background: #fff;
            }
            .backup-section + .backup-section {
                border-top: 1px solid var(--line); padding-top: 14px; margin-top: 16px;
            }
            .section-heading > div { min-width: 0; }
            .sync-now { flex: none; }
            .local-backup footer { margin-top: 8px; }
            .github-settings { margin-top: 11px; }
            .github-settings summary { cursor: pointer; color: var(--link); }
            .github-form input { width: 100%; margin-bottom: 8px; }
            .github-form a { color: var(--link); }
            .github-help { margin: 0 0 8px; color: var(--muted); font-size: 12px; }
            .conflict-actions { margin-top: 10px; }
            @media (max-width: 370px) {
                .panel-head, .panel-body { padding-inline: 11px; }
            }
        </style>
        <div class="widget">
            <button class="toggle" type="button" aria-expanded="false" aria-controls="panel" title="单击打开，拖动可移动">后台助手</button>
            <section class="panel" id="panel" aria-labelledby="title" hidden>
                <div class="panel-head">
                    <header>
                        <h2 id="title">飞书后台助手</h2>
                        <button class="close" type="button" aria-label="关闭面板">×</button>
                    </header>
                    <div class="tabs" role="tablist" aria-label="后台助手功能">
                        <button type="button" role="tab" id="favorites-tab" aria-controls="favorites-view" aria-selected="true">常用入口</button>
                        <button type="button" role="tab" id="menus-tab" aria-controls="menus-view" aria-selected="false" tabindex="-1">侧栏管理</button>
                        <button type="button" role="tab" id="backup-tab" aria-controls="backup-view" aria-selected="false" tabindex="-1">备份与同步</button>
                    </div>
                </div>
                <div class="panel-body">
                    <div id="favorites-view" role="tabpanel" aria-labelledby="favorites-tab">
                        <ul aria-label="常用功能"></ul>
                        <p class="empty" hidden>还没有常用入口。</p>
                        <footer>
                            <button class="add primary" type="button">收藏当前页</button>
                            <button class="add-link" type="button">添加链接</button>
                            <button class="manage" type="button" aria-pressed="false">管理收藏</button>
                        </footer>
                        <form class="favorite-form" hidden>
                            <label for="favorite-name">入口名称</label>
                            <input id="favorite-name" required maxlength="60">
                            <div class="address-field" hidden>
                                <label for="favorite-address">网页地址</label>
                                <input id="favorite-address" type="url" placeholder="https://…" spellcheck="false" autocomplete="off">
                            </div>
                            <footer>
                                <button class="primary" type="submit">保存</button>
                                <button class="cancel" type="button">取消</button>
                            </footer>
                        </form>
                    </div>
                    <div id="menus-view" role="tabpanel" aria-labelledby="menus-tab" hidden>
                        <div class="menu-overview">
                            <div class="setting-row">
                                <div>
                                    <strong id="filter-label">隐藏侧栏菜单</strong>
                                    <p class="setting-detail" id="filter-detail"></p>
                                </div>
                                <button type="button" class="filter-switch" role="switch" aria-checked="true"
                                    aria-labelledby="filter-label" aria-describedby="filter-detail"></button>
                            </div>
                            <button class="edit-menus" type="button">编辑隐藏规则</button>
                        </div>
                        <div class="menu-editing" hidden>
                            <p class="menu-help"></p>
                            <footer>
                                <button class="save-menus primary" type="button">保存</button>
                                <button class="cancel-menus" type="button">取消</button>
                                <button class="reset-menus" type="button">清空勾选</button>
                            </footer>
                        </div>
                    </div>
                    <div id="backup-view" role="tabpanel" aria-labelledby="backup-tab" hidden>
                        <section class="backup-section">
                            <div class="section-heading">
                                <div>
                                    <h3>GitHub 同步</h3>
                                    <p class="connection-detail"></p>
                                </div>
                                <button class="sync-now primary" type="button">立即同步</button>
                            </div>
                            <details class="github-settings">
                                <summary>连接设置</summary>
                                <form class="github-form">
                                    <p class="github-help">
                                        使用私有仓库与仅授权给该仓库的细粒度令牌（Contents 读写）。
                                        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建令牌</a>
                                    </p>
                                    <label for="github-repo">私有仓库</label>
                                    <input id="github-repo" type="text" placeholder="所有者/仓库名" required spellcheck="false" autocomplete="off">
                                    <label for="github-token">GitHub 令牌</label>
                                    <input id="github-token" type="password" spellcheck="false" autocomplete="off">
                                    <button type="submit">保存连接</button>
                                </form>
                            </details>
                            <footer class="conflict-actions" hidden>
                                <button class="use-remote" type="button">使用仓库配置</button>
                                <button class="use-local" type="button">上传本机配置</button>
                            </footer>
                        </section>
                        <section class="backup-section local-backup">
                            <h3>本地备份</h3>
                            <footer>
                                <button class="export-backup" type="button">导出备份</button>
                                <button class="import-backup" type="button">导入备份</button>
                                <input class="backup-file" type="file" accept=".json,application/json" hidden>
                            </footer>
                        </section>
                    </div>
                    <p class="status" role="status"></p>
                </div>
            </section>
        </div>`;
    document.body.append(host);

    const widget = root.querySelector('.widget');
    const toggle = root.querySelector('.toggle');
    const panel = root.querySelector('.panel');
    const list = root.querySelector('ul');
    const empty = root.querySelector('.empty');
    const add = root.querySelector('.add');
    const addLink = root.querySelector('.add-link');
    const manage = root.querySelector('.manage');
    const form = root.querySelector('.favorite-form');
    const input = root.querySelector('#favorite-name');
    const addressField = root.querySelector('.address-field');
    const addressInput = root.querySelector('#favorite-address');
    const status = root.querySelector('.status');
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const backupTab = root.querySelector('#backup-tab');
    const editMenus = root.querySelector('.edit-menus');
    const filterSwitch = root.querySelector('.filter-switch');
    const filterDetail = root.querySelector('#filter-detail');
    const resetMenus = root.querySelector('.reset-menus');
    const backupView = root.querySelector('#backup-view');
    const sidebarId = 'admin-aside-outer';
    const menuPathAttribute = 'data-menu-path';
    const menuRow = `[${menuPathAttribute}]`;
    const hiddenAttribute = 'data-feishu-favorites-hidden-menu';
    const checkboxClass = 'feishu-favorites-hide-checkbox';
    let menuChanges = null;
    let sidebar = null;
    let hiddenNodes = new Set();
    const menuCheckboxes = new Map();
    let managing = false;
    let draft = null;
    let formTrigger = null;
    let position = GM_getValue(positionKey, null);
    let drag = null;
    let suppressClick = false;

    function clamp(value, max, min = 0) {
        return Math.max(min, Math.min(value, max));
    }

    function viewport() {
        return {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
        };
    }

    function widgetBounds() {
        const { width, height } = viewport();
        return {
            maxLeft: Math.max(0, width - widget.offsetWidth),
            maxTop: Math.max(0, height - widget.offsetHeight),
            height,
        };
    }

    function placePanel() {
        if (panel.hidden) return;
        const { width, height } = viewport();
        const gap = 8;
        const anchor = toggle.getBoundingClientRect();
        panel.style.maxWidth = `${Math.max(0, width - 2 * gap)}px`;
        panel.style.maxHeight = `${Math.max(0, height - 2 * gap)}px`;
        const panelWidth = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;
        let left = anchor.right + gap;
        let top = anchor.bottom - panelHeight;
        if (left + panelWidth > width - gap) {
            left = anchor.left - gap - panelWidth;
            if (left < gap) {
                left = anchor.left;
                const below = height - anchor.bottom;
                top = below >= anchor.top ? anchor.bottom + gap : anchor.top - gap - panelHeight;
            }
        }
        if (menuChanges && sidebar) {
            const right = sidebar.getBoundingClientRect().right + gap;
            if (right + panelWidth <= width - gap) left = Math.max(left, right);
            else top = height - gap - panelHeight;
        }
        panel.style.left = `${clamp(left, width - gap - panelWidth, gap) - anchor.left}px`;
        panel.style.top = `${clamp(top, height - gap - panelHeight, gap) - anchor.top}px`;
    }

    function moveWidget(left, top, { maxLeft, maxTop } = widgetBounds()) {
        widget.style.left = `${clamp(left, maxLeft)}px`;
        widget.style.top = `${clamp(top, maxTop)}px`;
        placePanel();
    }

    function restorePosition() {
        const bounds = widgetBounds();
        if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
            moveWidget(bounds.maxLeft * position.x, bounds.maxTop * position.y, bounds);
        } else {
            moveWidget(0, bounds.maxTop - (bounds.height <= 480 ? 16 : 88), bounds);
        }
    }

    function finishDrag(event) {
        if (drag?.pointerId !== event.pointerId) return;
        const moved = drag.moved;
        drag = null;
        if (!moved) return;
        toggle.classList.remove('dragging');
        suppressClick = true;
        if (event.type !== 'pointerup') {
            restorePosition();
            return;
        }
        const { maxLeft, maxTop } = widgetBounds();
        position = {
            x: maxLeft ? widget.offsetLeft / maxLeft : (position?.x ?? 0),
            y: maxTop ? widget.offsetTop / maxTop : (position?.y ?? 0),
        };
        GM_setValue(positionKey, position);
    }

    toggle.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick = false;
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: widget.offsetLeft,
            top: widget.offsetTop,
            moved: false,
        };
        toggle.setPointerCapture(event.pointerId);
    });
    toggle.addEventListener('pointermove', event => {
        if (drag?.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved) {
            if (Math.hypot(dx, dy) < 5) return;
            drag.moved = true;
            toggle.classList.add('dragging');
        }
        moveWidget(drag.left + dx, drag.top + dy);
    });
    toggle.addEventListener('pointerup', finishDrag);
    toggle.addEventListener('pointercancel', finishDrag);
    toggle.addEventListener('lostpointercapture', finishDrag);

    restorePosition();
    new ResizeObserver(placePanel).observe(panel);
    window.addEventListener('resize', () => {
        if (!drag?.moved) restorePosition();
    });

    function setOpen(open, restoreFocus = false) {
        if (!open && menuChanges) finishMenuEditing();
        if (!backupView.hidden) resetBackupSettings();
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            render();
            placePanel();
        }
        if (restoreFocus) toggle.focus();
    }

    function showForm(path, name, editing, trigger) {
        draft = { path, editing };
        formTrigger = trigger;
        status.textContent = '';
        input.value = name.slice(0, input.maxLength);
        addressField.hidden = path !== null;
        addressInput.required = path === null;
        addressInput.value = '';
        form.hidden = false;
        input.focus();
        input.select();
    }

    function closeForm() {
        form.hidden = true;
        draft = null;
        if (formTrigger?.isConnected) formTrigger.focus();
        else manage.focus();
        formTrigger = null;
    }

    function saveFavorites(favorites, message) {
        GM_setValue(storageKey, favorites);
        render();
        status.textContent = message;
    }

    function changePosition(path, step) {
        const favorites = readFavorites();
        const index = favorites.findIndex(entry => entry.path === path);
        const target = index + step;
        if (index < 0 || target < 0 || target >= favorites.length) return;
        const [entry] = favorites.splice(index, 1);
        favorites.splice(target, 0, entry);
        saveFavorites(favorites, '顺序已更新');
        const actions = list.children[target].querySelector('.actions');
        const move = actions.children[step < 0 ? 1 : 2];
        (move.disabled ? actions.firstElementChild : move).focus();
    }

    function action(text, label, listener, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-label', label);
        button.disabled = disabled;
        button.addEventListener('click', listener);
        return button;
    }

    function render() {
        const favorites = readFavorites();
        const rows = favorites.map(({ name, path }, index) => {
            const row = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'favorite';
            link.href = new URL(path, location.origin).href;
            link.title = link.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.setAttribute('aria-label', `${name}（在新标签页打开）`);
            const label = document.createElement('span');
            label.textContent = name;
            const icon = document.createElement('span');
            icon.textContent = '↗';
            icon.setAttribute('aria-hidden', 'true');
            link.append(label, icon);
            row.append(link);
            if (managing) {
                const actions = document.createElement('div');
                actions.className = 'actions';
                actions.append(
                    action('改名', `改名 ${name}`, event => showForm(path, name, true, event.currentTarget)),
                    action('上移', `上移 ${name}`, () => changePosition(path, -1), index === 0),
                    action('下移', `下移 ${name}`, () => changePosition(path, 1), index === favorites.length - 1),
                    action('移除', `移除 ${name}`, () => {
                        if (draft?.path === path) closeForm();
                        saveFavorites(readFavorites().filter(entry => entry.path !== path), '已移除入口');
                        manage.focus();
                    }),
                );
                row.append(actions);
            }
            return row;
        });
        list.replaceChildren(...rows);
        empty.hidden = favorites.length > 0;
    }

    // Feishu renders a group heading followed by a container for its child rows.
    function groupWrapper(row) {
        const content = row.nextElementSibling;
        if (row.matches('a[href]') || row.parentElement.firstElementChild !== row ||
            !content || content.matches(menuRow)) return null;
        return content.style.maxHeight || content.querySelector(menuRow) ? row.parentElement : null;
    }

    function hiddenMenuKeys() {
        const saved = GM_getValue(menuKey, []);
        return new Set(Array.isArray(saved) ? saved : []);
    }

    function menuFilteringIsEnabled() {
        return GM_getValue(menuFilterKey, true) !== false;
    }

    function selectedMenus() {
        const selection = hiddenMenuKeys();
        for (const [key, hide] of menuChanges ?? []) {
            if (hide) selection.add(key);
            else selection.delete(key);
        }
        return selection;
    }

    function updateMenuCheckbox(row, key, name, checked) {
        let checkbox = menuCheckboxes.get(row);
        if (checkbox?.parentElement !== row) {
            checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = checkboxClass;
            // Keep checkbox activation separate from Feishu's link and expand handlers.
            checkbox.addEventListener('click', event => event.stopPropagation());
            checkbox.addEventListener('change', () => {
                if (!menuChanges) return;
                menuChanges.set(checkbox.dataset.menuKey, checkbox.checked);
                resetMenus.disabled = selectedMenus().size === 0;
            });
            row.append(checkbox);
            menuCheckboxes.set(row, checkbox);
        }
        checkbox.dataset.menuKey = key;
        checkbox.checked = checked;
        checkbox.setAttribute('aria-label', `隐藏 ${name}`);
        checkbox.title = `隐藏 ${name}`;
    }

    function refreshSidebar() {
        sidebar = document.getElementById(sidebarId);
        const rows = sidebar?.querySelectorAll(menuRow) ?? [];
        const selection = selectedMenus();
        const filtering = menuFilteringIsEnabled();
        const groupKeys = new Map();
        const activeRows = new Set();
        const nextHidden = new Set();

        if (menuChanges || (filtering && selection.size)) {
            for (const row of rows) {
                const group = groupWrapper(row);
                const href = adminPath(row.getAttribute('href'));
                const path = row.getAttribute(menuPathAttribute).trim();
                const name = row.textContent.trim().replace(/\s+/g, ' ');
                if (!name) continue;
                let parent = row.parentElement;
                while (parent !== sidebar && !groupKeys.has(parent)) {
                    parent = parent.parentElement;
                }
                const identity = path && path !== '/' ? path : name;
                const key = href ? `url:${href}` : JSON.stringify([groupKeys.get(parent) ?? '', identity]);
                if (group) groupKeys.set(group, key);

                if (menuChanges) {
                    activeRows.add(row);
                    updateMenuCheckbox(row, key, name, selection.has(key));
                } else if (selection.has(key)) {
                    nextHidden.add(group ?? row);
                }
            }
        }

        for (const [row, checkbox] of menuCheckboxes) {
            if (activeRows.has(row)) continue;
            checkbox.remove();
            menuCheckboxes.delete(row);
        }
        for (const node of hiddenNodes) {
            if (!nextHidden.has(node)) node.removeAttribute(hiddenAttribute);
        }
        for (const node of nextHidden) node.setAttribute(hiddenAttribute, '');
        hiddenNodes = nextHidden;

        filterSwitch.setAttribute('aria-checked', String(filtering));
        filterDetail.textContent = filtering
            ? `已启用 · ${selection.size} 条隐藏规则`
            : `显示完整侧栏 · 保留 ${selection.size} 条规则`;
        if (menuChanges) {
            const help = rows.length
                ? '在左侧勾选要隐藏的菜单。可以展开分组，单独勾选子菜单。'
                : '请先展开飞书左侧导航，再勾选要隐藏的菜单。';
            const helpText = root.querySelector('.menu-help');
            if (helpText.textContent !== help) helpText.textContent = help;
            resetMenus.disabled = selection.size === 0;
            placePanel();
        }
    }

    function showMenuEditing(editing) {
        root.querySelector('.menu-overview').hidden = editing;
        root.querySelector('.menu-editing').hidden = !editing;
        refreshSidebar();
        placePanel();
    }

    function finishMenuEditing(message = '') {
        menuChanges = null;
        showMenuEditing(false);
        status.textContent = message;
        editMenus.focus();
    }

    const sidebarStyle = document.createElement('style');
    sidebarStyle.textContent = `
        #${sidebarId} [${hiddenAttribute}] { display: none !important; }
        #${sidebarId} .${checkboxClass} {
            display: inline-block; flex: 0 0 15px; inline-size: 15px; block-size: 15px;
            margin: 0 0 0 auto; cursor: pointer; accent-color: #245bdb; align-self: center;
        }
    `;
    document.head.append(sidebarStyle);
    refreshSidebar();

    new MutationObserver(records => {
        if (sidebar !== document.getElementById(sidebarId) ||
            records.some(record => sidebar?.contains(record.target))) refreshSidebar();
    }).observe(document.getElementById('app') ?? document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [menuPathAttribute, 'href'],
    });

    editMenus.addEventListener('click', () => {
        if (draft) closeForm();
        status.textContent = '';
        menuChanges = new Map();
        showMenuEditing(true);
        root.querySelector('.save-menus').focus();
    });
    filterSwitch.addEventListener('click', () => {
        GM_setValue(menuFilterKey, !menuFilteringIsEnabled());
        status.textContent = '';
        refreshSidebar();
    });
    root.querySelector('.cancel-menus').addEventListener('click', () => finishMenuEditing());
    root.querySelector('.save-menus').addEventListener('click', () => {
        GM_setValue(menuKey, [...selectedMenus()]);
        finishMenuEditing('左侧菜单设置已保存');
    });
    resetMenus.addEventListener('click', () => {
        for (const key of selectedMenus()) menuChanges.set(key, false);
        refreshSidebar();
        status.textContent = '已清空勾选，保存后生效。';
    });

    const githubForm = root.querySelector('.github-form');
    const githubSettings = root.querySelector('.github-settings');
    const connectionDetail = root.querySelector('.connection-detail');
    const repoInput = root.querySelector('#github-repo');
    const tokenInput = root.querySelector('#github-token');
    const syncNow = root.querySelector('.sync-now');
    const conflictActions = root.querySelector('.conflict-actions');
    const useRemote = root.querySelector('.use-remote');
    const backupFile = root.querySelector('.backup-file');
    let githubBusy = false;
    let pendingConflict = null;

    function validPosition(value) {
        return [value?.x, value?.y].every(axis => Number.isFinite(axis) && axis >= 0 && axis <= 1);
    }

    function configuration(favorites, hiddenMenus, launcherPosition, filtering = true) {
        const value = {
            format: backupFormat,
            version: 1,
            favorites,
            hiddenMenus: [...new Set(hiddenMenus)].sort(),
            position: launcherPosition === null ? null : { x: launcherPosition.x, y: launcherPosition.y },
        };
        // In a version 1 backup an absent switch means filtering is enabled.
        if (!filtering) value.menuFilteringEnabled = false;
        return value;
    }

    function snapshot() {
        const savedPosition = GM_getValue(positionKey, null);
        return configuration(
            readFavorites(), hiddenMenuKeys(), validPosition(savedPosition) ? savedPosition : null, menuFilteringIsEnabled(),
        );
    }

    function parseBackup(text) {
        let value;
        try {
            value = JSON.parse(text);
        } catch {
            throw new Error('文件内容无法解析为 JSON。');
        }
        if (value?.format !== backupFormat || value.version !== 1) {
            throw new Error('请选择飞书后台助手导出的配置文件。');
        }
        if (!Array.isArray(value.favorites) || !Array.isArray(value.hiddenMenus) ||
            value.hiddenMenus.some(key => typeof key !== 'string' || !key) ||
            (value.position !== null && !validPosition(value.position)) ||
            ('menuFilteringEnabled' in value && typeof value.menuFilteringEnabled !== 'boolean')) {
            throw new Error('备份中的配置字段无效。');
        }
        const favorites = normalizeFavorites(value.favorites);
        if (favorites.length !== value.favorites.length) {
            throw new Error('备份中有无效或重复的收藏入口。');
        }
        return configuration(favorites, value.hiddenMenus, value.position, value.menuFilteringEnabled !== false);
    }

    function applyBackup(value) {
        GM_setValue(storageKey, value.favorites);
        GM_setValue(menuKey, value.hiddenMenus);
        GM_setValue(menuFilterKey, value.menuFilteringEnabled !== false);
        GM_setValue(positionKey, value.position);
        position = value.position;
        if (!drag?.moved) restorePosition();
        refreshSidebar();
        render();
    }

    function repoName(input) {
        const name = input.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
        const match = name.match(/^[a-z0-9][a-z0-9-]*\/([a-z0-9_.-]+)$/i);
        return match && !['.', '..'].includes(match[1]) ? name.toLowerCase() : null;
    }

    function currentConnection() {
        return GM_getValue(connectionKey, null);
    }

    function githubRequest(connection, resource = '', body) {
        const url = `https://api.github.com/repos/${connection.repo}${resource}`;
        return new Promise((resolve, reject) => {
            let timer;
            const failed = () => {
                clearTimeout(timer);
                reject(new Error('连接 GitHub 失败或超时，请重试。'));
            };
            const request = GM_xmlhttpRequest({
                method: body ? 'PUT' : 'GET',
                url,
                headers: {
                    Authorization: `Bearer ${connection.token}`,
                    Accept: 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                data: body ? JSON.stringify(body) : undefined,
                responseType: 'json',
                anonymous: true,
                nocache: true,
                redirect: 'error',
                onload: response => {
                    clearTimeout(timer);
                    if (response.finalUrl && !response.finalUrl.startsWith('https://api.github.com/')) {
                        reject(new Error('GitHub 请求返回了非预期的地址。'));
                        return;
                    }
                    resolve({ status: response.status, data: response.response });
                },
                onerror: failed,
                onabort: failed,
                ontimeout: failed,
            });
            timer = setTimeout(() => {
                failed();
                request?.abort();
            }, 15000);
        });
    }

    function githubError(code) {
        if (code === 401) return new Error('GitHub 令牌无效或已过期，请重新保存连接。');
        if (code === 403 || code === 404) return new Error('GitHub 拒绝了请求。请检查仓库和令牌的 Contents 读写权限。');
        if (code === 409 || code === 422) return new Error('GitHub 拒绝了写入。请重新同步，并检查仓库是否已初始化、默认分支是否允许写入。');
        return new Error(`GitHub 请求失败（HTTP ${code}）。`);
    }

    async function verifyRepository(connection) {
        const { status: code, data } = await githubRequest(connection);
        if (code !== 200) throw githubError(code);
        if (data?.private !== true || (data.visibility && data.visibility !== 'private')) {
            throw new Error('请选择 GitHub 私有仓库保存配置。');
        }
        if (!data.default_branch || !Number.isSafeInteger(data.id)) {
            throw new Error('无法确认仓库的默认分支。');
        }
        return { branch: data.default_branch, scope: `${data.id}:${data.default_branch}` };
    }

    async function loadRemoteBackup(connection, branch, path) {
        const resource = `/contents/${path}?ref=${encodeURIComponent(branch)}`;
        const { status: code, data } = await githubRequest(connection, resource);
        if (code === 404) return null;
        if (code !== 200) throw githubError(code);
        if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' ||
            typeof data.sha !== 'string' || data.size > backupSizeLimit || data.content.length > backupSizeLimit * 1.5) {
            throw new Error('仓库中的配置文件格式无效或超过大小限制。');
        }
        let decoded;
        try {
            const bytes = Uint8Array.from(atob(data.content), character => character.charCodeAt(0));
            if (bytes.length > backupSizeLimit) throw new Error();
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            throw new Error('仓库配置文件超过大小限制或编码无效。');
        }
        const value = parseBackup(decoded);
        return { value, json: JSON.stringify(value), sha: data.sha, path };
    }

    async function uploadBackup(connection, branch, local, remote) {
        const bytes = new TextEncoder().encode(JSON.stringify(local, null, 2) + '\n');
        if (bytes.length > backupSizeLimit) throw new Error('当前配置超过 1 MB，无法上传到 GitHub。');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        const payload = { message: 'Sync Feishu admin preferences', branch, content: btoa(binary) };
        if (remote) payload.sha = remote.sha;
        const { status: code } = await githubRequest(connection, `/contents/${remote?.path ?? githubFile}`, payload);
        if (code !== 200 && code !== 201) throw githubError(code);
    }

    function getSyncAction(localJson, remote, scope) {
        const baseline = GM_getValue(baselineKey, null);
        const previous = baseline?.scope === scope ? baseline.json : null;
        if (!remote) return previous ? 'review' : 'push';
        if (localJson === remote.json) return 'same';
        if (!previous) {
            const defaultJson = JSON.stringify(configuration(defaults, [], null));
            return localJson === defaultJson ? 'pull' : 'review';
        }
        if (previous === localJson) return 'pull';
        if (previous === remote.json) return 'push';
        return 'review';
    }

    function clearConflict() {
        pendingConflict = null;
        conflictActions.hidden = true;
    }

    function resetBackupSettings() {
        const connection = currentConnection();
        tokenInput.value = '';
        clearConflict();
        repoInput.value = connection?.repo ?? defaultGitHubRepo;
        githubSettings.open = false;
        updateGitHubControls();
    }

    function updateGitHubControls() {
        const connection = currentConnection();
        const edited = tokenInput.value || repoName(repoInput.value) !== connection?.repo;
        connectionDetail.textContent = connection?.repo ?? '尚未连接仓库';
        githubSettings.hidden = !connection && !githubSettings.open;
        for (const field of githubForm.querySelectorAll('input, button[type="submit"]')) {
            field.disabled = githubBusy;
        }
        for (const button of conflictActions.querySelectorAll('button')) button.disabled = githubBusy;
        syncNow.textContent = connection ? '立即同步' : '连接仓库';
        syncNow.disabled = githubBusy || Boolean(connection && edited);
    }

    async function runGitHub(operation) {
        if (githubBusy) return;
        githubBusy = true;
        status.textContent = '正在连接 GitHub…';
        updateGitHubControls();
        try {
            await operation();
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'GitHub 请求失败。';
        } finally {
            githubBusy = false;
            updateGitHubControls();
        }
    }

    async function syncWithGitHub(choice) {
        if (githubBusy) return;
        const conflict = pendingConflict;
        clearConflict();
        const connection = currentConnection();
        if (!connection) {
            status.textContent = '请先保存 GitHub 仓库连接。';
            return;
        }
        await runGitHub(async () => {
            const { branch, scope } = await verifyRepository(connection);
            const baseline = GM_getValue(baselineKey, null);
            let remote = await loadRemoteBackup(connection, branch, githubFile);
            if (!remote && !(baseline?.scope === scope && baseline.path === githubFile)) {
                remote = await loadRemoteBackup(connection, branch, legacyGitHubFile);
            }
            const saved = currentConnection();
            if (saved?.repo !== connection.repo || saved.token !== connection.token) {
                throw new Error('GitHub 连接已在其他标签页更改，请重新同步。');
            }
            const local = snapshot();
            const localJson = JSON.stringify(local);
            let action = getSyncAction(localJson, remote, scope);
            const path = remote?.path ?? githubFile;
            if (choice && conflict?.scope === scope && conflict.path === path &&
                conflict.sha === (remote?.sha ?? null) && conflict.localJson === localJson) {
                action = choice;
            }
            if (action === 'review') {
                pendingConflict = { localJson, scope, path, sha: remote?.sha ?? null };
                useRemote.hidden = !remote;
                conflictActions.hidden = false;
                status.textContent = remote
                    ? '本机和仓库的配置不同，请选择保留哪一份。'
                    : '仓库中的配置文件已移除。可以选择上传本机配置，重新创建文件。';
                return;
            }
            if (action === 'pull') applyBackup(remote.value);
            if (action === 'push') await uploadBackup(connection, branch, local, remote);
            GM_setValue(baselineKey, { scope, path, json: action === 'pull' ? remote.json : localJson });
            status.textContent = { pull: '已应用仓库配置。', push: '已备份到 GitHub。', same: '本机与 GitHub 配置一致。' }[action];
        });
    }

    root.querySelector('.export-backup').addEventListener('click', () => {
        const contents = JSON.stringify(snapshot(), null, 2) + '\n';
        const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'feishu-admin-favorites-backup.json';
        backupView.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = '已导出本机配置。';
    });
    root.querySelector('.import-backup').addEventListener('click', () => backupFile.click());
    backupFile.addEventListener('change', async () => {
        const [file] = backupFile.files;
        backupFile.value = '';
        if (!file) return;
        try {
            const value = parseBackup(await file.text());
            if (!window.confirm('用这份备份替换本机的收藏、侧栏设置和标签位置？')) return;
            applyBackup(value);
            clearConflict();
            status.textContent = '已导入并应用到本机。';
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : '无法打开备份文件。';
        }
    });

    githubForm.addEventListener('input', () => {
        clearConflict();
        updateGitHubControls();
    });
    githubForm.addEventListener('submit', event => {
        event.preventDefault();
        const repo = repoName(repoInput.value);
        if (!repo) {
            status.textContent = '请输入 GitHub 仓库链接，或填「所有者/仓库名」。';
            return;
        }
        const saved = currentConnection();
        const token = tokenInput.value.trim() || (saved?.repo === repo ? saved.token : '');
        if (!/^github_pat_[a-z0-9_]+$/i.test(token)) {
            status.textContent = '请填写 GitHub 细粒度令牌。';
            return;
        }
        const connection = { repo, token };
        clearConflict();
        void runGitHub(async () => {
            await verifyRepository(connection);
            GM_setValue(connectionKey, connection);
            tokenInput.value = '';
            repoInput.value = repo;
            githubSettings.open = false;
            status.textContent = '已保存连接，点击「立即同步」检查配置。';
        }).then(() => {
            if (!githubSettings.open && !panel.hidden && !backupView.hidden) syncNow.focus();
        });
    });
    githubSettings.addEventListener('toggle', () => {
        if (githubSettings.open || githubBusy) return;
        tokenInput.value = '';
        repoInput.value = currentConnection()?.repo ?? defaultGitHubRepo;
        updateGitHubControls();
    });
    syncNow.addEventListener('click', () => {
        if (currentConnection()) {
            void syncWithGitHub();
            return;
        }
        githubSettings.hidden = false;
        githubSettings.open = true;
        repoInput.focus();
        placePanel();
    });
    useRemote.addEventListener('click', () => void syncWithGitHub('pull'));
    root.querySelector('.use-local').addEventListener('click', () => void syncWithGitHub('push'));

    function selectTab(tab) {
        if (tab.getAttribute('aria-selected') === 'true') return;
        if (draft) closeForm();
        if (menuChanges) finishMenuEditing();
        if (!backupView.hidden || tab === backupTab) resetBackupSettings();
        status.textContent = '';
        for (const item of tabs) {
            const selected = item === tab;
            item.setAttribute('aria-selected', String(selected));
            item.tabIndex = selected ? 0 : -1;
            root.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
        }
        tab.focus();
        placePanel();
    }

    for (const [index, tab] of tabs.entries()) {
        tab.addEventListener('click', () => selectTab(tab));
        tab.addEventListener('keydown', event => {
            const targets = {
                ArrowLeft: (index + tabs.length - 1) % tabs.length,
                ArrowRight: (index + 1) % tabs.length,
                Home: 0,
                End: tabs.length - 1,
            };
            if (!Object.hasOwn(targets, event.key)) return;
            event.preventDefault();
            selectTab(tabs[targets[event.key]]);
        });
    }

    toggle.addEventListener('click', event => {
        if (!suppressClick || event.detail === 0) setOpen(panel.hidden);
        suppressClick = false;
    });
    root.querySelector('.close').addEventListener('click', () => setOpen(false, true));
    root.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || panel.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        if (menuChanges) finishMenuEditing();
        else if (draft) closeForm();
        else setOpen(false, true);
    });
    document.addEventListener('pointerdown', event => {
        if (!menuChanges && !panel.hidden && !event.composedPath().includes(host)) setOpen(false);
    }, true);

    add.addEventListener('click', () => {
        const path = adminPath(location.href);
        if (!path) {
            status.textContent = '当前页面不在飞书管理后台内。';
            return;
        }
        const existing = readFavorites().find(entry => entry.path === path);
        if (existing) {
            status.textContent = `已收藏为「${existing.name}」`;
            return;
        }
        const title = document.title.trim().replace(/\s*[-–—|｜]\s*飞书管理后台\s*$/, '');
        showForm(path, title || '常用页面', false, add);
    });
    addLink.addEventListener('click', () => showForm(null, '', false, addLink));
    manage.addEventListener('click', () => {
        managing = !managing;
        if (!managing && draft?.editing) closeForm();
        manage.setAttribute('aria-pressed', String(managing));
        manage.textContent = managing ? '完成' : '管理收藏';
        render();
    });
    root.querySelector('.cancel').addEventListener('click', closeForm);
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (!draft) return;
        const name = input.value.trim();
        if (!name) {
            status.textContent = '请输入入口名称。';
            input.focus();
            return;
        }
        const { path: savedPath, editing } = draft;
        const path = savedPath ?? favoriteAddress(addressInput.value);
        if (!path) {
            status.textContent = '请输入以 https:// 或 http:// 开头、不含账号密码的网页地址。';
            addressInput.focus();
            return;
        }
        const favorites = readFavorites();
        const existing = favorites.find(entry => entry.path === path);
        if (existing && !editing) {
            status.textContent = `此地址已收藏为「${existing.name}」`;
            return;
        }
        closeForm();
        if (!existing && editing) {
            status.textContent = '此入口已在其他页面移除。';
            return;
        }
        if (existing) existing.name = name;
        else favorites.push({ name, path });
        const message = editing ? '名称已更新' : (savedPath === null ? '已添加链接' : '已收藏当前页');
        saveFavorites(favorites, message);
        if (editing) manage.focus();
    });

    GM_addValueChangeListener(storageKey, (_key, _oldValue, _newValue, remote) => {
        if (remote && !panel.hidden) render();
    });
    GM_addValueChangeListener(positionKey, (_key, _oldValue, newValue, remote) => {
        if (!remote) return;
        position = newValue;
        if (!drag?.moved) restorePosition();
    });
    GM_addValueChangeListener(menuKey, (_key, _oldValue, _newValue, remote) => {
        if (remote) refreshSidebar();
    });
    GM_addValueChangeListener(menuFilterKey, (_key, _oldValue, _newValue, remote) => {
        if (remote) refreshSidebar();
    });
})();
