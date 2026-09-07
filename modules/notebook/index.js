import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Button, TextInput, TextArea, Slider, Details, Row, Field, EmptyState } from '../../libraries/shared/widgets.js';

/**
 * Модуль «Notebook» — приватный блокнот модели, как в Alpha
 * (modules/notebook). Модель сама пишет в него настоящим инструментом ST
 * (`write`/`update`) и сама же перечитывает его в следующем промпте — рабочая
 * память для планов, секретов и целей персонажей, которых не должно быть в
 * тексте самой реплики.
 *
 * Три отличия от Alpha, и все три — не косметика:
 *
 *  1. **Вклад в промпт — через настоящий, проверенный механизм**, а не через
 *     `setExtensionPrompt` (в Beta он никуда не подключён и подключать его в
 *     обход собственного пайплайна значило бы завести второй, невидимый
 *     движку способ попасть в промпт). Модуль регистрирует ОДИН этап на
 *     `generation.beforeSend` — том самом пайплайне, что реально держит
 *     генерацию и реально формирует то, что уйдёт модели (см.
 *     generation-core.test.js: «a stage editing it shapes the prompt without
 *     touching saved history»). Этап получает настоящий `chat` через
 *     `{ $from: '$input.chat' }` и вставляет заметку как отдельное сообщение
 *     на глубину `injectionDepth` от конца — то же самое «@N», что было у
 *     Alpha, только не строкой в отдельном API ST, а прямой правкой того же
 *     массива, который увидит остальной пайплайн.
 *  2. **Настройки и заметки разнесены по разным хранилищам.** У Alpha и то,
 *     и другое лежало в `chatMetadata` — значит, настроив `maxNotes` один
 *     раз, в СЛЕДУЮЩЕМ чате приходилось настраивать заново. Здесь настройки
 *     (сколько заметок держать, на какую глубину вставлять) — это
 *     `storage.settings`, конфигурация Модуля, переживающая любой чат; сами
 *     заметки — `storage.chatMemory`, факт КОНКРЕТНОЙ истории.
 *  3. **Отметка внутриигрового времени не подделывается угадыванием.** У
 *     Alpha заметка получала штамп ТОЛЬКО если был включён именно её Модуль
 *     RP Time — через `host.services.request('time')`, отдельный канал
 *     Модуль→Модуль, которого в Beta нет и не должно появляться в обход
 *     общих Ядер. Здесь этого нет вовсе: если модели важно записать время —
 *     она год умеет писать его прямо в тексте заметки, что и происходит на
 *     практике. Взамен не нужен и весь регэксп Alpha, вырезающий
 *     задвоенную дату первой строкой (`stripLeadingTimeLine`) — он был нужен
 *     только из-за автоматического штампа.
 */

export const MODULE_ID = 'module.notebook';
const SETTINGS_NAMESPACE = MODULE_ID;
const MEMORY_NAMESPACE = MODULE_ID;
const NOTES_KEY = 'notes';
const TOOL_NAME = 'Notebook';
/**
 * Первый в движке случай, когда Модуль community-уровня регистрирует
 * СВОЙ собственный контракт (для этапа пайплайна — исполнять его должен
 * именно он, под своими правами). NAMING_PHILOSOPHY.md требует префикс
 * `community.<id-заказчика>.` начиная с этого уровня доверия; правило пока
 * не проверяется кодом (см. ROADMAP — настоящий Раннер с проверкой прав при
 * регистрации), но это не повод не следовать ему самим.
 */
const INJECT_CONTRACT = 'community.notebook.inject';
const STAGE_ID = 'notebook:inject';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';

export const DEFAULT_SETTINGS = Object.freeze({ maxNotes: 12, cleanupBatch: 4, injectionDepth: 4 });

