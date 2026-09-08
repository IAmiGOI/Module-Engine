import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Button, TextInput, TextArea, Select, Toggle, Slider, Field, Row, EditableList, EmptyState } from '../../libraries/shared/widgets.js';
import { GenerationSettingsPanel } from '../../libraries/shared/generation-settings-panel.js';
import { SAMPLER_PRESETS, clampSamplerSettings, clampReasoningSettings, buildCustomPreset } from '../../cores/models/internal-engine.js';


/**
 * Модуль «Post-Turn Processor» — порт Alpha `modules/postprocess` на
 * архитектуру Beta. Каждый свежий ответ проходит цепочку НЕЗАВИСИМЫХ pass'ов
 * (свой промпт, своё подключение к модели, свои настройки сэмплера), и
 * последний результат заменяет текст сообщения. Бейдж под сообщением
 * показывает word-level diff каждого pass'а.
 *
 * **Что и куда переехало относительно Alpha** (каждая строка — на то была
 * причина):
 *
 *  - `MESSAGE_RECEIVED` → **прямая подписка на `generation.completed`**
 *    (`host.events.subscribe`) — тот же триггер, что у «RP Time» и
 *    generic-трекера. Раньше авто-запуск шёл через этапы fold-пайплайна
 *    `generation.completed`; вживую этот путь так и не заработал (в
 *    изоляции — работал), и «нормальные типы» на пайплайн для момента
 *    «ответ готов» не опираются. Цепочка begin → pass'ы → apply та же,
 *    что у кнопки «Process last reply now», — один код на оба пути.
 *  - Правка `context.chat` напрямую → **`chatHistory.replaceText`**
 *    (Ядро истории чата → Сервис `stChat.setText`). Alpha сама звала
 *    `updateMessageBlock`/`saveChatConditional`; здесь это знание живёт
 *    в Сервисе, а Модуль проходит через контракт — тот же разрез, что и
 *    у всех остальных правок сообщения.
 *  - SideCar-профили → **workerId + GenerationSettingsPanel на каждый
 *    pass** (та же карточка, что у трекеров и «RP Time»): функционально
 *    богаче профиля — ризонинг настраивается рядом с сэмплером.
 *  - chat-badges в `message.extra` → **аннотации Ядра истории чата +
 *    узкая кнопка в слоте `center` подвала** (`ui.messageFooter.claim`).
 *    Alpha хранила trace в `message.extra` — то есть писала в данные чата;
 *    здесь кнопка живёт в DOM и per-chat хранилище аннотаций, `message.mes`
 *    не касается. Фабрика слота отдаёт null под сообщением без готового
 *    trace: Ядро строит ячейку сетки только под непустые фабрики, поэтому
 *    соседний блок времени больше не сжимается под сообщениями, где
 *    postturn ничего не менял (реальный регресс, лечён именно этим).
 *    Кнопка открывает всплывающее окно с word-diff'ом каждого pass'а.
 *  - Словесный diff, сборка запроса pass'а и санитизация списка pass'ов —
 *    портированы как чистые функции (экспортируются для тестов) без
 *    изменений в поведении.
 *
 * **Переносимое значение цепочки** — `{ skip, mesid, original, text,
 * trace }`. Шаг begin его собирает (или честно ставит `skip: true` —
 * нечего обрабатывать), каждый pass дописывает свой шаг в `trace` и,
 * если удался, подменяет `text`, шаг apply применяет результат. Провал
 * pass'а превращается в запись «skipped» в trace, а не в краш: один
 * плохой pass не отменяет ни соседних, ни уже сделанного — тот же
 * «skipped, не упал», что и у Alpha.
 */

export const MODULE_ID = 'module.postprocess';
const SETTINGS_NAMESPACE = MODULE_ID;
/** Namespace аннотаций Ядра истории чата — per-chat бесплатно. */
const HISTORY_NAMESPACE = MODULE_ID;

