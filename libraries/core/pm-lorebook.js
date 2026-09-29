import { estimateTokens } from './pm-tokens.js';

/**
 * Собственный движок активации лорбука (решение владельца: результат ST не используем).
 * Чистая функция над записями формата ST World Info (их отдаёт Ядро лорбука, `lorebook.scan`).
 *
 * Поддержано: constant, ключи (простые и `/regex/флаги`), caseSensitive, matchWholeWords,
 * selective + selectiveLogic (0 AND_ANY, 1 NOT_ALL, 2 NOT_ANY, 3 AND_ALL), scanDepth (запись/общий),
 * probability (с зерном — воспроизводимо), sticky / cooldown / delay (в сообщениях чата),
 * рекурсия (excludeRecursion, preventRecursion, delayUntilRecursion), бюджет токенов, порядок.
 * Позиции: 0 before, 1 after, 2/3 Author's Note top/bottom, 4 на глубину, 5/6 примеры диалога top/bottom.
 * Правила порядка и границы бюджета сверить с живым ST (PROMPT_MANAGER_PLAN.md, раздел 2).
 *
 * activateEntries(entries, { messages, chatLength, scanDepth, budgetTokens, maxRecursion, random, timed })
 *   messages — тексты сообщений, НОВЫЕ ПЕРВЫМИ; timed — состояние sticky/cooldown прошлых ходов (мутируется)
 *   → { before, after, anTop, anBottom, examplesTop, examplesBottom, depth: [{depth, role, content, order}], activated, skipped }
 */
const ROLES = ['system', 'user', 'assistant'];

function toRegex(key, flags) {
    const match = /^\/(.+)\/([a-z]*)$/i.exec(key);
    if (!match) return null;
    try { return new RegExp(match[1], match[2] || flags); } catch { return null; }
}

function keyMatches(key, text, entry) {
    const trimmed = String(key ?? '').trim();
    if (!trimmed) return false;
    const flags = entry.caseSensitive ? '' : 'i';
    const regex = toRegex(trimmed, flags);
    if (regex) return regex.test(text);
    const haystack = entry.caseSensitive ? text : text.toLowerCase();
    const needle = entry.caseSensitive ? trimmed : trimmed.toLowerCase();
    if (entry.matchWholeWords && !/\s/.test(needle)) {
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, entry.caseSensitive ? 'u' : 'iu').test(text);
    }
    return haystack.includes(needle);
}

function matchesKeys(entry, text) {
    const primary = (entry.key ?? []).filter(Boolean);
    if (!primary.length || !primary.some(key => keyMatches(key, text, entry))) return false;
    const secondary = (entry.keysecondary ?? []).filter(Boolean);
    if (!entry.selective || !secondary.length) return true;
    const hits = secondary.map(key => keyMatches(key, text, entry));
    switch (entry.selectiveLogic ?? 0) {
        case 1: return !hits.every(Boolean);
        case 2: return !hits.some(Boolean);
        case 3: return hits.every(Boolean);
        default: return hits.some(Boolean);
    }
}

export function activateEntries(entries, { messages = [], chatLength = messages.length, scanDepth = 4, budgetTokens = Infinity, maxRecursion = 3, random = Math.random, timed = {} } = {}) {
    const activated = new Map(); // uid -> { entry, reason }
    const skipped = [];
    const baseText = depth => messages.slice(0, Math.max(depth, 0)).join('\n');
    const usable = entries.filter(entry => !entry.disable && String(entry.content ?? '').trim());

    const eligible = entry => {
        const state = timed[entry.uid] ?? {};
        if (entry.delay && chatLength < entry.delay) return 'delay';
        const sticky = state.stickyUntil !== undefined && chatLength < state.stickyUntil;
        if (!sticky && state.cooldownUntil !== undefined && chatLength < state.cooldownUntil) return 'cooldown';
        return null;
    };
    const passProbability = entry => !(entry.useProbability && entry.probability < 100) || random() * 100 < entry.probability;

    let recursionText = '';
    for (let pass = 0; pass <= maxRecursion; pass++) {
        let added = false;
        for (const entry of usable) {
            if (activated.has(entry.uid)) continue;
            if (pass === 0 && entry.delayUntilRecursion) continue;
            if (pass > 0 && entry.excludeRecursion) continue;
            const blocked = eligible(entry);
            if (blocked) { skipped.push({ uid: entry.uid, reason: blocked }); continue; }
            const state = timed[entry.uid] ?? {};
            const sticky = state.stickyUntil !== undefined && chatLength < state.stickyUntil;
            const text = `${baseText(entry.scanDepth ?? scanDepth)}\n${recursionText}`;
            const reason = sticky ? 'sticky' : entry.constant ? 'constant' : matchesKeys(entry, text) ? 'key' : null;
            if (!reason) continue;
            if (reason !== 'sticky' && !passProbability(entry)) { skipped.push({ uid: entry.uid, reason: 'probability' }); continue; }
            activated.set(entry.uid, { entry, reason });
            added = true;
        }
        if (!added) break;
        recursionText = [...activated.values()].filter(a => !a.entry.preventRecursion).map(a => a.entry.content).join('\n');
    }

    // Бюджет: важнее запись с большим order (constant — вне бюджета).
    let spent = 0;
    const ranked = [...activated.values()].sort((a, b) => (b.entry.order ?? 100) - (a.entry.order ?? 100));
    const kept = [];
    for (const item of ranked) {
        const cost = estimateTokens(item.entry.content);
        if (item.reason !== 'constant' && spent + cost > budgetTokens) { skipped.push({ uid: item.entry.uid, reason: 'budget' }); activated.delete(item.entry.uid); continue; }
        spent += cost;
        kept.push(item);
    }
    for (const { entry, reason } of kept) {
        const state = timed[entry.uid] ?? (timed[entry.uid] = {});
        if (reason !== 'sticky') {
            if (entry.sticky) state.stickyUntil = chatLength + entry.sticky;
            if (entry.cooldown) state.cooldownUntil = chatLength + (entry.sticky ?? 0) + entry.cooldown;
        }
    }

    const byPosition = position => kept.filter(({ entry }) => (entry.position ?? 0) === position)
        .sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100)).map(({ entry }) => entry.content);
    return {
        before: byPosition(0), after: byPosition(1), anTop: byPosition(2), anBottom: byPosition(3),
        examplesTop: byPosition(5), examplesBottom: byPosition(6),
        depth: kept.filter(({ entry }) => (entry.position ?? 0) === 4)
            .map(({ entry }) => ({ depth: entry.depth ?? 4, role: ROLES[entry.role ?? 0] ?? 'system', content: entry.content, order: entry.order ?? 100, uid: entry.uid })),
        activated: kept.map(({ entry, reason }) => ({ uid: entry.uid, book: entry.book, comment: entry.comment, reason, tokens: estimateTokens(entry.content) })),
        skipped,
    };
}