/**
 * Схема инструмента — вынесена отдельным экспортируемым объектом (без
 * `action`/`formatMessage`, тех двух полей, что реально нужен `host`,
 * см. `load()` ниже), чтобы проверяться тестами напрямую, а не только
 * косвенно через поведение.
 *
 * Переписана целиком по живой жалобе пользователя: модель почти всегда
 * забывала заполнить И title, И content разом, и вызывала инструмент
 * заметно реже, чем стоило бы. Обе причины — один и тот же корень, слабый
 * промпт:
 *  - **`title`/`content` теперь в `required` БЕЗУСЛОВНО**, не только для
 *    `write`. Компромисс осознанный: `updateNote()` по-прежнему умеет
 *    частичную правку (см. её doc-comment) — это осталось СПОСОБНОСТЬЮ
 *    функции, не тем, что обязана делать модель. Схема специально не
 *    различает write/update (`draft-04`, никакого `if/then` под рукой,
 *    да и не все бэкенды function-calling его вообще уважают) —
 *    безусловное `required` работает одинаково везде, а модель и так
 *    видит ТЕКУЩИЕ title/content в блоке блокнота у себя в контексте
 *    (см. `buildNotebookPrompt()`) и может просто повторить неизменное
 *    поле, если меняет только одно.
 *  - **`description` объясняет ЗАЧЕМ, не только КАК.** Раньше было одно
 *    сухое утилитарное предложение — не продавало пользу инструмента и
 *    не подсказывало, когда его вообще стоит доставать. Теперь —
 *    конкретные категории (goal, needs, current state, secrets, plans,
 *    relationships) и прямая просьба писать ПРОАКТИВНО, а не только по
 *    запросу.
 *  - **`TIMING` — вызов ОБЯЗАН идти в начале рассуждения, до самого
 *    ответа игроку, не после.** Без этого модель писала заметку (если
 *    вообще писала) уже ПОСЛЕ того, как реплика собрана — то есть
 *    ближе к концу хода или вовсе следующим ходом, когда то, что нужно
 *    было запомнить, уже потерялось из фокуса рассуждения. Явный якорь
 *    «в начале CoT, до completion» переносит решение «что запомнить» на
 *    момент, когда модель ещё ДУМАЕТ над ходом, а не когда уже дописала
 *    его и меньше всего расположена возвращаться назад.
 */
export const NOTEBOOK_TOOL_SCHEMA = Object.freeze({
    name: TOOL_NAME,
    displayName: 'Notebook',
    description:
        'Your PRIVATE notebook — persists across replies, never shown to the player. Use it to track anything about ' +
        'the story or its characters that you would otherwise forget or lose track of: a character\'s current GOAL or ' +
        'MOTIVATION, their NEEDS or WANTS, their CURRENT STATE (physical condition, emotional state, location, what ' +
        'they are doing right now), secrets, unresolved plans, promises made, relationships, or any other fact worth ' +
        'carrying forward into later replies.\n\n' +
        'Use this tool PROACTIVELY, as the story develops — do not wait to be asked. Whenever something changes that ' +
        'matters for later (a goal shifts, an injury happens, a secret is revealed, a plan is made), write or update ' +
        'a note for it in the SAME turn, before it slips your mind.\n\n' +
        'TIMING — MANDATORY: call this tool FIRST, at the very start of your reasoning for this turn, before you draft ' +
        'or send your reply to the player. Decide what needs to be written down BEFORE composing the reply, never ' +
        'after — a note queued for "after I finish the reply" gets skipped the moment the reply is sent.\n\n' +
        'Before writing a NEW note, check the notebook already shown in your context (the "[Private notebook...]" ' +
        'block, if present) — if the fact you want to record already has a note, use update on its id instead of ' +
        'creating a duplicate.\n\n' +
        'FORMAT: every note needs BOTH a short, specific title (a label, like "Elena\'s goal" or "Tavern keeper\'s ' +
        'secret") AND real content (the actual detail, as long as it needs to be). A title alone or content alone is ' +
        'not a usable note — always provide both, every time.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['write', 'update'],
                description: '"write" creates a brand-new note. "update" edits an existing note by its note_id (shown in brackets in the notebook block in your context).',
            },
            title: {
                type: 'string',
                description: 'A short, specific label for the note — e.g. "Elena\'s goal", "Current injury", "Tavern keeper\'s secret". Always required — for update, resend the note\'s current title if you are only changing the content.',
            },
            content: {
                type: 'string',
                description: 'The actual detail to remember, in your own words — as short or long as the fact needs. Always required — for update, resend the note\'s current content if you are only changing the title.',
            },
            note_id: {
                type: 'string',
                description: 'The id of the note to change (shown in brackets in the notebook block, e.g. "note_abc123"). Required for update, ignored for write.',
            },
        },
        required: ['action', 'title', 'content'],
    },
    stealth: false,
});

