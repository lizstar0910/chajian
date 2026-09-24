/**
 * ST-UserInstructions —— 让用户自己维护「必须让 AI 记住的指令」，并稳定地注入到每一轮提示词。
 *
 * 解决的问题：在聊天里口头强调过一次，过几轮 AI 就打回原形。
 * 做法：把指令做成结构化条目（常驻 / 关键词触发 + 黏着 / 每 N 轮提醒），
 *      用 setExtensionPrompt 注入到「离当前对话最近」的位置（聊天内深度 0~2，system 角色），
 *      每轮生成前重新计算，保证始终在线。
 *
 * 纯逻辑部分（createEntry / matchKeywords / evaluateEntry / composeInjection …）不依赖任何
 * 浏览器或 ST 全局，便于单独测试；ST 相关代码只在检测到 SillyTavern 全局后才启动。
 */

/* =========================================================================
 *  常量
 * ========================================================================= */

const MODULE_NAME = 'user_instructions';

export const POSITION = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2, NONE: -1 });
export const ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
export const TRIGGER = Object.freeze({ ALWAYS: 'always', KEYWORD: 'keyword', INTERVAL: 'interval' });
export const MATCH = Object.freeze({ ANY: 'any', ALL: 'all', REGEX: 'regex' });
export const SCAN = Object.freeze({ LAST_USER: 'last_user', RECENT: 'recent', WHOLE: 'whole' });
export const SCOPE = Object.freeze({ GLOBAL: 'global', CHAT: 'chat' });

export const POSITION_LABEL = {
    [POSITION.IN_CHAT]: '聊天内',
    [POSITION.IN_PROMPT]: '系统提示词内',
    [POSITION.BEFORE_PROMPT]: '系统提示词前',
};

export const ROLE_LABEL = {
    [ROLE.SYSTEM]: 'system',
    [ROLE.USER]: 'user',
    [ROLE.ASSISTANT]: 'assistant',
};

export const TRIGGER_LABEL = {
    [TRIGGER.ALWAYS]: '常驻',
    [TRIGGER.KEYWORD]: '关键词',
    [TRIGGER.INTERVAL]: '每N轮',
};

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    emphasize_prefix: '【必须遵守的设定】',
    default_position: POSITION.IN_CHAT,
    default_depth: 2,
    default_role: ROLE.SYSTEM,
    default_scan: SCAN.LAST_USER,
    default_scan_messages: 3,
    default_sticky: 2,
    show_status: true,
});

const TEMPLATES = [
    {
        name: '时间线 / 当前节点',
        entry: {
            title: '当前节点：乐队尚未成立',
            trigger: TRIGGER.ALWAYS,
            content: '【时间线 · 必须遵守】\n当前节点：{{char}} 的乐队尚未成立。\n- 与之相关的后续事件一律不得提及、暗示或提前发生。\n- 角色之间仍处于此阶段的关系与称呼，请严格按此行事。\n- 若剧情需要推进，只能推进到「当前节点」为止。',
        },
    },
    {
        name: '角色状态速查',
        entry: {
            title: '角色状态',
            trigger: TRIGGER.ALWAYS,
            content: '【角色状态 · 必须遵守】\n- {{char}} 当前状态：\n- {{user}} 当前状态：\n- 关系阶段：\n除以上列出的内容外，其余状态视为未知，不得凭空补充或推翻。',
        },
    },
    {
        name: '硬性禁令（不 OOC）',
        entry: {
            title: '硬性禁令',
            trigger: TRIGGER.ALWAYS,
            content: '【硬性禁令】\n- 不得替 {{user}} 决定言行与内心想法。\n- 不得跳出角色（无「作为AI」之类的出戏发言）。\n- 不得引入未经确认的新设定、新角色、新组织。\n- 不得用总结句代替场景描写。',
        },
    },
    {
        name: '写作风格',
        entry: {
            title: '写作风格',
            trigger: TRIGGER.ALWAYS,
            content: '【写作要求】\n- 视角：第三人称限知，聚焦 {{char}}。\n- 长度：每次 300–600 字。\n- 以对话与细节动作为主，减少心理总结。',
        },
    },
    {
        name: '既定事实备忘（常驻）',
        entry: {
            title: '既定事实',
            trigger: TRIGGER.ALWAYS,
            content: '【既定事实 · 不得推翻】\n1. \n2. \n3. ',
        },
    },
    {
        name: '久未出现就提醒（关键词 + 黏着）',
        entry: {
            title: '提醒：时间线未推进',
            trigger: TRIGGER.KEYWORD,
            keywords: '以后,后来,已经,早就',
            sticky: 3,
            content: '【提醒】注意当前时间线节点，上述内容尚未发生，不得当作已发生的事实继续推进。',
        },
    },
];

/* =========================================================================
 *  纯逻辑
 * ========================================================================= */

let idSeed = 0;

export function newId() {
    idSeed += 1;
    return 'ui' + Date.now().toString(36) + idSeed.toString(36) + Math.random().toString(36).slice(2, 6);
}

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * 新建一个指令条目。
 * @param {object} [patch]
 * @param {object} [defaults]
 */
