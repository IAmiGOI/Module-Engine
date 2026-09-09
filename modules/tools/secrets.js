import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { Button, TextInput, TextArea, Slider, Details, Row, Field, EmptyState } from '../../libraries/shared/widgets.js';
import {
    createModuleHost,
    persistedSettings,
    chatCollection,
    pipelineStage,
    stTool,
} from '../../libraries/shared/module-kit.js';

/**
 * Tool «Secrets» (папка «Tools») — приватный список секретов модели, один
 * в один по устройству с NoteBook (modules/tools/notebook.js): модель сама
 * пишет в него настоящим инструментом ST и сама же перечитывает его в
 * следующем промпте через этап `generation.beforeSend`.
 *
 * Отличие от блокнота — в ФОРМЕ записи. Заметка блокнота была свободной;
 * секрет — структурирован, потому что у секрета есть обязательные
 * измерения, которые модель обязана назвать явно:
 *
 *  - **`characters`** — ПЕРСОНАЖИ, КОТОРЫЕ ЗНАЮТ секрет (кроме самой
 *    модели, она знает все свои секреты). Секундная дисциплина «назови
 *    кого касается» не даёт секрету превратиться в расплывчатую заметку
 *    «кто-то что-то знает» — и позволяет модели в siguientes ходах
 *    учитывать, КТО в сцене в курсе, а кто нет;
 *  - **`title`** — короткое название секрета («Elena — бастард барона»);
 *  - **`content`** — само содержимое, как есть.
 *
 * Действия: `create` / `update` / `remove`. В отличие от блокнота у
 * `remove` здесь нет UI-дублирования «просто стереть и забыть» — модель
 * удаляет секрет, когда он раскрыт и больше не является секретом.
 *
 * Неймспейсы хранения (`module.secrets`), контракт, этап и имя
 * инструмента — свои, по образцу блокнота. Настройки (ёмкость/глубина
 * вставки) — `storage.settings`, сами секреты — `storage.chatMemory`
 * (глобальная настройка, факт конкретной истории), всё через Библиотеку
 * module-kit — с flush (класс бага 1) и подпиской `st.chatChanged`
 * (класс бага 2) из коробки.
 */

const SETTINGS_NAMESPACE = 'module.secrets';
const MEMORY_NAMESPACE = 'module.secrets';
const SECRETS_KEY = 'secrets';
const TOOL_NAME = 'Secrets';
const INJECT_CONTRACT = 'community.secrets.inject';
const STAGE_ID = 'secrets:inject';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';

export const SECRETS_MODULE_ID = 'module.secrets';
export const DEFAULT_SETTINGS = Object.freeze({ maxSecrets: 15, cleanupBatch: 5, injectionDepth: 4 });

/**
 * Схема инструмента — по образцу NOTEBOOK_TOOL_SCHEMA (см. её doc-comment
 * про безусловный `required`, «description объясняет ЗАЧЕМ» и якорь
 * `TIMING` в начале рассуждения). Здесь то же + обязательный `characters`:
 * секрет без имени знающих не пригоден ни для драматургии (кто может
 * выдать?), ни для проверки непротиворечивости.
 */
export const SECRETS_TOOL_SCHEMA = Object.freeze({
    name: TOOL_NAME,
    displayName: 'Secrets',
    description:
        'Your PRIVATE list of SECRETS — persists across replies, never shown to the player. A secret is a fact that is ' +
        'true in the story but HIDDEN from some or all characters: a hidden identity, a betrayal being planned, a ' +
        'deception in progress, an unspoken feeling, a crime committed, knowledge a character should not have.\n\n' +
        'Every secret MUST name: the CHARACTERS WHO KNOW IT (besides you), a short TITLE, and the CONTENT itself. ' +
        'Naming who knows is the point — it tracks who can reveal it, who must not find out, and who is being deceived.\n\n' +
        'Use this tool PROACTIVELY: the moment a secret is born, changed, or exposed in the story, record it in the ' +
        'SAME turn. When a secret stops being secret (it was revealed to everyone, or the plan was abandoned), REMOVE ' +
        'it — a stale secret poisons the story.\n\n' +
        'TIMING — MANDATORY: call this tool FIRST, at the very start of your reasoning for this turn, before you draft ' +
        'or send your reply to the player.\n\n' +
        'Check the secrets already shown in your context (the "[Private secrets...]" block, if present) — update the ' +
        'existing secret by its id instead of creating a duplicate.\n\n' +
        'FORMAT: `characters` — comma-separated names of the characters who know the secret (e.g. "Elena, Marcus"). ' +
        '`title` — a short label (e.g. "Elena is the baron\'s daughter"). `content` — the full detail, as long as it ' +
        'needs to be. All three are ALWAYS required — for update, resend the current values of fields you are not changing.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'update', 'remove'],
                description: '"create" makes a new secret. "update" edits an existing one by its secret_id (shown in brackets in the secrets block in your context). "remove" deletes a secret that is no longer a secret — by its secret_id.',
            },
            characters: {
                type: 'string',
                description: 'Characters WHO KNOW this secret, besides yourself — comma-separated names, e.g. "Elena, Marcus". Always required — for update, resend the current value if you are not changing it.',
            },
            title: {
                type: 'string',
                description: 'A short, specific label for the secret — e.g. "Elena is the baron\'s daughter". Always required — for update, resend the current value if you are not changing it.',
            },
            content: {
                type: 'string',
                description: 'The full detail of the secret, in your own words. Always required — for update, resend the current value if you are not changing it.',
            },
            secret_id: {
                type: 'string',
                description: 'The id of the secret to change or delete (shown in brackets in the secrets block, e.g. "secret_abc123"). Required for update and remove, ignored for create.',
            },
        },
        required: ['action', 'characters', 'title', 'content'],
    },
    stealth: false,
});

