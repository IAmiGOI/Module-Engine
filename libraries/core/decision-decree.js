/**
 * Указ (Decree) — чистые правила: форма пяти полей, оси настроения и
 * сравнение. Ни хранения, ни модели: запись в Great Bank делает ядро
 * (`cores/decision/bank-great.js`), а сюда приходит разобранный вызов
 * инструмента `decree`.
 *
 * Поля владельца: 1 самые важные ценности и факты; 2 как персонаж видит
 * себя; 3 цель — длинная и на день; 4 настроение дня; 5 правила резолвинга
 * на сейчас. Настроение — по осям словами, каждая «slightly», «strongly»
 * или «neutral».
 */

const text = value => String(value ?? '').trim();

export const MOOD_AXES = Object.freeze([
    { key: 'calm', opposite: 'agitated', label: 'calm ↔ agitated' },
    { key: 'warm', opposite: 'cold', label: 'warm ↔ cold' },
    { key: 'lively', opposite: 'tired', label: 'lively ↔ tired' },
]);

export const MOOD_LEVELS = Object.freeze(['slightly', 'strongly', 'neutral']);

const LEVEL_WORDS = Object.freeze({
    slightly: 'slightly', slight: 'slightly', little: 'slightly', somewhat: 'slightly', lightly: 'slightly', mildly: 'slightly',
    strongly: 'strongly', strong: 'strongly', very: 'strongly', deeply: 'strongly', greatly: 'strongly', heavily: 'strongly',
    neutral: 'neutral', even: 'neutral', none: 'neutral', normal: 'neutral', balanced: 'neutral',
});

function levelOf(value) {
    const clean = text(value).toLowerCase();
    if (LEVEL_WORDS[clean]) return LEVEL_WORDS[clean];
    for (const [word, level] of Object.entries(LEVEL_WORDS)) {
        if (clean.includes(word)) return level;
    }
    return 'neutral';
}

/** Строка или массив → строки поля; `- ` снимается, пустое отбрасывается. */
export function decreeLines(value) {
    const list = Array.isArray(value) ? value : [value];
    return list
        .flatMap(item => text(item).split('\n'))
        .map(line => line.replace(/^\s*[-•*]\s*/, '').trim())
        .filter(Boolean);
}

/**
 * Настроение по осям. Принимает объект (`{ calm: 'slightly', warm: 'strongly' }`)
 * или строку («slightly calm, strongly warm, neutral»). Неизвестное остаётся
 * текстом как есть — Указ не теряется.
 */
function axisLine(axis, pole = '', level = 'neutral') {
    const clean = MOOD_LEVELS.includes(level) ? level : 'neutral';
    const toward = clean !== 'neutral' && pole ? ` toward ${pole}` : '';
    return `${axis.key} ↔ ${axis.opposite}: ${clean}${toward}`;
}

export function normalizeMood(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return MOOD_AXES.map(axis => {
            const key = Object.keys(value).find(name => [axis.key, axis.opposite].includes(String(name).toLowerCase()));
            if (!key) return axisLine(axis);
            return axisLine(axis, String(key).toLowerCase(), levelOf(value[key]));
        }).join('; ');
    }
    const raw = text(value);
    if (!raw) return MOOD_AXES.map(axis => axisLine(axis)).join('; ');
    // Свой же вид «calm ↔ agitated: slightly toward agitated» — полюс после «toward», а не первое слово оси.
    const canonical = MOOD_AXES.map(axis => {
        const match = new RegExp(`${axis.key}\\s*↔\\s*${axis.opposite}\\s*:\\s*([a-z]+)(?:\\s+toward\\s+([a-z]+))?`, 'i').exec(raw);
        if (!match) return null;
        const pole = [axis.key, axis.opposite].includes(String(match[2] ?? '').toLowerCase()) ? match[2].toLowerCase() : '';
        return axisLine(axis, pole, pole ? levelOf(match[1]) : 'neutral');
    });
    if (canonical.some(Boolean)) return canonical.map((line, index) => line ?? axisLine(MOOD_AXES[index])).join('; ');
    const words = raw.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
    const lines = [];
    for (const axis of MOOD_AXES) {
        const at = words.findIndex(word => word === axis.key || word === axis.opposite);
        if (at < 0) { lines.push(axisLine(axis)); continue; }
        // Сила стоит рядом с осью — до или сразу после неё; «slightly agitated, strongly warm» не путает оси.
        const window = words.slice(Math.max(0, at - 2), at + 3);
        const level = window.map(levelOf).find(candidate => candidate !== 'neutral') ?? 'neutral';
        lines.push(axisLine(axis, words[at], level));
    }
    return lines.some(line => !line.endsWith('neutral')) ? lines.join('; ') : raw;
}

/** Один Указ → пять полей Great Bank (списки строк). */
export function normalizeDecree(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const name = text(source.character ?? source.name);
    if (!name) return null;
    const goals = source.goals && typeof source.goals === 'object' && !Array.isArray(source.goals) ? source.goals : {};
    const long = text(goals.long ?? goals.longTerm ?? source.longGoal);
    const today = text(goals.today ?? goals.daily ?? source.todayGoal);
    const goalLines = [long ? `Long goal: ${long}` : '', today ? `Today: ${today}` : ''].filter(Boolean);
    return {
        character: name,
        valuesAndFacts: decreeLines(source.valuesAndFacts ?? source.values ?? source.facts),
        selfView: decreeLines(source.selfView ?? source.self ?? source.selfImage),
        goals: { long, today, lines: goalLines },
        mood: normalizeMood(source.mood),
        resolving: decreeLines(source.resolving ?? source.resolve ?? source.rules),
    };
}

/** Пять полей Указа → разделы 1–5 записи Great Bank. */
export function decreeSections(decree) {
    // Указ, записанный файлом (`decree.md`), приходит готовыми разделами — без разбора полей.
    if (decree?.sections && typeof decree.sections === 'object') {
        return Object.fromEntries([1, 2, 3, 4, 5].map(no => [no, decreeLines(decree.sections[no] ?? [])]));
    }
    return {
        1: decreeLines(decree?.valuesAndFacts),
        2: decreeLines(decree?.selfView),
        3: decreeLines(decree?.goals?.lines),
        4: decree?.mood ? [text(decree.mood)] : [],
        5: decreeLines(decree?.resolving),
    };
}

/** Разобранные указы без пустых и без повторов имён (последний выигрывает). */
export function normalizeDecrees(list) {
    const seen = new Map();
    for (const item of Array.isArray(list) ? list : []) {
        const decree = normalizeDecree(item);
        if (!decree) continue;
        seen.set(decree.character.toLowerCase(), decree);
    }
    return [...seen.values()];
}

/** Прежний и новый Указ совпадают по всем пяти полям — историю не плодим. */
export function sameDecree(a, b) {
    const left = JSON.stringify(decreeSections(a));
    const right = JSON.stringify(decreeSections(b));
    return left === right;
}

/** Указ заполнен хотя бы одним полем. */
export function hasDecree(decree) {
    return Object.values(decree?.sections ?? decree ?? {}).some(lines => Array.isArray(lines) && lines.some(line => text(line)));
}
