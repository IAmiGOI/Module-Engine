import { BANK_SORT } from '../../libraries/core/decision-prompts-bank.js';
import { promptText } from '../../libraries/core/prompt-overrides.js';

/**
 * Сортировка холодного старта (пять ролей): персонажей не строят, а только
 * раскладывают по важности одним вызовом модели банков. Полный банк Main Cast
 * пишет Director по карточке и Мирозданию. Без модели или при сбое — по виду
 * источника: карточка чата — main, запись лорбука — side.
 */
const LEVELS = new Set(['main', 'side', 'temporary', 'mass']);
const EXCERPT = 600;
const clean = value => String(value ?? '').trim();
const keyOf = value => clean(value).toLowerCase();

export function fallbackImportance(source) {
    if (source?.sourceKind === 'persona') return 'temporary';
    return source?.sourceKind === 'card' ? 'main' : 'side';
}

export function parseSort(answer) {
    const raw = clean(answer?.text ?? answer);
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    const levels = new Map();
    // Карточка на нескольких персонажей: имя → кто в ней; делит Директор (split_character).
    levels.several = new Map();
    if (start < 0 || end <= start) return levels;
    try {
        const list = JSON.parse(raw.slice(start, end + 1));
        for (const item of Array.isArray(list) ? list : []) {
            const name = keyOf(item?.name);
            const level = keyOf(item?.importance);
            if (name && LEVELS.has(level)) levels.set(name, level);
            const several = (Array.isArray(item?.several) ? item.several : []).map(clean).filter(Boolean);
            if (name && several.length > 1) levels.several.set(name, several);
        }
    } catch { /* без JSON — без сортировки */ }
    return levels;
}

export function sortTask(sources) {
    return sources.map(source => `### ${clean(source.name)} (${source.sourceKind === 'card' ? 'a character card of this chat' : 'a lorebook entry'})\n${clean(source.source).slice(0, EXCERPT)}`).join('\n\n');
}

/** Источники → Map(sourceKey → важность). Персона пользователя в сортировку не идёт. */
export async function sortSources({ call, getSettings, sources }) {
    const levels = new Map(sources.map(source => [source.sourceKey, fallbackImportance(source)]));
    levels.several = new Map();
    const characters = sources.filter(source => source.sourceKind !== 'persona' && source.sourceKind !== 'scene');
    const workerId = clean(getSettings()?.researcher?.workerId);
    if (!characters.length || !workerId) return levels;
    try {
        const answer = await call('model.generate', { purpose: 'bank sort',
            workerId, maxTokens: 2000, temperature: 0.2, stream: false, reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
            messages: [{ role: 'system', content: promptText(BANK_SORT) }, { role: 'user', content: sortTask(characters) }],
        });
        const sorted = parseSort(answer);
        for (const source of characters) {
            const level = sorted.get(keyOf(source.name));
            if (level) levels.set(source.sourceKey, level);
            const several = sorted.several?.get(keyOf(source.name));
            if (several) levels.several.set(source.sourceKey, several);
        }
    } catch { /* без ответа — по виду источника */ }
    return levels;
}