/** Тот же дисциплинарный клампер, что у блокнота (см. его doc-comment про два мусорных значения разом). */
function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    const chosen = Number.isFinite(number) ? Math.round(number) : fallback;
    return Math.max(min, Math.min(max, chosen));
}

/** Защитное чтение настроек: любой мусор с диска превращается в валидные границы, никогда не бросает. */
export function clampSecretSettings(values = {}) {
    const maxSecrets = clampNumber(values.maxSecrets, 1, 500, DEFAULT_SETTINGS.maxSecrets);
    const cleanupBatch = clampNumber(values.cleanupBatch, 1, maxSecrets, DEFAULT_SETTINGS.cleanupBatch);
    const injectionDepth = clampNumber(values.injectionDepth, 0, 100, DEFAULT_SETTINGS.injectionDepth);
    return { maxSecrets, cleanupBatch, injectionDepth };
}

function makeSecretId(now, random) {
    return `secret_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

/** Нормализация поля «кто знает»: одна строка через запятую — модель пишет её одной фразой, разбивать — её дело. */
function cleanCharacters(characters) {
    return String(characters ?? '').trim().replace(/\s*,\s*/g, ', ');
}

/**
 * Добавляет секрет, соблюдая ёмкость: переполнение чистит СТАРЕЙШИЕ батчем
 * `cleanupBatch` — та же механика, что у блокнота (addNote), по той же
 * причине: чистка по одной даёт лишнюю запись на каждый новый секрет.
 */
export function addSecret(secrets, { characters, title, content } = {}, settings, { now = Date.now, random = Math.random } = {}) {
    const cleanTitle = String(title ?? '').trim();
    const cleanContent = String(content ?? '').trim();
    const cleanWho = cleanCharacters(characters);
    if (!cleanWho || !cleanTitle || !cleanContent) throw new Error('A secret needs the characters who know it, a title, and content.');
    let next = [...secrets];
    let removed = 0;
    if (next.length >= settings.maxSecrets) {
        removed = Math.min(next.length, Math.max(settings.cleanupBatch, next.length + 1 - settings.maxSecrets));
        next = next.slice(removed);
    }
    const secret = { id: makeSecretId(now, random), characters: cleanWho, title: cleanTitle, content: cleanContent, updated: now() };
    return { secrets: [...next, secret], secret, removed };
}

/** Поля, не переданные в `update`, остаются прежними — правка того, что названо, а не переписывание вслепую. */
export function updateSecret(secrets, id, { characters, title, content } = {}, { now = Date.now } = {}) {
    const index = secrets.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Secrets: no secret with id "${id}".`);
    const current = secrets[index];
    const nextCharacters = characters === undefined ? current.characters : cleanCharacters(characters);
    const nextTitle = title === undefined ? current.title : String(title ?? '').trim();
    const nextContent = content === undefined ? current.content : String(content ?? '').trim();
    if (!nextCharacters || !nextTitle || !nextContent) throw new Error('A secret needs the characters who know it, a title, and content.');
    const secret = { ...current, characters: nextCharacters, title: nextTitle, content: nextContent, updated: now() };
    const next = [...secrets];
    next[index] = secret;
    return { secrets: next, secret };
}

/** Никогда не бросает на неизвестном id — секрет мог быть уже удалён другим ходом модели. */
export function removeSecret(secrets, id) {
    const index = secrets.findIndex(item => item.id === id);
    if (index < 0) return { secrets, removed: false };
    const next = [...secrets];
    next.splice(index, 1);
    return { secrets: next, removed: true };
}

