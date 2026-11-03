import { formatDuration } from './decision-clock.js';

/**
 * Библиотека персонажей и их планы — чистые правила без хранения.
 *
 * Уровни (DIRECTOR-SPEC.md):
 *  1 — самые важные, план на 3–12 часов RP-времени;
 *  2 — важные, но редко активные, план на несколько дней;
 *  3 — неважные, но частые, план подробный без особых деталей;
 *  4 — неважные и нечастые, планов нет;
 *  5 — одноразовые, в библиотеке не сохраняются, живут только в ростере.
 */

export const LEVELS = Object.freeze({ 1: true, 2: true, 3: true, 4: true, 5: true });

export const PLAN_BOUNDS = Object.freeze({
    1: { min: 180, max: 720, hint: '3–12 hours' },
    2: { min: 1440, max: 10080, hint: 'several days' },
    3: { min: 720, max: 4320, hint: '12 hours – 3 days' },
});

const key = value => String(value ?? '').trim().toLowerCase();
const text = value => String(value ?? '').trim();

function normalizeLibrary(library) {
    return library && typeof library === 'object' && !Array.isArray(library) ? { ...library } : {};
}

export function getCharacter(library, name) {
    return normalizeLibrary(library)[key(name)] ?? null;
}

/** Уровень 5 допустим только пока персонаж в ростере; иначе — ошибка, а не скрытая запись. */
export function setLevel(library, { character, level, inRoster = false, now = Date.now() } = {}) {
    const name = text(character);
    if (!name) return { ok: false, error: 'A character level needs a character.' };
    const value = Number(level);
    if (!LEVELS[value]) return { ok: false, error: `Level must be 1–5, got "${level}".` };
    if (value === 5 && !inRoster) return { ok: false, error: `${name} is level 5, but level 5 exists only while the character is in the active roster.` };
    const next = normalizeLibrary(library);
    next[key(name)] = { name, level: value, updatedAt: now };
    return { ok: true, library: next };
}

/** Уход из ростера: уровень 5 удаляется из библиотеки, имя остаётся выданным (это отдельное хранилище). */
export function removeOnLeavingRoster(library, { character } = {}) {
    const next = normalizeLibrary(library);
    const name = key(character);
    const record = next[name];
    if (!record) return { removed: false, library: next };
    if (record.level === 5) {
        delete next[name];
        return { removed: true, library: next };
    }
    return { removed: false, library: next };
}

export function removeCharacter(library, name) {
    const next = normalizeLibrary(library);
    delete next[key(name)];
    return next;
}

/**
 * План персонажа. Для активного ростера план примерный и без времени
 * (`dueAt: null, interrupted: true`). Для остальных — `dueAt` = часы + срок.
 */
export function setPlan(plans, { character, level, summary, steps = [], durationMinutes, inRoster = false, clockMinutes = 0, now = Date.now(), rid = Math.random } = {}) {
    const name = text(character);
    const body = text(summary);
    if (!name) return { ok: false, error: 'A plan needs a character.' };
    if (!body) return { ok: false, error: 'A plan needs a summary.' };
    const levelValue = Number(level);
    const list = Array.isArray(plans) ? [...plans] : [];
    const existing = list.findIndex(plan => key(plan.character) === key(name));
    const plan = {
        id: `plan_${now.toString(36)}_${rid().toString(36).slice(2, 8)}`,
        character: name,
        summary: body,
        steps: Array.isArray(steps) ? steps.map(text).filter(Boolean) : [],
        level: levelValue || null,
        createdAt: now,
        dueAt: null,
        interrupted: Boolean(inRoster),
        approximate: Boolean(inRoster),
        resolvedAt: null,
    };
    if (!inRoster) {
        const bounds = PLAN_BOUNDS[levelValue];
        if (!bounds) return { ok: false, error: `Level ${levelValue || '?'} takes no timed plans.` };
        const duration = Number(durationMinutes);
        if (!Number.isFinite(duration) || duration < bounds.min || duration > bounds.max) {
            return { ok: false, error: `A level ${levelValue} plan lasts ${bounds.hint} (${bounds.min}–${bounds.max} minutes), got ${durationMinutes}.` };
        }
        plan.dueAt = Number(clockMinutes) + duration;
        plan.durationMinutes = duration;
    }
    if (existing >= 0) list[existing] = plan; else list.push(plan);
    return { ok: true, plans: list, plan };
}

