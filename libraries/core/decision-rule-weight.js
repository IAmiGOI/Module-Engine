/**
 * Трудность броска по правилу системы мира: база — уровень Weight самого правила, дальше шаг вверх за каждое названное
 * повышение и шаг вниз за каждое понижение (из правила или помеха/подмога, уже бывшая в сцене). Резолвер раньше ставил
 * трудность сам и называл правилом то, чего в правиле нет («сложная конструкция — трудно»): крылья из маны вышли 15%
 * вместо ~45%. Чистые функции.
 */
import { DIFFICULTY_LEVELS } from './decision-probability.js';
import { findScaleSystem } from './decision-scales.js';

const text = value => String(value ?? '').trim();
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** «Система / Правило» или просто «Правило» → { system, rule } среди систем мира. */
export function findRule(systems, name) {
    const wanted = text(name);
    if (!wanted) return null;
    const [left, right] = wanted.includes('/') ? wanted.split('/').map(text) : ['', wanted];
    const pool = left ? [findScaleSystem(systems, left)].filter(Boolean) : (Array.isArray(systems) ? systems : []);
    const target = slug(right);
    for (const exact of [true, false]) {
        for (const system of pool) {
            for (const rule of Array.isArray(system?.rules) ? system.rules : []) {
                const name = slug(rule?.name);
                if (exact ? name === target : (name.includes(target) || (target.length > 6 && target.includes(name)))) return { system, rule };
            }
        }
    }
    return null;
}

/** Что бывает при неудаче — строки Cost правила с «Clumsy»/«Botched»; без них — пусто. */
export function failureOf(rule) {
    const cost = (Array.isArray(rule?.cost) ? rule.cost : [rule?.cost]).map(text).join(' ');
    const clumsy = /Clumsy\s*[—-]\s*([^.]*(?:\.[^.A-Z][^.]*)*)/.exec(cost)?.[1] ?? '';
    const botched = /Botched\s*[—-]\s*([^.]*(?:\.[^.A-Z][^.]*)*)/.exec(cost)?.[1] ?? '';
    return { clumsy: text(clumsy), botched: text(botched) };
}

/** Все правила мира строкой «Система / Правило» — для отказа с подсказкой. */
export function ruleNames(systems) {
    return (Array.isArray(systems) ? systems : []).flatMap(system => (Array.isArray(system?.rules) ? system.rules : []).map(rule => `${text(system.name)} / ${text(rule.name)}`));
}

/** Уровни, которые вес правила называет: поле level и все уровни в его тексте («умеренно для простого; трудно для сложного»). */
export function ruleLevels(rule) {
    const words = `${text(rule?.weight?.level)} ${text(rule?.weight?.text)}`.toLowerCase();
    // «very hard» и «nearly impossible» — раньше «hard»/«impossible», чтобы не засчитать часть слова.
    const found = [...DIFFICULTY_LEVELS].sort((a, b) => b.length - a.length).filter(level => new RegExp(`(^|[^a-z])${level}([^a-z]|$)`).test(words.replace(/very hard|nearly impossible/g, match => (level === match ? match : ' '))));
    return DIFFICULTY_LEVELS.filter(level => found.includes(level));
}

/**
 * База и шаги → итоговая трудность. База — уровень, который вес правила называет для такого рода работы (`chosen`,
 * если он среди названных правилом; иначе поле level). Сверх этого — только названные повышения и понижения.
 */
export function ruleDifficulty(rule, { rises = [], falls = [], chosen = '' } = {}) {
    const named = ruleLevels(rule);
    const wanted = text(chosen).toLowerCase();
    const base = named.includes(wanted) ? wanted : text(rule?.weight?.level).toLowerCase();
    const start = DIFFICULTY_LEVELS.indexOf(base);
    if (start < 0) return null;
    const up = (Array.isArray(rises) ? rises : []).map(text).filter(Boolean);
    const down = (Array.isArray(falls) ? falls : []).map(text).filter(Boolean);
    const index = Math.max(0, Math.min(DIFFICULTY_LEVELS.length - 1, start + up.length - down.length));
    return { base, named, difficulty: DIFFICULTY_LEVELS[index], rises: up, falls: down };
}

