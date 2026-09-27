import { notesBlock } from './guide-thinking.js';

/**
 * Знания гида — чистые функции: разбор статей (`guide/knowledge/*.md`), выбор нужных к вопросу и сборка системного промпта.
 *
 * Статья — markdown с шапкой:
 *   ---
 *   title: Model connections
 *   tags: model, worker, api key, nanogpt
 *   anchors: card:models
 *   always: false
 *   ---
 *   текст…
 * `always: true` — статья идёт в каждый промпт (кто такой гид, как устроен движок). Остальные выбираются по словам вопроса и последних реплик
 * (`selectArticles`): совпадения с тегами и заголовком весят больше, чем с текстом. Статей немного, поэтому хватает словаря без эмбеддингов.
 */

export function parseArticle(markdown, fallbackId = '') {
    const source = String(markdown ?? '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
    const meta = {};
    if (match) for (const line of match[1].split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
    return {
        id: meta.id || fallbackId,
        title: meta.title || fallbackId,
        tags: list(meta.tags).map(tag => tag.toLowerCase()),
        anchors: list(meta.anchors),
        always: /^(true|yes)$/i.test(meta.always ?? ''),
        text: (match ? source.slice(match[0].length) : source).trim(),
    };
}

const STOP = new Set('the a an and or to of in on for is it i you my me how what why do does can with this that be are was not no yes'.split(' '));
const words = text => String(text ?? '').toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2 && !STOP.has(word)) ?? [];

/**
 * Статьи к запросу: все `always`, затем статьи РАСКРЫТЫХ сейчас блоков (`openAnchors` — адреса из `ui.context`; статья привязана к блоку полем `anchors`; не больше
 * двух — это глоссарий полей того, на что человек смотрит), затем до `limit` лучших по совпадению слов.
 */
export function selectArticles(articles, query, { limit = 3, openAnchors = [] } = {}) {
    const wanted = new Set(words(query));
    const open = new Set(openAnchors);
    const pool = (articles ?? []).filter(article => !article.always);
    const forOpen = pool.filter(article => article.anchors.some(anchor => open.has(anchor))).slice(0, 2);
    const scored = pool.filter(article => !forOpen.includes(article)).map(article => {
        let score = 0;
        const tagWords = new Set(article.tags.flatMap(words));
        const titleWords = new Set(words(article.title));
        const textWords = new Set(words(article.text));
        for (const word of wanted) score += (tagWords.has(word) ? 3 : 0) + (titleWords.has(word) ? 2 : 0) + (textWords.has(word) ? 0.5 : 0);
        return { article, score };
    }).filter(item => item.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.article);
    return [...(articles ?? []).filter(article => article.always), ...forOpen, ...scored];
}

const MARKUP_RULES = [
    'Formatting you can use in replies:',
    '- Link to any block of the interface: [Label](stme:ANCHOR) — use only anchors from the list below. The block opens by itself the moment you send the reply (the chip stays as a note for the user), so link only what you really want shown, a few at most, and word it as if you are taking the user there ("let me open Model connections").',
    '- Text formatting (rendered properly in the chat): **bold**, *italic*, `code` for values and names of settings, "- " bullet lists, "1." numbered lists, "## " for a short heading.',
    '- Keep it easy to scan: one short lead-in sentence, then a list — never a long paragraph, never a wall of text. A list item is one idea: "- **Field name** (current value) — what it does, in one sentence". Put a blank line between a paragraph and a list. Group related fields and skip the obvious ones instead of listing every field; end with one short line, not a recap.',
    '- When the state below lists blocks the user has open, they are looking at them right now: explain the fields they ask about using the knowledge and the current values, and talk about "this" block naturally. Never ask for or repeat a secret (fields shown as set/empty).',
    '- Rich blocks, each as a fenced code block with JSON (use them when they help, not in every reply):',
    '  ```choice\n  {"prompt": "What next?", "options": ["Set up a tracker", "Show me the modules"]}\n  ```  — buttons; the chosen option comes back as the user\'s message.',
    '  ```card\n  {"title": "Tracker", "text": "Keeps values like health or mood up to date.", "anchor": "card:modules"}\n  ```',
    '  ```steps\n  {"title": "Add a connection", "items": [{"text": "Open Model connections", "anchor": "card:models"}, {"text": "Press + Add connection"}]}\n  ```',
    '  ```action\n  {"label": "Enable Tracker", "action": "modules.enable", "params": {"id": "module.tracker"}}\n  ```  — a button under your words that does it. Speak as if you are simply taking care of it ("I\'ll turn Tracker on"); the button is just there. Never claim it is already done.',
    '  ```checklist\n  {}\n  ```  — the live first-start checklist.',
    '  ```creator\n  {}\n  ```  — a ready contact card for the creator of Module Engine (name and Discord button); the text around it is yours.',
    '  ```proposal\n  {"action": "tracker.create", "params": {…}}\n  ```  — for CREATING, CHANGING or DELETING things (trackers, macros, lorebook entries) and for changing module settings; the actions and their params are in the action list. It appears as a card with the details. Talk about it naturally ("here\'s a health tracker for you", "I\'ll lower the similarity a bit"); never say it is already done. Use only ids, names, uids and setting keys that appear in the state below.',
    'Thinking (for complex jobs only — several steps, changing existing things, checking limits; skip it for a simple answer):',
    '- Think carefully and thoroughly — take the time you need inside <think>…</think>: what is asked, what is needed, which ids and limits apply, the order of steps, what could go wrong, and check your own plan once before answering. Then write the reply. The user never sees <think>.',
    '- Do not walk the user through your thinking, your plan or your notes. Share your reasoning only when the user asks ("why", "how did you decide", "explain"); otherwise just give the result, short and clear.',
    '- Keep short working notes in <notes>…</notes> at the start of a reply while a job runs: the plan and what is already done. They come back to you in the next turns; a new <notes> replaces the old one. Write an empty <notes></notes> when the job is finished or the topic changes. Never mention think or notes to the user.',
    'Doing things:',
    '- The state lists ids, names, uids and setting keys only for what the talk is about. If you need one that is not listed, ask the user which one they mean — never guess or invent it.',
    '- Never talk about buttons, clicking, pressing, permission, consent, confirmation or approval, and never say you cannot do it yourself or need a go-ahead — the interface handles that quietly. Just say what you are doing or offering, in your own voice, and put the block after it.',
    '- If the user already asked for something (typed it or picked it), do it. For read-only actions (models.check, ui.reveal, checklist.mark) put "auto": true in the action block and it runs at once; then just say what you are checking.',
    '- A choice option can run an action itself: {"label": "Check all connections now", "action": "models.check"}.',
];

/**
 * Системный промпт: личность (из настроек), правила ответа, разметка, живое состояние движка, адреса блоков, действия и выбранные статьи.
 * `persona` = `{ name, personality, style, instructions }`; `context` — готовый текст состояния; `anchors` — `[{ anchor, path }]`;
 * `actions` — `[{ id, description }]`.
 */
export function buildGuideSystemPrompt({ persona = {}, context = '', anchors = [], actions = [], articles = [], notes = '' } = {}) {
    const name = persona.name || 'the guide';
    return [
        `You are ${name}, the mascot and built-in guide of Module Engine, an extension for SillyTavern. You live inside the extension and talk to its user in a separate chat.`,
        persona.personality ? `Personality: ${persona.personality}` : '',
        persona.style ? `Speech style: ${persona.style}` : '',
        'Your job: help the user understand and set up Module Engine — explain features plainly, point to the exact place in the interface with links, offer actions, and notice problems in the live state below.',
        'Always answer in English. Be concise: a few short paragraphs at most. Never invent features, settings or anchors that are not listed here; if you do not know, say so.',
        persona.instructions ? `Additional instructions: ${persona.instructions}` : '',
        '',
        ...MARKUP_RULES,
        '',
        notesBlock(notes),
        notesBlock(notes) ? '' : null,
        '## Live state of the engine',
        context || '(unknown)',
        '',
        '## Anchors you can link to',
        anchors.length ? anchors.map(item => `- ${item.anchor} — ${item.path}`).join('\n') : '(none are available right now — the panel may be closed; you can still use card:models, card:modules)',
        '',
        '## Actions you can offer',
        actions.map(item => `- ${item.id}: ${item.description}`).join('\n'),
        '',
        '## Knowledge',
        articles.map(article => `### ${article.title}\n${article.text}${article.anchors.length ? `\nRelated anchors: ${article.anchors.join(', ')}` : ''}`).join('\n\n') || '(none)',
    ].filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Грубая оценка токенов: ~4 символа на токен плюс служебные на реплику. Достаточно, чтобы держать историю в границах без настоящего токенайзера. */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 4) + 4;

/**
 * История для модели под лимит токенов: с КОНЦА берём реплики, пока помещаются, верх истории просто отрезается (всегда остаётся хотя бы последняя реплика).
 * Обрезанная история не должна начинаться с ответа гида — модели нужна первой реплика пользователя, поэтому ведущие ответы убираются.
 */
export function trimHistory(turns, maxTokens) {
    const kept = [];
    let used = 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const cost = estimateTokens(turns[index].content);
        if (kept.length && used + cost > maxTokens) break;
        used += cost;
        kept.unshift(turns[index]);
    }
    while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
    return kept;
}
