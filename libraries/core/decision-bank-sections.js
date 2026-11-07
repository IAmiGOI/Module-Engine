/**
 * Разделы Great Bank — чистые данные: оба деления, указ, уровни важности и
 * поиск раздела по номеру, названию или похожему слову. Ни хранения, ни
 * моделей: этим пользуются и разбор сборщика, и проекции, и правка.
 */

const text = value => String(value ?? '').trim();

export const IMPORTANCE_LEVELS = Object.freeze(['main', 'side', 'temporary', 'mass']);

export const MATERIAL_SECTIONS = Object.freeze([
    { part: 'material', no: 1, id: 'appearance', name: 'Appearance' },
    { part: 'material', no: 2, id: 'property', name: 'Property' },
    { part: 'material', no: 3, id: 'life', name: 'Life facts' },
    { part: 'material', no: 4, id: 'carried', name: 'Carried items' },
    { part: 'material', no: 5, id: 'clothing', name: 'Clothing' },
    { part: 'material', no: 6, id: 'abilities', name: 'Abilities' },
    { part: 'material', no: 7, id: 'other-material', name: 'Other material facts' },
]);

export const SPIRITUAL_SECTIONS = Object.freeze([
    { part: 'spiritual', no: 1, id: 'values', name: 'Values' },
    { part: 'spiritual', no: 2, id: 'likes', name: 'Likes and dislikes' },
    { part: 'spiritual', no: 3, id: 'emotions', name: 'Emotional display and public mood' },
    { part: 'spiritual', no: 4, id: 'needs', name: 'Needs and goals' },
    { part: 'spiritual', no: 5, id: 'speech', name: 'Speech and thinking patterns' },
    { part: 'spiritual', no: 6, id: 'resolving', name: 'Resolving' },
]);

/** Указ — пять полей владельца. Место в хранении есть, инструмента ещё нет (фаза 4). */
export const DECREE_SECTIONS = Object.freeze([
    { part: 'decree', no: 1, id: 'decree-core', name: 'The values and facts that matter most for understanding them' },
    { part: 'decree', no: 2, id: 'decree-self', name: 'How they see themselves' },
    { part: 'decree', no: 3, id: 'decree-goals', name: 'Their goal: the long one and the one for today' },
    { part: 'decree', no: 4, id: 'decree-mood', name: 'Their mood for the day' },
    { part: 'decree', no: 5, id: 'decree-resolving', name: 'Their rules of resolving right now' },
]);

/** Внутреннее ведро духовного: неразобранный раздел не теряется и в проекциях не печатается. */
export const OTHER_SPIRITUAL = Object.freeze({ part: 'spiritual', no: 0, id: 'other-spiritual', name: 'Other spiritual facts' });
export const ALL_SECTIONS = Object.freeze([...MATERIAL_SECTIONS, ...SPIRITUAL_SECTIONS]);

export function sectionsOf(part) {
    if (part === 'material') return MATERIAL_SECTIONS;
    if (part === 'spiritual') return [...SPIRITUAL_SECTIONS, OTHER_SPIRITUAL];
    if (part === 'decree') return DECREE_SECTIONS;
    return ALL_SECTIONS;
}

/** Не угадан раздел — правка идёт в «Другие факты» своей части. */
export const otherSection = part => (part === 'spiritual' ? OTHER_SPIRITUAL : MATERIAL_SECTIONS[6]);

export function sectionLabel(part, no) {
    const section = sectionsOf(part).find(item => item.no === Number(no));
    return section ? section.name : '';
}

const SYNONYMS = Object.freeze({
    appearance: ['look', 'looks', 'body', 'face', 'hair', 'height', 'build', 'eyes', 'внешность', 'вид'],
    property: ['possessions', 'belongings', 'wealth', 'money', 'home', 'house', 'owns', 'имущество'],
    life: ['history', 'backstory', 'past', 'biography', 'present', 'жизнь'],
    carried: ['carries', 'carry', 'items', 'inventory', 'pockets', 'weapons', 'предметы'],
    clothing: ['clothes', 'outfit', 'dress', 'wears', 'wardrobe', 'одежда'],
    abilities: ['skills', 'powers', 'magic', 'strengths', 'weaknesses', 'combat', 'способности'],
    'other-material': ['other', 'misc', 'miscellaneous', 'другое'],
    values: ['morals', 'principles', 'beliefs', 'ценности'],
    likes: ['dislikes', 'preferences', 'loves', 'hates', 'favourites', 'предпочтения'],
    emotions: ['feelings', 'mood', 'expression', 'temper', 'эмоции'],
    needs: ['goals', 'wants', 'desires', 'aims', 'потребности', 'цели'],
    speech: ['voice', 'talk', 'thinking', 'patterns', 'речь'],
    resolving: ['decisions', 'choices', 'chooses', 'judgment', 'резолвинг'],
});

const STOPWORDS = new Set(['material', 'spiritual', 'section', 'the', 'of', 'and', 'раздел', 'пункт']);

function words(value) {
    return text(value).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function scoreSection(section, query) {
    if (!query.length) return 0;
    const own = [...words(section.id.replace(/-/g, ' ')), ...words(section.name), ...(SYNONYMS[section.id] ?? []).flatMap(words)];
    const hits = query.filter(word => own.some(candidate => candidate === word || candidate.startsWith(word) || word.startsWith(candidate)));
    const score = hits.length / query.length;
    if (score >= 0.6) return score;
    // Точное слово (название, id или синоним) — уже узнавание: «what she wears» — про одежду.
    return query.some(word => own.includes(word)) ? 0.6 : score;
}

/**
 * Разбор раздела: номер, название или похожее слово; не угадано — «Остальное»
 * своей части. `bareNumber` — номер без названия части: оба деления
 * нумеруются с единицы, поэтому такой раздел правка доуточняет по строке.
 * «Knowledge» и «Decree» — отдельные блоки, не разделы.
 */
export function resolveSection(value) {
    const raw = text(value).toLowerCase();
    if (!raw) return { kind: 'section', part: 'material', no: MATERIAL_SECTIONS[6].no, bareNumber: true };
    if (/^(knowledge|знания)\b/.test(raw)) return { kind: 'knowledge' };
    if (/^(decree|указ)\b/.test(raw)) return { kind: 'decree', part: 'decree', no: 1, bareNumber: false };
    const part = /material|предметн/.test(raw) ? 'material' : /spiritual|духовн/.test(raw) ? 'spiritual' : null;
    const list = part ? sectionsOf(part) : ALL_SECTIONS;
    const numeric = /^\s*(\d{1,2})\s*$/.exec(raw) ?? /(?:^|\D)(\d{1,2})(?:\D|$)/.exec(raw);
    if (numeric) {
        const hit = list.find(section => section.no === Number(numeric[1]));
        if (hit) return { kind: 'section', part: hit.part, no: hit.no, bareNumber: !part };
    }
    const query = words(raw).filter(word => !STOPWORDS.has(word));
    const scored = list.map(section => ({ section, score: scoreSection(section, query) })).sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 0.6) return { kind: 'section', part: scored[0].section.part, no: scored[0].section.no, bareNumber: false };
    const fallback = part ?? 'material';
    return { kind: 'section', part: fallback, no: otherSection(fallback).no, bareNumber: false };
}
