/**
 * Настройки игры директора и писателя — чистые данные и защитные чтения.
 *
 * Владелец (часть 13): игрок выбирает режим, как сложность в игре, а не
 * правит промпты. Режим — готовый набор значений; любая ручная правка
 * переводит набор в Custom, но ничего не теряет. Каждое значение —
 * готовая строка правила в `decision-prompts.js` (§22 PROMPTS.md).
 */
import { STORY_SETTINGS_HEADER, STORY_SETTINGS_RULES } from './decision-prompts.js';

/** Группы окна: сверху вниз, как их читает игрок. */
export const GAME_GROUPS = Object.freeze([
    { id: 'story', title: 'Story' },
    { id: 'character', title: 'Your character' },
    { id: 'writing', title: 'Writing' },
    { id: 'display', title: 'Display' },
]);

/**
 * Опции в порядке показа. `note` — одна строка последствия по-игровому,
 * без слов о движке. `classic` — значение Classic и умолчание нового чата.
 */
export const GAME_OPTIONS = Object.freeze([
    {
        id: 'difficulty', title: 'Difficulty', group: 'story', classic: 'normal',
        values: [
            { value: 'easy', label: 'Easy', note: 'Doubt goes in your favour; failure is rare.' },
            { value: 'normal', label: 'Normal', note: 'Every attempt stands on its own odds.' },
            { value: 'hard', label: 'Hard', note: 'Careless attempts fail more often.' },
            { value: 'brutal', label: 'Brutal', note: 'The world does not forgive a mistake.' },
        ],
    },
    {
        id: 'power', title: "Your character's power", group: 'character', classic: 'as-described',
        values: [
            { value: 'grounded', label: 'Grounded', note: 'Your abilities reach only as far as this world allows.' },
            { value: 'as-described', label: 'As you describe', note: 'Your abilities work exactly as you stated them.' },
        ],
    },
    {
        id: 'consequences', title: 'Consequences', group: 'story', classic: 'wounds',
        values: [
            { value: 'safe', label: 'Safe', note: 'No one who matters dies or is crippled; failure costs something else.' },
            { value: 'wounds', label: 'Wounds', note: 'Wounds last; death comes only from a choice that leads to it.' },
            { value: 'lethal', label: 'Lethal', note: 'Anyone can die, your character included.' },
        ],
    },
    {
        id: 'pacing', title: 'Pacing', group: 'story', classic: 'balanced',
        values: [
            { value: 'slow-burn', label: 'Slow burn', note: 'Quiet turns stay quiet; trouble comes only when it must.' },
            { value: 'balanced', label: 'Balanced', note: 'One thing moves forward each turn.' },
            { value: 'eventful', label: 'Eventful', note: 'Something new presses on the scene every turn or two.' },
        ],
    },
    {
        id: 'initiative', title: 'World initiative', group: 'story', classic: 'living',
        values: [
            { value: 'reactive', label: 'Reactive', note: 'Characters act when you give them a reason.' },
            { value: 'living', label: 'Living', note: 'Characters pursue their own plans whether you watch or not.' },
            { value: 'relentless', label: 'Relentless', note: 'The world moves on its own every turn.' },
        ],
    },
    {
        id: 'canon', title: 'Canon', group: 'story', classic: 'strict',
        values: [
            { value: 'strict', label: 'Strict canon', note: 'Characters and world hold to their canon.' },
            { value: 'flavoured', label: 'Canon-flavoured', note: 'The canon sets the flavour; this story may fill its gaps.' },
            { value: 'free', label: 'Free', note: 'The canon is material, not a rule.' },
        ],
    },
    {
        id: 'romance', title: 'Romance', group: 'story', classic: 'natural',
        values: [
            { value: 'slow', label: 'Slow', note: 'Characters warm to you over many turns.' },
            { value: 'natural', label: 'Natural', note: 'Romance grows at the pace the story allows.' },
            { value: 'fast', label: 'Fast', note: 'Characters warm to you quickly.' },
            { value: 'off', label: 'Off', note: 'No romantic lines at all.' },
        ],
    },
    {
        id: 'tone', title: 'Tone', group: 'story', classic: 'balanced',
        values: [
            { value: 'light', label: 'Light', note: 'Warmth, humour and kindness carry the story.' },
            { value: 'balanced', label: 'Balanced', note: 'Warmth and cruelty weigh as the story demands.' },
            { value: 'dark', label: 'Dark', note: 'The world is harsh; loss and cruelty belong in it.' },
        ],
    },
    {
        id: 'hooks', title: 'Hooks', group: 'story', classic: 'natural',
        values: [
            { value: 'natural', label: 'Where it ends', note: 'Each turn ends on its own last beat.' },
            { value: 'cliffhangers', label: 'Cliffhangers', note: 'Each turn ends on a pull back into the story.' },
        ],
    },
    {
        id: 'replyLength', title: 'Reply length', group: 'writing', classic: 'medium',
        values: [
            { value: 'short', label: 'Short', note: 'A few sentences per reply.' },
            { value: 'medium', label: 'Medium', note: 'Two or three paragraphs per reply.' },
            { value: 'long', label: 'Long', note: 'Room for detail and atmosphere.' },
        ],
    },
    {
        id: 'pov', title: 'Point of view', group: 'writing', classic: 'second',
        values: [
            { value: 'second', label: 'Second person', note: 'The story speaks to you as "you".' },
            { value: 'third', label: 'Third person', note: 'Your character is seen from outside.' },
            { value: 'first', label: 'First person', note: 'Your character is the one telling the story.' },
        ],
    },
    {
        id: 'prose', title: 'Prose', group: 'writing', classic: 'vivid',
        values: [
            { value: 'plain', label: 'Plain', note: 'Clear sentences, little ornament.' },
            { value: 'vivid', label: 'Vivid', note: 'Concrete senses and living gestures.' },
            { value: 'literary', label: 'Literary', note: 'Rhythm, imagery and precise words.' },
        ],
    },
    {
        id: 'dialogue', title: 'Dialogue', group: 'writing', classic: 'balanced',
        values: [
            { value: 'less', label: 'Less', note: 'Description carries most of the reply.' },
            { value: 'balanced', label: 'Balanced', note: 'Speech and description share the reply.' },
            { value: 'more', label: 'More', note: 'Speech takes more room than description.' },
        ],
    },
    {
        id: 'innerThoughts', title: 'Inner thoughts of others', group: 'writing', classic: 'hidden',
        values: [
            { value: 'hidden', label: 'Hidden', note: "Other characters' thoughts stay behind what they show." },
            { value: 'shown', label: 'Shown', note: "Other characters' thoughts may be heard, in moderation." },
        ],
    },
    {
        id: 'showRolls', title: 'Show rolls', group: 'display', classic: 'log',
        values: [
            { value: 'hidden', label: 'Hidden', note: 'Rolls are not shown anywhere.' },
            { value: 'log', label: 'In the director log', note: 'Rolls appear in the director log only.' },
            { value: 'chat', label: 'In the chat', note: 'A short line above the reply names each roll.' },
        ],
    },
    {
        id: 'bootstrapQuestions', title: 'Bootstrap questions', group: 'display', classic: 'normal',
        values: [
            { value: 'few', label: 'Few', note: 'At most 2 questions before the story starts.' },
            { value: 'normal', label: 'Normal', note: 'At most 5 questions before the story starts.' },
            { value: 'many', label: 'Many', note: 'At most 8 questions before the story starts.' },
        ],
    },
]);

