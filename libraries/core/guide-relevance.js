/**
 * Фокус разговора гида (cores/guide/context.js): чистые функции. Списки «что уже есть» (трекеры, макросы, записи лорбука) и настройки Модулей раздуваются вместе с
 * данными пользователя, а нужны не в каждом вопросе — поэтому в промпт они идут ПОЛНЫМ списком только в фокусе, иначе одной строкой с количеством.
 *
 * Фокус ЛИПКИЙ: раз попав в него, тема остаётся, даже когда в следующих репликах её слов уже нет («а теперь сделай поменьше»). Выходит из фокуса не по молчанию, а по ФАКТУ:
 *  - задача завершена — применено изменение по теме (`done`) или человек сам закрыл разговор («спасибо», «всё», «отмена»);
 *  - или он перешёл на другую тему/Модуль ФРАЗОЙ — тогда фокус заменяется на новую тему, и гид видит её данные.
 * Пока ни того ни другого — фокус держится, а данные в нём каждый раз читаются заново (актуальное состояние, не снимок из прошлого запроса).
 */

const TRACKERS = /\b(trackers?|tracking|tracked|poll|polling)\b/i;
const MACROS = /\bmacros?\b|\{\{/i;
const LOREBOOK = /\b(lore|lorebook|lorebooks|world\s?info|entry|entries)\b/i;
const SETTINGS = /\b(settings?|sliders?|options?|threshold|tune|tuning)\b/i;
const CLOSING = /\b(thanks|thank you|thx|done|that'?s (all|it)|all set|never ?mind|cancel|got it|perfect|great|nothing else)\b/i;
const OPEN_TRACKERS = anchor => anchor === 'module:module.tracker' || anchor.startsWith('tracker:');
const OPEN_LOREBOOK = anchor => anchor === 'card:lorebook' || anchor.startsWith('lorebook:');

export const NEUTRAL = Object.freeze({ trackers: false, macros: false, lorebook: false, allSettings: false, modules: Object.freeze([]), anchors: Object.freeze([]), done: false });

const words = text => String(text ?? '').toLowerCase();

/** Как люди называют Модуль, не повторяя его название: «passes» — это Post-Turn Processor. */
const MODULE_ALIASES = Object.freeze({ 'module.postprocess': /\b(post[- ]?turn|post[- ]?process\w*|pass(?:es)?)\b/i });

/** Модуль упомянут: по названию («Scene Painter», «Music») или по короткому id (`scenePainter`) в реплике, либо раскрыт на экране. */
const moduleNamed = (module, text, anchors) => {
    if (anchors.includes(`module:${module.id}`)) return true;
    const title = words(module.title);
    const shortId = words(String(module.id).replace(/^module\./, ''));
    return Boolean((title && words(text).includes(title)) || (shortId && words(text).includes(shortId)) || MODULE_ALIASES[module.id]?.test(text));
};

/** Что назвала эта реплика (и НОВО раскрытые блоки): `null`, если ничего — тогда фокус не меняется. */
export function detectFocus({ query = '', anchors = [], modules = [] } = {}) {
    const found = {
        trackers: TRACKERS.test(query) || anchors.some(OPEN_TRACKERS),
        macros: MACROS.test(query) || anchors.includes('card:macros'),
        lorebook: LOREBOOK.test(query) || anchors.some(OPEN_LOREBOOK),
        allSettings: SETTINGS.test(query),
        modules: modules.filter(module => moduleNamed(module, query, anchors)).map(module => module.id),
    };
    return found.trackers || found.macros || found.lorebook || found.allSettings || found.modules.length ? found : null;
}

const TASK = /\b(build|make|create|add|change|set|edit|write|rewrite|configure|tune|improve|fix|remove|delete|rework|update|adjust|design|need|want|help me)\b/i;

/** Реплика просит СДЕЛАТЬ что-то (а не объяснить): по такой гид сама открывает блок нужного Модуля, чтобы увидеть его состояние, — не полагаясь на то, что модель об этом вспомнит. */
export const isTaskRequest = text => TASK.test(String(text ?? ''));

/** Модули, которых в новом фокусе стало больше, чем в прежнем. */
export const freshModules = (previous, next) => (next.modules ?? []).filter(id => !(previous.modules ?? []).includes(id));

/** Человек закрыл разговор сам — короткая реплика «спасибо / всё / отмена» без новой темы. */
export const isClosing = text => String(text ?? '').trim().length <= 60 && CLOSING.test(text);

/**
 * Следующий фокус. `anchors` — раскрытые сейчас блоки: считаются «разговором о нём» только когда блок раскрыт НОВО (иначе раскрытый и забытый блок держал бы тему вечно).
 * Порядок: новая тема фразой → замена; закрытие или завершение → нейтральный; иначе — прежний.
 */
export function nextFocus(previous = NEUTRAL, { query = '', anchors = [], modules = [] } = {}) {
    const opened = anchors.filter(anchor => !(previous.anchors ?? []).includes(anchor));
    const detected = detectFocus({ query, anchors: opened, modules });
    if (detected) return { ...detected, anchors, done: false };
    if (previous.done || isClosing(query)) return { ...NEUTRAL, anchors };
    return { ...previous, anchors };
}

/** Действия, после которых задача по теме считается завершённой. */
export const COMPLETING_ACTIONS = Object.freeze(new Set(['tracker.create', 'tracker.update', 'tracker.delete', 'macro.create', 'macro.update', 'macro.delete', 'lorebook.addEntry', 'lorebook.updateEntry', 'lorebook.deleteEntry', 'module.setting.set']));

/** Фокус из хранилища → безопасная форма (мусор — нейтральный). */
export function sanitizeFocus(value) {
    if (!value || typeof value !== 'object') return { ...NEUTRAL };
    return {
        trackers: value.trackers === true, macros: value.macros === true, lorebook: value.lorebook === true, allSettings: value.allSettings === true,
        modules: Array.isArray(value.modules) ? value.modules.filter(id => typeof id === 'string').slice(0, 20) : [],
        anchors: Array.isArray(value.anchors) ? value.anchors.filter(id => typeof id === 'string').slice(0, 40) : [],
        done: value.done === true,
    };
}

/** Строка про то, что на руках, но не показано списком: «2 trackers, 1 macro, 12 lorebook entries». */
export function countsLine({ trackers = 0, macros = 0, entries = 0 }, focus) {
    const parts = [];
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    if (trackers && !focus.trackers) parts.push(plural(trackers, 'tracker', 'trackers'));
    if (macros && !focus.macros) parts.push(plural(macros, 'macro', 'macros'));
    if (entries && !focus.lorebook) parts.push(plural(entries, 'lorebook entry', 'lorebook entries'));
    return parts.length ? `Also on hand (not listed until the talk is about them): ${parts.join(', ')}.` : '';
}