/**
 * Текст для промпта: модель видит id (для update/remove), знающих
 * персонажей, название и содержимое. Пустой список не добавляет ни байта.
 * Шапка — короткое напоминание, полное «зачем» модель уже прочла в
 * описании инструмента.
 */
export function buildSecretsPrompt(secrets) {
    if (!secrets.length) return '';
    return [
        '[Private secrets — your persistent list of hidden story facts, invisible to the player. Each secret names WHO KNOWS it: respect that knowledge — a character who does not know must not act as if they do. Update secrets by id as things change; remove one once it is no longer secret.]',
        ...secrets.map(secret => `- [${secret.id}] (known by: ${secret.characters}) ${secret.title}: ${secret.content}`),
    ].join('\n');
}

/** Куда в `chat` встаёт блок: `depth` сообщений от конца, depth 0 — «прямо перед ответом модели», как у блокнота. */
export function computeInsertIndex(chatLength, depth) {
    return Math.max(0, Math.min(chatLength, chatLength - Math.max(0, Number(depth) || 0)));
}

/**
 * Фабрика Tool'а. `host` — moduleHost реестра (со своими правами, см.
 * DEFINITIONS в engine-wiring.js), как у любого самостоятельного Модуля:
 * «Tools» — только папка в UI (`folder: 'Tools'`), не контейнер.
 */