/** Набор Classic — он же умолчание нового чата. */
export const DEFAULT_GAME_SETTINGS = Object.freeze(Object.fromEntries(GAME_OPTIONS.map(option => [option.id, option.classic])));

const optionIndex = new Map(GAME_OPTIONS.map(option => [option.id, option]));

/** Готовые режимы. Custom — не набор, а отсутствие совпадения с любым из них. */
export const GAME_MODES = Object.freeze([
    { id: 'story', label: 'Story', note: 'A forgiving world that moves towards you.' },
    { id: 'classic', label: 'Classic', note: 'The way the director already runs.' },
    { id: 'hardcore', label: 'Hardcore', note: 'A hostile world where anyone can die.' },
]);

const MODE_VALUES = Object.freeze({
    story: {
        difficulty: 'easy', power: 'as-described', consequences: 'safe', pacing: 'eventful',
        initiative: 'living', canon: 'flavoured', romance: 'fast', tone: 'light', hooks: 'natural',
        replyLength: 'medium', pov: 'second', prose: 'vivid', dialogue: 'balanced', innerThoughts: 'hidden',
        showRolls: 'log', bootstrapQuestions: 'normal',
    },
    classic: { ...DEFAULT_GAME_SETTINGS },
    hardcore: {
        difficulty: 'hard', power: 'as-described', consequences: 'lethal', pacing: 'balanced',
        initiative: 'relentless', canon: 'strict', romance: 'natural', tone: 'dark', hooks: 'natural',
        replyLength: 'medium', pov: 'second', prose: 'vivid', dialogue: 'balanced', innerThoughts: 'hidden',
        showRolls: 'log', bootstrapQuestions: 'normal',
    },
});

/** Сдвиг столбца сложности в таблице броска: легче — минус, тяжелее — плюс. */
export const DIFFICULTY_SHIFTS = Object.freeze({ easy: -1, normal: 0, hard: 1, brutal: 2 });

/** Сколько вопросов bootstrap задавать. */
export const BOOTSTRAP_QUESTION_COUNTS = Object.freeze({ few: 2, normal: 5, many: 8 });

