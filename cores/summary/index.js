import { request } from '../../libraries/shared/request.js';
import { deliverToPrompt } from '../../libraries/shared/prompt-contribution.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';

const SETTINGS_NAMESPACE = 'core.summary';
const MEMORY_NAMESPACE = 'core.summary';
const SUMMARIES_KEY = 'summaries';
const PENDING_KEY = 'pendingVerification';
const LEDGER_KEY = 'ledger';
const PREPARE_PIPELINE = 'generation.prepare';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const FOLD_CONTRACT = 'summary.check';
const INJECT_CONTRACT = 'summary.inject';
const FOLD_STAGE_ID = 'summary:fold';
const INJECT_STAGE_ID = 'summary:inject';
/** Запас сверх protectedWindow+batchSize, который реально запрашивается у chatHistory.messages — цепочка ToolCall/сирота может съесть несколько сообщений, не дав ни одной новой единицы для подсчёта. */
const FETCH_MARGIN = 30;
/** Сколько раз ПЕРЕДЕЛАТЬ/РАСШИРИТЬ саммари, прежде чем принять как есть с пометкой (решение владельца: "не более двух отправок на переделку", один общий счётчик на оба вердикта, не раздельно). */
const MAX_VERIFY_ATTEMPTS = 2;
/** Сколько раз повторить САМ verify-вызов при сетевом сбое/непарсящемся ответе, прежде чем сдаться — это фон, ретраи почти бесплатны (решение владельца: "раз это в фоне — можем запрашивать повторные"). Не тратит попытку expand/redo. */
const MAX_VERIFY_TRANSPORT_RETRIES = 3;

export const DEFAULT_SETTINGS = Object.freeze({
    // Один уровень — один проход свёртки: N нижних элементов (сырых сообщений
    // для уровня 1, саммари уровня N-1 для остальных) → 1 саммари этого уровня.
    // Число уровней — это просто длина массива, тоже настраиваемая.
    levels: [{ batchSize: 10 }, { batchSize: 5 }, { batchSize: 5 }],
    // «Второй порог» из обсуждения с пользователем: сколько последних единиц
    // никогда не сворачиваются. Активация мгновенная (без ручного шага), как
    // только за пределами этого окна накопился целый батч уровня 1.
    protectedWindow: 20,
    workerId: null,
    // Проверка саммари уровня >1 вызовом ЛЛМ (ROADMAP.md) — выключена по
    // умолчанию: удваивает-утраивает число вызовов модели на каждый фолд
    // уровня >1, осознанный компромисс владельца проекта, но не то, что
    // должно молча включиться всем существующим пользователям разом.
    verifyEnabled: false,
    // Отдельный воркер-ревьюер (решение владельца: "отдельного, без
    // настроек, подберём оптимального по ходу") — если не задан, падает на
    // тот же workerId, что и сам фолд, а не на пул целиком: ревьюер должен
    // быть таким же ПРЕДСКАЗУЕМЫМ по стоимости/поведению, как фолд, просто
    // отдельно перенастраиваемым.
    verifyWorkerId: null,
    // Структурированная свёртка уровня 1: кроме пересказа модель ведёт СПИСОК ЗАКРЕПЛЁННЫХ ФАКТОВ (правила мира, обещания, отношения,
    // нерешённые линии — не пересказываются при следующих свёртках, а обновляются) и блок «Сейчас» (где и на чём остановились).
    // Выключено — прежнее поведение: один пересказ без списка и без блока.
    structuredFold: true,
    // Потолок списка закреплённых фактов в символах (≈ четверть в токенах): растущий список не должен съедать контекст.
    pinnedMaxChars: 2400,
});

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** Защитный клэмп — та же дисциплина, что у `clampNoteSettings()` (modules/tools/notebook.js): ручная правка файла настроек не должна осесть как есть. */
export function clampSummarySettings(values = {}) {
    const levels = Array.isArray(values.levels) && values.levels.length
        ? values.levels.map(level => ({ batchSize: clampInt(level?.batchSize, 2, 200, 5) }))
        : DEFAULT_SETTINGS.levels.map(level => ({ ...level }));
    return {
        levels,
        protectedWindow: clampInt(values.protectedWindow, 1, 2000, DEFAULT_SETTINGS.protectedWindow),
        workerId: values.workerId ?? null,
        verifyEnabled: Boolean(values.verifyEnabled),
        verifyWorkerId: values.verifyWorkerId ?? null,
        structuredFold: values.structuredFold === undefined ? DEFAULT_SETTINGS.structuredFold : Boolean(values.structuredFold),
        pinnedMaxChars: clampInt(values.pinnedMaxChars, 400, 20000, DEFAULT_SETTINGS.pinnedMaxChars),
    };
}

/**
 * Маркер «не до конца проверено» (BasicSummary verify, ROADMAP.md) — живёт
 * ВНУТРИ `record.text` (не отдельным полем), потому что его нужно вырезать
 * регексом в КАЖДОМ месте, где этот текст уходит СЛЕДУЮЩЕМУ сайдкар-вызову
 * (обычный фолд следующего уровня читает чужого ребёнка через
 * `buildLevelNPrompt()`, verify следующего уровня читает через
 * `resolveOriginalContent()`) — для сайдкара это шум, не факт про историю.
 * Только `formatSummaryMessage()` (путь к ОСНОВНОЙ ролевой модели,
 * `injectIntoPrompt`) оставляет его как есть — решение владельца: "должно
 * приниматься в сообщениях с пометкой... но не должно, если саммари
 * считается точным".
 */
const UNVERIFIED_PREFIX = '[[UNVERIFIED]]This summary may be incomplete or slightly inaccurate — if the ongoing story or the user contradicts it, trust them over this summary.[[/UNVERIFIED]]\n\n';
const UNVERIFIED_RE = /^\[\[UNVERIFIED\]\][\s\S]*?\[\[\/UNVERIFIED\]\]\n\n/;

function stripUnverifiedMarker(text) {
    return String(text ?? '').replace(UNVERIFIED_RE, '');
}

// --- Игровое время в заголовках --------------------------------------------------------------------------------------------

/** Реальная дата сообщения (`sendDate`, ISO с миллисекундами и `Z`) — не игровое время: в заголовок саммари ей делать нечего. */
const REAL_DATE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Игровое время записи (отметка RP Time) или `null`: пустое, не строка или реальная дата — «времени нет». */
export function inWorldTime(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && !REAL_DATE_RE.test(text) ? text : null;
}

/** Ближайшая отметка RP Time от `from` к `to` по mesid (включительно), до 400 шагов; `null`, если отметок на пути нет. */
export function nearestMark(marks, from, to) {
    const step = to >= from ? 1 : -1;
    for (let mesid = from, left = 400; left > 0; mesid += step, left -= 1) {
        const mark = inWorldTime(marks?.[String(mesid)]);
        if (mark) return mark;
        if (mesid === to) break;
    }
    return null;
}

