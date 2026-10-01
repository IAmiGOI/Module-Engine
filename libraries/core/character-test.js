/**
 * Проверка карточки персонажа: чистые функции. Тест — короткая серия ходов «за {{user}}» в изолированном чате с этой карточкой на модели, на которой человек
 * играет; гид читает ответы и сверяет их с именованными правилами карточки. Здесь — проверка проб, история теста для сборки запроса и текст для гида.
 */

export const MAX_PROBES = 8;
const MAX_SAY_LENGTH = 600;
const MAX_RULE_LENGTH = 80;
export const REPLY_VIEW_CHARS = 3500;
export const CHAT_EXCERPT_MAX_MESSAGES = 12;
const CHAT_EXCERPT_MESSAGE_CHARS = 1800;

const cutText = (value, maxLength) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);

/** Пробы теста: `[{ rule, say }]` — что «скажет» {{user}} и какое правило карточки этим проверяется (необязательно). */
export function normalizeProbes(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: 'The test needs at least one probe: {"say": "what the user writes", "rule": "the rule it checks"}.' };
    if (list.length > MAX_PROBES) return { ok: false, error: `A test runs at most ${MAX_PROBES} probes — each one is a full generation.` };
    const probes = [];
    for (const [index, raw] of list.entries()) {
        const say = cutText(typeof raw === 'string' ? raw : raw?.say, MAX_SAY_LENGTH);
        if (!say) return { ok: false, error: `Probe ${index + 1} has nothing to say.` };
        probes.push({ rule: cutText(raw?.rule, MAX_RULE_LENGTH), say });
    }
    return { ok: true, value: probes };
}

/** Чат теста в родном виде ST (`mes`, `is_user`, `name`): приветствие карточки первым сообщением — так начинается настоящий чат. */
export function buildTestChat(card, userName, turns) {
    const chat = card.first_mes ? [{ name: card.name, is_user: false, mes: card.first_mes }] : [];
    for (const turn of turns) {
        chat.push({ name: userName, is_user: true, mes: turn.say });
        if (turn.reply !== undefined) chat.push({ name: card.name, is_user: false, mes: turn.reply });
    }
    return chat;
}

/** Результат теста для гида: кто и на чём отвечал, затем по пробе — что написано и что ответила модель (длинный ответ обрезается с пометкой). */
export function describeTestResult({ name, modelLabel, presetName, results }) {
    const header = `Test of “${name}” on ${modelLabel}, preset “${presetName}”, isolated chat (the card's first message, then the probes; no lorebook or memory of any open chat).`;
    const body = results.map((item, index) => {
        const reply = item.reply.length > REPLY_VIEW_CHARS ? `${item.reply.slice(0, REPLY_VIEW_CHARS)}\n[cut: ${item.reply.length} characters in all]` : item.reply;
        return `Probe ${index + 1}${item.rule ? ` — checks: ${item.rule}` : ''}\n{{user}}: ${item.say}\n${name}: ${reply || '(empty reply)'}`;
    });
    return [header, ...body].join('\n\n');
}

/** Какие сообщения чата идут в разбор: только реплики (не системные и не пустые), последние `CHAT_EXCERPT_MAX_MESSAGES`. */
export function selectExcerptMessages(messages) {
    return messages.filter(message => !message.isSystem && message.text.trim()).slice(-CHAT_EXCERPT_MAX_MESSAGES);
}

/** Последние сообщения настоящего чата для разбора, каждое обрезано, чтобы разбор не съел весь промпт. */
export function describeChatExcerpt({ name, messages }) {
    const shown = selectExcerptMessages(messages);
    const lines = shown.map(message => `${message.isUser ? '{{user}}' : message.name || name}: ${message.text.length > CHAT_EXCERPT_MESSAGE_CHARS ? `${message.text.slice(0, CHAT_EXCERPT_MESSAGE_CHARS)}\n[cut: ${message.text.length} characters in all]` : message.text}`);
    return `The last ${shown.length} messages of the open chat with “${name}” (oldest first):\n\n${lines.join('\n\n')}`;
}