/**
 * `fallback` is clamped too, not returned raw — a garbage `cleanupBatch`
 * next to a garbage-but-now-clamped `maxNotes` of 1 must not fall back to a
 * default of 4 and quietly break the "cleanupBatch <= maxNotes" invariant.
 * (Alpha's own `clamp()` had exactly this gap — never hit in practice only
 * because nothing there fed it two garbage values at once.)
 */
function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    const chosen = Number.isFinite(number) ? Math.round(number) : fallback;
    return Math.max(min, Math.min(max, chosen));
}

/** Защитное чтение настроек: любой мусор с диска превращается в валидные границы, никогда не бросает. */
export function clampNoteSettings(values = {}) {
    const maxNotes = clampNumber(values.maxNotes, 1, 500, DEFAULT_SETTINGS.maxNotes);
    const cleanupBatch = clampNumber(values.cleanupBatch, 1, maxNotes, DEFAULT_SETTINGS.cleanupBatch);
    const injectionDepth = clampNumber(values.injectionDepth, 0, 100, DEFAULT_SETTINGS.injectionDepth);
    return { maxNotes, cleanupBatch, injectionDepth };
}

function makeNoteId(now, random) {
    return `note_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

/**
 * Добавляет заметку, соблюдая ёмкость: переполнение чистит СТАРЕЙШИЕ батчем
 * `cleanupBatch`, а не по одной — та же механика, что у Alpha, и по той же
 * причине: чистка по одной на каждую новую заметку у большого блокнота
 * означала бы одну лишнюю запись на каждую следующую.
 */
export function addNote(notes, { title, content } = {}, settings, { now = Date.now, random = Math.random } = {}) {
    const cleanTitle = String(title ?? '').trim();
    const cleanContent = String(content ?? '').trim();
    if (!cleanTitle || !cleanContent) throw new Error('A note needs both a title and content.');
    let next = [...notes];
    let removed = 0;
    if (next.length >= settings.maxNotes) {
        removed = Math.min(next.length, Math.max(settings.cleanupBatch, next.length + 1 - settings.maxNotes));
        next = next.slice(removed);
    }
    const note = { id: makeNoteId(now, random), title: cleanTitle, content: cleanContent, updated: now() };
    return { notes: [...next, note], note, removed };
}

/** `title`/`content` не переданы — то поле остаётся прежним: `update` меняет то, что назвали, а не переписывает заметку целиком. */
export function updateNote(notes, id, { title, content } = {}, { now = Date.now } = {}) {
    const index = notes.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Notebook: no note with id "${id}".`);
    const current = notes[index];
    const nextTitle = title === undefined ? current.title : String(title ?? '').trim();
    const nextContent = content === undefined ? current.content : String(content ?? '').trim();
    if (!nextTitle || !nextContent) throw new Error('A note needs both a title and content.');
    const note = { ...current, title: nextTitle, content: nextContent, updated: now() };
    const next = [...notes];
    next[index] = note;
    return { notes: next, note };
}

/** Никогда не бросает на неизвестном id — кнопка «Delete», нажатая дважды, или заметка, уже стёртая AI, это не ошибка. */
export function removeNote(notes, id) {
    const index = notes.findIndex(item => item.id === id);
    if (index < 0) return { notes, removed: false };
    const next = [...notes];
    next.splice(index, 1);
    return { notes: next, removed: true };
}

/**
 * Текст, который модель увидит и по которому сможет сослаться на заметку
 * для `update`. Пустой блокнот не добавляет в промпт ни байта. Шапка —
 * короткое напоминание, а не повтор полного описания инструмента
 * (`NOTEBOOK_TOOL_SCHEMA.description` выше) — эта строка уходит в промпт
 * НА КАЖДЫЙ ход, где блокнот не пуст, и разрастаться ей незачем; полное
 * объяснение «зачем» модель уже увидела при выборе инструмента.
 */
