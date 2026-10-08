import { cosineSimilarity } from '../../libraries/core/embedding.js';
import { gameTimeKey } from './game-time.js';
import { isEvent, kindOf } from './kinds.js';

/**
 * Состояния, которые меняются со временем (одежда, место, настроение, ранение), — чистые функции. Факт «Nyx носит белое платье» и
 * факт «Nyx носит чёрное пальто» не дубли и не уточнения друг друга: второй ЗАМЕНЯЕТ первый. Модель помечает такие факты
 * одинаковым `attribute` («outfit»); граф здесь решает, какой из них действует сейчас. Старое значение не удаляется — оно
 * остаётся в графе как история (`supersededBy`), но выпадает из ретрива.
 */

export const normalizeAttribute = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);

/** Действует ли нода сейчас: не заменена другой. */
export const isCurrentState = node => !node?.supersededBy;

/** Есть ли у ноды состояние (`attribute`), которое может смениться. События — точки на линии времени, состояний не бывают. */
export const hasState = node => Boolean(node?.attribute) && !isEvent(node);

/** Общий субъект двух нод: у первого субъекта новой ноды есть общий с субъектами старой (список `subjectIds`). */
export function sharesSubject(a, b) {
    const left = a.subjectIds ?? [];
    const right = b.subjectIds ?? [];
    if (!left.length || !right.length) return false;
    return right.includes(left[0]) || left.includes(right[0]);
}

/**
 * Заменяет ли новая нода `created` какие-то из действующих: тот же `attribute`, общий субъект, не событие. Время решает, КТО новее:
 * если у обеих нод есть игровое время и у новой оно РАНЬШЕ (воспоминание о прошлом), новая нода сама оказывается устаревшей, а не
 * действующей; иначе новее ту, что пришла позже. Возвращает `{ supersede: [id…], supersededBy: id | null }`.
 */
export function planSupersession(created, nodesById) {
    if (!hasState(created)) return { supersede: [], supersededBy: null };
    const createdKey = gameTimeKey(created.gameTime);
    const supersede = [];
    let supersededBy = null;
    let latestKey = -Infinity;
    for (const other of Object.values(nodesById)) {
        if (!other || other.id === created.id || !isCurrentState(other) || !hasState(other)) continue;
        if (other.attribute !== created.attribute || !sharesSubject(created, other)) continue;
        const otherKey = gameTimeKey(other.gameTime);
        if (createdKey !== null && otherKey !== null && createdKey < otherKey) {
            if (supersededBy === null || otherKey > latestKey) { supersededBy = other.id; latestKey = otherKey; }
        } else supersede.push(other.id);
    }
    return { supersede, supersededBy };
}

/** Пара, которую сливать нельзя: оба — состояния одного атрибута одного субъекта (разные значения — не дубли). */
export function areStateVariants(a, b) {
    return hasState(a) && hasState(b) && a.attribute === b.attribute && sharesSubject(a, b);
}

/** Косинус, начиная с которого новый факт — пересказ уже лежащего (а не новое значение состояния): для E5 это почти дословное совпадение. */
export const RESTATEMENT_SIMILARITY = 0.97;

/**
 * Не повторяет ли новый факт уже действующий факт того же субъекта (модель заново «открывает» то, что граф и так знает: «квартира —
 * студия» на каждом ходу, пока сцена в квартире). Новое значение состояния (чёрное пальто после белого платья) на пересказ не похоже —
 * там сходство заметно ниже. Возвращает id существующей ноды или null; решает только сходство, без вызова модели.
 */
export function findRestatement({ embedding, subjectIds, kind }, nodesById, { threshold = RESTATEMENT_SIMILARITY } = {}) {
    if (!Array.isArray(embedding) || !embedding.length || !subjectIds?.length) return null;
    let bestId = null;
    let best = threshold;
    for (const other of Object.values(nodesById)) {
        if (!other?.embedding?.length || !isCurrentState(other) || isEvent(other) || kindOf(other) !== kind) continue;
        if (!sharesSubject({ subjectIds }, other)) continue;
        const similarity = cosineSimilarity(embedding, other.embedding);
        if (similarity >= best) { best = similarity; bestId = other.id; }
    }
    return bestId;
}