/**
 * Период саммари для заголовка. Сохранённые `startTime`/`endTime` берутся, только если это игровое время; иначе (старые записи с
 * реальными датами, или RP Time ещё не успел посчитать отметки в момент свёртки) недостающее ищется среди отметок RP Time
 * по номерам сообщений ПРИ ВСТАВКЕ в промпт — к этому моменту отметки обычно уже есть. Нет ни одной — `{ start: null, end: null }`.
 */
export function resolvePeriod(record, marks) {
    const start = inWorldTime(record.startTime) ?? nearestMark(marks, Number(record.startIndex), Number(record.endIndex));
    const end = inWorldTime(record.endTime) ?? nearestMark(marks, Number(record.endIndex), Number(record.startIndex));
    return { start, end };
}

/** Заголовок саммари: период — только игровое время, без подмеси реальных дат; нет времени — нет и фразы «covering». */
export function formatSummaryHeader(record, period = { start: null, end: null }) {
    const { start, end } = period;
    let when = '';
    if (start && end) when = start === end ? `, at ${start}` : `, covering ${start} → ${end}`;
    else if (start) when = `, starting ${start}`;
    else if (end) when = `, ending ${end}`;
    return `[Summary of earlier messages #${record.startIndex}–#${record.endIndex}${when}]`;
}

// --- Структурированная свёртка: пересказ + закреплённые факты + «Сейчас» ----------------------------------------------------

const SECTION_RE = /^[ \t]*[#*_> \t]*(STORY|PINNED|NOW)[*_ \t]*[:：]?[*_ \t]*(.*)$/i;
const PINNED_ITEM_MAX = 200;

/**
 * Разбор ответа структурированной свёртки: разделы `STORY:` / `PINNED:` / `NOW:` (регистр и markdown-обёртки вроде `**STORY:**`
 * терпимы). Нет раздела STORY — модель формат проигнорировала: весь ответ идёт как пересказ, закреплённые факты и «Сейчас» не
 * тронуты (`pinned: null`, `now: null`). `pinned` — пустой список означает «раздел был, но пуст» (так модель говорит «ничего не осталось»).
 */
export function parseStructuredFold(raw) {
    const text = String(raw ?? '').trim();
    const found = { STORY: null, PINNED: null, NOW: null };
    let current = null;
    for (const line of text.split('\n')) {
        const match = line.match(SECTION_RE);
        if (match && found[match[1].toUpperCase()] === null) {
            current = match[1].toUpperCase();
            found[current] = [];
            if (match[2].trim()) found[current].push(match[2].trim());
        } else if (current) found[current].push(line);
    }
    if (found.STORY === null) return { story: text, pinned: null, now: null, structured: false };
    const story = found.STORY.join('\n').trim();
    const pinned = found.PINNED === null ? null : parsePinnedLines(found.PINNED);
    const now = found.NOW === null ? null : found.NOW.join('\n').trim();
    return { story: story || text, pinned, now: now || null, structured: true };
}

/** Строки раздела PINNED → список коротких пунктов без дублей (без учёта регистра); «(none)» и пустые строки отбрасываются. */
export function parsePinnedLines(lines) {
    const seen = new Set();
    const items = [];
    for (const line of lines) {
        const clean = String(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
        if (!clean || /^\(?none\)?\.?$/i.test(clean)) continue;
        const item = clean.length > PINNED_ITEM_MAX ? `${clean.slice(0, PINNED_ITEM_MAX - 1).trimEnd()}…` : clean;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
    }
    return items;
}

/**
 * Новый список закреплённых фактов из старого и ответа модели. Модель просят вернуть ПОЛНЫЙ обновлённый список; если она вернула
 * заметно меньше, чем было (больше половины пропало при списке от 6 пунктов) — это скорее сбой (потеряла список), чем «всё решилось»:
 * старые пункты остаются, из ответа добавляются только новые. Результат обрезается по `maxChars` с конца.
 */
export function mergePinned(previous, proposed, maxChars = DEFAULT_SETTINGS.pinnedMaxChars) {
    let next;
    if (proposed === null) next = [...previous];
    else if (previous.length >= 6 && proposed.length < previous.length / 2) {
        const known = new Set(previous.map(item => item.toLowerCase()));
        next = [...previous, ...proposed.filter(item => !known.has(item.toLowerCase()))];
    } else next = [...proposed];
    const result = [];
    let total = 0;
    for (const item of next) {
        if (total + item.length + 3 > maxChars) break;
        result.push(item);
        total += item.length + 3;
    }
    return result;
}

/** Пустое состояние журнала чата: закреплённые факты, «Сейчас», до какого сообщения оно верно, участники. */
export function emptyLedger() {
    return { pinned: [], now: '', asOf: null, cast: [] };
}

/** Участники из сообщений батча: `{ name, isUser }` без дублей; список копится в журнале (до 12 имён). */
export function collectCast(messages, previous = []) {
    const seen = new Map(previous.map(entry => [entry.name.toLowerCase(), entry]));
    for (const message of messages) {
        const name = String(message?.name ?? '').trim();
        if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, isUser: Boolean(message.isUser) });
    }
    return [...seen.values()].slice(0, 12);
}