export function buildNotebookPrompt(notes) {
    if (!notes.length) return '';
    return [
        '[Private notebook — your persistent working memory, invisible to the player. Keep it updated as things change: goals, needs, current state, secrets, plans. Reference a note by its id to update it instead of duplicating it.]',
        ...notes.map(note => `- [${note.id}] ${note.title}: ${note.content}`),
    ].join('\n');
}

/** Куда в `chat` встаёт заметка: `depth` сообщений от конца — depth 0 значит «прямо перед тем, что сейчас отвечает модель», как у Alpha's `@0`. */
export function computeInsertIndex(chatLength, depth) {
    return Math.max(0, Math.min(chatLength, chatLength - Math.max(0, Number(depth) || 0)));
}

export function createNotebookModule(host) {
    const notes = signal([]);
    const maxNotes = signal(DEFAULT_SETTINGS.maxNotes);
    const cleanupBatch = signal(DEFAULT_SETTINGS.cleanupBatch);
    const injectionDepth = signal(DEFAULT_SETTINGS.injectionDepth);
    const newTitle = signal('');
    const newContent = signal('');

    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    async function persistNotes(next) {
        notes.set(next);
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: NOTES_KEY, value: next });
    }

    async function loadNotes() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: NOTES_KEY, fallback: [] });
        notes.set(result.ok ? result.value ?? [] : []);
    }

    /**
     * Заметки лежат в памяти ЧАТА (`storage.chatMemory`), а `load()`
     * выполняется ровно один раз — при инициализации движка, зачастую ДО
     * того, как ST успевает подгрузить `chatMetadata` текущего чата (и это
     * та же гонка, что и на самой обычной перезагрузке страницы: `st.
     * chatChanged` ловит и самый первый чат после неё, не только ручное
     * переключение). Без этой подписки заметки из предыдущей загрузки
     * просто оставались бы невидимы панели — а если модель в этот момент
     * вызвала бы `write`, `persistNotes()` сохранил бы новый список ПОВЕРХ
     * устаревшего пустого, реально затерев то, что уже было на диске. Тот
     * же приём, что уже есть у Модулей «Трекер» и «RP Time» (см. их
     * doc-comment на `st.chatChanged`).
     */
    const subscriptions = [
        host.events.subscribe('st.chatChanged', () => { loadNotes(); }),
    ];

    function currentSettings() {
        return { maxNotes: maxNotes.peek(), cleanupBatch: cleanupBatch.peek(), injectionDepth: injectionDepth.peek() };
    }

    async function saveSettings() {
        const clamped = clampNoteSettings(currentSettings());
        maxNotes.set(clamped.maxNotes);
        cleanupBatch.set(clamped.cleanupBatch);
        injectionDepth.set(clamped.injectionDepth);
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: 'settings', value: clamped });
        await notify('ok', 'Notebook settings saved');
        return true;
    }

    async function write({ title, content }) {
        const { notes: next, note, removed } = addNote(notes.peek(), { title, content }, currentSettings());
        await persistNotes(next);
        return { note, removed };
    }

    async function writeFromUi() {
        try {
            const { note } = await write({ title: newTitle.peek(), content: newContent.peek() });
            newTitle.set('');
            newContent.set('');
            await notify('ok', `Saved "${note.title}"`);
        } catch (error) {
            await notify('error', error.message);
        }
    }

    async function remove(id) {
        const { notes: next, removed } = removeNote(notes.peek(), id);
        if (!removed) return false;
        await persistNotes(next);
        return true;
    }

    /**
     * Инструмент ST. Ошибка возвращается ТЕКСТОМ, а не бросается наружу —
     * модель обязана увидеть, что пошло не так, и иметь шанс исправиться, а
     * не оборвать генерацию из-за собственной опечатки в `note_id`.
     */
    async function toolAction(args) {
        try {
            if (args?.action === 'write') {
                const { note, removed } = await write(args);
                return `Saved note "${note.title}" (id: ${note.id}).${removed ? ` Removed ${removed} oldest note(s) to stay within capacity.` : ''}`;
            }
            if (args?.action === 'update') {
                if (!args?.note_id) return 'update requires note_id.';
                const { notes: next, note } = updateNote(notes.peek(), args.note_id, args);
                await persistNotes(next);
                return `Updated note "${note.title}" (id: ${note.id}).`;
            }
            return 'Unknown action. Use write or update.';
        } catch (error) {
            return error?.message ?? String(error);
        }
    }

    /**
     * Этап `generation.beforeSend`. Вставляет заметку живой мутацией `chat` —
     * тот же массив, который увидит сборка промпта, а не копию. Пустой
     * блокнот ничего не трогает: `chat.splice()` с пустым текстом добавил бы
     * заметку из воздуха.
     */
    async function injectIntoPrompt({ chat } = {}) {
        const list = notes.peek();
        if (!Array.isArray(chat) || !list.length) return true;
        const insertAt = computeInsertIndex(chat.length, injectionDepth.peek());
        chat.splice(insertAt, 0, { is_user: false, is_system: true, name: 'Notebook', mes: buildNotebookPrompt(list) });
        return true;
    }

    function noteRow(note) {
        return Details(
            Row(
                h('strong', { class: 'stme-note-title' }, note.title),
                h('small', { class: 'stme-note-meta' }, new Date(note.updated).toLocaleString()),
                Button('Delete', event => { event.preventDefault(); event.stopPropagation(); void remove(note.id); }, { variant: 'danger' }),
            ),
            h('p', { class: 'stme-note-content' }, note.content),
        );
    }

    function tree() {
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Gives the AI a private notebook it can write to and read back — its own working memory, invisible to the player.'),
                Button('Save settings', saveSettings),
            ),
            Row(
                Slider('Maximum notes', maxNotes, { min: 1, max: 200, step: 1 }),
                Slider('Cleanup batch', cleanupBatch, { min: 1, max: computed(() => Math.max(1, maxNotes())), step: 1 }),
                Slider('Injection depth (@N)', injectionDepth, { min: 0, max: 50, step: 1 }),
            ),
            Field('New note', h('div', { class: 'stme-note-editor' },
                TextInput(newTitle, { placeholder: 'Title' }),
                TextArea(newContent, { placeholder: 'Content', rows: 3 }),
                Row(Button('+ Add note', writeFromUi)),
            )),
            h('div', { class: 'stme-note-list' },
                computed(() => (notes().length ? notes().map(noteRow) : [EmptyState('No notes yet — the AI writes here as the story goes, or add one yourself.')])),
            ),
        );
    }

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        if (saved.ok && saved.value) {
            const clamped = clampNoteSettings(saved.value);
            maxNotes.set(clamped.maxNotes);
            cleanupBatch.set(clamped.cleanupBatch);
            injectionDepth.set(clamped.injectionDepth);
        }
        await loadNotes();

        host.own.register(INJECT_CONTRACT, params => injectIntoPrompt(params));
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            // `onExhausted: 'flag'`: упавшая вставка блокнота — не повод
            // оставить пользователя без ответа, ровно тот же выбор, что у
            // блокирующего трекера (см. Модуль «Трекер»).
            stage: { id: STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });

        await call('generation.registerTool', {
            definition: {
                ...NOTEBOOK_TOOL_SCHEMA,
                action: toolAction,
                formatMessage: args => (args?.action === 'update' ? 'Updating notebook note…' : 'Saving notebook note…'),
            },
        });
    }

    return {
        id: MODULE_ID,
        title: 'Notebook',
        description: 'A private notebook the AI can write to and read back — working memory for plans, secrets and goals that shouldn\'t appear in the story text itself.',
        load,
        tree,
        notes,
        maxNotes,
        cleanupBatch,
        injectionDepth,
        newTitle,
        newContent,
        save: saveSettings,
        write,
        remove,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: STAGE_ID });
            call('generation.unregisterTool', { name: TOOL_NAME });
        },
    };
}
