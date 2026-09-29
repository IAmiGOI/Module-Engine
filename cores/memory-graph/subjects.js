import { isEvent, kindOf } from './kinds.js';

/**
 * Разрешение имён из ответа модели в ноды графа (MEMORY_GRAPH_TYPES_PLAN.md, этап 3) — чистые функции.
 * Имя субъекта — «Кира», «принцесса», «Marcus»; нода — существующая сущность/объект/факт. События субъектами не бывают.
 */

const normalize = text => String(text ?? '').trim().toLowerCase();
export const MAX_ALIASES = 8;

const wordsOf = text => normalize(text).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3);

/**
 * id ноды по имени или `null`. Порядок: (а) метка целиком без учёта регистра, (б) псевдоним, (в) имя — целое слово метки сущности/объекта
 * (или метка — целое слово имени: «Кира» ↔ «Кира Варех»), (г) иначе `null`. При равенстве в (в) берётся нода с самой короткой
 * меткой — «Кира» точнее, чем «Кира и её путь».
 */
export function resolveSubject(name, nodesById) {
    const wanted = normalize(name);
    if (!wanted) return null;
    const candidates = Object.values(nodesById).filter(node => node?.label && !isEvent(node));
    const exact = candidates.find(node => normalize(node.label) === wanted);
    if (exact) return exact.id;
    const alias = candidates.find(node => (node.aliases ?? []).some(value => normalize(value) === wanted));
    if (alias) return alias.id;
    const wantedWords = wordsOf(wanted);
    if (!wantedWords.length) return null;
    // Вхождение слова — только у сущностей/объектов: «Marcus» не должен находить факт «Marcus is a smith».
    const partial = candidates
        .filter(node => kindOf(node) === 'entity' || kindOf(node) === 'object')
        .filter(node => {
            const labelWords = wordsOf(node.label);
            return labelWords.length && (labelWords.every(word => wantedWords.includes(word)) || wantedWords.every(word => labelWords.includes(word)));
        })
        .sort((a, b) => a.label.length - b.label.length)[0];
    return partial?.id ?? null;
}

/** Дописывает псевдонимы ноде: без дублей (и без совпадения с меткой), максимум `MAX_ALIASES`. Возвращает, изменилось ли. */
export function addAliases(node, aliases) {
    const known = new Set([normalize(node.label), ...(node.aliases ?? []).map(normalize)]);
    const next = [...(node.aliases ?? [])];
    for (const alias of aliases ?? []) {
        const clean = String(alias ?? '').trim();
        if (!clean || known.has(normalize(clean)) || next.length >= MAX_ALIASES) continue;
        known.add(normalize(clean));
        next.push(clean);
    }
    if (next.length === (node.aliases ?? []).length) return false;
    node.aliases = next;
    return true;
}
