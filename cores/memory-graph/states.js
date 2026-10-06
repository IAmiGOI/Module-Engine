import { gameTimeKey } from './game-time.js';
import { isEvent } from './kinds.js';

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