const castLine = cast => (cast.length ? `Participants: ${cast.map(entry => (entry.isUser ? `${entry.name} (the user's persona)` : entry.name)).join(', ')}` : '');

const STRUCTURED_FOLD_SYSTEM_PROMPT = `You keep the long-term memory of a roleplay. Read the excerpt and answer in EXACTLY this format, with these three headings:

STORY:
A concise third-person summary of the excerpt: important facts, character goals and plot developments, with concrete details (who, what, where). Name people the way the text does and keep the pronouns the text uses for each of them.

PINNED:
The complete UPDATED list of lasting facts, one per line starting with "- ". Start from the CURRENT PINNED list given below: keep every item that is still true word for word, drop an item only if the excerpt resolved or contradicted it, merge duplicates, and add new lasting facts from the excerpt: world rules and limits, promises and commitments, relationships and what each character knows about the others, unresolved threads, key quotes. At most 20 items, each under 160 characters. Do NOT list events that merely happened; those belong in STORY.

NOW:
Two to four short sentences: where and when the excerpt ends, who is present, what each of them is doing or feeling, and what is about to happen.

Output ONLY these three sections, no preamble.`;

/** Пользовательская часть запроса структурированной свёртки: участники, что было сразу до отрывка, текущий список, сам отрывок. */
export function buildStructuredLevel1Prompt({ excerpt, cast = [], previousTail = '', previousNow = '', pinned = [] }) {
    const parts = [];
    const participants = castLine(cast);
    if (participants) parts.push(participants);
    if (previousTail) parts.push(`Summarized just before this excerpt (for continuity only, do not repeat it):\n${previousTail}${previousNow ? `\nSituation at that point: ${previousNow}` : ''}`);
    parts.push(`CURRENT PINNED:\n${pinned.length ? pinned.map(item => `- ${item}`).join('\n') : '(none)'}`);
    parts.push(`EXCERPT:\n${excerpt}`);
    return parts.join('\n\n');
}

/** Хвост пересказа для контекста следующей свёртки: последние ~`max` символов по границе предложения. */
export function tailOf(text, max = 600) {
    const clean = stripUnverifiedMarker(text).trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(clean.length - max);
    const sentence = cut.search(/[.!?]\s+\S/);
    return (sentence >= 0 && sentence < max / 2 ? cut.slice(sentence + 1) : cut).trim();
}

function makeSummaryId(now, random) {
    return `sum_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

/**
 * Сообщения → логические единицы для подсчёта порога. Цепочка ToolCall
 * (одно или несколько подряд `isToolCall`-сообщений — та же «черновик по
 * пути» форма, что документирована в cores/generation/index.js) вместе со
 * следующим за ней настоящим ответом — ОДНА единица, не три и не N+1. CoT
 * (`hasReasoning`) ничего дополнительно не требует: рассуждение уже лежит
 * ВНУТРИ одного объекта сообщения, а не отдельной записью.
 *
 * Незавершённая цепочка (`isToolCall`, а следующего настоящего ответа ещё
 * нет — конец окна) — orphan: остаётся ЗА пределами возвращённых единиц
 * целиком, а не «единицей из одного сообщения». Свёртка никогда не должна
 * разрезать цепочку пополам.
 */
export function groupIntoUnits(messages) {
    const units = [];
    let i = 0;
    while (i < messages.length) {
        if (messages[i].isToolCall) {
            let j = i;
            while (j < messages.length && messages[j].isToolCall) j += 1;
            if (j >= messages.length) break; // orphan chain at the tail — hold back entirely
            units.push(messages.slice(i, j + 1));
            i = j + 1;
        } else {
            units.push([messages[i]]);
            i += 1;
        }
    }
    return units;
}

/** `true`, когда единиц за пределами защищённого окна набрался полный батч — «мгновенная активация», без ручного шага. */
export function shouldFold(unitCount, protectedWindow, batchSize) {
    return unitCount >= protectedWindow + batchSize;
}

/** Единый порядок сортировки для UI и для инъекции: по СТАРШЕЙ (самой ранней) стороне охвата — «саммари идут по тайм-стампам и сами сортируются». */
export function sortByStart(records) {
    return [...records].sort((a, b) => a.startIndex - b.startIndex);
}

export function activeSummaries(all) {
    return sortByStart(all.filter(record => !record.folded));
}

export function createBasicSummaryCore(host, { publish, now = Date.now, random = Math.random } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let settings = clampSummarySettings(DEFAULT_SETTINGS);
    let summaries = []; // все саммари ТЕКУЩЕГО чата — и активные, и уже свёрнутые в уровень выше (история, не мусор)
    // Черновики уровня >1, ожидающие verify (BasicSummary verify, ROADMAP.md)
    // — НЕ часть `summaries`/`activeSummaries()` пока не промоутятся: их дети
    // остаются active всё это время, поэтому окно не "пустеет" на время
    // проверки. `{ draft, batchIds, prompt, attempts }` — `draft` та же форма,
    // что обычная запись (без `folded`), `batchIds` — id детей этого батча
    // (кого пометить `folded:true` при промоуте), `prompt` — тот самый
    // `buildLevelNPrompt(batch)`, что породил `draft.text` (нужен дословно
    // тем же, чтобы `refoldWithFeedback()` мог продолжить тот же "разговор").
    let pending = [];
    // Журнал чата (структурированная свёртка): закреплённые факты, «Сейчас», до какого сообщения оно верно, участники. Ключ `ledger` рядом с саммари.
    let ledger = emptyLedger();

    /** `options` — сейчас только `{ priority }` (см. request.js) — форвардится как есть, необязателен. */
    async function call(contract, params, options) {
        return request(host.own, contract, { params, ...options });
    }

    // Своя очередь на запись — тот же приём, что у Ядра лорбука/истории чата:
    // read-modify-write над ОДНИМ списком `summaries`, и без сериализации два
    // параллельных фолда (например уровень 1 и случайно совпавший ручной
    // `summary.check`) рисковали бы затереть друг друга.
    let writeTail = Promise.resolve();
    function enqueueWrite(task) {
        const run = writeTail.then(task, task);
        writeTail = run.then(() => {}, () => {});
        return run;
    }

    async function loadSettings() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        if (result.ok && result.value) settings = clampSummarySettings(result.value);
        return settings;
    }

    async function configure(next) {
        settings = clampSummarySettings({ ...settings, ...next });
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: 'settings', value: settings });
        return settings;
    }

    async function loadSummaries() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: SUMMARIES_KEY, fallback: [] });
        summaries = result.ok ? result.value ?? [] : [];
        return summaries;
    }

    async function loadLedger() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: LEDGER_KEY, fallback: null });
        const stored = result.ok ? result.value : null;
        ledger = stored && typeof stored === 'object'
            ? { pinned: Array.isArray(stored.pinned) ? stored.pinned.map(String) : [], now: String(stored.now ?? ''), asOf: Number.isFinite(stored.asOf) ? stored.asOf : null, cast: Array.isArray(stored.cast) ? stored.cast.filter(entry => entry?.name) : [] }
            : emptyLedger();
        return ledger;
    }

    async function saveLedger(next) {
        ledger = next;
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: LEDGER_KEY, value: next });
        await call('storage.chatMemory.flush');
    }

    /** Отдельный ключ, тот же неймспейс — переживает перезагрузку страницы посреди verify (см. `load()`/`reloadSummariesForChat()`, оба резюмируют оставшиеся записи). */
    async function loadPending() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: PENDING_KEY, fallback: [] });
        pending = result.ok ? result.value ?? [] : [];
        return pending;
    }

    async function savePending(next) {
        pending = next;
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: PENDING_KEY, value: next });
        await call('storage.chatMemory.flush');
    }

    /**
     * Перезагрузка при смене активного чата — ТА ЖЕ гонка, что задокументирована
     * у Модуля «Notebook» (modules/tools/notebook.js, doc-comment на
     * `st.chatChanged`): `load()` выполняется один раз при старте движка, часто
     * ДО того, как ST успел подгрузить `chatMetadata` текущего чата — первый
     * `loadSummaries()` видел пустоту. Но если у Notebook устаревший пустой
     * список лишь «прятал» заметки от панели, здесь пустой `summaries` ещё и
     * ЗАПИСЫВАЕТСЯ НАЗАД: следующий `checkAndFold()` собирает `list` из
     * устаревшего (пустого) массива и `saveSummaries()` затирает на диске ВСЕ
     * старые саммари одним новым — реальная жалоба пользователя, «пропадали не
     * только свежие, но и старые саммари». Тот же приём, что у Notebook,
     * Tracker'а и reloadForActiveChat() Ядра графа памяти: подписка на
     * `st.chatChanged` (ловит и самый первый чат после перезагрузки страницы).
     * Перезагрузка идёт ЧЕРЕЗ `enqueueWrite()` — иначе параллельный с ней фолд
     * мог бы начать с предсменного списка и записать его уже ПОСЛЕ перезагрузки.
     *
     * После перезагрузки публикуется `summary.reloaded` — панель движка
     * перечитывает список по этому событию и показывает саммари УЖЕ ТЕКУЩЕГО
     * чата сразу при заходе в него, без ручного «Fold now» (тот же паттерн
     * «Ядро объявляет факт — слушатели решают сами», что и `summary.folded`).
     */
    function reloadSummariesForChat() {
        return enqueueWrite(async () => {
            await loadSummaries();
            await loadLedger();
            await loadPending();
            publishEvent('summary.reloaded', { count: activeSummaries(summaries).length });
            // Резюмируем verify для того, что не успело промоутиться до
            // смены/перезагрузки чата — fire-and-forget, НЕ await: оно само
            // дальше пишет через ту же enqueueWrite()-очередь, эта задача
            // обязана освободить её сейчас, а не ждать целого цикла verify.
            for (const entry of pending) runPendingVerification(entry.draft.id);
        });
    }

    async function saveSummaries(next) {
        summaries = next;
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: SUMMARIES_KEY, value: next });
        // Явный flush сразу после записи — тот же фикс, что уже стоит у Ядра
        // графа памяти после бутстрапа (cores/memory-graph/index.js). Обычный
        // `set()` лишь взводит ST-шный debounce (saveMetadataDebounced, 1000ms);
        // перезагрузка страницы в течение этой секунды после фолда теряла
        // саммари молча — при этом скрытые сообщения УЖЕ реально сохранены
        // (foldRawUnits() ходит через chatHistory.hide → context.saveChat()),
        // и после релоада оставалась обратная дыра: сообщения спрятаны, а
        // саммари для них нет. flush() идёт через ту же очередь Ядра памяти,
        // так что порядок с параллельными фолдами сохраняется.
        await call('storage.chatMemory.flush');
    }

    /** Тихий вызов модели — тот же контракт и та же форма запроса, что у cores/tracking/index.js's poll() (workerId пиннит на конкретный сайдкар). Здесь ответ — голый текст, не JSON: свёртке нечего парсить. */
    // `maxTokens: 5000` — явно, а не молчаливый дефолт Ядра моделей (1000):
    // свёртка батча в 10 сообщений регулярно упиралась в потолок и обрезала
    // саммари на полуслове. Реальная жалоба пользователя.
    const FOLD_MAX_TOKENS = 5000;
    /** `priority: 'pipeline'` — ВСЕГДА, у обоих вызывающих (`foldRawUnits()`/`foldChildSummaries()`): фолд всегда на критическом пути ответа пользователю (см. dispatch-queue.js), в отличие от фонового verify/refold ниже, который его НИКОГДА не передаёт — иначе фолд рисковал бы застрять в очереди воркера ЗА уже идущей фоновой проверкой. */
    async function askModelToFold(systemPrompt, prompt) {
        const result = await call('model.generate', { prompt, systemPrompt, maxTokens: FOLD_MAX_TOKENS, workerId: settings.workerId ?? undefined }, { priority: 'pipeline' });
        if (!result.ok) throw new Error(result.error.message);
        return String(result.value ?? '').trim();
    }

    function buildLevel1Prompt(units) {
        return units.flat().map(message => `${message.name || (message.isUser ? 'User' : 'Character')}: ${message.text}`).join('\n');
    }

    /** `stripUnverifiedMarker()` — чужой ребёнок мог сам быть принят "как есть" после исчерпанных попыток verify; сайдкару, читающему его как источник для СЛЕДУЮЩЕГО уровня, эта пометка — шум, не факт истории (см. doc-comment над `UNVERIFIED_PREFIX`). */
    function buildLevelNPrompt(children) {
        const body = children.map(child => stripUnverifiedMarker(child.text)).join('\n\n');
        const participants = settings.structuredFold ? castLine(ledger.cast) : '';
        return participants ? `${participants}\n\n${body}` : body;
    }

    /**
     * Отметки RP Time для периода саммари. RP Time привязывает показания
     * ВНУТРИГРОВОГО времени к сообщениям через `chatHistory.annotate`
     * (namespace `module.time`) — тот же контракт Ядра истории чата, что и у
     * всех. Никакого доступа к чужому неймспейсу мимо контракта: читается
     * штатным `chatHistory.annotations`, прямо здесь, своим правом
     * `official`.
     */
    const TIME_MARKS_NAMESPACE = 'module.time';

    async function readTimeMarks() {
        const result = await call('chatHistory.annotations', { namespace: TIME_MARKS_NAMESPACE });
        return result.ok ? result.value ?? {} : {};
    }

    /** Отметки первого и последнего замещённого сообщения по их mesid (могут быть undefined — RP Time их ещё не считал). */
    function firstLastTimeMarks(marks, mesids) {
        const byTime = [...mesids].sort((a, b) => Number(a) - Number(b));
        const first = marks[byTime[0]];
        const last = marks[byTime[byTime.length - 1]];
        return { first: first ?? undefined, last: last ?? undefined };
    }

    /** Level-1: сворачивает `batchSize` старейших единиц СЫРЫХ сообщений в одно саммари и прячет их через chatHistory.hide (is_system=true — mesid не сдвигается, см. doc-comment services/st-chat.js). */
    async function foldRawUnits(units, { previous = null } = {}) {
        const flat = units.flat();
        const mesids = flat.map(message => message.mesid);
        let text;
        let update = null;
        if (settings.structuredFold) {
            // Структурированная свёртка: пересказ + обновлённый список закреплённых фактов + «Сейчас». Модель видит участников, хвост
            // предыдущего пересказа (для непрерывности) и ТЕКУЩИЙ список — обновляет его, а не пересказывает заново.
            const cast = collectCast(flat, ledger.cast);
            const raw = await askModelToFold(STRUCTURED_FOLD_SYSTEM_PROMPT, buildStructuredLevel1Prompt({
                excerpt: buildLevel1Prompt(units), cast,
                previousTail: previous ? tailOf(previous.text) : '',
                previousNow: previous && ledger.asOf === previous.endIndex ? ledger.now : '',
                pinned: ledger.pinned,
            }));
            const parsed = parseStructuredFold(raw);
            text = parsed.story;
            update = { parsed, cast };
        } else {
            text = await askModelToFold(
                'Summarize the following conversation excerpt concisely, in third person, preserving important facts, character goals, and plot developments. Output ONLY the summary text, no preamble.',
                buildLevel1Prompt(units),
            );
        }
        // Период саммари — отметки RP Time (аннотации Ядра истории чата,
        // namespace `module.time`), а не реальные даты ST (решение
        // архитектора 11.09): заголовок саммари обязан говорить ВНУТРИГРОВОЕ
        // время, которое отслеживает RP Time. Аннотации привязаны к mesid,
        // значит период записи = отметка ПЕРВОГО и ПОСЛЕДНЕГО замещённого
        // сообщения. Читается через Ядро истории чата (annotate-контракт),
        // не напрямую в chat-memory. Отметки может не быть (опрос RP Time
        // ещё не добирался до этих сообщений) — тогда fallback на реальные
        // sendDate, чтобы период не пропадал совсем.
        const marks = await readTimeMarks();
        const inWorld = firstLastTimeMarks(marks, mesids);
        const record = {
            id: makeSummaryId(now, random),
            level: 1,
            coveredIds: mesids,
            startIndex: Math.min(...mesids.map(Number)),
            endIndex: Math.max(...mesids.map(Number)),
            // Только игровое время RP Time: реальная дата сообщения в заголовок не годится (смешивалась с игровым временем). Не посчитано
            // на момент свёртки — `null`; заголовок при вставке в промпт найдёт отметки заново (`resolvePeriod`).
            startTime: inWorldTime(inWorld.first),
            endTime: inWorldTime(inWorld.last),
            text,
            createdAt: now(),
            edited: false,
            folded: false,
        };
        for (const mesid of mesids) {
            const hidden = await call('chatHistory.hide', { mesid, hidden: true });
            if (!hidden.ok) throw new Error(hidden.error.message);
        }
        return { record, update };
    }

    /** Level N>1: сворачивает `batchSize` старейших активных саммари уровня N-1 в одно саммари уровня N — без повторного чтения сырых сообщений, только тексты детей. */
    async function foldChildSummaries(children, level) {
        const text = await askModelToFold(
            'Combine the following summaries into one, more condensed summary. Preserve important facts, character goals, and plot developments. Output ONLY the summary text, no preamble.',
            buildLevelNPrompt(children),
        );
        return {
            id: makeSummaryId(now, random),
            level,
            coveredIds: children.map(child => child.id),
            startIndex: Math.min(...children.map(child => child.startIndex)),
            endIndex: Math.max(...children.map(child => child.endIndex)),
            startTime: inWorldTime(children[0]?.startTime),
            endTime: inWorldTime(children[children.length - 1]?.endTime),
            text,
            createdAt: now(),
            edited: false,
            folded: false,
        };
    }

    /**
     * Проверка саммари уровня >1 вызовом ЛЛМ (BasicSummary verify,
     * ROADMAP.md) — решение владельца проекта, полная раскладка в истории
     * обсуждения, не только в этом doc-comment. Уровень 1 НЕ проверяется
     * (он и так читает сырые сообщения напрямую). Ревьюер видит содержимое
     * НА ОДИН УРОВЕНЬ НИЖЕ прямых детей («через один», grandparent-check):
     * для уровня 2 это сырые сообщения (`coveredIds` детей-уровня-1 — mesid),
     * для уровня 3 — тексты саммари уровня 1 (`coveredIds` детей-уровня-2).
     * Дети уровня 1, даже уже свёрнутые в уровень 2 (`folded:true`), остаются
     * в `summaries` НАВСЕГДА («история, не мусор» — см. doc-comment у самого
     * поля `summaries`), поэтому их тексты всегда достижимы для более
     * высокого уровня.
     */
    async function resolveOriginalContent(children) {
        const parts = [];
        for (const child of children) {
            if (child.level === 1) {
                const fetched = await call('chatHistory.messages', { mesids: child.coveredIds });
                const messages = fetched.ok ? fetched.value ?? [] : [];
                const byMesid = new Map(messages.map(message => [message.mesid, message]));
                parts.push(child.coveredIds.map(mesid => {
                    const message = byMesid.get(String(mesid));
                    return message ? `${message.name || (message.isUser ? 'User' : 'Character')}: ${message.text}` : '[message unavailable — context may differ]';
                }).join('\n'));
            } else {
                parts.push(child.coveredIds.map(id => {
                    const found = summaries.find(record => record.id === id);
                    return found ? stripUnverifiedMarker(found.text) : '[summary unavailable — context may differ]';
                }).join('\n\n'));
            }
        }
        return parts.join('\n\n');
    }

    /** Схема-клэмп ответа ревьюера — та же дисциплина, что `clampSummarySettings()`: неожиданная форма (модель сболтнула не то) никогда не долетает до вызывающего кода как есть. */
    function clampVerifyVerdict(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.verdict === 'ok') return { verdict: 'ok' };
        if (parsed.verdict === 'expand' && parsed.instruction) return { verdict: 'expand', instruction: String(parsed.instruction) };
        if (parsed.verdict === 'redo') return { verdict: 'redo', reason: parsed.reason ? String(parsed.reason) : undefined };
        return null;
    }

    /** Вызов ревьюера — НИКОГДА `priority: 'pipeline'` (см. doc-comment над `askModelToFold()`): это фон, ему не место впереди реального фолда в очереди воркера. `verifyWorkerId` с фоллбэком на основной `workerId` — не отдельный пул по умолчанию, просто перенастраиваемый отдельно (см. DEFAULT_SETTINGS). Непарсящийся ответ — НЕ ошибка, просто "нет вердикта" вызывающему коду: это фон, вызывающий сам решает, сколько раз повторить. */
    async function askModelToVerify(draft, originalContent) {
        const prompt = `A higher-level summary was produced by condensing several lower-level summaries. Verify it against the ORIGINAL content it is supposed to represent.\n\nORIGINAL CONTENT:\n${originalContent}\n\nSUMMARY TO VERIFY:\n${stripUnverifiedMarker(draft.text)}\n\nReply with ONLY a JSON object, one of:\n- {"verdict":"ok"} — the summary faithfully represents the original; nothing important is missing or wrong.\n- {"verdict":"expand","instruction":"..."} — the summary is missing something important; "instruction" names exactly what to add.\n- {"verdict":"redo","reason":"..."} — the summary is significantly wrong or misleading and should be written from scratch.`;
        const result = await call('model.generate', { prompt, maxTokens: FOLD_MAX_TOKENS, workerId: settings.verifyWorkerId ?? settings.workerId ?? undefined });
        if (!result.ok) return { error: result.error.message };
        const verdict = clampVerifyVerdict(parseModelJson(result.value));
        return verdict ? { verdict } : { malformed: true };
    }

    const COMBINE_SYSTEM_PROMPT = 'Combine the following summaries into one, more condensed summary. Preserve important facts, character goals, and plot developments. Output ONLY the summary text, no preamble.';

    /**
     * Расширение/переделка — НЕ вызывает `foldChildSummaries()` заново (та
     * форма промпта не несёт черновика/фидбека). N-turn контракт
     * `model.generate` (`messages`, ROADMAP.md), только `openai`-формат —
     * решение владельца: `[system, user, system]` для переделки (никакого
     * прошлого текста — свежая генерация с нуля), `[system, user, agent,
     * system]` для расширения (прошлый черновик — ассистентом, инструкция
     * ревьюера — вторым system последним ходом). `originalPrompt` — тот же
     * `buildLevelNPrompt(batch)`, что породил исходный черновик (см. `pending`
     * doc-comment) — тот же "user"-ход, что и в первой попытке.
     */
    async function refoldWithFeedback(draft, verdict, originalPrompt) {
        const messages = verdict.verdict === 'expand'
            ? [
                { role: 'system', content: COMBINE_SYSTEM_PROMPT },
                { role: 'user', content: originalPrompt },
                { role: 'assistant', content: stripUnverifiedMarker(draft.text) },
                { role: 'system', content: `This summary is missing something important: ${verdict.instruction}. Expand it to include this, keeping everything else it already says. Output ONLY the full revised summary text, no preamble.` },
              ]
            : [
                { role: 'system', content: COMBINE_SYSTEM_PROMPT },
                { role: 'user', content: originalPrompt },
                { role: 'system', content: `The previous attempt was discarded${verdict.reason ? ` — ${verdict.reason}` : ''}. Produce a fresh summary from scratch. Output ONLY the summary text, no preamble.` },
              ];
        const result = await call('model.generate', { messages, maxTokens: FOLD_MAX_TOKENS, workerId: settings.workerId ?? undefined });
        if (!result.ok) throw new Error(result.error.message);
        return String(result.value ?? '').trim();
    }

    /**
     * НЕ обёрнута в `enqueueWrite()` — единственный вызывающий,
     * `checkAndFold()`, уже выполняется ВНУТРИ своего собственного
     * `enqueueWrite()`; обернуть ещё раз означало бы ждать задачу,
     * поставленную ПОСЛЕ текущей в ту же очередь, из самой текущей задачи —
     * дедлок. Взаимоисключение здесь уже обеспечено внешним `enqueueWrite()`.
     */
    async function pushPendingRaw(entry) {
        await savePending([...pending, entry]);
    }

    async function savePendingEntry(entry) {
        return enqueueWrite(async () => { await savePending(pending.map(item => (item.draft.id === entry.draft.id ? entry : item))); });
    }

    /** Промоут — дети батча помечаются `folded:true`, черновик уходит в `summaries` настоящей активной записью, запись убирается из буфера. `unreliable` — исчерпаны попытки (или сам verify не смог ответить вовсе) — добавляет `UNVERIFIED_PREFIX`, решение владельца п.16: "принимаем, но помечаем внутри самого саммари". */
    async function promotePending(id, { unreliable }) {
        return enqueueWrite(async () => {
            const entry = pending.find(item => item.draft.id === id);
            if (!entry) return; // уже промоутнута/удалена другим путём
            const finalText = unreliable ? `${UNVERIFIED_PREFIX}${stripUnverifiedMarker(entry.draft.text)}` : entry.draft.text;
            const record = { ...entry.draft, text: finalText };
            const batchIds = new Set(entry.batchIds);
            let next = summaries.map(item => (batchIds.has(item.id) ? { ...item, folded: true } : item));
            next = [...next, record];
            await saveSummaries(next);
            await savePending(pending.filter(item => item.draft.id !== id));
            publishEvent('summary.folded', { count: next.length });
            publishEvent('summary.verify.completed', { id, verdict: unreliable ? 'accepted-unverified' : 'ok' });
        });
    }

    /**
     * Гоняется detached (fire-and-forget) — вызывающий код (checkAndFold()/
     * load()/reloadSummariesForChat()) НИКОГДА её не ждёт: цикл фолда и ответ
     * пользователю не должны ждать фоновую проверку (решение владельца:
     * "проводить его когда есть свободное место" — настоящего сигнала
     * "воркер свободен" строить не нужно, общая очередь и так это отражает,
     * см. dispatch-queue.js). Каждая итерация сама коммитит прогресс через
     * `savePendingEntry()`/`promotePending()` — переживает и обрыв прямо
     * посреди цикла (следующий `load()`/`st.chatChanged` резюмирует с того
     * же `attempts`/`draft.text`, не с нуля).
     */
    async function runPendingVerification(id) {
        const entry = pending.find(item => item.draft.id === id);
        if (!entry) return;

        const children = entry.batchIds.map(childId => summaries.find(record => record.id === childId)).filter(Boolean);
        const originalContent = await resolveOriginalContent(children);

        for (;;) {
            let verdict = null;
            for (let attempt = 0; attempt < MAX_VERIFY_TRANSPORT_RETRIES && !verdict; attempt += 1) {
                const outcome = await askModelToVerify(entry.draft, originalContent);
                if (outcome.verdict) { verdict = outcome.verdict; break; }
                publishEvent('summary.verify.failed', { id, reason: outcome.error ?? 'malformed verifier response' });
            }
            if (!verdict) { await promotePending(id, { unreliable: true }); return; }
            if (verdict.verdict === 'ok') { await promotePending(id, { unreliable: false }); return; }
            if (entry.attempts >= MAX_VERIFY_ATTEMPTS) { await promotePending(id, { unreliable: true }); return; }

            entry.attempts += 1;
            try {
                entry.draft = { ...entry.draft, text: await refoldWithFeedback(entry.draft, verdict, entry.prompt) };
            } catch (error) {
                publishEvent('summary.verify.failed', { id, reason: error?.message ?? String(error) });
                await promotePending(id, { unreliable: true }); // refold сам не смог ответить — не крутим цикл вечно
                return;
            }
            await savePendingEntry(entry);
        }
    }

    /**
     * Порог + каскад — этап `generation.prepare` (то же «освежить своё
     * состояние до ответа», что и у Tracker'а). Уровень 1 читает реальные
     * сообщения; каждый следующий уровень — уже готовые тексты уровня ниже,
     * поэтому цена каскада не растёт с глубиной истории.
     */
    /**
     * `summary.folded` уходит СРАЗУ после каждого сохранённого батча, не
     * только один раз в конце всей функции — раньше был именно так, и это
     * пряталось за тем же наблюдением, что уже отражено в комментарии ниже
     * про построчное `saveSummaries()`: упади батч ПОСЛЕ хотя бы одного
     * удачного (второй уровень, второй проход уровня 1 — что угодно дальше
     * по цепочке), исключение уходит из `checkAndFold()` до строки с
     * `publishEvent`, и УЖЕ СОХРАНЁННЫЙ на диск батч остаётся невидим
     * панели — `cores/ui/engine-panel.js` перечитывает список ТОЛЬКО по
     * этому событию (см. его doc-comment на `summary.folded`), а не при
     * каждом открытии. Данные не терялись (это уже проверяет отдельный
     * тест), терялось только уведомление панели о том, что они появились.
     */
    async function checkAndFold() {
        try {
            return await enqueueWrite(async () => {
                let list = [...summaries];

                // Сохраняем ПОСЛЕ КАЖДОГО удачного фолда, а не одним разом в конце:
                // `foldRawUnits()` уже скрыло реальные сообщения через `chatHistory.hide`
                // до того, как эта функция вообще узнаёт, удался ли фолд — и упади
                // следующий батч в цепочке (например, второй уровень или второй
                // проход уровня 1), запись «в один присест» потеряла бы уже
                // состоявшийся, необратимый фолд: сообщения скрыты, а саммари для
                // них — нет. Обнаружено живой проверкой в браузере (сеть реально
                // упала на втором вызове модели), не придумано заранее.
                const level1 = settings.levels[0];
                if (level1) {
                    const fetched = await call('chatHistory.messages', { limit: settings.protectedWindow + level1.batchSize + FETCH_MARGIN });
                    const messages = fetched.ok ? fetched.value ?? [] : [];
                    const units = groupIntoUnits(messages);
                    while (shouldFold(units.length, settings.protectedWindow, level1.batchSize)) {
                        const batch = units.splice(0, level1.batchSize);
                        const firstMesid = Math.min(...batch.flat().map(message => Number(message.mesid)));
                        const previous = activeSummaries(list).filter(item => item.endIndex < firstMesid).at(-1) ?? null;
                        const { record, update } = await foldRawUnits(batch, { previous });
                        list = [...list, record];
                        await saveSummaries(list);
                        if (update) await applyLedgerUpdate(update, record);
                        publishEvent('summary.folded', { count: list.length });
                    }
                }

                for (let levelIndex = 1; levelIndex < settings.levels.length; levelIndex += 1) {
                    const level = settings.levels[levelIndex];
                    const parentLevel = levelIndex; // саммари уровня `levelIndex` (1-based level number == levelIndex here, since levels[0] produces level:1)
                    let pool = activeSummaries(list).filter(record => record.level === parentLevel);
                    while (pool.length >= level.batchSize) {
                        const batch = pool.slice(0, level.batchSize);
                        const record = await foldChildSummaries(batch, parentLevel + 1);
                        pool = pool.slice(level.batchSize);

                        if (settings.verifyEnabled) {
                            // НЕ идёт в `list`/`summaries` сразу и НЕ помечает
                            // детей `folded` — черновик уходит в буфер, verify
                            // гоняется detached (см. `runPendingVerification()`
                            // doc-comment). Дети остаются active всё это время:
                            // окно контекста не "пустеет" на время проверки, а
                            // следующий уровень каскада (levelIndex+1) честно не
                            // видит ещё не промоутнутый черновик — заберёт его
                            // на СЛЕДУЮЩЕМ вызове `checkAndFold()`, когда он уже
                            // будет в `summaries`.
                            const entry = { draft: record, batchIds: batch.map(child => child.id), prompt: buildLevelNPrompt(batch), attempts: 0 };
                            await pushPendingRaw(entry);
                            publishEvent('summary.verify.started', { id: record.id, level: record.level });
                            runPendingVerification(record.id); // fire-and-forget — см. doc-comment функции
                        } else {
                            const batchIds = new Set(batch.map(child => child.id));
                            list = list.map(item => (batchIds.has(item.id) ? { ...item, folded: true } : item));
                            list = [...list, record];
                            await saveSummaries(list);
                            publishEvent('summary.folded', { count: list.length });
                        }
                    }
                }

                return activeSummaries(list);
            });
        } catch (error) {
            // Автоматический фолд идёт этапом `generation.prepare` с
            // `onExhausted: 'flag'` — его отказ НЕ идёт через ручной путь
            // «Fold now» (`engine-panel.js`'s `forceSummaryFold()`), который
            // сам показывает `result.error.message`. Без этого события
            // автоматический сбой был не виден вообще НИГДЕ: сообщение уже
            // не свёрнуто, а почему — неизвестно ни пользователю, ни при
            // отладке. Модуль/панель решает, показывать ли это как тост —
            // здесь только объявление факта, тот же приём, что и `tracking.
            // poll.failed` у Ядра трекинга.
            publishEvent('summary.foldFailed', { message: error?.message ?? String(error) });
            throw error;
        }
    }

    /** Журнал после свёртки: закреплённые факты (с защитой от потери списка), «Сейчас» и участники. Формат проигнорирован — прежнее остаётся. */
    async function applyLedgerUpdate({ parsed, cast }, record) {
        await saveLedger({
            pinned: parsed.pinned === null ? ledger.pinned : mergePinned(ledger.pinned, parsed.pinned, settings.pinnedMaxChars),
            now: parsed.now ?? ledger.now,
            asOf: parsed.now ? record.endIndex : ledger.asOf,
            cast,
        });
    }

    /** Ручная правка журнала (закреплённые факты и «Сейчас») — модель может ошибиться, а пользователь знает историю. */
    async function setLedger({ pinned, now: nowText } = {}) {
        return enqueueWrite(async () => {
            const next = {
                ...ledger,
                pinned: Array.isArray(pinned) ? mergePinned([], parsePinnedLines(pinned), settings.pinnedMaxChars) : ledger.pinned,
                now: nowText === undefined ? ledger.now : String(nowText ?? '').trim(),
            };
            await saveLedger(next);
            return next;
        });
    }

    async function updateSummary({ id, text } = {}) {
        return enqueueWrite(async () => {
            const index = summaries.findIndex(record => record.id === id);
            if (index < 0) throw new Error(`summary.update: no summary with id "${id}".`);
            const next = [...summaries];
            next[index] = { ...next[index], text: String(text ?? '').trim(), edited: true };
            await saveSummaries(next);
            return next[index];
        });
    }

    async function deleteSummary({ id } = {}) {
        return enqueueWrite(async () => {
            const next = summaries.filter(record => record.id !== id);
            if (next.length === summaries.length) return false;
            await saveSummaries(next);
            return true;
        });
    }

    /**
     * Инъекция — этап `generation.beforeSend`, живая мутация `chat` (тот же
     * приём, что modules/tools/notebook.js's injectIntoPrompt). Все активные
     * саммари ВСЕГДА старше любого оставшегося сырого сообщения (сворачиваются
     * только те, что уже вне защищённого окна) — поэтому их не нужно
     * вперемешку вставлять по всему массиву, достаточно вставить блоком в
     * самое начало, отсортировав между собой по `startIndex`. Каждое —
     * ОТДЕЛЬНЫМ сообщением, не одним слитым блоком: у ST бюджет промпта
     * заполняется от новых к старым и режет ровно на границе (проверено по
     * script.js), и только отдельные сообщения вытесняются по-настоящему
     * строго от старых к новым — слитый блок пришлось бы выкидывать целиком.
     *
     * СКРЫТЫЕ ТУЛ-КОЛЛЫ ВЫРЕЗАЮТСЯ, а не скрываются (живая проблема 11.09):
     * ST при сборке промпта фильтрует `is_system`, но с ИСКЛЮЧЕНИЕМ для
     * тул-коллов — `script.js`: `coreChat = chat.filter(x => !x.is_system ||
     * (canUseTools && Array.isArray(x.extra?.tool_invocations)))`. Поэтому
     * `chatHistory.hide` прячет обычные сообщения, а сообщения с
     * `extra.tool_invocations` всё равно попадают в промпт — вместе со всем
     * содержимым вызовов и результатов. Здесь они удаляются из мутируемой
     * копии `chat` целиком: пара «assistant с tool_calls + role:'tool'
     * ответы» живёт ВНУТРИ одного объекта сообщения (`extra.tool_invocations`,
     * ST синтезирует `role:'tool'` строки из него при сборке payload), так
     * что вырезание одного элемента убирает и вызов, и его результат.
     *
     * Граница «свежести» — от КОНЦА истории (решение архитектора 11.09):
     * тул-колл рождается в ST уже системным, поэтому «скрыт саммари» и
     * «просто свежий тул-колл» по is_system не различаются. Режутся скрытые
     * тул-коллы только СТАРЕЕ защищённого окна (protectedWindow от конца
     * истории); свежие вызовы внутри окна не трогаются никогда.
     */
    /**
     * Заголовок саммари — ЯВНОЕ объявление «это саммари» + период, который оно
     * замещает (запрос архитектора 11.09). Период берётся из record.startTime/
     * endTime — а они у КАЖДОГО уровня привязаны к ПЕРВОМУ и ПОСЛЕДНЕМУ
     * замещённому сообщению: уровень 1 пишет их из сырых сообщений батча,
     * уровень N>1 — из крайних ДЕТЕЙ (foldChildSummaries), так что при
     * слиянии слоёв период честно расширяется и остаётся привязанным к
     * реальным сообщениям, а не к моменту свёртки.
     */
    function formatSummaryMessage(record, marks = {}) {
        return `${formatSummaryHeader(record, resolvePeriod(record, marks))}\n${record.text}`;
    }

    /** Закреплённые факты и «Сейчас» — отдельными сообщениями после саммари: ST режет промпт от старых к новым, эти уходят последними. */
    function ledgerMessages() {
        const out = [];
        if (ledger.pinned.length) {
            out.push({ is_user: false, is_system: true, name: 'Summary', mes: `[Pinned facts — lasting rules, promises, relationships and open threads established so far; they hold until the story changes them]\n${ledger.pinned.map(item => `- ${item}`).join('\n')}` });
        }
        if (ledger.now) {
            const upTo = ledger.asOf === null ? '' : ` (up to message #${ledger.asOf})`;
            out.push({ is_user: false, is_system: true, name: 'Summary', mes: `[Where the summarized part of the story ends${upTo}]\n${ledger.now}` });
        }
        return out;
    }

    async function injectIntoPrompt({ chat } = {}) {
        if (!Array.isArray(chat)) return true;
        const active = activeSummaries(summaries);
        let messages = [];
        if (active.length) {
            // Вырезание скрытых тул-коллов СТАРЕЕ защищённого окна (позиция
            // считается ОТ КОНЦА — решение архитектора 11.09), затем unshift
            // саммари. Один проход фильтром: у выживших индексы сдвигаются
            // равномерно, поэтому «позиция от конца» считается по ИСХОДНОЙ
            // длине массива.
            const windowStart = chat.length - settings.protectedWindow; // всё < этого индекса — старая зона
            const pruned = chat.filter((message, index) => {
                const isToolCall = Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0;
                return !(isToolCall && message.is_system && index < windowStart);
            });
            if (pruned.length !== chat.length) chat.splice(0, chat.length, ...pruned);
            const marks = await readTimeMarks(); // игровое время — по отметкам RP Time на момент вставки, не по сохранённому при свёртке
            messages = [...active.map(record => ({ is_user: false, is_system: true, name: 'Summary', mes: formatSummaryMessage(record, marks) })), ...ledgerMessages()];
        }
        // Место публикуется ВСЕГДА, даже без активных саммари (владелец: «модуль должен публиковать своё место
        // даже если он пустой») — иначе до первой свёртки истории Summaries нигде не было видно в дереве PM.
        await deliverToPrompt({
            call, contribution: { id: 'summary', name: 'Summaries', role: 'assistant', content: messages.map(message => message.mes).join('\n\n'), defaultPlacement: 'before-history', stable: true },
            legacy: () => { if (messages.length) chat.unshift(...messages); },
        });
        return true;
    }

    async function load() {
        await loadSettings();
        await loadSummaries();
        await loadLedger();
        await loadPending();
        host.own.register(FOLD_CONTRACT, () => checkAndFold());
        host.own.register(INJECT_CONTRACT, params => injectIntoPrompt(params));
        await call('pipeline.stages.add', {
            pipelineId: PREPARE_PIPELINE,
            stage: { id: FOLD_STAGE_ID, contract: FOLD_CONTRACT, onExhausted: 'flag' },
        });
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            stage: { id: INJECT_STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
        // Резюмирует verify оставшееся с прошлого запуска движка (страница
        // перезагрузилась/движок перезапустился посреди цикла) — тот же
        // fire-and-forget, что и у `reloadSummariesForChat()`.
        for (const entry of pending) runPendingVerification(entry.draft.id);
    }

    const unregisters = [
        host.own.register('summary.settings', () => settings),
        host.own.register('summary.configure', params => configure(params ?? {})),
        host.own.register('summary.list', () => activeSummaries(summaries)),
        host.own.register('summary.ledger', () => ledger),
        host.own.register('summary.ledger.set', params => setLedger(params)),
        host.own.register('summary.update', params => updateSummary(params)),
        host.own.register('summary.delete', params => deleteSummary(params)),
    ];

    const unsubscribeChatChanged = host.events.subscribe('st.chatChanged', () => { reloadSummariesForChat(); });

    return {
        load,
        checkAndFold,
        settings: () => settings,
        list: () => activeSummaries(summaries),
        ledger: () => ledger,
        unregister: async () => {
            await call('pipeline.stages.remove', { pipelineId: PREPARE_PIPELINE, stageId: FOLD_STAGE_ID }).catch(() => {});
            await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: INJECT_STAGE_ID }).catch(() => {});
            unsubscribeChatChanged();
            for (const unregister of unregisters) unregister();
        },
    };
}