export function createEntry(patch = {}, defaults = DEFAULT_SETTINGS) {
    return Object.assign(
        {
            id: newId(),
            title: '新指令',
            content: '',
            enabled: true,
            scope: SCOPE.GLOBAL,
            position: num(defaults.default_position, POSITION.IN_CHAT),
            depth: clamp(num(defaults.default_depth, 2), 0, 1000),
            role: num(defaults.default_role, ROLE.SYSTEM),
            scan: false,
            trigger: TRIGGER.ALWAYS,
            match: MATCH.ANY,
            keywords: '',
            keyword_case: false,
            scan_scope: defaults.default_scan || SCAN.LAST_USER,
            scan_messages: clamp(num(defaults.default_scan_messages, 3), 1, 50),
            sticky: clamp(num(defaults.default_sticky, 2), 0, 999),
            interval: 5,
            priority: 100,
            emphasize: true,
            collapsed: true,
            created: Date.now(),
        },
        patch,
    );
}

/** 修正从设置文件读到的旧数据 / 手改数据 */
export function normalizeEntry(raw, defaults = DEFAULT_SETTINGS) {
    const e = createEntry({}, defaults);
    if (!raw || typeof raw !== 'object') return e;
    const merged = Object.assign(e, raw);
    merged.id = typeof raw.id === 'string' && raw.id ? raw.id : newId();
    merged.title = String(raw.title ?? e.title).slice(0, 200);
    merged.content = String(raw.content ?? '');
    merged.enabled = raw.enabled !== false;
    merged.scope = raw.scope === SCOPE.CHAT ? SCOPE.CHAT : SCOPE.GLOBAL;
    merged.position = [POSITION.IN_PROMPT, POSITION.IN_CHAT, POSITION.BEFORE_PROMPT].includes(num(raw.position))
        ? num(raw.position)
        : POSITION.IN_CHAT;
    merged.depth = clamp(num(raw.depth, e.depth), 0, 1000);
    merged.role = [ROLE.SYSTEM, ROLE.USER, ROLE.ASSISTANT].includes(num(raw.role)) ? num(raw.role) : ROLE.SYSTEM;
    merged.scan = raw.scan === true;
    merged.trigger = Object.values(TRIGGER).includes(raw.trigger) ? raw.trigger : TRIGGER.ALWAYS;
    merged.match = Object.values(MATCH).includes(raw.match) ? raw.match : MATCH.ANY;
    merged.keywords = String(raw.keywords ?? '');
    merged.keyword_case = raw.keyword_case === true;
    merged.scan_scope = Object.values(SCAN).includes(raw.scan_scope) ? raw.scan_scope : SCAN.LAST_USER;
    merged.scan_messages = clamp(num(raw.scan_messages, e.scan_messages), 1, 50);
    merged.sticky = clamp(num(raw.sticky, e.sticky), 0, 999);
    merged.interval = clamp(num(raw.interval, 5), 1, 999);
    merged.priority = clamp(num(raw.priority, 100), -9999, 99999);
    merged.emphasize = raw.emphasize !== false;
    merged.collapsed = raw.collapsed !== false;
    merged.created = num(raw.created, Date.now());
    return merged;
}