/** Персонаж вошёл в ростер: его план вне сцены прерывается и становится примерным. */
export function interruptPlan(plans, { character } = {}) {
    const name = key(character);
    return (Array.isArray(plans) ? plans : []).map(plan => (key(plan.character) === name
        ? { ...plan, interrupted: true, approximate: true, dueAt: null }
        : plan));
}

/** Персонаж вышел из ростера: старого плана нет, пассивный цикл должен написать новый. */
export function needsNewPlan(plans, { character } = {}) {
    const name = key(character);
    return (Array.isArray(plans) ? plans : []).filter(plan => key(plan.character) === name);
}

export function duePlans(plans, clockMinutes) {
    return (Array.isArray(plans) ? plans : [])
        .filter(plan => plan && !plan.resolvedAt && !plan.interrupted && Number.isFinite(plan.dueAt) && plan.dueAt <= Number(clockMinutes))
        .sort((a, b) => a.dueAt - b.dueAt || String(a.character).localeCompare(String(b.character)));
}

export function completePlan(plans, { character, now = Date.now() } = {}) {
    const name = key(character);
    return (Array.isArray(plans) ? plans : []).map(plan => (key(plan.character) === name && !plan.resolvedAt
        ? { ...plan, resolvedAt: now, dueAt: null }
        : plan));
}

export function planFor(plans, { character } = {}) {
    const name = key(character);
    return (Array.isArray(plans) ? plans : []).find(plan => key(plan.character) === name && !plan.resolvedAt) ?? null;
}

/** Блок 4: библиотека с уровнями, без планов — обновляется при переключении окна. */
export function libraryLevelsSection(library) {
    const records = Object.values(normalizeLibrary(library));
    if (!records.length) return '';
    const body = records.map(record => `- ${record.name} (level ${record.level})`).join('\n');
    return `CHARACTER LIBRARY (levels 1–5):\n\n${body}`;
}

/** Блок 6: только планы на 24+ часа RP-времени — обновляются при переключении окна. */
export function longPlansSection(plans, clockMinutes = 0) {
    const list = (Array.isArray(plans) ? plans : []).filter(plan => {
        if (!plan || plan.resolvedAt) return false;
        const duration = Number(plan.durationMinutes);
        if (Number.isFinite(duration)) return duration >= 1440;
        const span = Number(plan.dueAt) - Number(plan.createdAt);
        return Number.isFinite(span) && span >= 1440;
    });
    if (!list.length) return '';
    const body = list.map(plan => {
        const when = plan.interrupted ? 'in the scene, approximate plan'
            : Number.isFinite(plan.dueAt) ? `due in ${formatDuration(Math.max(0, plan.dueAt - clockMinutes))}`
                : 'no timed plan';
        return `- ${plan.character} (level ${plan.level}): ${plan.summary} — ${when}`;
    }).join('\n');
    return `CHARACTER PLANS (24 hours or longer; directions, not scripts):\n\n${body}`;
}

/** Компактная секция контекста: по строке на персонажа, чтобы библиотека не съедала окно. */
export function librarySection(library, plans, clockMinutes = 0) {
    const records = Object.values(normalizeLibrary(library));
    if (!records.length) return '';
    const byName = new Map((Array.isArray(plans) ? plans : []).filter(plan => !plan.resolvedAt).map(plan => [key(plan.character), plan]));
    const body = records.map(record => {
        const plan = byName.get(key(record.name));
        const when = plan?.interrupted ? 'in the scene, approximate plan'
            : Number.isFinite(plan?.dueAt) ? `due in ${formatDuration(Math.max(0, plan.dueAt - clockMinutes))}`
                : 'no timed plan';
        return `- ${record.name} (level ${record.level}): ${plan?.summary ?? 'no plan'} — ${when}`;
    }).join('\n');
    return `CHARACTER LIBRARY (levels 1–5; plans are directions, not scripts):\n\n${body}`;
}