const STOP = new Set(['with', 'when', 'from', 'that', 'this', 'they', 'their', 'into', 'than', 'have', 'been', 'only', 'more', 'less', 'over', 'under', 'what', 'which', 'caster', 'casters', 'already', 'rises', 'falls']);
const words = value => new Set(text(value).toLowerCase().match(/[a-z]{4,}/g)?.filter(word => !STOP.has(word)).map(word => word.replace(/(ing|ed|es|s)$/, '')) ?? []);
const EXPERIENCE = /\b(in)?experience(d)?\b|\b(un)?practi[sc]ed\b|\bskill(ed)?\b|\bnovice\b|\bfirst time\b/i;
const TRAIT = /\b(mana (capacity|pool|reserves?)|enormous mana|vast mana|talent(ed)?|gift(ed)?|innate)\b/i;

/**
 * Каждый шаг — «rule: …» (условие из повышений/понижений самого правила — сверяется по словам) или «scene: …»
 * (помеха или подмога, уже бывшая в сцене). Черта персонажа — опыт, а не шаг, если правило её не называет.
 * @returns строки ошибок; пусто — шаги приняты
 */
export function checkSteps(rule, { rises = [], falls = [] } = {}) {
    const errors = [];
    const ruleText = `${text(rule?.weight?.rises)} ${text(rule?.weight?.falls)} ${text(rule?.weight?.text)}`;
    const ruleWords = words(ruleText);
    for (const [side, list] of [['rises', rises], ['falls', falls]]) {
        for (const raw of Array.isArray(list) ? list : []) {
            const item = text(raw);
            if (!item) continue;
            const match = /^(rule|scene)\s*:\s*(.+)$/i.exec(item);
            if (!match) { errors.push(`${side}: "${item}" — start it with "rule:" (a condition the rule itself lists) or "scene:" (an obstacle or help already established in the scene).`); continue; }
            const [, source, body] = match;
            if (EXPERIENCE.test(body)) { errors.push(`${side}: "${body}" is about their experience — that is the experience level, already counted; it is never a step.`); continue; }
            if (TRAIT.test(body) && !TRAIT.test(ruleText)) { errors.push(`${side}: "${body}" is the character's own trait — that is their experience, not a step.`); continue; }
            if (source.toLowerCase() === 'rule') {
                const own = [...words(body)];
                const shared = own.filter(word => ruleWords.has(word)).length;
                if (shared < Math.min(2, own.length)) errors.push(`${side}: "${body}" is not in this rule — its ${side} are: ${text(side === 'rises' ? rule?.weight?.rises : rule?.weight?.falls) || 'none'}. Use "scene:" only for what the scene already established.`);
            }
        }
    }
    return errors;
}

const joined = list => (Array.isArray(list) ? list : [list]).map(text).filter(Boolean).join(' ');

/** Полная карточка правила — резолвер видит её, когда называет правило: снимок мира мог её не содержать. */
export function ruleCard(system, rule) {
    return [
        `RULE ${text(system?.name)} / ${text(rule?.name)}`,
        `Needs: ${joined(rule?.needs) || '—'}`,
        `Yields: ${joined(rule?.yields) || '—'}`,
        `Weight: ${text(rule?.weight?.text) || text(rule?.weight?.level) || '—'}`,
        `Scaling: ${joined(rule?.scaling) || '—'}`,
        `Limit: ${joined(rule?.limit) || '—'}`,
    ].join('\n');
}

/** Правила свободной работы — те, чьи Needs строятся на воображении персонажа. */
export function freeformRules(systems) {
    return (Array.isArray(systems) ? systems : []).flatMap(system => (Array.isArray(system?.rules) ? system.rules : [])
        .filter(rule => /imagin|imagery|freeform|visuali[sz]/i.test(`${rule?.name} ${joined(rule?.needs)}`))
        .map(rule => `${text(system.name)} / ${text(rule.name)}`));
}

/** Процитированное резолвером есть в тексте правила: общие значимые слова. */
export function quotes(source, quoted) {
    const own = [...words(quoted)];
    if (!own.length) return false;
    const pool = words(joined(source));
    const shared = own.filter(word => pool.has(word)).length;
    return shared >= Math.min(3, own.length) || shared / own.length >= 0.5;
}

/** Насколько способ (словами пользователя) совпадает с Needs правила: доля его значимых слов, которые есть в Needs. */
export function methodFits(needs, method) {
    const own = [...words(method)];
    if (!own.length) return 0;
    const pool = words(joined(needs));
    return own.filter(word => pool.has(word)).length / own.length;
}
