/**
 * Мосты данных «Пяти столпов»: «что угодно → модель столпа». ЧИСТЫЕ адаптеры
 * без DOM, без хранения и без моделей — вид только рисует готовую модель.
 * Новый источник текста подключается ОДНОЙ функцией, отдающей блоки `Page`
 * (см. `textToBlocks`), остальные виды не меняются.
 *
 * Правило (задание): каждый вид рисует только модель; действия видов идут
 * через существующие контракты `call('decision.…')` — здесь они названы, но
 * не вызываются.
 */

import {
    LANES, LANE_IDS, laneOfEntry, splitEntry, toolLabel, toolFields, entrySummary,
} from './court-lanes.js';
import {
    MATERIAL_SECTIONS, SPIRITUAL_SECTIONS, DECREE_SECTIONS, IMPORTANCE_LEVELS,
} from './decision-bank-sections.js';
import { GAME_OPTIONS, GAME_GROUPS, optionLabel } from './game-settings.js';
import { builtInPrompts } from './prompt-catalog.js';
import { canonSummary } from './decision-canon.js';
import { usageOf, tokensOf } from './court-files-model.js';

const text = value => String(value ?? '').trim();
const arr = value => (Array.isArray(value) ? value : []);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** RP-время из минут: `HH:MM`. Не число — пусто. */
export function clockLabel(minutes) {
    if (!Number.isFinite(Number(minutes))) return '';
    const total = Math.max(0, Math.round(Number(minutes)));
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Человеческая метка записи: ход, RP-время, дата — что есть, в этом порядке. */
export function recordWhen(entry) {
    const parts = [];
    if (Number.isFinite(Number(entry?.turn)) && entry?.turn !== null && entry?.turn !== '') parts.push(`Turn ${entry.turn}`);
    const clock = clockLabel(entry?.clockMinutes);
    if (clock) parts.push(`RP ${clock}`);
    if (!parts.length && entry?.at) parts.push(new Date(Number(entry.at)).toLocaleString());
    return parts.join(' · ');
}

/** Одна запись ленты столпа — общая форма для всех видов. */
export function makeRecord({ id, lane = null, turn = null, when = '', title = '', summary = '', fields = [], raw = null, ask = null } = {}) {
    return {
        id: text(id),
        lane,
        turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
        when: text(when),
        title: text(title),
        summary: text(summary),
        fields: arr(fields).filter(pair => arr(pair).length === 2 && text(pair[1])).map(([label, value]) => [text(label), text(value)]),
        raw,
        ...(ask ? { ask: { prompt: text(ask.prompt), id: text(ask.id) || null } } : {}),
    };
}

/** Поля главного вызова записи: первый вызов/прошение, у которого есть человеческие поля. */
function recordFields(rows) {
    for (const row of rows) {
        if (row?.kind !== 'call' && row?.kind !== 'petition') continue;
        const fields = toolFields(row.name, row.args ?? row);
        if (fields.length) return fields;
    }
    return [];
}

/** Запись по части дорожки: заголовок — по смыслу первого вызова, иначе по части. */
function recordForPart(part, lane) {
    const rows = arr(part?.rows);
    const first = rows.find(row => row?.kind === 'call' || row?.kind === 'petition');
    const title = text(part?.title) || (first ? toolLabel(first.name, first.args ?? first) : '');
    return makeRecord({
        id: `${text(part?.id)}|${lane}`, lane, turn: part?.turn, when: recordWhen(part),
        title, summary: entrySummary(part), fields: recordFields(rows), raw: part,
    });
}

/**
 * `toLaneEntries(entries)` — лента (`libraries/core/court-lanes.js`) → записи
 * столпа. Каждая часть дорожки (запись цикла или её кусок для Writer) — одна
 * запись; вопрос God добавляется как запись с `ask`.
 */
export function toLaneEntries(entries) {
    const records = [];
    for (const entry of arr(entries)) {
        const parts = splitEntry(entry);
        for (const [lane, part] of Object.entries(parts)) {
            records.push(recordForPart(part, lane));
            // «God awaits your answer»: открытый вопрос — отдельная запись с промптом.
            for (const row of arr(part?.rows)) {
                if (row?.kind !== 'god_questions') continue;
                for (const question of arr(row.questions)) {
                    records.push(makeRecord({
                        id: `${text(part?.id)}|ask|${text(question?.id)}`, lane, turn: part?.turn,
                        when: recordWhen(part), title: 'God asks you', summary: text(question?.why),
                        raw: question, ask: { prompt: question?.question, id: question?.id ?? null },
                    }));
                }
            }
        }
    }
    return records;
}

/** Записи одной дорожки — из общей ленты (удобно виду The Court). */
export function toLane(entries, lane) {
    return toLaneEntries(entries).filter(record => record.lane === lane);
}

/**
 * `toLedger(chat)` — журнал чата → записи Ведомости: реплики, телеграммы,
 * молитвы и ответы Советника, новые сверху.
 */
export function toLedger(chat) {
    const records = [];
    for (const entry of arr(chat)) {
        for (const [index, row] of arr(entry?.rows).entries()) {
            const kind = text(row?.kind);
            const title = kind === 'message' ? 'You'
                : kind === 'telegram' ? 'Telegram'
                    : kind === 'prayer' ? 'Prayer'
                        : kind === 'counsellor_reply' ? 'The Counsellor' : '';
            if (!title) continue;
            records.push(makeRecord({
                id: `${text(entry?.id) || 'cycle'}|ledger|${index}`,
                lane: laneOfEntry(entry), turn: entry?.turn, when: recordWhen(entry),
                title, summary: text(row.text), raw: row,
            }));
        }
    }
    return records.sort((a, b) => (b.turn ?? -1) - (a.turn ?? -1));
}

// ── Страницы книги ──────────────────────────────────────────────────────────────────────────────────────────────

export const PAGE_BLOCK_TYPES = Object.freeze(['heading', 'text', 'pairs', 'amend', 'note', 'sketch', 'actions']);

/** Пустая страница: блоки и номер внизу у наружного края. */
export function page(blocks = [], folio = '') {
    return { blocks: arr(blocks), folio: String(folio ?? '') };
}

/**
 * «Одна функция» для нового источника текста: простой текст → блоки `Page`.
 * Заголовок — строка `# …`; пары `— label: value`; пустая строка — абзац;
 * остальное — текст. Источник, у которого нет своей формы, подключается так.
 */
export function textToBlocks(value) {
    const blocks = [];
    for (const raw of String(value ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) { blocks.push({ type: 'heading', text: line.replace(/^#+\s*/, '') }); continue; }
        const pair = /^[-—*]\s*([^:]{1,60}):\s*(.+)$/.exec(line);
        if (pair) { blocks.push({ type: 'pairs', pairs: [[pair[1].trim(), pair[2].trim()]] }); continue; }
        blocks.push({ type: 'text', text: line });
    }
    return blocks;
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];

/** Части персонажа — ленты книги и порядок разворотов. */
export const BOOK_PARTS = Object.freeze(['material', 'spiritual', 'knowledge', 'decree', 'history']);
export const BOOK_PART_LABELS = Object.freeze({
    material: 'Material', spiritual: 'Spiritual', knowledge: 'Knowledge', decree: 'Decree', history: 'History',
});

/** Заголовки разделов части — из чистых данных Great Bank. */
function partSections(part) {
    if (part === 'material') return MATERIAL_SECTIONS;
    if (part === 'spiritual') return SPIRITUAL_SECTIONS;
    if (part === 'decree') return DECREE_SECTIONS;
    return [];
}

function linesOf(character, part, no) {
    const bucket = isObject(character?.[part]) ? character[part] : {};
    return arr(bucket?.[no]).map(text).filter(Boolean);
}

function knowledgeLines(character) {
    return arr(character?.knowledge?.items).map(item => text(item?.fact)).filter(Boolean);
}

function historyBlocks(character) {
    return arr(character?.history).map(change => ({
        type: 'amend', was: text(change?.old), now: text(change?.new),
        who: `${text(change?.by) || 'someone'}${change?.at ? ` · ${text(change.at)}` : ''}`,
    }));
}

/** Правая страница персонажа: разделы выбранной части. */
function characterRight(character, part) {
    const name = text(character?.name);
    if (part === 'knowledge') {
        const lines = knowledgeLines(character);
        return [{
            type: 'heading', text: BOOK_PART_LABELS.knowledge,
        }, lines.length
            ? { type: 'pairs', pairs: lines.map((line, index) => [`${index + 1}`, line]), character: name, part }
            : { type: 'text', text: 'Nothing is known yet.' }];
    }
    if (part === 'history') {
        const history = historyBlocks(character);
        return [{ type: 'heading', text: BOOK_PART_LABELS.history }, ...(history.length ? history : [{ type: 'text', text: 'No hand has changed this chapter yet.' }])];
    }
    const sections = partSections(part);
    const blocks = [{ type: 'heading', text: BOOK_PART_LABELS[part] }];
    const pairs = [];
    const sectionsUsed = [];
    for (const section of sections) {
        const lines = linesOf(character, part, section.no).filter(line => line !== '');
        for (const line of lines) { pairs.push([section.name, line]); sectionsUsed.push(section.no); }
    }
    if (pairs.length) blocks.push({ type: 'pairs', pairs, character: name, part, sections: sectionsUsed });
    else blocks.push({ type: 'text', text: 'This part is not written yet.' });
    return blocks;
}

/** Левая страница персонажа: имя, важность, заметка-набросок. */
function characterLeft(character, part, index) {
    const importance = IMPORTANCE_LEVELS.includes(character?.importance) ? character.importance : 'side';
    return [
        { type: 'note', text: `chapter ${ROMAN[index] ?? index + 1} · ${importance}` },
        { type: 'heading', text: text(character?.name) || 'An unnamed soul' },
        { type: 'sketch', kind: 'figure' },
        { type: 'text', text: part === 'decree' ? 'What they hold to, and what they are for.' : `The ${BOOK_PART_LABELS[part]?.toLowerCase() ?? part} of this soul.` },
    ];
}

/** Содержание книги: список персонажей с номерами страниц. */
function contentsSpread(characters) {
    const pairs = characters.map((character, index) => [`${text(character?.name) || 'Unnamed'} · ${index + 1}`, '']);
    return [
        page([{ type: 'heading', text: 'The Great Bank' }, { type: 'text', text: 'Every soul that walks this world — kept by the Director, amended by the Resolver, read by the Writer.' }, { type: 'sketch', kind: 'emblem' }], 1),
        page([{ type: 'heading', text: 'Contents' }, { type: 'pairs', pairs: pairs.map(([name]) => [name, '']) }], 2),
    ];
}

/**
 * `toBookVolume(kind, sources)` — том книги. `kind` — `'bank'` (Great Bank) или
 * `'world'` (Creation и Scales). `sources` — данные вида: `great` (записи
 * персонажей) для банка, `creation` ({ sections, scales }) и `prayers` для
 * мира. Всё чистое: вид рисует готовое.
 */
export function toBookVolume(kind = 'bank', sources = {}) {
    if (kind === 'world') return worldVolume(sources);
    return bankVolume(sources);
}

function bankVolume({ great = {}, title = 'The Great Bank' } = {}) {
    const characters = Object.entries(isObject(great) ? great : {})
        .map(([key, character], index) => ({ key, character, index }))
        .sort((a, b) => (a.character?.importance === 'main' ? -1 : 0) - (b.character?.importance === 'main' ? -1 : 0));
    const spreads = [];
    const [left, right] = contentsSpread(characters.map(item => item.character));
    spreads.push({ who: 'contents', left, right });
    let folio = 3;
    for (const { key, character, index } of characters) {
        for (const part of BOOK_PARTS) {
            const body = characterRight(character, part);
            spreads.push({
                who: key, part,
                left: page(characterLeft(character, part, index), folio),
                right: page(body, folio + 1),
            });
            folio += 2;
        }
    }
    return {
        kind: 'bank',
        title,
        coverEmblem: 'bank',
        spreads,
        ribbons: BOOK_PARTS.map(part => ({ id: part, label: BOOK_PART_LABELS[part], go: { who: characters[0]?.key ?? null, part } })),
        thumbs: [
            { id: 'contents', label: 'Contents', group: '', go: { who: 'contents' } },
            ...characters.map(({ key, character }) => ({ id: key, label: text(character?.name) || 'Unnamed', group: text(character?.importance), go: { who: key } })),
        ],
        characters: characters.map(({ key, character }) => ({ id: key, name: text(character?.name), importance: text(character?.importance) })),
    };
}

const CREATION_LABELS = Object.freeze({
    geography: 'Geography', spirituality: 'Spirituality and Culture', scales: 'Scales',
    history: 'History', politics: 'Politics and Conflicts', user: 'The User in the World',
});

/** Том мира: разделы Creation и системы Scales, плюс глава Молитв. */
function worldVolume({ creation = {}, prayers = [], title = 'The World' } = {}) {
    const sections = arr(creation?.sections).filter(section => text(section?.text) || text(section?.title));
    const scales = arr(creation?.scales);
    const spreads = [];
    const contents = [
        ...sections.map((section, index) => [`${text(section.title) || CREATION_LABELS[section.key] || `Section ${index + 1}`} · ${index + 1}`, '']),
        ...scales.map((scale, index) => [`${text(scale?.name) || `Scale ${index + 1}`} · ${sections.length + index + 1}`, '']),
        ['Prayers', ''],
    ];
    spreads.push({
        who: 'contents',
        left: page([{ type: 'heading', text: title }, { type: 'text', text: 'As God shaped it, and as the Prayers have changed it.' }, { type: 'sketch', kind: 'map' }], 1),
        right: page([{ type: 'heading', text: 'Contents' }, { type: 'pairs', pairs: contents }], 2),
    });
    let folio = 3;
    for (const [index, section] of sections.entries()) {
        spreads.push({
            who: text(section.key) || `section-${index}`, group: 'creation',
            left: page([
                { type: 'note', text: 'of Creation' },
                { type: 'heading', text: text(section.title) || CREATION_LABELS[section.key] || 'A section' },
                { type: 'sketch', kind: 'map' },
            ], folio),
            right: page([{ type: 'heading', text: text(section.title) || CREATION_LABELS[section.key] || 'A section' }, ...textToBlocks(section.text), { type: 'actions', actions: [{ id: 'amend', label: 'amend the page' }] }], folio + 1),
        });
        folio += 2;
    }
    for (const [index, scale] of scales.entries()) {
        const rules = arr(scale?.rules).map(rule => [text(rule?.name) || 'A rule', `${text(rule?.needs)} → ${text(rule?.yields)}`]).filter(([, value]) => value !== ' → ');
        spreads.push({
            who: text(scale?.id) || `scale-${index}`, group: 'scales',
            left: page([
                { type: 'note', text: 'of the Scales' },
                { type: 'heading', text: text(scale?.name) || 'A system' },
                { type: 'sketch', kind: 'scales' },
                { type: 'text', text: text(scale?.principle) },
            ], folio),
            right: page([{ type: 'heading', text: text(scale?.name) || 'A system' }, rules.length ? { type: 'pairs', pairs: rules } : { type: 'text', text: 'The rules are not written yet.' }, { type: 'actions', actions: [{ id: 'pray', label: 'pray to change it' }] }], folio + 1),
        });
        folio += 2;
    }
    const prayerPairs = arr(prayers).map(prayer => [text(prayer.who) || `Prayer ${text(prayer.id)}`, text(prayer.text)]).filter(([, value]) => value);
    spreads.push({
        who: 'prayers', group: 'prayers',
        left: page([{ type: 'note', text: 'the last chapter' }, { type: 'heading', text: 'Prayers' }, { type: 'sketch', kind: 'quill' }, { type: 'text', text: 'What you asked of God.' }], folio),
        right: page([{ type: 'heading', text: 'Prayers' }, prayerPairs.length ? { type: 'pairs', pairs: prayerPairs } : { type: 'text', text: 'No prayer has been written yet.' }], folio + 1),
    });
    return {
        kind: 'world', title, coverEmblem: 'world', spreads, characters: [],
        ribbons: [
            { id: 'creation', label: 'Creation', go: { who: text(sections[0]?.key) || (sections.length ? 'section-0' : 'contents') } },
            { id: 'scales', label: 'Scales', go: { who: text(scales[0]?.id) || (scales.length ? 'scale-0' : 'contents') } },
            { id: 'prayers', label: 'Prayers', go: { who: 'prayers' } },
        ],
        thumbs: [
            { id: 'contents', label: 'Contents', group: '', go: { who: 'contents' } },
            ...sections.map((section, index) => ({ id: text(section.key) || `section-${index}`, label: text(section.title) || CREATION_LABELS[section.key] || `Section ${index + 1}`, group: 'creation', go: { who: text(section.key) || `section-${index}` } })),
            ...scales.map((scale, index) => ({ id: text(scale?.id) || `scale-${index}`, label: text(scale?.name) || `Scale ${index + 1}`, group: 'scales', go: { who: text(scale?.id) || `scale-${index}` } })),
            { id: 'prayers', label: 'Prayers', group: 'one is heard', go: { who: 'prayers' } },
        ],
    };
}

// ── Charter ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Пропуск статьи: значение и варианты выбора (клик — выбор в строке). */
export function gap(key, value, options, { paid = false } = {}) {
    const list = arr(options).map(text).filter(Boolean);
    return { key: text(key), value: text(value), options: list.length ? [...new Set([text(value), ...list])] : [text(value)], paid: Boolean(paid) };
}

/** Статья свода: строки текста и пропуски, признак «зачёркнута» и «оплачена». */
function article(id, pieces, { struck = false, paid = false } = {}) {
    return {
        id: text(id),
        text: arr(pieces).flatMap(piece => (piece && typeof piece === 'object' ? [piece] : text(piece) ? [text(piece)] : [])),
        struck: Boolean(struck),
        paid: Boolean(paid),
    };
}

const VOICE_ROWS = Object.freeze([
    { id: 'god', name: 'God', label: 'God' },
    { id: 'director', name: 'Director', label: 'The Director' },
    { id: 'counsellor', name: 'Counsellor', label: 'The Counsellor' },
    { id: 'resolver', name: 'Resolver', label: 'The Resolver' },
    { id: 'writer', name: 'Writer', label: 'The Writer' },
]);

function workerModel(workers, id) {
    const worker = arr(workers).find(item => text(item?.id) === id) ?? null;
    return { model: text(worker?.model) || 'a model', profile: text(worker?.id) || 'no connection' };
}

/**
 * `toCharter(settings, extra)` — свод законов из настроек: статья на каждую
 * опцию игры и на каждую роль, приложения — встроенные промпты и файлы
 * (`court-files-model.js`). Сохранение — через существующие настройки
 * `stme_settings` (вид зовёт `call('decision.gameSettings.set')` и
 * `call('decision.configure')`), здесь только модель.
 */
export function toCharter(settings = {}, { workers = [], files = null, prompts = null } = {}) {
    const voiceArticles = VOICE_ROWS.map((voice, index) => {
        const own = { god: settings.god, director: settings.director, counsellor: settings.counsellor, resolver: settings.decider, writer: settings.writer }[voice.id] ?? {};
        const model = workerModel(workers, own?.workerId) ?? { model: 'a model', profile: 'its own profile' };
        return article(`voices-${voice.id}`, [
            voice.label, ' shall think through ',
            gap(`${voice.id}-model`, model.model, workers.map(item => text(item?.model)).filter(Boolean)),
            ' by way of ', gap(`${voice.id}-profile`, model.profile, workers.map(item => text(item?.id)).filter(Boolean)),
            ', and speak no longer than ', gap(`${voice.id}-tokens`, String(own?.maxTokens ?? ''), ['4000', '6000', '8000', '16000', '24000', '32000']),
            ' tokens.',
        ], { paid: index < 2 });
    });

    const storyArticles = [];
    for (const option of GAME_OPTIONS) {
        const value = settings.gameDefaults?.[option.id] ?? settings.values?.[option.id] ?? option.classic;
        storyArticles.push(article(`story-${option.id}`, [
            `The ${option.title.toLowerCase()} of a new story shall be `,
            gap(`story-${option.id}`, optionLabel(option.id, value), option.values.map(item => item.label)),
            '.',
        ]));
    }

    const memoryArticles = [
        article('memory-window', [
            'The Resolver shall hold no more than ', gap('memory-window', String(settings.windowLimit ?? ''), ['20', '50', '100', '200']),
            ' turns of the story in mind.',
        ]),
        article('memory-compressed', [
            'The Resolver shall keep no more than ', gap('memory-compressed', String(settings.compressedLimitTokens ?? ''), ['60000', '120000', '200000', '300000']),
            ' tokens of the compressed story.',
        ]),
        article('memory-archive', [
            'The archive shall hold no more than ', gap('memory-archive', String(settings.archiveLimitTokens ?? ''), ['100000', '200000', '300000']),
            ' tokens before the oldest arcs are lost.',
        ]),
    ];

    const chapters = [
        { id: 'voices', title: 'Of the Voices', articles: voiceArticles },
        { id: 'story', title: 'Of the Story', articles: storyArticles },
        { id: 'memory', title: 'Of the Memory', articles: memoryArticles },
    ];

    const catalog = arr(files ?? prompts ?? builtInPrompts());
    const appendices = catalog.map((file, index) => ({
        id: text(file?.id) || `appendix-${index}`,
        letter: String.fromCharCode(65 + (index % 26)),
        title: text(file?.name) || text(file?.title) || 'A prompt',
        meta: `${text(file?.name) || 'PROMPT'} · ${tokensOf(file?.text)} tokens`,
        text: text(file?.text),
        usage: usageOf(file),
    }));

    const dirty = chapters.flatMap(chapter => chapter.articles).filter(item => item.struck).length;
    return { kind: 'charter', chapters, appendices, dirty, groups: GAME_GROUPS };
}

// ── Sky (Canon) ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Детерминированный генератор по семени: раскладка созвездий не «пляшет» между открытиями. */
function seeded(seed) {
    let state = Number(seed) || 1;
    return () => {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
    };
}

function hashId(value) {
    let hash = 0;
    const source = String(value ?? '');
    for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
    return Math.abs(hash) || 1;
}

/** Пятёрка позиций на небе — чтобы созвездия не ложились друг на друга. */
const SKY_SLOTS = Object.freeze([
    [360, 300], [1240, 280], [1210, 690], [430, 700], [800, 150], [180, 470], [1440, 460],
]);

/** Звёзды созвездия: люди мира, главные — крупнее. Ломаная — жадно к ближайшему соседу. */
export function constellationStars(cast, seed = 1) {
    const random = seeded(seed);
    const stars = arr(cast).map((person, index) => {
        const name = text(person?.name ?? person);
        const main = Boolean(person?.main);
        const angle = (index / Math.max(1, arr(cast).length)) * Math.PI * 2 + random() * 0.9;
        const distance = 40 + random() * 110;
        return { name, main, r: main ? 5 : 3, x: Math.cos(angle) * distance * 1.3, y: Math.sin(angle) * distance * 0.8 };
    });
    if (!stars.length) return { stars, line: '', low: 0 };
    const path = [stars[0]];
    const left = stars.slice(1);
    while (left.length) {
        const last = path[path.length - 1];
        left.sort((a, b) => Math.hypot(a.x - last.x, a.y - last.y) - Math.hypot(b.x - last.x, b.y - last.y));
        path.push(left.shift());
    }
    const line = `M${path.map(star => `${star.x.toFixed(1)} ${star.y.toFixed(1)}`).join('L')}`;
    const low = Math.max(...stars.map(star => star.y)) + 6;
    return { stars, line, low };
}

/**
 * `toSky(canon)` — небо Canon: каждый сохранённый мир — созвездие, текущий
 * (не сохранённый) — россыпь без линий и имени. Действия вписаны в созвездие:
 * выбрать, сохранить поверх, экспорт, удалить.
 */
export function toSky(canon = {}) {
    const saved = arr(canon.canons);
    const current = canon.current ?? null;
    const constellations = saved.map((item, index) => {
        const summary = canonSummary(item);
        const slot = SKY_SLOTS[index % SKY_SLOTS.length];
        const { stars, line, low } = constellationStars(arr(item?.cast).length ? item.cast : [], summary.createdAt || hashId(summary.id));
        return {
            id: summary.id,
            name: summary.name,
            meta: `${summary.characters} souls · saved ${summary.createdAt ? new Date(summary.createdAt).toLocaleDateString() : 'earlier'}`,
            at: slot,
            stars,
            line,
            low,
            unsealed: false,
            actions: [
                { id: 'choose', label: 'descend into this world', call: 'decision.canonApply', params: { id: summary.id } },
                { id: 'export', label: 'carry it out', call: null, params: { id: summary.id } },
                { id: 'delete', label: 'let it fade', call: null, params: { id: summary.id } },
            ],
        };
    });
    if (current) {
        const slot = SKY_SLOTS[(saved.length) % SKY_SLOTS.length];
        const random = seeded(hashId(canon.key ?? 'now'));
        const cast = arr(current.cast);
        const stars = (cast.length ? cast : Array.from({ length: 5 }, (_, index) => ({ name: '', main: index < 2 }))).map(person => ({
            name: text(person?.name),
            main: Boolean(person?.main),
            r: person?.main ? 5 : 3,
            x: (random() - 0.5) * 260,
            y: (random() - 0.5) * 180,
        }));
        constellations.push({
            id: 'now',
            name: text(current.name) || 'This world',
            meta: `${text(current.meta) || 'not yet sealed'}`,
            at: slot,
            stars,
            line: '',
            low: Math.max(0, ...stars.map(star => star.y)) + 6,
            unsealed: true,
            actions: [{ id: 'seal', label: 'seal the present', call: 'decision.canonSave', params: { name: text(current.name) || 'This world' } }],
        });
    }
    return { kind: 'sky', constellations, slots: SKY_SLOTS };
}

// ── Court ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_ANGLES = Object.freeze({ god: -90, director: -18, counsellor: 54, resolver: 126, writer: 198 });

/**
 * `toCourt(state)` — круглый стол: роли (кто работает, вопрос God), ходы,
 * файлы, Ведомость. `state` — `{ entries, god, turns, files, clock, place, name }`.
 */
// Столпов пять по утверждённому макету: дорожка Simulator живёт только в старом окне The Court.
const PILLAR_LANES = new Set(['god', 'director', 'counsellor', 'resolver', 'writer']);

export function toCourt(state = {}) {
    const entries = arr(state.entries);
    const ledgerRecords = toLedger(entries);
    const laneRecords = toLaneEntries(entries);
    const working = new Set(arr(state.working));
    const questions = arr(state.god?.questions).filter(question => !text(question?.answer));
    const roles = LANES.filter(lane => PILLAR_LANES.has(lane.id)).map(lane => {
        const records = laneRecords.filter(record => record.lane === lane.id);
        const asks = questions.map(question => makeRecord({
            id: `god-ask|${text(question.id)}`, lane: 'god', turn: question?.turn ?? null,
            when: recordWhen({ turn: question?.turn }), title: 'God asks you', summary: text(question?.why),
            raw: question, ask: { prompt: question?.question, id: question?.id ?? null },
        }));
        const isWorking = working.has(lane.id) || (lane.id === 'god' && asks.length > 0);
        return {
            id: lane.id,
            name: lane.label,
            angle: ROLE_ANGLES[lane.id] ?? 0,
            lit: isWorking,
            sub: isWorking ? 'working' : lane.empty,
            records: lane.id === 'god' ? [...asks, ...records] : records,
            empty: lane.empty,
        };
    });
    const turns = (arr(state.turns).length ? arr(state.turns) : [...new Set(entries.map(entry => Number(entry?.turn)).filter(Number.isFinite))])
        .sort((a, b) => a - b);
    return {
        kind: 'court',
        name: text(state.name),
        rpTime: clockLabel(state.clock?.minutes),
        place: text(state.place),
        roles,
        turns: turns.map(turn => ({ n: turn, label: String(turn) })),
        ledger: ledgerRecords,
        files: arr(state.files).map(file => {
            const path = text(file?.path);
            const mapped = {
                ...file,
                kind: text(file?.kind) || (/^Characters\//i.test(path) ? 'character' : /^Creation\//i.test(path) ? 'layer' : 'layer'),
                part: text(file?.part) || (/^Characters\/[^/]+\/knowledge\.md$/i.test(path) ? 'knowledge' : undefined),
            };
            return {
                id: text(file?.id) || path,
                path, title: text(file?.title) || path,
                role: text(file?.role), tokens: tokensOf(file?.text), text: text(file?.text), usage: usageOf(mapped),
            };
        }),
        working: [...working],
    };
}

// ── Печать устава ────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_SETTINGS = Object.freeze({ god: 'god', director: 'director', counsellor: 'counsellor', resolver: 'decider', writer: 'writer' });
const MEMORY_SETTINGS = Object.freeze({ 'memory-window': 'windowLimit', 'memory-compressed': 'compressedLimitTokens', 'memory-archive': 'archiveLimitTokens' });

/**
 * `charterPatch(settings, workers, changes)` — изменённые пропуски устава (`[{ key, value }]`) →
 * `{ configure, game }`: патч для `decision.configure` (верхний уровень целиком — движок сливает
 * настройки неглубоко) и для `decision.gameSettings.set`. Неизвестный ключ — пропускается.
 */
export function charterPatch(settings = {}, workers = [], changes = []) {
    const configure = {};
    const game = {};
    const role = id => (configure[ROLE_SETTINGS[id]] ??= { ...(isObject(settings[ROLE_SETTINGS[id]]) ? settings[ROLE_SETTINGS[id]] : {}) });
    for (const { key, value } of arr(changes)) {
        const k = text(key), v = text(value);
        const voice = /^(god|director|counsellor|resolver|writer)-(model|profile|tokens)$/.exec(k);
        if (voice) {
            const [, id, what] = voice;
            if (what === 'tokens') { const n = Number(v.replace(/\D/g, '')); if (n > 0) role(id).maxTokens = n; continue; }
            const worker = arr(workers).find(item => (what === 'model' ? text(item?.model) : text(item?.id)) === v);
            if (worker?.id) role(id).workerId = worker.id;
            continue;
        }
        if (MEMORY_SETTINGS[k]) { const n = Number(v.replace(/\D/g, '')); if (n > 0) configure[MEMORY_SETTINGS[k]] = n; continue; }
        const story = /^story-(.+)$/.exec(k);
        if (story) {
            const option = GAME_OPTIONS.find(item => item.id === story[1]);
            const choice = option?.values.find(item => item.label === v || item.value === v);
            if (choice) game[option.id] = choice.value;
        }
    }
    return { configure, game };
}
