/**
 * Режимы хода — чистые данные и правила, без модели (DIRECTOR-SPEC «Режимы хода»). Перед ходом выбирается
 * 1–2 режима; каждый кладёт короткий блок рядом с заданием Resolver, решает, есть ли на ходу броски, и даёт
 * указание Писателю. Режим определяется тем, что он меняет, а не темой. Источник выбора сменный: сейчас —
 * короткий запрос к воркеру Resolver, потом — локальная модель DataGen; формат ответа один: режим → 0…1.
 */

const text = value => String(value ?? '').trim();

export const TURN_MODES = Object.freeze([
    {
        id: 'peasant', label: 'Peasant', rolls: 'explicit',
        when: 'everyday life: nothing important is at stake',
        resolver: 'An ordinary moment. Keep the turn short and alive: small concrete things people do, no forced drama.',
        writer: 'Plain and lively: everyday texture, short exchanges.',
    },
    {
        id: 'elder', label: 'Elder', rolls: 'no',
        when: 'an important talk: a confession, a hard truth, a decision about trust',
        resolver: 'An important talk. Each character answers the meaning of what was said, and their view of the speaker can change this turn — trust gained or lost, a mind changed.',
        writer: 'Weighty: let lines land, leave pauses, show what it costs them to speak.',
    },
    {
        id: 'merchant', label: 'Merchant', rolls: 'no',
        when: 'trade or a deal: goods, services, payment, terms',
        resolver: 'A deal. A character offers and promises only what their bank says they have and control. The other side weighs what they gain against what they risk, believes nothing they cannot check, and has their own interest. Moving forward can be a counter-demand, a refusal, a test or a delay — not only agreement.',
        writer: 'Concrete: terms, sums and conditions as the characters would say them; hesitation shows in hands and eyes.',
    },
    {
        id: 'king', label: 'King', rolls: 'no',
        when: 'politics: power, factions, leverage, alliances',
        resolver: 'Politics. Every side has a position, a price and consequences beyond this room. Nothing big is settled in a single turn; words are moves, and each move is answered with a move.',
        writer: 'Subtext and the balance of power: who holds the advantage shows in posture and silence.',
    },
    {
        id: 'warrior', label: 'Warrior', rolls: 'yes',
        when: 'a fight, a chase or direct danger',
        resolver: 'Danger. Roll every attempt that can fail; track positions, wounds and who can see whom. Things happen fast and in order.',
        writer: 'Short, sharp sentences; physical and immediate; no reflection mid-action.',
    },
    {
        id: 'hunter', label: 'Hunter', rolls: 'yes',
        when: 'stealth, searching, following someone or investigating',
        resolver: 'A search or stealth. Roll noticing and hiding; decide what is found and what is missed, and what the searched-for does meanwhile.',
        writer: 'Traces and details; held breath; what is noticed and what slips past.',
    },
    {
        id: 'artist', label: 'Artist', rolls: 'explicit',
        when: 'a place or moment that should be shown: arriving somewhere new, a view, a striking change of scene',
        resolver: 'A moment to be shown. Do not rush the turn; choose what the eye falls on first and what it lingers on.',
        writer: 'Descriptive: show the place or the moment; choose the details of focus — what is seen first, what stays.',
    },
    {
        id: 'bard', label: 'Bard', rolls: 'no',
        when: 'a warm, close, quiet scene between people',
        resolver: 'A warm, close scene. Slow down; no hurry to move the plot — small gestures and what people feel for each other are the turn.',
        writer: 'Slow and sensory; closeness in small gestures; quiet between the lines.',
    },
]);

export const MODE_IDS = Object.freeze(TURN_MODES.map(mode => mode.id));
const byId = id => TURN_MODES.find(mode => mode.id === text(id).toLowerCase()) ?? null;

/** Сцена для выбора режима — как в DataGen: последние сообщения, «User:» / «Character:», не длиннее 1800 символов. */
export function modeScene(chat, { limit = 1800, count = 3 } = {}) {
    const messages = (Array.isArray(chat) ? chat : []).filter(entry => text(entry?.mes ?? entry?.content)).slice(-count);
    const lines = messages.map(entry => `${entry?.is_user ? 'User' : 'Character'}: ${text(entry?.mes ?? entry?.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
    let scene = lines.join('\n');
    if (scene.length > limit) scene = scene.slice(scene.length - limit);
    return scene;
}

/** Задание выборщику режимов: описания и формат ответа. */
export function modePrompt() {
    return [
        'You label one turn of a roleplay with its modes. Read the scene — above all the last User message — and rate how well each mode fits this turn, from 0 to 1.',
        '',
        ...TURN_MODES.map(mode => `- ${mode.id}: ${mode.when}`),
        '',
        'Answer with JSON only, every mode once: {"peasant": 0.1, "elder": 0.0, ...}',
    ].join('\n');
}

/** Ответ модели → { режим: 0…1 }. Не разобрали — пусто. */
export function parseModeAnswer(answer) {
    const raw = text(answer?.text ?? answer);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return {};
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const out = {};
        for (const id of MODE_IDS) {
            const value = Number(parsed?.[id]);
            if (Number.isFinite(value)) out[id] = Math.min(1, Math.max(0, value));
        }
        return out;
    } catch { return {}; }
}

/** 1–2 режима: лучший, если уверен, и второй, если тоже уверен; никто не уверен — Peasant. */
export function chooseModes(answers, { threshold = 0.5, second = 0.5 } = {}) {
    const ranked = Object.entries(answers ?? {}).filter(([id]) => byId(id)).sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < threshold) return ['peasant'];
    const chosen = [ranked[0][0]];
    if (ranked[1] && ranked[1][1] >= second) chosen.push(ranked[1][0]);
    return chosen;
}

/** Есть ли на этом ходу броски: «да» у любого режима — да; «только явные» — да; все «нет» — инструмента броска нет. */
export function modesAllowRolls(ids) {
    const modes = (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean);
    if (!modes.length) return true;
    return modes.some(mode => mode.rolls !== 'no');
}

/** Блок рядом с заданием Resolver. */
export function resolverModeBlock(ids) {
    const modes = (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean);
    if (!modes.length) return '';
    const rolls = modesAllowRolls(ids) ? '' : '\nNothing is rolled this turn.';
    return `THIS TURN — ${modes.map(mode => mode.label).join(' + ')}:\n${modes.map(mode => `- ${mode.resolver}`).join('\n')}${rolls}`;
}

/** Строка для Писателя — в Inscription. */
export function writerModeLine(ids) {
    const modes = (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean);
    if (!modes.length) return '';
    return `HOW THIS TURN READS (${modes.map(mode => mode.label).join(' + ')}): ${modes.map(mode => mode.writer).join(' ')}`;
}