/** 关键词文本 → 数组。支持换行、中英文逗号、分号分隔。 */
export function parseKeywords(text) {
    return String(text || '')
        .split(/[\n,，;；|]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function stripRegexSlashes(s) {
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(s.trim());
    return m ? m[1] : s;
}

/**
 * 关键词匹配。
 * @returns {boolean}
 */
export function matchKeywords(entry, text) {
    const parts = parseKeywords(entry.keywords);
    const hay = String(text || '');
    if (!parts.length || !hay) return false;

    if (entry.match === MATCH.REGEX) {
        return parts.some((p) => {
            try {
                return new RegExp(stripRegexSlashes(p), entry.keyword_case ? '' : 'i').test(hay);
            } catch (err) {
                return false;
            }
        });
    }

    const flags = entry.keyword_case ? '' : 'i';
    const needles = parts.map((p) => (entry.keyword_case ? p : p.toLowerCase()));
    const body = entry.keyword_case ? hay : hay.toLowerCase();
    return entry.match === MATCH.ALL ? needles.every((n) => body.includes(n)) : needles.some((n) => body.includes(n));
}

/** 按扫描范围取出要检测的文本 */
export function buildScanText(entry, chat) {
    const msgs = Array.isArray(chat) ? chat : [];
    if (!msgs.length) return '';
    const toText = (m) => String(m?.mes ?? m?.content ?? '');

    switch (entry.scan_scope) {
        case SCAN.WHOLE:
            return msgs.map(toText).join('\n');
        case SCAN.RECENT: {
            const n = clamp(num(entry.scan_messages, 3), 1, 50);
            return msgs.slice(-n).map(toText).join('\n');
        }
        case SCAN.LAST_USER:
        default: {
            for (let i = msgs.length - 1; i >= 0; i -= 1) {
                if (msgs[i]?.is_user) return toText(msgs[i]);
            }
            return toText(msgs[msgs.length - 1]);
        }
    }
}

/** 统计用户发言轮数（作为「第几轮」的基准） */
export function countUserTurns(chat) {
    const msgs = Array.isArray(chat) ? chat : [];
    return msgs.filter((m) => m?.is_user).length;
}

/**
 * 判定某条指令这一轮是否生效。
 * @param {object} entry
 * @param {{chat:any[], turn:number, sticky:Record<string,number>}} ctx
 * @returns {{active:boolean, hit:boolean, reason:string}}
 */
export function evaluateEntry(entry, ctx) {
    if (!entry || entry.enabled === false) return { active: false, hit: false, reason: 'disabled' };

    if (entry.trigger === TRIGGER.KEYWORD) {
        const hit = matchKeywords(entry, buildScanText(entry, ctx.chat));
        const remain = num(ctx.sticky?.[entry.id], 0);
        if (hit) return { active: true, hit: true, reason: 'hit' };
        if (remain > 0) return { active: true, hit: false, reason: `sticky:${remain}` };
        return { active: false, hit: false, reason: 'idle' };
    }

    if (entry.trigger === TRIGGER.INTERVAL) {
        const n = clamp(num(entry.interval, 5), 1, 999);
        const turn = num(ctx.turn, 0);
        const on = turn > 0 && turn % n === 0;
        return { active: on, hit: false, reason: on ? `turn:${turn}` : 'idle' };
    }

    return { active: true, hit: false, reason: 'always' };
}

/**
 * 生成最终注入文本。
 * @param {object} entry
 * @param {object} settings
 * @param {(s:string)=>string} [substitute] 宏替换函数（{{char}} / {{user}} …）
 */
export function composeInjection(entry, settings = DEFAULT_SETTINGS, substitute) {
    let body = String(entry?.content ?? '').trim();
    if (!body) return '';
    if (typeof substitute === 'function') {
        try {
            body = substitute(body);
        } catch (err) {
            /* 宏替换失败就用原文 */
        }
    }
    const prefix = entry.emphasize === false ? '' : String(settings?.emphasize_prefix ?? '').trim();
    return prefix ? `${prefix}\n${body}` : body;
}

/** 合并后的生效顺序：先按 priority 数值，再按加入时间 */
export function sortEntries(items) {
    return [...items].sort(
        (a, b) => num(a.entry.priority, 100) - num(b.entry.priority, 100) || num(a.entry.created, 0) - num(b.entry.created, 0),
    );
}

/** ST 的 extension_prompts 是按 key 字母序拼接的，所以要用零填充前缀锁定顺序 */
export function promptKey(index, entry) {
    return `userinstr_${String(clamp(num(index, 0), 0, 99999)).padStart(5, '0')}_${entry.id}`;
}

/* =========================================================================
 *  ST 运行时
 * ========================================================================= */

function C() {
    const st = globalThis.SillyTavern;
    return st && typeof st.getContext === 'function' ? st.getContext() : null;
}

const S = {
    settings: { ...DEFAULT_SETTINGS },
    globalEntries: [],
    keys: new Set(),
    status: new Map(),
    filter: 'all',
    ready: false,
    bound: false,
};

function persistGlobal() {
    const ctx = C();
    if (!ctx) return;
    try {
        ctx.saveSettingsDebounced();
    } catch (err) {
        console.error('[指令] 保存设置失败', err);
    }
}

function persistChat() {
    const ctx = C();
    if (!ctx) return;
    try {
        ctx.saveMetadataDebounced();
    } catch (err) {
        console.error('[指令] 保存聊天元数据失败', err);
    }
}

/** 取聊天级存储（默认不主动创建，避免污染 chat_metadata） */
function chatStore(create = false) {
    const ctx = C();
    const md = ctx?.chatMetadata;
    if (!md) return null;
    if (!md[MODULE_NAME] || typeof md[MODULE_NAME] !== 'object') {
        if (!create) return null;
        md[MODULE_NAME] = { entries: [], sticky: {}, lastHit: {} };
    }
    const store = md[MODULE_NAME];
    if (!Array.isArray(store.entries)) store.entries = [];
    if (!store.sticky || typeof store.sticky !== 'object') store.sticky = {};
    if (!store.lastHit || typeof store.lastHit !== 'object') store.lastHit = {};
    return store;
}

function chatEntries() {
    return chatStore(false)?.entries ?? [];
}

/** 设置文件里的存储对象 */
function globalStore() {
    const ctx = C();
    if (!ctx?.extensionSettings) return null;
    if (!ctx.extensionSettings[MODULE_NAME] || typeof ctx.extensionSettings[MODULE_NAME] !== 'object') {
        ctx.extensionSettings[MODULE_NAME] = { version: 1, settings: { ...DEFAULT_SETTINGS }, entries: [] };
    }
    const store = ctx.extensionSettings[MODULE_NAME];
    if (!Array.isArray(store.entries)) store.entries = [];
    if (!store.settings || typeof store.settings !== 'object') store.settings = { ...DEFAULT_SETTINGS };
    return store;
}

function loadSettings() {
    const store = globalStore();
    if (!store) return;
    store.settings = Object.assign({}, DEFAULT_SETTINGS, store.settings);
    S.settings = store.settings;
    store.entries = store.entries.map((e) => normalizeEntry(e, S.settings));
    S.globalEntries = store.entries;
    // 归一化可能补齐了默认值（旧版本数据 / 手改数据），回写一次，避免每次启动重复修正
    persistGlobal();
}

/** 当前所有条目（全局 + 聊天），带 scope 标记 */
function allEntries() {
    const out = S.globalEntries.map((entry) => ({ entry, scope: SCOPE.GLOBAL }));
    for (const entry of chatEntries()) out.push({ entry, scope: SCOPE.CHAT });
    return out;
}

function findEntry(id) {
    const g = S.globalEntries.findIndex((e) => e.id === id);
    if (g >= 0) return { entry: S.globalEntries[g], scope: SCOPE.GLOBAL, index: g };
    const store = chatStore(false);
    const c = store ? store.entries.findIndex((e) => e.id === id) : -1;
    if (c >= 0) return { entry: store.entries[c], scope: SCOPE.CHAT, index: c };
    return null;
}

function arrayForScope(scope) {
    if (scope === SCOPE.CHAT) {
        const store = chatStore(true);
        return store ? store.entries : null;
    }
    return S.globalEntries;
}

function saveScope(scope) {
    if (scope === SCOPE.CHAT) persistChat();
    else persistGlobal();
}

/* ------------------------- 注入同步 ------------------------- */

function setSticky(entryId, remaining) {
    const store = chatStore(true);
    if (!store) return;
    store.sticky[entryId] = Math.max(0, num(remaining, 0));
}

function getStickyMap() {
    return chatStore(false)?.sticky ?? {};
}

/**
 * 核心：每轮生成前重算所有条目，并写入 extension prompts。
 */
function sync() {
    const ctx = C();
    if (!ctx) return;

    const chat = ctx.chat ?? [];
    const turn = countUserTurns(chat);
    const sticky = getStickyMap();
    const store = chatStore(false);
    const status = new Map();
    const wanted = new Map();

    const items = S.settings.enabled ? sortEntries(allEntries()) : [];
    let index = 0;

    for (const { entry } of items) {
        const res = evaluateEntry(entry, { chat, turn, sticky });

        // 关键词命中：只在「新的一轮」重置黏着计数，避免同轮多次 sync 把它一直续命
        if (res.hit && res.reason === 'hit') {
            const st = chatStore(true);
            if (st && num(st.lastHit[entry.id], -1) !== turn) {
                st.lastHit[entry.id] = turn;
                setSticky(entry.id, entry.sticky);
                sticky[entry.id] = num(entry.sticky, 0);
                persistChat();
            }
        }

        const text = res.active ? composeInjection(entry, S.settings, ctx.substituteParams) : '';
        status.set(entry.id, { active: !!text, hit: res.hit, reason: res.reason, text });
        if (!text) continue;

        wanted.set(promptKey(index, entry), { entry, text });
        index += 1;
    }

    // 写入 / 清理
    for (const [key, { entry, text }] of wanted) {
        ctx.setExtensionPrompt(key, text, entry.position, entry.depth, entry.scan, entry.role);
    }
    for (const key of Array.from(S.keys)) {
        if (!wanted.has(key)) ctx.setExtensionPrompt(key, '', POSITION.NONE, 0, false, ROLE.SYSTEM);
    }
    S.keys = new Set(wanted.keys());
    S.status = status;

    refreshVisuals();
}

/** AI 回复一次 = 消耗一轮黏着 */
function consumeSticky() {
    const store = chatStore(false);
    if (!store) return;
    let changed = false;
    for (const key of Object.keys(store.sticky)) {
        const value = num(store.sticky[key], 0);
        if (value > 0) {
            store.sticky[key] = value - 1;
            changed = true;
        }
    }
    if (changed) persistChat();
    sync();
}

/* ------------------------- UI ------------------------- */

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function $(sel) {
    return globalThis.jQuery(sel);
}

function positionBadge(entry) {
    if (entry.position === POSITION.IN_CHAT) return `聊天内@${entry.depth} ${ROLE_LABEL[entry.role] ?? 'system'}`;
    return POSITION_LABEL[entry.position] ?? '聊天内';
}

function triggerBadge(entry) {
    if (entry.trigger === TRIGGER.KEYWORD) return `关键词${entry.sticky > 0 ? `+${entry.sticky}轮` : ''}`;
    if (entry.trigger === TRIGGER.INTERVAL) return `每${entry.interval}轮`;
    return '常驻';
}

function entryCard(item) {
    const { entry, scope } = item;
    const st = S.status.get(entry.id);
    const scopeLabel = scope === SCOPE.CHAT ? '本聊天' : '全局';
    return `
    <div class="sui-card ${entry.enabled ? '' : 'sui-off'}" data-id="${esc(entry.id)}">
        <div class="sui-card-head">
            <input type="checkbox" class="sui-enable" ${entry.enabled ? 'checked' : ''} title="启用这条指令">
            <span class="sui-dot ${st?.active ? 'on' : ''}" title="${st?.active ? `本轮会注入（${esc(st.reason)}）` : '本轮不注入'}"></span>
            <span class="sui-title" title="${esc(entry.title)}">${esc(entry.title || '(无标题)')}</span>
            <span class="sui-badges">
                <span class="sui-badge sui-badge-scope">${scopeLabel}</span>
                <span class="sui-badge sui-badge-trigger">${esc(triggerBadge(entry))}</span>
                <span class="sui-badge sui-badge-pos">${esc(positionBadge(entry))}</span>
            </span>
            <span class="sui-actions">
                <span class="sui-icon-btn sui-up" title="上移">▲</span>
                <span class="sui-icon-btn sui-down" title="下移">▼</span>
                <span class="sui-icon-btn sui-dup" title="复制">⧉</span>
                <span class="sui-icon-btn sui-del" title="删除">✕</span>
                <span class="sui-icon-btn sui-fold" title="展开/收起">${entry.collapsed ? '▾' : '▴'}</span>
            </span>
        </div>
        <div class="sui-card-body ${entry.collapsed ? 'sui-hidden' : ''}">
            <textarea class="sui-content text_pole" placeholder="在这里写下你要 AI 记住的东西，例如：当前节点乐队尚未成立，相关后续事件一律不得提及。支持 {{char}} / {{user}} 宏。">${esc(entry.content)}</textarea>
            <div class="sui-row">
                <span class="sui-field"><label>标题</label><input type="text" class="sui-title-input sui-wide" value="${esc(entry.title)}"></span>
                <span class="sui-field"><label>作用域</label>
                    <select class="sui-scope">
                        <option value="global" ${scope === SCOPE.GLOBAL ? 'selected' : ''}>全局（所有聊天）</option>
                        <option value="chat" ${scope === SCOPE.CHAT ? 'selected' : ''}>本聊天（随聊天记录走）</option>
                    </select>
                </span>
                <span class="sui-field"><label>排序</label><input type="number" class="sui-priority" value="${entry.priority}" step="1"></span>
            </div>
            <div class="sui-row">
                <span class="sui-field"><label>触发</label>
                    <select class="sui-trigger">
                        <option value="always" ${entry.trigger === TRIGGER.ALWAYS ? 'selected' : ''}>常驻（每轮都注入）</option>
                        <option value="keyword" ${entry.trigger === TRIGGER.KEYWORD ? 'selected' : ''}>关键词（命中后黏着）</option>
                        <option value="interval" ${entry.trigger === TRIGGER.INTERVAL ? 'selected' : ''}>每 N 轮提醒一次</option>
                    </select>
                </span>
                <span class="sui-field sui-row-keyword ${entry.trigger === TRIGGER.KEYWORD ? '' : 'sui-hidden'}"><label>关键词</label><input type="text" class="sui-keywords sui-wide" value="${esc(entry.keywords)}" placeholder="逗号/换行分隔；匹配方式选正则可写 /xxx/i"></span>
                <span class="sui-field sui-row-keyword ${entry.trigger === TRIGGER.KEYWORD ? '' : 'sui-hidden'}"><label>匹配</label>
                    <select class="sui-match">
                        <option value="any" ${entry.match === MATCH.ANY ? 'selected' : ''}>任一</option>
                        <option value="all" ${entry.match === MATCH.ALL ? 'selected' : ''}>全部</option>
                        <option value="regex" ${entry.match === MATCH.REGEX ? 'selected' : ''}>正则</option>
                    </select>
                </span>
                <span class="sui-field sui-row-keyword ${entry.trigger === TRIGGER.KEYWORD ? '' : 'sui-hidden'}"><label>黏着轮数</label><input type="number" class="sui-sticky" value="${entry.sticky}" min="0" step="1"></span>
                <span class="sui-field sui-row-keyword ${entry.trigger === TRIGGER.KEYWORD ? '' : 'sui-hidden'}"><label>扫描范围</label>
                    <select class="sui-scan-scope">
                        <option value="last_user" ${entry.scan_scope === SCAN.LAST_USER ? 'selected' : ''}>最新一条用户消息</option>
                        <option value="recent" ${entry.scan_scope === SCAN.RECENT ? 'selected' : ''}>最近 N 条消息</option>
                        <option value="whole" ${entry.scan_scope === SCAN.WHOLE ? 'selected' : ''}>整个聊天</option>
                    </select>
                </span>
                <span class="sui-field sui-row-keyword ${entry.trigger === TRIGGER.KEYWORD && entry.scan_scope === SCAN.RECENT ? '' : 'sui-hidden'}"><label>N</label><input type="number" class="sui-scan-messages" value="${entry.scan_messages}" min="1" step="1"></span>
                <span class="sui-field sui-row-interval ${entry.trigger === TRIGGER.INTERVAL ? '' : 'sui-hidden'}"><label>每</label><input type="number" class="sui-interval" value="${entry.interval}" min="1" step="1"><label>轮注入一次</label></span>
            </div>
            <div class="sui-row">
                <span class="sui-field"><label>注入位置</label>
                    <select class="sui-position">
                        <option value="${POSITION.IN_CHAT}" ${entry.position === POSITION.IN_CHAT ? 'selected' : ''}>聊天内（按深度，推荐）</option>
                        <option value="${POSITION.IN_PROMPT}" ${entry.position === POSITION.IN_PROMPT ? 'selected' : ''}>系统提示词内</option>
                        <option value="${POSITION.BEFORE_PROMPT}" ${entry.position === POSITION.BEFORE_PROMPT ? 'selected' : ''}>系统提示词最前</option>
                    </select>
                </span>
                <span class="sui-field ${entry.position === POSITION.IN_CHAT ? '' : 'sui-hidden'} sui-row-depth"><label>深度</label><input type="number" class="sui-depth" value="${entry.depth}" min="0" step="1" title="0 = 紧贴最新一条消息，数字越大越靠前"></span>
                <span class="sui-field ${entry.position === POSITION.IN_CHAT ? '' : 'sui-hidden'} sui-row-role"><label>角色</label>
                    <select class="sui-role">
                        <option value="${ROLE.SYSTEM}" ${entry.role === ROLE.SYSTEM ? 'selected' : ''}>system（最硬）</option>
                        <option value="${ROLE.USER}" ${entry.role === ROLE.USER ? 'selected' : ''}>user</option>
                        <option value="${ROLE.ASSISTANT}" ${entry.role === ROLE.ASSISTANT ? 'selected' : ''}>assistant</option>
                    </select>
                </span>
                <label class="checkbox_label sui-field"><input type="checkbox" class="sui-emphasize" ${entry.emphasize ? 'checked' : ''}><span>加强前缀</span></label>
                <label class="checkbox_label sui-field"><input type="checkbox" class="sui-scan" ${entry.scan ? 'checked' : ''}><span>参与世界书扫描</span></label>
            </div>
        </div>
    </div>`;
}

function renderList() {
    const root = document.querySelector('.sui-panel .sui-list');
    if (!root) return;
    const items = sortEntries(allEntries()).filter(({ scope }) => {
        if (S.filter === 'global') return scope === SCOPE.GLOBAL;
        if (S.filter === 'chat') return scope === SCOPE.CHAT;
        return true;
    });
    root.innerHTML = items.length
        ? items.map(entryCard).join('')
        : '<div class="sui-empty">还没有指令。点「新建指令」或从「模板」里挑一个开始。</div>';
    updateCounts();
}

function updateCounts() {
    const g = S.globalEntries.length;
    const c = chatEntries().length;
    $('.sui-panel .sui-tab[data-filter="all"]').text(`全部 (${g + c})`);
    $('.sui-panel .sui-tab[data-filter="global"]').text(`全局 (${g})`);
    $('.sui-panel .sui-tab[data-filter="chat"]').text(`本聊天 (${c})`);
}

/** 只更新不改变结构的部分（状态点、徽章、显隐），避免打字时失焦 */
function refreshVisuals() {
    document.querySelectorAll('.sui-panel .sui-card').forEach((card) => {
        const id = card.dataset.id;
        const st = S.status.get(id);
        const dot = card.querySelector('.sui-dot');
        if (dot) {
            dot.classList.toggle('on', !!st?.active);
            dot.title = st?.active ? `本轮会注入（${st.reason}）` : '本轮不注入';
        }
    });
    updateStatusPreview();
}

let statusTimer = null;

function updateStatusPreview() {
    const box = document.querySelector('.sui-panel .sui-status-body');
    const head = document.querySelector('.sui-panel .sui-status-head b');
    if (!box || !head) return;

    const active = [];
    for (const { entry } of sortEntries(allEntries())) {
        const st = S.status.get(entry.id);
        if (st?.active && st.text) active.push(st.text);
    }
    const text = active.join('\n');
    head.textContent = `本回合生效：${active.length} 条 / 共 ${allEntries().length} 条`;

    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
        let tokens = Math.ceil(text.replace(/\s+/g, '').length / 1.6);
        try {
            const ctx = C();
            if (ctx?.getTokenCountAsync && text) tokens = await ctx.getTokenCountAsync(text);
        } catch (err) {
            /* 没有分词器就用估算值 */
        }
        const note = document.querySelector('.sui-panel .sui-status-tokens');
        if (note) note.textContent = text ? `约 ${tokens} tokens` : '';
        const pre = document.querySelector('.sui-panel .sui-status-pre');
        if (pre) pre.textContent = text || '（本回合没有指令被注入）';
    }, 120);
}

