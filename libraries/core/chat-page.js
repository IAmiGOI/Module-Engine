/**
 * Чат как «страница» для краулера гида (по образцу lorebook-page.js): чат бывает на тысячи сообщений, и в контекст его не кладут, а «открывают» страницей в бэкенде
 * (Сервис `stWebSearch`): каждое сообщение — раздел `## #mesid Имя [роль] дата`, дальше его читают по диапазону номеров (`chat.read`) и ищут по словам и по смыслу
 * (`chat.find`). Номер `#mesid` — тот же, что у сообщения в самой ST (индекс в чате без заголовка файла), поэтому по нему же гид ссылается на место в чате.
 * Чистые функции, без Шины.
 */

/** Страница чата больше обычной веб-страницы: в хранилище её кладут с этим пределом. */
export const CHAT_PAGE_MAX_CHARS = 4000000;
export const CHAT_READ_DEFAULT_CHARS = 4000;
export const CHAT_READ_MAX_CHARS = 8000;
/** До этого размера открытый чат приходит в ответ целиком; дальше — только обзор. */
export const SMALL_CHAT_CHARS = 3000;
const GLANCE_CHARS = 160;
const DATE_CHARS = 40;
const LAST_DEFAULT = 6;
const LAST_MAX = 40;

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const cut = (text, length) => (oneLine(text).length > length ? `${oneLine(text).slice(0, length)}…` : oneLine(text));
// Строка сообщения, начинающаяся с «## », стала бы заголовком раздела и разорвала бы страницу: ей ставится обратная косая.
const escapeHeadings = text => String(text ?? '').replace(/^(#{1,6})(\s)/gm, '\\$1$2');

/** Сохранённый файл чата ST (массив: заголовок `chat_metadata`, затем реплики) → сообщения в нейтральной форме с `mesid` как в живом чате. */
export function normalizeSavedChat(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const messages = list.filter(item => item && typeof item === 'object' && !(item.chat_metadata !== undefined && item.mes === undefined));
    return messages.map((message, index) => ({
        mesid: String(index),
        isUser: Boolean(message.is_user),
        isSystem: Boolean(message.is_system),
        name: String(message.name ?? ''),
        text: String(message.mes ?? ''),
        sendDate: message.send_date ?? null,
    }));
}

const roleOf = message => (message.isSystem ? 'hidden' : message.isUser ? 'user' : 'char');

/** Заголовок сообщения: `## #12 Aria [char] 2026-10-02 14:01`. Скрытое или системное — `[hidden]`: ST не посылает его модели. */
export function messageHeading(message) {
    const name = oneLine(message.name) || (message.isUser ? 'User' : 'Character');
    const date = message.sendDate === null || message.sendDate === undefined ? '' : ` ${cut(message.sendDate, DATE_CHARS)}`;
    return `## #${message.mesid} ${name} [${roleOf(message)}]${date}`;
}

/** Текст страницы чата: шапка (кто, сколько) и все сообщения по порядку, у каждого заголовок и текст. */
export function renderChatPage({ title, messages }) {
    const list = [...(messages ?? [])];
    if (!list.length) return `Chat “${title}” has no messages.`;
    const head = `Chat “${title}” — ${list.length} message${list.length === 1 ? '' : 's'}, #${list[0].mesid} to #${list.at(-1).mesid}. Each section is one message: its number, who wrote it, [user | char | hidden: not sent to the model], the date.`;
    return `${head}\n\n${list.map(message => `${messageHeading(message)}\n${escapeHeadings(String(message.text ?? '').trim())}`).join('\n\n')}`;
}

/** Где в тексте страницы лежит каждое сообщение: `[{ mesid, name, role, start, end }]` — по заголовкам `## #N …`. */
export function parseMessageSpans(text) {
    const source = String(text ?? '');
    const heads = [...source.matchAll(/^## #(\d+) (.*?) \[(user|char|hidden)\]/gm)].map(match => ({ mesid: Number(match[1]), name: match[2], role: match[3], start: match.index }));
    return heads.map((head, index) => ({ ...head, end: heads[index + 1]?.start ?? source.length }));
}

/** Сообщение, в которое попадает смещение (результат поиска), либо `null` (шапка страницы). */
export function locateMessage(spans, offset) {
    return spans.find(span => offset >= span.start && offset < span.end) ?? null;
}

/**
 * Срез по номерам сообщений: `from`–`to` (включительно) либо `last` последних; не больше `chars` знаков (сообщение целиком; только первое режется само, если одно больше предела). Возвращает `{ text, from, to, count, total, next, cutOffset }`; `next` — номер сообщения, с которого читать дальше (`null` — больше нет в этом срезе), `cutOffset` — смещение, с которого читать остаток слишком длинного сообщения.
 */
export function sliceMessages(text, spans, { from, to, last, chars = CHAT_READ_DEFAULT_CHARS } = {}) {
    const limit = Math.min(Math.max(Math.floor(Number(chars)) || CHAT_READ_DEFAULT_CHARS, 300), CHAT_READ_MAX_CHARS);
    let picked;
    if (last !== undefined && last !== null && last !== '') {
        const count = Math.min(Math.max(Math.floor(Number(last)) || LAST_DEFAULT, 1), LAST_MAX);
        picked = spans.slice(-count);
    } else {
        const low = from === undefined || from === null || from === '' ? (spans[0]?.mesid ?? 0) : Math.floor(Number(from));
        const high = to === undefined || to === null || to === '' ? Infinity : Math.floor(Number(to));
        if (!Number.isFinite(low) || Number.isNaN(high)) return { text: '', from: null, to: null, count: 0, total: spans.length, next: null };
        picked = spans.filter(span => span.mesid >= low && span.mesid <= high);
    }
    const parts = [];
    let used = 0;
    let next = null;
    let cutOffset = null;
    for (const [index, span] of picked.entries()) {
        const body = text.slice(span.start, span.end).trimEnd();
        if (!parts.length && body.length > limit) {
            // Одно сообщение больше предела: берётся начало, а остаток читается по смещению (`web.page` с `offset`).
            parts.push(`${body.slice(0, limit)}\n[message #${span.mesid} is cut: ${body.length} characters in all]`);
            cutOffset = span.start + limit;
            next = picked[index + 1]?.mesid ?? null;
            break;
        }
        if (parts.length && used + body.length > limit) { next = span.mesid; break; }
        parts.push(body);
        used += body.length;
    }
    const lastShown = picked[parts.length - 1];
    return { text: parts.join('\n\n'), from: picked[0]?.mesid ?? null, to: lastShown?.mesid ?? null, count: parts.length, total: spans.length, next, cutOffset };
}

/** Обзор открытого чата для ответа гиду: кто пишет, сколько, диапазон, первое и последнее сообщения одной строкой, как читать дальше. */
export function describeChatOpening({ id, title, messages, chars, live }) {
    const list = messages ?? [];
    const speakers = [...new Set(list.map(message => oneLine(message.name)).filter(Boolean))].slice(0, 6);
    const hidden = list.filter(message => message.isSystem).length;
    const glance = message => `#${message.mesid} ${oneLine(message.name) || '—'}: ${cut(message.text, GLANCE_CHARS)}`;
    const first = list[0];
    const last = list.at(-1);
    return [
        `Chat ${id} — “${title}”${live ? ' (the chat open in SillyTavern right now)' : ''}: ${list.length} message${list.length === 1 ? '' : 's'} (#${first?.mesid}–#${last?.mesid}), ${chars} characters${hidden ? `, ${hidden} hidden` : ''}. Speakers: ${speakers.join(', ') || 'none'}.`,
        first ? `First: ${glance(first)}` : '',
        last && last !== first ? `Last: ${glance(last)}` : '',
        `Read it with chat.read {"id": "${id}", "last": 10} (the latest), {"id": "${id}", "from": 40, "to": 55} (by message number) and look for things with chat.find {"id": "${id}", "query": "…"} (by words and by meaning).`,
    ].filter(Boolean).join('\n');
}
