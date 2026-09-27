import { describeSpecs } from '../../libraries/core/guide-settings.js';
import { NEUTRAL, countsLine } from '../../libraries/core/guide-relevance.js';

/**
 * Что гид знает о происходящем помимо состояния подключений (cores/guide/index.js): что раскрыто на экране (`ui.context`) и что уже есть и можно править —
 * трекеры, макросы, записи лорбука и настройки включённых Модулей, с id/uid/ключами, на которые она ссылается в правках. Всё уходит модели текстом —
 * но не всё сразу: полный список идёт, только пока тема в ФОКУСЕ (`guide-relevance.js`: липкий — держится до завершения задачи или до перехода на другую тему фразой),
 * иначе одна строка с количеством. Данные в фокусе читаются заново при каждом запросе.
 */
export function createGuideContext({ call, modules }) {
    /** Раскрытое сейчас: текст для промпта и адреса для подбора статей. Нет ответа — как будто ничего не открыто. */
    async function screen() {
        const result = await call('ui.context');
        return result.ok && result.value ? { text: String(result.value.text ?? ''), anchors: (result.value.blocks ?? []).map(block => block.anchor) } : { text: '', anchors: [] };
    }

    /**
     * Свои трекеры (не системные и не чужих Модулей), макросы, записи лорбука (до 30) и объявленные настройки включённых Модулей. `query` — недавняя переписка,
     * `focus` — текущий фокус разговора: что показать списком, а что — только числом.
     */
    async function editable({ focus = NEUTRAL } = {}) {
        const [trackers, macros, entries] = await Promise.all([call('tracking.trackers'), call('macros.programs'), call('lorebook.find', {})]);
        const mine = (trackers.ok ? trackers.value ?? [] : []).filter(tracker => tracker.kind !== 'system' && !tracker.ownerId);
        const programs = macros.ok ? macros.value ?? [] : [];
        const found = entries.ok ? entries.value ?? [] : [];
        const lines = [];
        if (mine.length && focus.trackers) lines.push(`Your trackers: ${mine.map(tracker => `${tracker.id} (fields: ${(tracker.fields ?? []).map(field => field.name).join(', ')})`).join('; ')}.`);
        if (programs.length && focus.macros) lines.push(`Macros: ${programs.map(program => `{{${program.macroName}}}`).join(', ')}.`);
        if (found.length && focus.lorebook) lines.push(`Lorebook entries (uid, book): ${found.slice(0, 30).map(entry => `#${entry.uid} “${entry.name}” (${entry.book})`).join('; ')}${found.length > 30 ? `; …and ${found.length - 30} more` : ''}.`);
        const counts = countsLine({ trackers: mine.length, macros: programs.length, entries: found.length }, focus);
        if (counts) lines.push(counts);
        const known = modules?.list?.() ?? [];
        const quiet = [];
        for (const id of modules?.enabled?.() ?? []) {
            const tools = modules?.guideTools?.(id);
            if (tools?.describe && focus.modules.includes(id)) lines.push(tools.describe());
            const declared = modules?.guideSettings?.(id);
            if (!declared?.specs?.length) continue;
            const module = known.find(item => item.id === id) ?? { id, title: id };
            if (focus.allSettings || focus.modules.includes(id)) lines.push(`Settings you can change in ${module.title} (${id}): ${describeSpecs(declared.specs)}.`);
            else quiet.push(module.title);
        }
        if (quiet.length) lines.push(`Modules with settings you can change (their keys show up when you talk about them or they are open): ${quiet.join(', ')}.`);
        return lines.join('\n');
    }

    return { screen, editable };
}
