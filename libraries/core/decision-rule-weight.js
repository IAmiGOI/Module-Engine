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
