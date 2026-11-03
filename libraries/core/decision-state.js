/**
 * План директора, Character Notes и Arcs — чистые операции над состоянием.
 * Хранение и инструменты снаружи; здесь правила, которые нельзя нарушить:
 * ≤ 4 заметки на персонажа, закрытая арка не открывается заново, у плана
 * всегда есть направление.
 */

export const MAX_NOTES_PER_CHARACTER = 4;

const text = value => String(value ?? '').trim();
const key = value => text(value).toLowerCase();

export function emptyNotes() {
    return {};
}

/** Заметки одного персонажа из общего словаря. */
export function notesFor(notes, character) {
    const found = notes?.[key(character)];
    return Array.isArray(found) ? found : [];
}

/** Все заметки списком для секции контекста. */
export function flattenNotes(notes) {
    return Object.entries(notes ?? {}).flatMap(([character, list]) => (Array.isArray(list) ? list.map(note => ({ ...note, character: note.character ?? character })) : []));
}

/**
 * @returns {{ ok: boolean, error?: string, notes: object }}
 */
export function applyCharacterNote(notes, { character, op, id, title, text: body } = {}, { now = () => Date.now(), rid = () => Math.random().toString(36).slice(2, 8) } = {}) {
    const name = key(character);
    if (!name) return { ok: false, error: 'A character note needs a character.', notes };
    const current = notesFor(notes, character);
    // Заметку находят по id или по названию — директор видит названия («Sasha: What Sasha has on them»), а не id.
    // Раньше remove по названию молча отвечал «ok», ничего не удаляя, и директор ходил по кругу, а старая заметка оставалась.
    const bare = value => text(value).toLowerCase().replace(new RegExp(`^${text(character).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`), '').trim();
    const find = (wanted, wantedTitle) => {
        const byId = current.find(note => note.id === text(wanted));
        if (byId) return byId;
        const label = bare(wanted) || bare(wantedTitle);
        return label ? current.find(note => bare(note.title) === label) ?? null : null;
    };
    const known = () => current.map(note => `"${note.title}"`).join(', ') || 'none';
    let next;
    if (op === 'remove') {
        const target = find(id, title);
        if (!target) return { ok: false, error: `There is no note "${text(id) || text(title)}" for ${text(character)}. Notes: ${known()}.`, notes };
        next = current.filter(note => note.id !== target.id);
    } else if (op === 'set') {
        const target = find(id, title);
        if (!target) return { ok: false, error: `There is no note "${text(id) || text(title)}" for ${text(character)}. Notes: ${known()}.`, notes };
        next = current.map(note => (note.id === target.id ? { ...note, title: text(title) || note.title, text: text(body) || note.text, updatedAt: now() } : note));
    } else if (op === 'add') {
        if (!text(title) || !text(body)) return { ok: false, error: 'A new note needs both a title and text.', notes };
        if (current.length >= MAX_NOTES_PER_CHARACTER) return { ok: false, error: `${text(character)} already has ${MAX_NOTES_PER_CHARACTER} notes (${known()}) — "set" one of them by its title instead, or "remove" one first.`, notes };
        next = [...current, { id: `note_${now().toString(36)}_${rid()}`, character: text(character), title: text(title), text: text(body), updatedAt: now() }];
    } else return { ok: false, error: `Unknown note operation "${op}".`, notes };
    return { ok: true, notes: { ...notes, [name]: next } };
}

export function applyArc(arcs, { op, id, title, note } = {}, { now = () => Date.now(), rid = () => Math.random().toString(36).slice(2, 8) } = {}) {
    const list = Array.isArray(arcs) ? [...arcs] : [];
    if (op === 'open') {
        if (!text(title)) return { ok: false, error: 'Opening an arc needs a title.', arcs: list };
        const arc = { id: `arc_${now().toString(36)}_${rid()}`, title: text(title), status: 'open', stages: [], createdAt: now(), closedAt: null };
        return { ok: true, arcs: [...list, arc], arc };
    }
    const index = list.findIndex(arc => arc.id === id);
    if (index < 0) return { ok: false, error: `There is no arc "${id ?? ''}".`, arcs: list };
    if (op === 'close') {
        if (list[index].status === 'closed') return { ok: false, error: `Arc "${list[index].title}" is already closed.`, arcs: list };
        list[index] = { ...list[index], status: 'closed', closedAt: now() };
        return { ok: true, arcs: list, arc: list[index] };
    }
    if (op === 'stage') {
        if (list[index].status === 'closed') return { ok: false, error: `Arc "${list[index].title}" is closed and takes no new stages.`, arcs: list };
        const stage = { at: now(), note: text(note) };
        list[index] = { ...list[index], stages: [...(list[index].stages ?? []), stage] };
        return { ok: true, arcs: list, arc: list[index] };
    }
    return { ok: false, error: `Unknown arc operation "${op}".`, arcs: list };
}

export function applyPlan(plan, { direction, stages, currentStage } = {}, { now = () => Date.now() } = {}) {
    const heading = text(direction);
    if (!heading) return { ok: false, error: 'The director plan needs a direction.', plan };
    const list = Array.isArray(stages) ? stages.map(text).filter(Boolean) : Array.isArray(plan?.stages) ? plan.stages : [];
    return {
        ok: true,
        plan: {
            direction: heading,
            stages: list,
            currentStage: Number.isFinite(Number(currentStage)) ? Math.max(0, Math.min(Math.round(Number(currentStage)), Math.max(0, list.length - 1))) : Number(plan?.currentStage ?? 0),
            updatedAt: now(),
        },
    };
}

// --- Секции контекста ------------------------------------------------------

export function planSection(plan) {
    if (!plan?.direction) return '';
    const stage = plan.stages?.[plan.currentStage];
    const stages = (plan.stages ?? []).map((item, index) => `${index === plan.currentStage ? '→' : '-'} ${item}`).join('\n');
    return `YOUR PLAN (a direction, not a fixed sequence):\n\n${plan.direction}${stage ? `\nCurrent stage: ${stage}` : ''}${stages ? `\n${stages}` : ''}`;
}

export function arcsSection(arcs) {
    const list = Array.isArray(arcs) ? arcs : [];
    if (!list.length) return '';
    const body = list.map(arc => `- [${arc.status}] ${arc.title}${arc.stages?.length ? ` (${arc.stages.length} stage${arc.stages.length === 1 ? '' : 's'})` : ''}`).join('\n');
    return `ARCS:\n\n${body}`;
}

export function notesSection(notes) {
    const list = flattenNotes(notes);
    if (!list.length) return '';
    const body = list.map(note => `### ${note.character}: ${note.title}\n${note.text}`).join('\n\n');
    return `CHARACTER NOTES (the most the writer needs to know):\n\n${body}`;
}

export function notesAsBlocks(notes) {
    return flattenNotes(notes).map(note => ({ id: note.id, title: `${note.character}: ${note.title}`, text: note.text }));
}