/* ------------------------- 交互 ------------------------- */

function addEntry(patch = {}, scope = null) {
    const targetScope = scope ?? (S.filter === 'chat' ? SCOPE.CHAT : SCOPE.GLOBAL);
    const entry = createEntry(Object.assign({}, patch, { scope: targetScope }), S.settings);
    const arr = arrayForScope(targetScope);
    if (!arr) return;
    arr.push(entry);
    saveScope(targetScope);
    if (targetScope === SCOPE.CHAT) S.filter = 'chat';
    renderList();
    sync();
}

function deleteEntry(id) {
    const found = findEntry(id);
    if (!found) return;
    if (!confirm(`删除指令「${found.entry.title || '(无标题)'}」？`)) return;
    const arr = arrayForScope(found.scope);
    arr.splice(found.index, 1);
    saveScope(found.scope);
    renderList();
    sync();
}

function moveEntry(id, delta) {
    const found = findEntry(id);
    if (!found) return;
    const arr = arrayForScope(found.scope);
    const to = found.index + delta;
    if (to < 0 || to >= arr.length) return;
    const [item] = arr.splice(found.index, 1);
    arr.splice(to, 0, item);
    saveScope(found.scope);
    renderList();
    sync();
}

function duplicateEntry(id) {
    const found = findEntry(id);
    if (!found) return;
    const copy = normalizeEntry(
        Object.assign({}, found.entry, { id: newId(), title: `${found.entry.title} 副本`, created: Date.now() }),
        S.settings,
    );
    const arr = arrayForScope(found.scope);
    arr.splice(found.index + 1, 0, copy);
    saveScope(found.scope);
    renderList();
    sync();
}

