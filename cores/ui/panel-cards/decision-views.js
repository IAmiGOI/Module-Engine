import { h } from '../tree.js';

/**
 * Просмотр состояния директора для карточки настроек. Чистые функции над
 * уже прочитанными данными — без вызовов контрактов. Тексты английские.
 */

const line = value => String(value ?? '').trim();
const hint = text => h('small', { class: 'stme-module-hint' }, text);

export function rosterView(roster) {
    const active = Array.isArray(roster?.active) ? roster.active : [];
    if (!active.length) return hint('No active characters. The director fills the roster as the scene changes.');
    return h('div', { class: 'stme-decision-list' }, active.map(name => h('div', { class: 'stme-decision-row' }, `• ${name}`)));
}

export function planView(plan) {
    if (!plan?.direction) return hint('No director plan yet. The director has to create one before the first form.');
    return h('div', { class: 'stme-decision-plan' },
        h('div', {}, plan.direction),
        h('small', { class: 'stme-module-hint' }, `Stage ${Number(plan.currentStage ?? 0) + 1} of ${(plan.stages ?? []).length || 1}`),
        ...(plan.stages ?? []).map((stage, index) => h('div', { class: 'stme-decision-row' }, `${index === plan.currentStage ? '→' : '·'} ${stage}`)),
    );
}

export function libraryView(library, plans, clock) {
    const records = Object.values(library ?? {});
    if (!records.length) return hint('The character library is empty.');
    const byName = new Map((Array.isArray(plans) ? plans : []).filter(plan => !plan.resolvedAt).map(plan => [String(plan.character).toLowerCase(), plan]));
    return h('div', { class: 'stme-decision-list' }, records.map(record => {
        const plan = byName.get(String(record.name).toLowerCase());
        const when = plan?.interrupted ? 'in the scene (approximate plan)'
            : Number.isFinite(plan?.dueAt) ? `due in ${Math.max(0, Math.round((plan.dueAt - Number(clock?.minutes ?? 0)) / 60))} h`
                : 'no timed plan';
        return h('div', { class: 'stme-decision-row' },
            h('strong', {}, `${record.name} — level ${record.level}`),
            h('div', {}, plan?.summary ?? 'no plan'),
            h('small', { class: 'stme-module-hint' }, when));
    }));
}

export function bankView(bank) {
    const entries = Object.entries(bank ?? {});
    if (!entries.length) return hint('The memory bank is empty.');
    return h('div', { class: 'stme-decision-list' }, entries.map(([character, records]) => {
        const list = Array.isArray(records) ? records : [];
        const important = list.filter(record => record.important).length;
        const latest = list.at(-1);
        return h('div', { class: 'stme-decision-row' },
            h('strong', {}, `${character} — ${list.length} record${list.length === 1 ? '' : 's'}${important ? `, ${important} important` : ''}`),
            h('div', {}, latest ? String(latest.text).slice(0, 200) : ''));
    }));
}

export function arcsNotesView(arcs, notes) {
    const arcList = Array.isArray(arcs) ? arcs : [];
    const noteEntries = Object.entries(notes ?? {});
    const parts = [];
    if (arcList.length) parts.push(h('div', {}, ...arcList.map(arc => h('div', { class: 'stme-decision-row' },
        `[${arc.status}] ${arc.title}${arc.summary ? ' — summarized' : ''}`))));
    else parts.push(hint('No arcs yet.'));
    if (noteEntries.length) {
        parts.push(h('div', {}, ...noteEntries.flatMap(([character, list]) => (Array.isArray(list) ? list : []).map(note => h('div', { class: 'stme-decision-row' },
            h('strong', {}, `${character}: ${note.title}`), h('div', {}, note.text))))));
    } else parts.push(hint('No character notes yet.'));
    return h('div', {}, ...parts);
}

export function researchView(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.length) return hint('No research tasks have been started.');
    return h('div', { class: 'stme-decision-list' }, list.slice(-10).map(task => h('div', { class: 'stme-decision-row' },
        h('strong', {}, `${task.status === 'done' ? '✓' : '…'} ${task.task}`),
        task.report ? h('div', {}, String(task.report).slice(0, 400)) : hint(`running, ${task.steps ?? 0} steps`))));
}

export function forcedView(ids) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return hint('No summaries are forced; folding works as usual.');
    return h('div', { class: 'stme-decision-list' }, list.map(id => h('div', { class: 'stme-decision-row' }, `• ${id}`)));
}

/** Лог директора: циклы, вызовы с комментариями, thinking, предупреждения. */
export function logView(cycles) {
    const list = Array.isArray(cycles) ? cycles.slice(-12).reverse() : [];
    if (!list.length) return hint('The director has not run a cycle yet.');
    return h('div', { class: 'stme-decision-log' }, list.map(cycle => h('div', { class: 'stme-decision-cycle' },
        h('strong', {}, `${cycle.event ?? 'turn'} · ${new Date(Number(cycle.at) || 0).toLocaleTimeString()} · ${cycle.tokens ?? 0} tokens${cycle.usage ? ` · ${cycle.usage.prompt ?? 0} in / ${cycle.usage.completion ?? 0} out, ${cycle.usage.cached ?? 0} cached` : ''}`),
        ...(cycle.toolCalls ?? []).map(call => h('div', { class: 'stme-decision-row' },
            h('code', {}, call.name ?? '?'),
            h('div', {}, line(call.comment) || '(no comment)'),
            h('small', { class: 'stme-module-hint' }, call.error ? `error: ${call.error}` : summarize(call.result)))),
        cycle.thinking ? h('details', {}, h('summary', {}, 'thinking'), h('div', { class: 'stme-decision-thinking' }, String(cycle.thinking).slice(0, 4000))) : null,
        ...(cycle.warnings ?? []).map(warning => h('small', { class: 'stme-module-hint' }, `⚠ ${warning}`)),
    )));
}

function summarize(result) {
    if (result === null || result === undefined) return 'ok';
    try { return JSON.stringify(result).slice(0, 240); }
    catch { return String(result).slice(0, 240); }
}