export function createSecretsModule(host) {
    const secrets = signal([]);
    const maxSecrets = signal(DEFAULT_SETTINGS.maxSecrets);
    const cleanupBatch = signal(DEFAULT_SETTINGS.cleanupBatch);
    const injectionDepth = signal(DEFAULT_SETTINGS.injectionDepth);
    const newCharacters = signal('');
    const newTitle = signal('');
    const newContent = signal('');

    const { notify } = createModuleHost(host);

    /** Настройки — глобальные (переживают чат), клампер выше; Библиотека module-kit. */
    const settings = persistedSettings(host, {
        namespace: SETTINGS_NAMESPACE,
        clamp: clampSecretSettings,
    });

    function applySettings(clamped) {
        maxSecrets.set(clamped.maxSecrets);
        cleanupBatch.set(clamped.cleanupBatch);
        injectionDepth.set(clamped.injectionDepth);
    }

    /**
     * Секреты — память ЧАТА: подписка `st.chatChanged` (класс бага 2) и
     * flush после каждой записи (класс бага 1) — внутри Библиотеки.
     */
    const store = chatCollection(host, {
        namespace: MEMORY_NAMESPACE,
        key: SECRETS_KEY,
        signal: secrets,
    });

    /** Этап `generation.beforeSend` — контракт `community.secrets.inject` под правами этого Модуля. */
    const injectStage = pipelineStage(host, {
        pipelineId: BEFORE_SEND_PIPELINE,
        stageId: STAGE_ID,
        contract: INJECT_CONTRACT,
        onExhausted: 'flag',
        execute: params => injectIntoPrompt(params),
    });

    /** Инструмент ST — ошибки возвращаются текстом, генерацию не обрывают. */
    const tool = stTool(host, {
        schema: SECRETS_TOOL_SCHEMA,
        action: args => toolAction(args),
        formatMessage: args => (args?.action === 'remove' ? 'Removing a secret…' : args?.action === 'update' ? 'Updating a secret…' : 'Recording a secret…'),
        onError: 'returnText',
    });

    function currentSettings() {
        return { maxSecrets: maxSecrets.peek(), cleanupBatch: cleanupBatch.peek(), injectionDepth: injectionDepth.peek() };
    }

    async function saveSettings() {
        await settings.save(currentSettings(), applySettings);
        await notify.ok('Secrets settings saved');
        return true;
    }

    async function create({ characters, title, content }) {
        const { secrets: next, secret, removed } = addSecret(secrets.peek(), { characters, title, content }, currentSettings());
        await store.persist(next);
        return { secret, removed };
    }

    async function writeFromUi() {
        try {
            const { secret } = await create({ characters: newCharacters.peek(), title: newTitle.peek(), content: newContent.peek() });
            newCharacters.set('');
            newTitle.set('');
            newContent.set('');
            await notify.ok(`Saved secret "${secret.title}"`);
        } catch (error) {
            await notify.error(error.message);
        }
    }

    async function remove(id) {
        const { secrets: next, removed } = removeSecret(secrets.peek(), id);
        if (!removed) return false;
        await store.persist(next);
        return true;
    }

    /**
     * Инструмент ST. Ошибка возвращается ТЕКСТОМ, а не бросается наружу —
     * модель обязана увидеть, что пошло не так, и иметь шанс исправиться
     * (опечатка в `secret_id`, незаполненное поле), не обрывая генерацию.
     */
    async function toolAction(args) {
        try {
            if (args?.action === 'create') {
                const { secret, removed } = await create(args);
                return `Recorded secret "${secret.title}" (id: ${secret.id}, known by: ${secret.characters}).${removed ? ` Removed ${removed} oldest secret(s) to stay within capacity.` : ''}`;
            }
            if (args?.action === 'update') {
                if (!args?.secret_id) return 'update requires secret_id.';
                const { secrets: next, secret } = updateSecret(secrets.peek(), args.secret_id, args);
                await store.persist(next);
                return `Updated secret "${secret.title}" (id: ${secret.id}, known by: ${secret.characters}).`;
            }
            if (args?.action === 'remove') {
                if (!args?.secret_id) return 'remove requires secret_id.';
                const removed = await remove(args.secret_id);
                return removed ? 'Secret removed.' : `No secret with id "${args.secret_id}" — it may already be gone.`;
            }
            return 'Unknown action. Use create, update or remove.';
        } catch (error) {
            return error?.message ?? String(error);
        }
    }

    /**
     * Этап `generation.beforeSend`. Вставляет блок секретов живой мутацией
     * `chat` — тот же массив, который увидит сборка промпта. Пустой список
     * ничего не трогает.
     */
    async function injectIntoPrompt({ chat } = {}) {
        const list = secrets.peek();
        if (!Array.isArray(chat) || !list.length) return true;
        const insertAt = computeInsertIndex(chat.length, injectionDepth.peek());
        chat.splice(insertAt, 0, { is_user: false, is_system: true, name: 'Secrets', mes: buildSecretsPrompt(list) });
        return true;
    }

    function secretRow(secret) {
        return Details(
            Row(
                h('strong', { class: 'stme-secret-title' }, secret.title),
                h('small', { class: 'stme-secret-who' }, `known by: ${secret.characters}`),
                h('small', { class: 'stme-secret-meta' }, new Date(secret.updated).toLocaleString()),
                Button('Delete', event => { event.preventDefault(); event.stopPropagation(); void remove(secret.id); }, { variant: 'danger' }),
            ),
            h('p', { class: 'stme-secret-content' }, secret.content),
        );
    }

    /** Корень `stme-module-body` — у Tool'а своя карточка со своим тумблером, «Tools» лишь папка в UI. */
    function tree() {
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Gives the AI a private list of secrets — hidden story facts, each tagged with the characters who know it. Invisible to the player.'),
                Button('Save settings', saveSettings),
            ),
            Row(
                Slider('Maximum secrets', maxSecrets, { min: 1, max: 200, step: 1 }),
                Slider('Cleanup batch', cleanupBatch, { min: 1, max: computed(() => Math.max(1, maxSecrets())), step: 1 }),
                Slider('Injection depth (@N)', injectionDepth, { min: 0, max: 50, step: 1 }),
            ),
            Field('New secret', h('div', { class: 'stme-secret-editor' },
                TextInput(newCharacters, { placeholder: 'Known by (character names, comma-separated)' }),
                TextInput(newTitle, { placeholder: 'Title' }),
                TextArea(newContent, { placeholder: 'Content', rows: 3 }),
                Row(Button('+ Add secret', writeFromUi)),
            )),
            h('div', { class: 'stme-secret-list' },
                computed(() => (secrets().length ? secrets().map(secretRow) : [EmptyState('No secrets yet — the AI records them as the story goes, or add one yourself.')])),
            ),
        );
    }

    async function load() {
        await settings.restore(applySettings);
        await store.load();

        // `onExhausted: 'flag'`: упавшая вставка — не повод оставить
        // пользователя без ответа, как у блокнота и трекера.
        await injectStage.add({ chat: { $from: '$input.chat' } });
        await tool.register();
    }

    return {
        id: SECRETS_MODULE_ID,
        title: 'Secrets',
        description: 'A private list of the AI\'s secrets — hidden story facts, each tagged with who knows it.',
        load,
        tree,
        // Публичный API: сигналы UI и операции — как у блокнота.
        secrets,
        maxSecrets,
        cleanupBatch,
        injectionDepth,
        newCharacters,
        newTitle,
        newContent,
        save: saveSettings,
        create,
        remove,
        stop: () => {
            store.stop();
            void injectStage.remove();
            void tool.unregister();
        },
    };
}