const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 4000;
const MIN_CONTEXT_DEPTH = 1;
const MAX_CONTEXT_DEPTH = 20;
const DEFAULT_CONTEXT_DEPTH = 6;
/** Один такой символ — раздражающий шум, а не сигнал (наследовано из Alpha). */
const MESSAGE_CHARS = 900;
// Word-level diff поверх такого числа токенов на любой из сторон — дорогой
// LCS O(a*b) ради бейджа, который могут так и не открыть. Дальше — одна
// пара remove+add вместо таблицы.
const MAX_DIFF_TOKENS = 4000;
/** Сколько последних сообщений запросить, когда pass просил контекст чата. */
const CONTEXT_LIMIT = 50;

// --- Чистые функции (экспортируются для тестов) ------------------------------

function createPassId() {
    return `pass_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createPass() {
    const sampler = clampSamplerSettings();
    const reasoning = clampReasoningSettings();
    return {
        id: createPassId(), name: 'New pass', prompt: '', workerId: '', enabled: true,
        includeContext: false, contextDepth: DEFAULT_CONTEXT_DEPTH,
        samplerPreset: '', temperature: sampler.temperature, topP: sampler.topP, topK: sampler.topK,
        maxTokens: sampler.maxTokens, reasoningMode: reasoning.reasoningMode,
        reasoningEffort: reasoning.reasoningEffort, reasoningBudget: reasoning.reasoningBudget,
    };
}

function clampContextDepth(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(MAX_CONTEXT_DEPTH, Math.max(MIN_CONTEXT_DEPTH, number)) : DEFAULT_CONTEXT_DEPTH;
}

/** Нормализует сырой список pass'ов; дубликаты id выкидываются, у безымянных — «Untitled pass». */
export function sanitizePasses(passes) {
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(passes) ? passes : []) {
        const id = String(raw?.id ?? '').trim() || createPassId();
        if (seen.has(id)) continue;
        seen.add(id);
        const sampler = clampSamplerSettings(raw);
        const reasoning = clampReasoningSettings(raw);
        result.push({
            id,
            name: String(raw?.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled pass',
            prompt: String(raw?.prompt ?? '').trim().slice(0, MAX_PROMPT_LENGTH),
            workerId: String(raw?.workerId ?? '').trim(),
            enabled: raw?.enabled !== false,
            includeContext: Boolean(raw?.includeContext),
            contextDepth: clampContextDepth(raw?.contextDepth ?? DEFAULT_CONTEXT_DEPTH),
            samplerPreset: String(raw?.samplerPreset ?? '').trim(),
            temperature: sampler.temperature, topP: sampler.topP, topK: sampler.topK, maxTokens: sampler.maxTokens,
            reasoningMode: reasoning.reasoningMode, reasoningEffort: reasoning.reasoningEffort, reasoningBudget: reasoning.reasoningBudget,
        });
    }
    return result;
}

/** Форма контекста — та же, что у Alpha (Player/Character + обрезка), но по нейтральной форме Сервиса `{isUser, text}`. */
export function buildContextBlock(chat, depth) {
    return (chat ?? [])
        .filter(item => !item.isSystem)
        .slice(-depth)
        .map(item => `${item.isUser ? 'Player' : 'Character'}: ${String(item.text ?? '').slice(0, MESSAGE_CHARS)}`)
        .join('\n\n');
}

/**
 * Запрос одного pass'а: pass изолирован от остальных (не знает о пайплайне)
 * и по умолчанию видит только инструкцию и текст ПРЕДЫДУЩЕГО шага. Контекст
 * чата — его собственная настройка `includeContext`/`contextDepth`, не
 * макрос в тексте инструкции.
 */
export function buildPassRequest(pass, inputText, chat = []) {
    const systemPrompt = `${String(pass?.prompt ?? '').trim()}\n\nReturn ONLY the rewritten text — no explanation, no markdown code fences, no commentary before or after it.`;
    if (!pass?.includeContext) {
        return { systemPrompt, prompt: String(inputText ?? '') };
    }
    const context = buildContextBlock(chat, clampContextDepth(pass.contextDepth ?? DEFAULT_CONTEXT_DEPTH));
    return {
        systemPrompt,
        prompt: `RECENT CONTEXT:\n${context}\n\nTEXT TO REWRITE:\n${String(inputText ?? '')}`,
    };
}

/** Срезает код-фенс, который модель добавила назло инструкции, и тримит. */
export function cleanPassOutput(raw) {
    return String(raw ?? '').replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
}

/**
 * Один шаг цепочки. `requestFn(pass, built)` вводится снаружи — чисто и
 * тестируемо без модели. Pass без инструкции, пустой результат или упавший
 * запрос — это «skipped» в trace, а не провал цепочки: текст проходит
 * насквозь без изменений, остальные pass'ы работают.
 */
export async function applyPass(value, pass, requestFn, chat = []) {
    if (value?.skip) return value;
    const trace = [...(value?.trace ?? [])];
    if (!pass?.prompt) {
        trace.push({ passId: pass?.id, name: pass?.name ?? pass?.id, skipped: true, reason: 'no-prompt' });
        return { ...value, trace };
    }
    try {
        const built = buildPassRequest(pass, value.text, chat);
        const cleaned = cleanPassOutput(await requestFn(pass, built));
        if (!cleaned) {
            trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: 'empty-output' });
            return { ...value, trace };
        }
        trace.push({ passId: pass.id, name: pass.name, before: value.text, after: cleaned });
        return { ...value, text: cleaned, trace };
    } catch (error) {
        trace.push({ passId: pass.id, name: pass.name, skipped: true, reason: error?.message ?? String(error) });
        return { ...value, trace };
    }
}

// --- Word-level diff (портирован из Alpha без изменений) ----------------------

function tokenize(text) {
    return String(text ?? '').match(/\S+|\s+/g) ?? [];
}

function longestCommonSubsequenceTable(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    return dp;
}

/** Массив `{ type: 'equal'|'add'|'remove', text }`; сверх `MAX_DIFF_TOKENS` — одна пара remove+add без LCS. */
export function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
        const segments = [];
        if (a.length) segments.push({ type: 'remove', text: a.join('') });
        if (b.length) segments.push({ type: 'add', text: b.join('') });
        return segments;
    }
    const dp = longestCommonSubsequenceTable(a, b);
    const segments = [];
    const push = (type, text) => {
        const last = segments[segments.length - 1];
        if (last && last.type === type) last.text += text;
        else segments.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { push('equal', a[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { push('remove', a[i]); i++; }
        else { push('add', b[j]); j++; }
    }
    while (i < a.length) { push('remove', a[i]); i++; }
    while (j < b.length) { push('add', b[j]); j++; }
    return segments;
}

// --- Модуль -------------------------------------------------------------------

export function createPostprocessModule(host) {
    const settings = { autoRun: true, passes: [] };
    const autoRun = signal(true);
    const passes = signal([]);
    const workers = signal([]);
    const customPresets = signal([]);
    const busy = signal(false);
    /** Отметки `{ mesid: { original, trace, appliedAt } }` — источник бейджа, как у «RP Time». */
    const badges = signal({});
    // UI-сигналы каждого pass'а, лениво по pass.id (форма — ровно та, что
    // ждёт GenerationSettingsPanel, плюс собственные поля pass'а).
    const passUi = new Map();
    // Какой свайп был, генерации ещё не было — цель узнаём на beforeSend
    // (тот же приём, что у «RP Time»).
    let pendingSwipe = false;

    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    async function currentMesid() {
        const result = await call('ui.messageFooter.liveMesid');
        return result.ok ? result.value ?? null : null;
    }

    // --- Цепочка: три шага, по одному на этап ---------------------------------

    /**
     * Шаг 1 (этап `postprocess:begin`). Найти свежий не-пользовательский
     * ответ и снять с него «уже обработано» — если бейдж на этом mesid уже
     * стоит, повторно переписывать нечего (реролл стирает бейдж заранее,
     * см. подписки ниже).
     */
    async function beginRun({ ignoreAutoRun = false } = {}) {
        if (!ignoreAutoRun && settings.autoRun === false) return { skip: true };
        if (!sanitizePasses(settings.passes).some(pass => pass.enabled !== false && pass.prompt)) return { skip: true };
        const mesid = await currentMesid();
        if (!mesid) return { skip: true };
        const messagesResult = await call('chatHistory.messages', { limit: CONTEXT_LIMIT });
        const found = (messagesResult.ok ? messagesResult.value ?? [] : []).find(item => item.mesid === String(mesid));
        if (!found || found.isUser || found.isSystem) return { skip: true };
        const text = String(found.text ?? '');
        if (!text.trim()) return { skip: true };
        const annotationsResult = await call('chatHistory.annotations', { namespace: HISTORY_NAMESPACE });
        if ((annotationsResult.ok ? annotationsResult.value ?? {} : {})[String(mesid)]) return { skip: true };
        return { skip: false, mesid: String(mesid), original: text, text, trace: [] };
    }

    /**
     * Шаг 2 (этап `postprocess:pass:<id>`, по одному на каждый включённый
     * pass). Модель зовётся контрактом `model.generate` С ЯДРА моделей —
     * то, чем в Alpha был SideCar; workerId и настройки сэмплера —
 *     собственность pass'а, а не воркера.
     */
    async function runOnePass(value, pass) {
        if (!value || value.skip) return value;
        if (!pass || pass.enabled === false) return value;
        // Контекст чата — только когда pass сам его попросил; глубину клэмпим,
        // а не верим настройке как есть (та же гигиена, что у ползунков).
        let chat = [];
        if (pass.includeContext) {
            const chatResult = await call('chatHistory.messages', { limit: clampContextDepth(pass.contextDepth) });
            chat = chatResult.ok ? chatResult.value ?? [] : [];
        }
        return applyPass(value, pass, async (p, built) => {
            const result = await call('model.generate', {
                prompt: built.prompt,
                systemPrompt: built.systemPrompt,
                workerId: p.workerId || undefined,
                temperature: p.temperature, topP: p.topP, topK: p.topK, maxTokens: p.maxTokens,
                reasoningMode: p.reasoningMode, reasoningEffort: p.reasoningEffort, reasoningBudget: p.reasoningBudget,
            });
            if (!result.ok) throw new Error(result.error?.message ?? 'model.generate failed');
            return result.value;
        }, chat);
    }

    /**
     * Шаг 3 (этап `postprocess:apply`). Правка текста — ТОЛЬКО через
     * контракт Ядра истории чата (`chatHistory.replaceText` → Сервис), trace
     * — в аннотации того же Ядра. Если ни один pass ничего не изменил,
     * сообщение не трогается вовсе.
     */
    async function applyResult(value) {
        if (!value || value.skip) return false;
        if (String(value.text) === String(value.original)) return false;
        const entry = { original: value.original, trace: value.trace, appliedAt: Date.now() };
        const replaced = await call('chatHistory.replaceText', { mesid: value.mesid, text: value.text });
        if (!replaced.ok) throw new Error(replaced.error?.message ?? 'chatHistory.replaceText failed');
        await call('chatHistory.annotate', { namespace: HISTORY_NAMESPACE, mesid: value.mesid, value: entry });
        badges.set({ ...badges.peek(), [value.mesid]: entry });
        refreshFooter();
        return true;
    }

    /** Ручной прогон той же цепочки по последнему ответу — кнопка в панели. */
    async function processNow() {
        if (busy.peek()) return null;
        busy.set(true);
        try {
            const start = await beginRun({ ignoreAutoRun: true });
            if (start.skip) { await notify('ok', 'Nothing to process — no fresh unprocessed reply'); return false; }
            let value = start;
            for (const pass of sanitizePasses(settings.passes).filter(item => item.enabled !== false && item.prompt)) {
                value = await runOnePass(value, pass);
            }
            const changed = await applyResult(value);
            await notify('ok', changed ? 'Reply rewritten' : 'Passes ran, but nothing changed');
            return changed;
        } catch (error) {
            await notify('error', error?.message ?? String(error));
            return false;
        } finally {
            busy.set(false);
        }
    }

    /**
     * Авто-запуск по завершению генерации — прямая подписка на событие,
     * ровно как у «RP Time» (`advance()`) и generic-трекера. Раньше это был
     * набор этапов на fold-пайплайне `generation.completed`: в изоляции
     * цепочка работала, но вживую ни разу не сработала, а «нормальные типы»
     * событие «ответ готов» читают напрямую. Цепочка та же, что у кнопки
     * «Process last reply now»; повторный вызов безопасен — begin видит
     * аннотацию «уже обработано» и уходит в skip.
     */
    async function runOnCompleted() {
        if (busy.peek()) return;
        if (settings.autoRun === false) return;
        if (!sanitizePasses(settings.passes).some(pass => pass.enabled !== false && pass.prompt)) return;
        busy.set(true);
        try {
            const start = await beginRun({ ignoreAutoRun: true });
            if (start.skip) return;
            let value = start;
            for (const pass of sanitizePasses(settings.passes).filter(item => item.enabled !== false && item.prompt)) {
                value = await runOnePass(value, pass);
            }
            await applyResult(value);
        } catch (error) {
            await notify('error', error?.message ?? String(error));
        } finally {
            busy.set(false);
        }
    }

    // --- Бейдж ------------------------------------------------------------------

    function passRow(step) {
        if (step.skipped) {
            return h('div', { class: 'stme-postprocess-step stme-postprocess-step-skipped' },
                h('strong', {}, step.name ?? step.passId),
                h('span', { class: 'stme-postprocess-skip-reason' }, ` — skipped (${step.reason})`));
        }
        return h('div', { class: 'stme-postprocess-step' },
            h('strong', {}, step.name ?? step.passId),
            h('div', { class: 'stme-postprocess-diff-text' },
                diffWords(step.before, step.after).map(segment => (segment.type === 'equal'
                    ? segment.text
                    : h(segment.type === 'add' ? 'ins' : 'del',
                        { class: segment.type === 'add' ? 'stme-postprocess-add' : 'stme-postprocess-remove' },
                        segment.text)))));
    }

    /**
     * Фабрика слота `center` подвала: узел-кнопка ТОЛЬКО под сообщением, у
     * которого есть готовый trace, под остальными — null. Раньше корнем был
     * computed, который всегда возвращал обёртку: Ядро подвала честно строило
     * под ним ячейку сетки, и блок времени сжимался вдвое под КАЖДЫМ
     * сообщением, даже где postturn ничего не менял. Ядро создаёт ячейку
     * только под непустые фабрики (см. его fillSlots), поэтому пустота должна
     * быть именно null. Смена «пусто ↔ есть» — на самом модуле: его данные
     * изменились, он и зовёт `ui.messageFooter.attach`.
     */
    function footerWidget(message) {
        const entry = badges()[String(message.mesid)];
        if (!entry) return null;
        const done = (entry.trace ?? []).filter(step => !step.skipped).length;
        const popup = h('div', { class: 'stme-postprocess-popup', style: 'display:none' },
            h('div', { class: 'stme-postprocess-popup-head' },
                h('strong', {}, 'Post-Turn changes'),
                h('button', { type: 'button', class: 'stme-postprocess-popup-close', 'on:click': () => { popup.style.display = 'none'; } }, '✕')),
            h('div', { class: 'stme-postprocess-diff' }, (entry.trace ?? []).map(step => passRow(step))));
        const pill = h('button', {
            type: 'button',
            class: 'stme-stat stme-postprocess-pill',
            'on:click': () => {
                const showing = popup.style.display !== 'none';
                if (!showing) {
                    const rect = pill.getBoundingClientRect();
                    popup.style.top = `${rect.bottom + 6}px`;
                    popup.style.left = `${Math.max(8, Math.min(rect.left, (window.innerWidth ?? 1024) - 480))}px`;
                }
                popup.style.display = showing ? 'none' : 'block';
            },
        },
            h('div', { class: 'stme-stat-head' },
                h('span', { class: 'stme-stat-icon' }, '✎'),
                h('span', { class: 'stme-stat-label' }, 'Post-turn')),
            h('div', { class: 'stme-stat-value' }, String(done)));
        return h('div', { class: 'stme-postprocess-cell' }, pill, popup);
    }

    async function loadBadges() {
        const result = await call('chatHistory.annotations', { namespace: HISTORY_NAMESPACE });
        badges.set(result.ok ? result.value ?? {} : {});
        refreshFooter();
    }

    /** Состав отметок изменился → «пусто ↔ кнопка» знает только Ядро подвала; просим его пересмотреть фабрики. */
    function refreshFooter() {
        call('ui.messageFooter.attach', {});
    }

    async function clearBadge(mesid) {
        if (mesid === null || mesid === undefined || mesid === '') return;
        const key = String(mesid);
        const next = { ...badges.peek() };
        delete next[key];
        badges.set(next);
        await call('chatHistory.annotate', { namespace: HISTORY_NAMESPACE, mesid: key, value: null });
        refreshFooter();
    }

    // --- Настройки и панель ------------------------------------------------------

    async function refreshWorkers() {
        const result = await call('model.workers.get');
        const list = (result.ok ? result.value ?? [] : []).map(worker => ({ value: worker.id, label: worker.id }));
        workers.set([{ value: '', label: 'Any connection (load-balanced)' }, ...list]);
    }

    async function refreshCustomPresets() {
        const result = await call('model.presets.get');
        customPresets.set(result.ok ? result.value ?? [] : []);
    }

    /** Сигналы одного pass'а; создаются лениво и живут до удаления pass'а. */
    function uiFor(pass) {
        if (!passUi.has(pass.id)) {
            passUi.set(pass.id, {
                name: signal(pass.name),
                prompt: signal(pass.prompt),
                workerId: signal(pass.workerId),
                enabled: signal(pass.enabled !== false),
                includeContext: signal(Boolean(pass.includeContext)),
                contextDepth: signal(clampContextDepth(pass.contextDepth ?? DEFAULT_CONTEXT_DEPTH)),
                samplerPreset: signal(pass.samplerPreset ?? ''),
                temperature: signal(pass.temperature),
                topP: signal(pass.topP),
                topK: signal(pass.topK),
                maxTokens: signal(pass.maxTokens),
                reasoningMode: signal(pass.reasoningMode),
                reasoningEffort: signal(pass.reasoningEffort),
                reasoningBudget: signal(pass.reasoningBudget),
                newPresetName: signal(''),
            });
        }
        return passUi.get(pass.id);
    }

    function collectPass(pass) {
        const ui = uiFor(pass);
        return sanitizePasses([{
            ...pass,
            name: ui.name.peek(),
            prompt: ui.prompt.peek(),
            workerId: ui.workerId.peek(),
            enabled: ui.enabled.peek(),
            includeContext: ui.includeContext.peek(),
            contextDepth: ui.contextDepth.peek(),
            samplerPreset: ui.samplerPreset.peek(),
            temperature: ui.temperature.peek(), topP: ui.topP.peek(), topK: ui.topK.peek(), maxTokens: ui.maxTokens.peek(),
            reasoningMode: ui.reasoningMode.peek(), reasoningEffort: ui.reasoningEffort.peek(), reasoningBudget: ui.reasoningBudget.peek(),
        }])[0];
    }

    async function save() {
        settings.autoRun = autoRun.peek();
        settings.passes = passes.peek().map(collectPass);
        const result = await call('storage.settings.set', {
            namespace: SETTINGS_NAMESPACE,
            key: 'settings',
            value: { autoRun: settings.autoRun, passes: settings.passes },
        });
        if (!result.ok) { await notify('error', result.error?.message ?? 'Could not save settings'); return false; }
        passes.set(sanitizePasses(settings.passes));
        await notify('ok', 'Post-Turn Processor settings saved');
        return true;
    }

    function addPass() {
        passes.set([...passes.peek(), createPass()]);
    }

    function removePass(id) {
        passUi.delete(id);
        passes.set(passes.peek().filter(pass => pass.id !== id));
    }

    function movePass(id, delta) {
        const list = [...passes.peek()];
        const index = list.findIndex(pass => pass.id === id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= list.length) return;
        [list[index], list[target]] = [list[target], list[index]];
        passes.set(list);
    }

    /** Пресет заполняет и сэмплер, и ризонинг pass'а одним нажатием (та же механика, что у «RP Time»). */
    function applySampler(id, passId) {
        const ui = passUi.get(passId);
        const found = [...SAMPLER_PRESETS, ...customPresets.peek()].find(item => item.id === id);
        if (!ui || !found) return;
        ui.samplerPreset.set(found.id);
        ui.temperature.set(found.temperature);
        ui.topP.set(found.topP);
        ui.topK.set(found.topK);
        ui.maxTokens.set(found.maxTokens);
        ui.reasoningMode.set(found.reasoningMode);
        ui.reasoningEffort.set(found.reasoningEffort);
        ui.reasoningBudget.set(found.reasoningBudget);
    }

    async function savePreset(name, passId) {
        const ui = passUi.get(passId);
        const trimmed = String(name ?? '').trim();
        if (!ui || !trimmed) { await notify('error', 'Name the preset first'); return; }
        const preset = buildCustomPreset(trimmed, {
            temperature: ui.temperature.peek(), topP: ui.topP.peek(), topK: ui.topK.peek(), maxTokens: ui.maxTokens.peek(),
            reasoningMode: ui.reasoningMode.peek(), reasoningEffort: ui.reasoningEffort.peek(), reasoningBudget: ui.reasoningBudget.peek(),
        });
        const next = [...customPresets.peek().filter(item => item.id !== preset.id), preset];
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); ui.samplerPreset.set(preset.id); ui.newPresetName.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved preset "${trimmed}"` : result.error?.message);
    }

    async function deletePreset(passId) {
        const ui = passUi.get(passId);
        const id = ui?.samplerPreset.peek();
        if (!ui || !id) return;
        const next = customPresets.peek().filter(item => item.id !== id);
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); ui.samplerPreset.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Preset deleted' : result.error?.message);
    }

    function renderPass(pass) {
        const ui = uiFor(pass);
        return h('div', { key: pass.id, class: 'stme-postprocess-pass' },
            Row(
                TextInput(ui.name, { placeholder: 'Pass name' }),
                Toggle('Enabled', ui.enabled),
            ),
            Field('Instruction', TextArea(ui.prompt, { rows: 4, placeholder: 'What should this pass do to the text? e.g. "Fix grammar and tighten prose without changing meaning."' }), {
                hint: 'This pass always sees this instruction and the text so far — no other pass\'s identity, no macros needed.',
            }),
            Row(
                Field('Model connection', Select(ui.workerId, workers)),
                Button('↑', () => movePass(pass.id, -1)),
                Button('↓', () => movePass(pass.id, 1)),
                Button('Remove', () => removePass(pass.id), { variant: 'danger' }),
            ),
            Toggle('Include recent chat context', ui.includeContext, {
                hint: 'Off by default — a pass sees only the text being rewritten. Turn on to also give it the last few chat messages.',
            }),
            computed(() => (ui.includeContext()
                ? Slider('Messages of context', ui.contextDepth, { min: MIN_CONTEXT_DEPTH, max: MAX_CONTEXT_DEPTH, step: 1 })
                : null)),
            GenerationSettingsPanel(
                ui,
                () => [...SAMPLER_PRESETS, ...customPresets()],
                { onApplyPreset: id => applySampler(id, pass.id), onSavePreset: name => savePreset(name, pass.id), onDeletePreset: () => deletePreset(pass.id) },
            ),
        );
    }

    function tree() {
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Runs each fresh reply through a chain of independent rewrite passes'),
                Button('Save', save),
            ),
            Toggle('Auto-run after each reply', autoRun),
            h('p', { class: 'stme-postprocess-help' },
                'Each pass is an independent rewrite step — its own instruction, its own model connection. Passes run in order right after each reply; pass 2 sees pass 1\'s output, and so on. A ✎ toggle appears under every processed message showing exactly what changed.'),
            EditableList({
                items: passes,
                renderItem: renderPass,
                onAdd: addPass,
                empty: 'No passes yet — add one to start processing replies.',
            }),
            Row(Button('Process last reply now', processNow)),
        );
    }

    // --- Жизнь -------------------------------------------------------------------

    const subscriptions = [
        // Авто-запуск — как у «нормальных типов»: событие, а не этапы пайплайна.
        host.events.subscribe('generation.completed', () => { runOnCompleted(); }),
        // Реролл через «Regenerate»: ST укорачивает чат и шлёт MESSAGE_DELETED
        // (см. разбор в «RP Time») — бейдж старого варианта обязан уйти, иначе
        // «уже обработано» заблокирует новый ответ под тем же mesid.
        host.events.subscribe('st.messageDeleted', async payload => {
            const deletedMesid = String(payload?.args?.[0] ?? '').trim();
            if (deletedMesid) await clearBadge(deletedMesid);
        }),
        // Реролл через свайп: событие приходит и при простом пролистывании
        // готовых вариантов, поэтому только флаг — стирание на beforeSend,
        // когда генерация уже точно началась.
        host.events.subscribe('st.messageSwiped', () => { pendingSwipe = true; }),
        host.events.subscribe('generation.beforeSend', async () => {
            if (!pendingSwipe) return;
            pendingSwipe = false;
            await clearBadge(await currentMesid());
        }),
        // Другой чат — другие отметки.
        host.events.subscribe('st.chatChanged', () => { loadBadges(); }),
        // Пресеты/воркеры редактировал сосед — списки выбора перечитываются сами.
        host.events.subscribe('model.presets.changed', () => refreshCustomPresets()),
        host.events.subscribe('model.workers.changed', () => refreshWorkers()),
    ];

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        if (saved.ok && saved.value) {
            settings.autoRun = saved.value.autoRun !== false;
            settings.passes = sanitizePasses(saved.value.passes);
        }
        autoRun.set(settings.autoRun !== false);
        passes.set(sanitizePasses(settings.passes));
        await refreshWorkers();
        await refreshCustomPresets();
        await loadBadges();

        await call('ui.messageFooter.claim', { slot: 'center', ownerId: MODULE_ID, node: footerWidget });
    }

    return {
        id: MODULE_ID,
        title: 'Post-Turn Processor',
        description: 'Rewrites each fresh reply through a chain of independent model passes and replaces it with the final result.',
        load,
        tree,
        save,
        processNow,
        addPass,
        removePass,
        movePass,
        applySampler,
        savePreset,
        deletePreset,
        refreshWorkers,
        refreshCustomPresets,
        autoRun,
        passes,
        workers,
        customPresets,
        badges,
        busy,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            passUi.clear();
            call('ui.messageFooter.release', { ownerId: MODULE_ID });
        },
    };
}
