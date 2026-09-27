/**
 * Разметка треков МОДЕЛЬЮ: по названию и исполнителю текстовая модель пользователя пишет короткую «визитку» — настроение, темп, инструменты, к какой сцене подходит. Из неё
 * локальный эмбединг делает вектор, по которому трек сам включается по смыслу сцены (см. `libraries/core/track-selection.js`). Руками описывать ничего не нужно; правка
 * руками остаётся возможной и после неё модель этот трек больше не трогает.
 *
 * Здесь — чистые функции без сети и DOM: инструкция, промпт пачки, разбор ответа. Сам вызов модели — `modules/music/tagging.js`.
 */

export const TAGGING_BATCH_SIZE = 10;
export const TAGGING_MAX_DESCRIPTION = 320;

export const TAGGING_INSTRUCTION = [
    'You annotate music tracks for a roleplay soundtrack picker. The picker compares each description with the current scene of a story by meaning, so the description must say WHERE the track fits.',
    'For every numbered track write ONE description of at most 35 words: the mood and emotion, tempo and energy, main instruments or sound, and the kind of scene it suits (for example a quiet night camp, a chase, a sad farewell, a tense negotiation, a triumphant arrival).',
    'Use what you actually know about the track or the artist. If you do not recognise it, infer carefully from the words in the title and the artist\'s usual genre, and keep it general. Never invent lyrics, plots or facts.',
    'Do not repeat the title. Do not add commentary.',
    'Reply with ONLY a JSON array, one object per track, in the same order: [{"n":1,"d":"description"}, {"n":2,"d":"description"}].',
].join('\n');

/** Треки → пачки по `size` (последняя может быть короче). */
export function batchTracks(items, size = TAGGING_BATCH_SIZE) {
    const batches = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
}

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Пронумерованный список пачки: «1. Название — Исполнитель». */
export function buildTaggingPrompt(batch) {
    const lines = batch.map((item, index) => {
        const title = oneLine(item.name) || 'Untitled';
        const artist = oneLine(item.artist);
        return `${index + 1}. ${artist ? `${title} — ${artist}` : title}`;
    });
    return `Tracks:\n${lines.join('\n')}\n\nReturn the JSON array now.`;
}

/**
 * Ответ модели → массив описаний по порядку пачки (`null`, где записи нет или она негодная). Терпимо к обёрткам: ```json-блокам, тексту вокруг массива,
 * объекту `{ "tracks": [...] }`, ключам `d`/`description`, номерам `n`/`index`. Слишком длинное описание обрезается по границе слова.
 */
export function parseTaggingReply(reply, count) {
    const result = new Array(count).fill(null);
    let text = String(reply ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const start = text.search(/[[{]/);
    if (start < 0) return result;
    text = text.slice(start);
    let data = null;
    for (const end of [text.length, text.lastIndexOf(']') + 1, text.lastIndexOf('}') + 1]) {
        if (end <= 0) continue;
        try { data = JSON.parse(text.slice(0, end)); break; } catch { /* пробуем короче */ }
    }
    if (data && !Array.isArray(data)) data = data.tracks ?? data.items ?? data.result ?? null;
    if (data === null) {
        // Ответ оборвался (лимит токенов) или испорчен целиком: спасаем полные плоские объекты `{...}` по одному.
        data = (text.match(/\{[^{}]*\}/g) ?? []).flatMap(chunk => { try { return [JSON.parse(chunk)]; } catch { return []; } });
    }
    if (!Array.isArray(data)) return result;
    data.forEach((entry, position) => {
        if (!entry || typeof entry !== 'object') return;
        const number = Number.isInteger(entry.n) ? entry.n : Number.isInteger(entry.index) ? entry.index : position + 1;
        const description = cleanDescription(entry.d ?? entry.description ?? entry.desc);
        if (description && number >= 1 && number <= count) result[number - 1] = description;
    });
    return result;
}

/** Описание пригодно, если не пустое; длиннее предела — обрезаем по слову. */
export function cleanDescription(value) {
    const text = oneLine(value).replace(/^["'“”]+|["'“”]+$/g, '');
    if (text.length < 8) return null;
    if (text.length <= TAGGING_MAX_DESCRIPTION) return text;
    const cut = text.slice(0, TAGGING_MAX_DESCRIPTION);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd()}…`;
}

/** Текст для вектора: имя, исполнитель и описание модели — чтобы подбор помнил и «кто это», и «про что». */
export function embeddingText({ name, artist, description }) {
    const head = [oneLine(name), oneLine(artist)].filter(Boolean).join(' — ');
    return head && description ? `${head}. ${description}` : (description || head);
}

/** Чем размечен трек: `name` — только названием, `model` — моделью, `manual` — правил человек (модель такой трек не трогает). */
export const TAG_KINDS = Object.freeze({ NAME: 'name', MODEL: 'model', MANUAL: 'manual' });
export const sanitizeTagKind = value => (Object.values(TAG_KINDS).includes(value) ? value : TAG_KINDS.NAME);
