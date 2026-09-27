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

/** Статьи к запросу: все `always` плюс до `limit` лучших по совпадению слов. */
export function selectArticles(articles, query, { limit = 3 } = {}) {
    const wanted = new Set(words(query));
    const scored = (articles ?? []).filter(article => !article.always).map(article => {
        let score = 0;
        const tagWords = new Set(article.tags.flatMap(words));
        const titleWords = new Set(words(article.title));
        const textWords = new Set(words(article.text));
        for (const word of wanted) score += (tagWords.has(word) ? 3 : 0) + (titleWords.has(word) ? 2 : 0) + (textWords.has(word) ? 0.5 : 0);
        return { article, score };
    }).filter(item => item.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.article);
    return [...(articles ?? []).filter(article => article.always), ...scored];
}

const MARKUP_RULES = [
    'Formatting you can use in replies:',
    '- Link to any block of the interface: [Label](stme:ANCHOR) — use only anchors from the list below; the user clicks it and the block opens highlighted.',
    '- **bold** for emphasis. Keep paragraphs short.',
    '- Rich blocks, each as a fenced code block with JSON (use them when they help, not in every reply):',
    '  ```choice\n  {"prompt": "What next?", "options": ["Set up a tracker", "Show me the modules"]}\n  ```  — buttons; the chosen option comes back as the user\'s message.',
    '  ```card\n  {"title": "Tracker", "text": "Keeps values like health or mood up to date.", "anchor": "card:modules"}\n  ```',
    '  ```steps\n  {"title": "Add a connection", "items": [{"text": "Open Model connections", "anchor": "card:models"}, {"text": "Press + Add connection"}]}\n  ```',
    '  ```action\n  {"label": "Enable Tracker", "action": "modules.enable", "params": {"id": "module.tracker"}}\n  ```  — a button that does it; the user\'s click is the consent. Offer actions, never claim you already did them.',
    '  ```checklist\n  {}\n  ```  — the live first-start checklist.',
];

/**
 * Системный промпт: личность (из настроек), правила ответа, разметка, живое состояние движка, адреса блоков, действия и выбранные статьи.
 * `persona` = `{ name, personality, style, instructions }`; `context` — готовый текст состояния; `anchors` — `[{ anchor, path }]`;
 * `actions` — `[{ id, description }]`.
 */
export function buildGuideSystemPrompt({ persona = {}, context = '', anchors = [], actions = [], articles = [] } = {}) {
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
