import { SCALES_HINT_HEADER, SCALES_HINT_QUESTION, fillPrompt } from './decision-prompts.js';
import { ruleCard } from './rule-card.js';

/**
 * Подсказка резолверу: каких систем Scales касается ход. Классификатор (Noul)
 * отвечает по одному утверждению на систему, а в контекст идут карточки правил
 * только тех систем, что прошли порог. Чистые функции: сеть — у Ядра.
 */

export const SCALES_HINT_THRESHOLD = 0.2;
const MESSAGE_LIMIT = 1500;
const MESSAGE_COUNT = 3;

const text = value => String(value ?? '').trim();
const scaleKey = (system, index) => text(system?.id) || `scale:${index}`;

/** Три последних сообщения чата: два предыдущих коротко, последнее — как есть. */
export function scalesHintState(chat) {
    const list = (Array.isArray(chat) ? chat : [])
        .filter(entry => entry && entry.is_system !== true)
        .map(entry => ({ user: entry.is_user === true, text: text(entry.mes ?? entry.content) }))
        .filter(entry => entry.text)
        .slice(-MESSAGE_COUNT);
    if (!list.length) return '';
    const latest = list.at(-1);
    const lines = list.slice(0, -1).map(entry => `${entry.user ? 'User' : 'Story'}: ${entry.text.slice(0, MESSAGE_LIMIT)}`);
    lines.push(`User (latest): ${latest.text}`);
    return lines.join('\n');
}

/** Первое предложение принципа без markdown-разметки. */
export function firstSentence(value) {
    const clean = text(value).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const found = /^.*?[.!?…](?=\s|$)/.exec(clean);
    return text(found ? found[0] : clean);
}

/** По одному утверждению на систему: вопрос знает, как система называется и чем она является. */
export function scalesHintQuestions(systems) {
    const out = {};
    (Array.isArray(systems) ? systems : []).forEach((system, index) => {
        const name = text(system?.name);
        if (!name) return;
        out[scaleKey(system, index)] = fillPrompt(SCALES_HINT_QUESTION, { system: name, principle: firstSentence(system?.principle) });
    });
    return out;
}

/** Системы, чья оценка дошла до порога; порядок — как в Creation. */
export function scalesHintSystems(systems, answers, threshold = SCALES_HINT_THRESHOLD) {
    const limit = Number(threshold);
    return (Array.isArray(systems) ? systems : [])
        .map((system, index) => ({ system, index, chance: Number(answers?.[scaleKey(system, index)]) }))
        .filter(item => Number.isFinite(item.chance) && item.chance >= limit)
        .map(item => ({ system: item.system, name: text(item.system?.name), chance: item.chance }));
}

/** Блок в хвост задания хода: заголовок и карточки правил найденных систем. */
export function scalesHintBlock(hinted) {
    const cards = (Array.isArray(hinted) ? hinted : [])
        .flatMap(item => (Array.isArray(item?.system?.rules) ? item.system.rules : []).map(rule => ruleCard(item.system, rule)))
        .filter(Boolean);
    if (!cards.length) return '';
    return [SCALES_HINT_HEADER, ...cards].join('\n\n');
}