export function gameOption(id) {
    return optionIndex.get(String(id)) ?? null;
}

export function optionValues(id) {
    return gameOption(id)?.values ?? [];
}

/** Мусор (неизвестная опция или значение) приводится к Classic, а не ломает окно. */
export function clampGameSettings(values = {}) {
    const source = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const next = {};
    for (const option of GAME_OPTIONS) {
        const known = option.values.some(item => item.value === source[option.id]);
        next[option.id] = known ? source[option.id] : option.classic;
    }
    return next;
}

/** Набор готового режима; неизвестный режим — Classic. */
export function modeValues(modeId) {
    return clampGameSettings(MODE_VALUES[String(modeId)] ?? MODE_VALUES.classic);
}

/** Имя режима по набору: совпал с готовым — его имя, иначе Custom. */
export function modeOf(values) {
    const clean = clampGameSettings(values);
    for (const [id, preset] of Object.entries(MODE_VALUES)) {
        const target = clampGameSettings(preset);
        if (GAME_OPTIONS.every(option => target[option.id] === clean[option.id])) return id;
    }
    return 'custom';
}

/** Правка набора: меняются только названные опции, остальное сохраняется. */
export function patchGameSettings(current = {}, patch = {}) {
    const next = clampGameSettings(current);
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    return clampGameSettings({ ...next, ...source });
}

/** Ярлык значения опции — для журнала и пометок в окне. */
export function optionLabel(id, value) {
    const option = gameOption(id);
    return option?.values.find(item => item.value === value)?.label ?? String(value ?? '');
}

/**
 * Что за набор: режим и опции, отличные от его основы (у Custom основа —
 * Classic). Это же уходит в запись хода и в пометки окна.
 */
export function settingsLabel(values = {}) {
    const clean = clampGameSettings(values);
    const mode = modeOf(clean);
    const base = modeValues(mode === 'custom' ? 'classic' : mode);
    const changed = GAME_OPTIONS
        .filter(option => clean[option.id] !== base[option.id])
        .map(option => ({ id: option.id, title: option.title, value: clean[option.id], label: optionLabel(option.id, clean[option.id]) }));
    return { mode, changed };
}

/** «Classic → Custom: Tone Dark», «Story → Hardcore» — строка смены для журнала. */
export function describeSettingsChange(previous = {}, next = {}) {
    const before = clampGameSettings(previous);
    const after = clampGameSettings(next);
    const from = modeOf(before);
    const to = modeOf(after);
    const name = id => (id === 'custom' ? 'Custom' : GAME_MODES.find(mode => mode.id === id)?.label ?? 'Custom');
    const head = from === to ? name(to) : `${name(from)} → ${name(to)}`;
    if (to !== 'custom') return head;
    const changed = GAME_OPTIONS
        .filter(option => after[option.id] !== before[option.id])
        .map(option => `${option.title} ${optionLabel(option.id, after[option.id])}`);
    return changed.length ? `${head}: ${changed.join(', ')}` : head;
}

/** Настройки чата есть — они; нет — умолчание для новых чатов; нет и его — Classic. */
export function resolveGameSettings(stored = null, defaults = null) {
    return clampGameSettings(stored == null ? (defaults ?? DEFAULT_GAME_SETTINGS) : stored);
}

export function difficultyShift(value) {
    const key = typeof value === 'string' ? value : value?.difficulty;
    return DIFFICULTY_SHIFTS[key] ?? 0;
}

export function bootstrapQuestionCount(value) {
    const key = typeof value === 'string' ? value : value?.bootstrapQuestions;
    return BOOTSTRAP_QUESTION_COUNTS[key] ?? BOOTSTRAP_QUESTION_COUNTS.normal;
}

/** Опции, чьи строки идут в блок: у директора 1–9, у писателя 10–14. */
const STORY_SIDE_OPTIONS = Object.freeze({
    director: Object.freeze(['difficulty', 'power', 'consequences', 'pacing', 'initiative', 'canon', 'romance', 'tone', 'hooks']),
    writer: Object.freeze(['replyLength', 'pov', 'prose', 'dialogue', 'innerThoughts']),
});

/**
 * Блок `STORY SETTINGS:` из выбранных значений — только выбранные строки,
 * в порядке опций. Пустой набор строк не даёт вовсе.
 */
export function buildStorySettingsBlock(side, values = {}) {
    const ids = STORY_SIDE_OPTIONS[String(side)] ?? [];
    const clean = clampGameSettings(values);
    const lines = ids.map(id => STORY_SETTINGS_RULES[id]?.[clean[id]]).filter(Boolean);
    return lines.length ? `${STORY_SETTINGS_HEADER}\n${lines.join('\n')}` : '';
}