function changeScope(id, nextScope) {
    const found = findEntry(id);
    if (!found || found.scope === nextScope) return;
    const from = arrayForScope(found.scope);
    const to = arrayForScope(nextScope);
    if (!to) return;
    const [entry] = from.splice(found.index, 1);
    entry.scope = nextScope;
    to.push(entry);
    saveScope(found.scope);
    saveScope(nextScope);
    renderList();
    sync();
}

function patchEntry(id, patch, opts = {}) {
    const found = findEntry(id);
    if (!found) return;
    Object.assign(found.entry, patch);
    found.entry.scope = found.scope;
    saveScope(found.scope);
    if (opts.rerender) renderList();
    sync();
}

function exportJson() {
    const payload = {
        app: 'ST-UserInstructions',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: S.settings,
        global: S.globalEntries,
        chat: chatEntries(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `user-instructions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importJson(file) {
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        alert('导入失败：不是合法的 JSON 文件。');
        return;
    }
    const list = Array.isArray(data) ? data : [...(data.global ?? []), ...(data.chat ?? [])];
    if (!list.length) {
        alert('导入失败：文件里没有指令条目。');
        return;
    }
    const existing = new Set(allEntries().map(({ entry }) => entry.id));
    let added = 0;
    const chatList = [];
    for (const raw of list) {
        const entry = normalizeEntry(raw, S.settings);
        if (existing.has(entry.id)) entry.id = newId();
        existing.add(entry.id);
        if (entry.scope === SCOPE.CHAT) {
            chatList.push(entry);
        } else {
            entry.scope = SCOPE.GLOBAL;
            S.globalEntries.push(entry);
        }
        added += 1;
    }
    if (chatList.length) {
        const store = chatStore(true);
        if (store) store.entries.push(...chatList.map((e) => Object.assign(e, { scope: SCOPE.CHAT })));
    }
    persistGlobal();
    if (chatList.length) persistChat();
    renderList();
    sync();
    alert(`已导入 ${added} 条指令。`);
}

/* ------------------------- 事件绑定 ------------------------- */

function bindEvents() {
    const root = $('.sui-panel');
    if (!root.length || S.bound) return;
    S.bound = true;

    // 顶部
    root.on('change', '.sui-enabled', function () {
        S.settings.enabled = this.checked;
        persistGlobal();
        sync();
    });
    root.on('input', '.sui-prefix', function () {
        S.settings.emphasize_prefix = this.value;
        persistGlobal();
        sync();
    });
    root.on('click', '.sui-add', () => addEntry());
    root.on('click', '.sui-toggle-all', () => {
        const anyOff = allEntries().some(({ entry }) => !entry.enabled);
        for (const { entry } of allEntries()) {
            const found = findEntry(entry.id);
            entry.enabled = anyOff;
            if (found) saveScope(found.scope);
        }
        persistGlobal();
        persistChat();
        renderList();
        sync();
    });
    root.on('click', '.sui-harden', () => {
        if (!confirm('把所有条目改成：聊天内深度 0 + system 角色 + 加强前缀？\n（这是「AI 最容易读到」的位置）')) return;
        for (const { entry, scope } of allEntries()) {
            entry.position = POSITION.IN_CHAT;
            entry.depth = 0;
            entry.role = ROLE.SYSTEM;
            entry.emphasize = true;
            saveScope(scope);
        }
        renderList();
        sync();
    });
    root.on('click', '.sui-export', () => exportJson());
    root.on('click', '.sui-import', () => document.querySelector('.sui-panel .sui-file')?.click());
    root.on('change', '.sui-file', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (file) await importJson(file);
    });
    root.on('click', '.sui-clear', () => {
        const isChat = S.filter === 'chat';
        const isGlobal = S.filter === 'global';
        const label = isChat ? '本聊天的' : isGlobal ? '全局的' : '全部的';
        if (!confirm(`清空${label}指令？（不可撤销，建议先导出备份）`)) return;
        if (isChat || !isGlobal) {
            const store = chatStore(false);
            if (store) store.entries.length = 0;
            persistChat();
        }
        if (isGlobal || !isChat) {
            S.globalEntries.length = 0;
            persistGlobal();
        }
        renderList();
        sync();
    });

    // 模板
    root.on('change', '.sui-template', function () {
        const idx = Number(this.value);
        this.value = '';
        const tpl = TEMPLATES[idx];
        if (!tpl) return;
        addEntry(Object.assign({ collapsed: false }, tpl.entry));
    });

    // 标签页
    root.on('click', '.sui-tab', function () {
        S.filter = this.dataset.filter;
        $('.sui-panel .sui-tab').removeClass('active');
        $(this).addClass('active');
        renderList();
    });

    // 卡片折叠
    root.on('click', '.sui-card-head', function (ev) {
        if ($(ev.target).is('input, select, .sui-icon-btn')) return;
        const card = $(this).closest('.sui-card');
        const id = card.data('id');
        const found = findEntry(id);
        if (!found) return;
        found.entry.collapsed = !found.entry.collapsed;
        card.find('.sui-card-body').toggleClass('sui-hidden', found.entry.collapsed);
        card.find('.sui-fold').text(found.entry.collapsed ? '▾' : '▴');
        saveScope(found.scope);
    });
    root.on('click', '.sui-fold', function () {
        $(this).closest('.sui-card').find('.sui-card-head').trigger('click');
    });

    // 卡片操作
    root.on('click', '.sui-del', function () {
        deleteEntry($(this).closest('.sui-card').data('id'));
    });
    root.on('click', '.sui-dup', function () {
        duplicateEntry($(this).closest('.sui-card').data('id'));
    });
    root.on('click', '.sui-up', function () {
        moveEntry($(this).closest('.sui-card').data('id'), -1);
    });
    root.on('click', '.sui-down', function () {
        moveEntry($(this).closest('.sui-card').data('id'), 1);
    });

    // 卡片字段
    root.on('change', '.sui-enable', function () {
        patchEntry($(this).closest('.sui-card').data('id'), { enabled: this.checked }, { rerender: true });
    });
    root.on('input', '.sui-content', function () {
        patchEntry($(this).closest('.sui-card').data('id'), { content: this.value });
    });
    root.on('input', '.sui-title-input', function () {
        const card = $(this).closest('.sui-card');
        card.find('.sui-title').text(this.value || '(无标题)');
        patchEntry(card.data('id'), { title: this.value });
    });
    root.on('change', '.sui-trigger', function () {
        const card = $(this).closest('.sui-card');
        const value = this.value;
        card.find('.sui-row-keyword').toggleClass('sui-hidden', value !== TRIGGER.KEYWORD);
        card.find('.sui-row-interval').toggleClass('sui-hidden', value !== TRIGGER.INTERVAL);
        patchEntry(card.data('id'), { trigger: value }, { rerender: true });
    });
    root.on('change', '.sui-position', function () {
        const card = $(this).closest('.sui-card');
        const inChat = Number(this.value) === POSITION.IN_CHAT;
        card.find('.sui-row-depth, .sui-row-role').toggleClass('sui-hidden', !inChat);
        patchEntry(card.data('id'), { position: Number(this.value) }, { rerender: true });
    });
    root.on('change', '.sui-scan-scope', function () {
        const card = $(this).closest('.sui-card');
        const recent = this.value === SCAN.RECENT;
        const field = card.find('.sui-scan-messages').closest('.sui-field');
        field.toggleClass('sui-hidden', !recent);
        patchEntry(card.data('id'), { scan_scope: this.value }, { rerender: true });
    });
    root.on('change', '.sui-scope', function () {
        changeScope($(this).closest('.sui-card').data('id'), this.value);
    });

    const numeric = {
        '.sui-depth': 'depth',
        '.sui-priority': 'priority',
        '.sui-sticky': 'sticky',
        '.sui-interval': 'interval',
        '.sui-scan-messages': 'scan_messages',
    };
    for (const [sel, field] of Object.entries(numeric)) {
        root.on('input', sel, function () {
            patchEntry($(this).closest('.sui-card').data('id'), { [field]: Number(this.value) });
        });
    }
    const selects = { '.sui-role': 'role', '.sui-match': 'match' };
    for (const [sel, field] of Object.entries(selects)) {
        root.on('change', sel, function () {
            patchEntry($(this).closest('.sui-card').data('id'), { [field]: Number(this.value) });
        });
    }
    root.on('change', '.sui-emphasize', function () {
        patchEntry($(this).closest('.sui-card').data('id'), { emphasize: this.checked });
    });
    root.on('change', '.sui-scan', function () {
        patchEntry($(this).closest('.sui-card').data('id'), { scan: this.checked });
    });

    // 状态区折叠
    root.on('click', '.sui-status-head', () => {
        $('.sui-panel .sui-status-body').toggleClass('sui-hidden');
    });
}

function buildPanel() {
    const tabs = [
        ['all', '全部'],
        ['global', '全局'],
        ['chat', '本聊天'],
    ]
        .map(([key, label]) => `<div class="sui-tab ${S.filter === key ? 'active' : ''}" data-filter="${key}">${label}</div>`)
        .join('');

    const options = TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');

    return `
    <div class="sui-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>指令</b>
                <span class="sui-sub">自己写死的设定，每轮都塞给 AI</span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" class="sui-enabled" ${S.settings.enabled ? 'checked' : ''}><span>启用本插件</span></label>
                <div class="sui-row" style="margin-top:6px">
                    <span class="sui-field"><label>加强前缀</label><input type="text" class="sui-prefix" value="${esc(S.settings.emphasize_prefix)}" style="width:200px"></span>
                </div>
                <div class="sui-note">建议：重要设定用「常驻 + 聊天内深度 0~2 + system 角色」，这是 AI 最不容易漏掉的位置。改完立即生效，下次生成就会带上。</div>
                <div class="sui-toolbar">
                    <div class="menu_button sui-add"><i class="fa-solid fa-plus"></i> 新建指令</div>
                    <select class="sui-template text_pole" style="max-width:170px"><option value="">模板…</option>${options}</select>
                    <div class="menu_button sui-harden" title="全部改成聊天内深度0 + system + 加强前缀">一键强化</div>
                    <div class="menu_button sui-toggle-all">全部启用/停用</div>
                    <div class="menu_button sui-export">导出</div>
                    <div class="menu_button sui-import">导入</div>
                    <div class="menu_button sui-clear">清空当前标签</div>
                    <input type="file" class="sui-file sui-hidden" accept=".json,application/json">
                </div>
                <div class="sui-tabs">${tabs}</div>
                <div class="sui-list"></div>
                <div class="sui-status">
                    <div class="sui-status-head"><b>本回合生效</b><span class="sui-status-tokens"></span></div>
                    <div class="sui-status-body sui-hidden"><pre class="sui-status-pre"></pre></div>
                </div>
            </div>
        </div>
    </div>`;
}

function mountPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return false;
    if (host.querySelector('.sui-panel')) return true;
    host.insertAdjacentHTML('beforeend', buildPanel());
    bindEvents();
    renderList();
    sync();
    return true;
}

/* ------------------------- ST 生命周期 ------------------------- */

function bindStEvents() {
    const ctx = C();
    if (!ctx?.eventSource) return;
    const et = ctx.eventTypes ?? ctx.event_types ?? {};

    const onSync = () => sync();
    const onChatChanged = () => {
        S.keys = new Set();
        renderList();
        sync();
    };

    ctx.eventSource.on(et.GENERATION_STARTED, onSync);
    ctx.eventSource.on(et.MESSAGE_SENT, onSync);
    ctx.eventSource.on(et.MESSAGE_EDITED, onSync);
    ctx.eventSource.on(et.MESSAGE_DELETED, onSync);
    ctx.eventSource.on(et.MESSAGE_SWIPED, onSync);
    ctx.eventSource.on(et.MESSAGE_RECEIVED, () => consumeSticky());
    ctx.eventSource.on(et.CHAT_CHANGED, onChatChanged);
    ctx.eventSource.on(et.APP_READY, () => {
        loadSettings();
        renderList();
        sync();
    });
}

function boot() {
    if (!C()) return;
    loadSettings();
    if (!mountPanel()) {
        const timer = setInterval(() => {
            if (mountPanel()) clearInterval(timer);
        }, 500);
        setTimeout(() => clearInterval(timer), 30000);
    }
    bindStEvents();
    S.ready = true;
}

if (typeof globalThis.SillyTavern !== 'undefined' && typeof globalThis.jQuery !== 'undefined') {
    globalThis.jQuery(async () => {
        try {
            boot();
        } catch (err) {
            console.error('[指令] 初始化失败', err);
        }
    });
}

/* 供单测使用 */
export const __internals = {
    DEFAULT_SETTINGS,
    TEMPLATES,
    MODULE_NAME,
    sortEntries,
    countUserTurns,
    buildScanText,
    parseKeywords,
    stripRegexSlashes,
};
