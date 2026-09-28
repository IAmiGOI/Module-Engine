/**
 * Текст, который граф памяти отдаёт на извлечение фактов (MEMORY_GRAPH_FIX_PLAN.md, Этап 1; ROADMAP 5.107а). Раньше
 * `extractLatestText()` в `index.js` брало только `chat[chat.length - 1].mes` — на `generation.prepare` последнее
 * сообщение это ВСЕГДА новая реплика ИГРОКА, ответ модели (где обычно и появляются факты мира: она называет место,
 * представляет персонажа, раскрывает сюжетный поворот) в извлечение не попадал никогда. `extractRecentText()`
 * заменяет его — берёт хвост чата, а не одно сообщение.
 */

const HTML_TAG = /<[^>]+>/g;
const WHITESPACE = /\s+/g;

function cleanText(mes) {
    return String(mes ?? '').replace(HTML_TAG, '').replace(WHITESPACE, ' ').trim();
}

function speakerOf(message) {
    return message?.name ?? (message?.is_user ? 'User' : 'Character');
}

/**
 * Последние `count` сообщений чата как `Имя: текст`, в порядке чата, склеенные пустой строкой. Системные сообщения
 * (`is_system === true` — наши же вставки вроде sticky-инъекции графа, см. `injectIntoPrompt()`) пропускаются: это
 * не часть сцены, а служебный шум, извлекать из него нечего. Если результат длиннее `maxChars` — отрезаем НАЧАЛО, не
 * конец: свежее важнее, и последняя реплика (обычно самая релевантная) должна уцелеть целиком.
 */
export function extractRecentText(chat, { count = 4, maxChars = 3000 } = {}) {
    if (!Array.isArray(chat) || !chat.length) return '';
    const lines = chat.slice(-count)
        .filter(message => message?.is_system !== true)
        .map(message => `${speakerOf(message)}: ${cleanText(message?.mes)}`);
    const text = lines.join('\n\n');
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
