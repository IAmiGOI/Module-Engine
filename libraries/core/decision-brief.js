import { CHAT_BRIEF_HEADER } from './decision-prompts.js';

/** CHAT BRIEF: рендер, раздел TIMELINE и разбор списка банков. Чистые функции. */

const text = value => String(value ?? '').trim();
const KNOWN = ['TIMELINE', 'WORLD AT THE START', 'WHO KNOWS WHOM', 'DIFFERENCES FROM CANON', 'ASSUMPTIONS'];

export function normalizeTimelineBanks(value) {
    return (Array.isArray(value) ? value : [])
        .map(item => ({ name: text(item?.name), note: text(item?.note) }))
        .filter(item => item.name);
}

export function normalizeBrief(value) {
    if (!value || typeof value !== 'object') return null;
    const body = text(value.text ?? value.brief);
    if (!body) return null;
    return {
        text: body,
        timeline: text(value.timeline) || extractBriefSection(body, 'TIMELINE'),
        timelineBanks: normalizeTimelineBanks(value.timelineBanks),
        at: Number(value.at) || 0,
    };
}

export function renderChatBrief(value) {
    const brief = normalizeBrief(value);
    return brief ? `${CHAT_BRIEF_HEADER}\n\n${brief.text}` : '';
}

/** Вырезает раздел по заголовку; заголовки других разделов закрывают его. */
export function extractBriefSection(body, name) {
    const wanted = text(name).toUpperCase();
    if (!wanted) return '';
    const lines = String(body ?? '').split('\n');
    const out = [];
    let active = false;
    for (const line of lines) {
        const match = /^\s*(?:\*\*)?([A-Z][A-Z0-9 _-]*)(?:\*\*)?\s*(?::\s*(.*))?$/.exec(line);
        if (match) {
            const key = match[1].trim().toUpperCase();
            if (key === wanted) {
                active = true;
                if (text(match[2])) out.push(text(match[2]));
                continue;
            }
            if (active && (KNOWN.includes(key) || /^[A-Z][A-Z0-9 _-]{2,}$/.test(key))) break;
        }
        if (active) out.push(line);
    }
    return out.join('\n').trim();
}
