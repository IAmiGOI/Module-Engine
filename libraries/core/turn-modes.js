/**
 * Режимы хода — чистые данные и правила, без модели (DIRECTOR-SPEC «Режимы хода»). Перед ходом выбирается
 * 1–2 режима; каждый кладёт короткий блок рядом с заданием Resolver и даёт указание Писателю. Броски режим
 * не запрещает: попытка, которая может сорваться, бросается всегда (кислород в «политическом» ходу шёл без броска). Поля формы режима делятся на `real` (правда, Писателю не видна) и `lens` (что видно нашими глазами). Режим определяется тем, что он меняет, а не темой. Источник выбора сменный: сейчас —
 * короткий запрос к воркеру Resolver, потом — локальная модель DataGen; формат ответа один: режим → 0…1.
 */

const text = value => String(value ?? '').trim();

export const TURN_MODES = Object.freeze([
    {
        id: 'peasant', label: 'Peasant',
        when: 'everyday life: nothing important is at stake',
        resolver: 'An ordinary moment. Keep the turn short and alive: small concrete things people do, no forced drama.',
        writer: 'This is an everyday moment: keep it plain and lively, with everyday texture and short exchanges.',
        fields: {},
    },
    {
        id: 'elder', label: 'Elder',
        when: 'an important talk: a confession, a hard truth, a decision about trust',
        resolver: 'An important talk, where who each character is decides everything. Before what they say, take who they are from their bank: what they value, how they show or hide feeling, how they speak, what makes them shy, proud or afraid. Each answers in that way — with their own measure of openness, hesitation and courage — not in the plain, direct way the words alone might call for. What is said can change how they see the speaker.',
        writer: 'This is a weighty talk: let each line land and leave room after it, give each character the voice their bank describes, and show what speaking costs them.',
        fields: { view_of: 'how they see the speaker' },
    },
    {
        id: 'merchant', label: 'Merchant',
        when: 'trade or a deal: goods, services, payment, terms',
        resolver: 'A deal. A character offers and promises only what their bank says they have and control. The other side weighs what they gain against what they risk, believes nothing they cannot check, and has their own interest. Moving forward can be a counter-demand, a refusal, a test or a delay — not only agreement.',
        writer: 'This is a deal: give terms, sums and conditions as the characters would actually say them, and let hesitation show in what they do, not in what they say about it.',
        fields: { deal: 'what is being dealt and on what terms', stake: 'what they want from the deal' },
    },
    {
        id: 'king', label: 'King',
        when: 'politics: power, factions, leverage, alliances',
        resolver: 'Politics. Every side has a position, a price and consequences beyond this room. Nothing big is settled in a single turn; words are moves, and each move is answered with a move.',
        writer: 'This is politics: carry it in subtext — who holds the advantage shows in how people hold themselves and in what they leave unsaid, not in explanation.',
        fields: { stake: 'what their side wants from the others' },
    },
    {
        id: 'warrior', label: 'Warrior',
        when: 'a fight, a chase or direct danger',
        resolver: 'Danger. Roll every attempt that can fail; track positions, wounds and who can see whom. Things happen fast and in order.',
        writer: 'This is danger: short, sharp sentences, physical and immediate, with no reflection in the middle of the action.',
        fields: { position: 'where they are relative to the others', condition: 'what shape they are in' },
    },
    {
        id: 'hunter', label: 'Hunter',
        when: 'stealth, searching, following someone or investigating',
        resolver: 'A search or stealth. Roll noticing and hiding; decide what is found and what is missed, and what the searched-for does meanwhile.',
        writer: 'This is a search or stealth: give traces and details, the tension of keeping still, and what is noticed against what slips past.',
        fields: { aware_of: 'whom and what they have noticed' },
    },
    {
        id: 'artist', label: 'Artist',
        when: 'a place or moment that should be shown: arriving somewhere new, a view, a striking change of scene',
        resolver: 'A moment to be shown. Do not rush the turn; choose what the eye falls on first and what it lingers on.',
        writer: 'This is a moment to be shown: describe the place or the moment, choosing which details the eye falls on first and which stay with it.',
        fields: { focus: 'what the eye lingers on' },
    },
    {
        id: 'bard', label: 'Bard',
        when: 'a warm, close, quiet scene between people',
        resolver: 'A warm, close scene. Slow down; no hurry to move the plot — small gestures and what people feel for each other are the turn.',
        writer: 'This is a warm, close moment: write it slow and sensory, with closeness in small gestures and weight in what goes unsaid.',
        fields: { toward: 'what they feel toward the other', closeness: 'how close they would let the other come' },
    },
]);

/** Как заполнять форму режима — самодостаточно: модель не знает нашего обсуждения real/lens. */
const MODE_FORM_HEAD = 'THE MODE FORM: for every character who acts, also fill "mode". Its fields describe where the character stands in this kind of scene — their state at this moment, not what they do this turn and not how the turn ends; deeds and words stay in does, says and beats. Each field is {"real": …, "lens": …}. The fields for this turn:';
const MODE_FORM_HALVES = [
    'real — the truth of it as the character holds it: what they actually intend, want, have or feel, including what they keep to themselves. The Writer never sees it; it is kept for the next turns, so that what is hidden stays consistent.',
    'lens — what someone else can actually see and understand of it right now, from what the character does this turn. Only what is plainly visible — never an interpretation of it, never a narrator\'s label for who the character is. It shows through the character\'s own manner and the ways of their culture, as their bank and the Creation describe them. It is not a clue planted for the user: if the truth does not show, the lens holds only the surface. How much shows depends on how closely the user looks in their latest message: a passing glance gives only the obvious, watching for a while gives a little more, studying one detail gives more still. A state that simply continues from before has already been seen; the lens is what this turn\'s action adds to it.',
    'Fill both halves, even when they are the same.',
].join('\n');

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

/**
 * Контраст: сцена резко сменила характер. Оценки режимов этого хода сравниваются с прошлым принятым ходом
 * (косинус векторов 0…1 по восьми режимам); ниже порога и без общего выбранного режима — поворот.
 * Без оценок с одной из сторон — не судим.
 */
export function modeContrast(previous, current, { threshold = 0.35 } = {}) {
    const vector = answers => MODE_IDS.map(id => Number(answers?.[id]) || 0);
    const a = vector(previous), b = vector(current);
    const norm = list => Math.sqrt(list.reduce((sum, value) => sum + value * value, 0));
    if (!norm(a) || !norm(b)) return null;
    const cosine = a.reduce((sum, value, index) => sum + value * b[index], 0) / (norm(a) * norm(b));
    const from = chooseModes(previous), to = chooseModes(current);
    if (cosine >= threshold || from.some(id => to.includes(id))) return null;
    return { from, to, similarity: Math.round(cosine * 100) / 100 };
}

const labels = ids => (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean).map(mode => `${mode.label} (${mode.when})`).join(' + ');

/** Резолверу: сцена повернула — прошлое настроение не ведёт этот ход. */
export function resolverContrastBlock(contrast) {
    if (!contrast) return '';
    return `THE SCENE TURNS: the last turn was ${labels(contrast.from)}; this one is ${labels(contrast.to)}. The mood of what came before no longer holds and does not lead this turn. Decide it from what has just changed, at the pace this new moment has.`;
}

/** Писателю: тон, темп и ритм прошлых ответов не переносятся. */
export function writerContrastLine(contrast) {
    if (!contrast) return '';
    return `THE SCENE TURNS: the last reply was ${labels(contrast.from)}; this one is ${labels(contrast.to)}. Write it in its own tone, pace and sentence rhythm. Nothing of the last replies' manner carries over — the change itself should be felt on the page.`;
}

/** Блок рядом с заданием Resolver. */
export function resolverModeBlock(ids) {
    const modes = (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean);
    if (!modes.length) return '';
    const fields = Object.entries(modeFields(ids));
    const form = fields.length
        ? `\n\n${MODE_FORM_HEAD}\n${fields.map(([name, about]) => `- ${name}: ${about}`).join('\n')}\n${MODE_FORM_HALVES}`
        : '';
    return `THIS TURN — ${modes.map(mode => mode.label).join(' + ')}:\n${modes.map(mode => `- ${mode.resolver}`).join('\n')}\nThis tells you what kind of moment the scene is, not who the people in it are: how each character behaves in it still comes from their own bank, never from the mode.${form}`;
}

/** Поля формы выбранных режимов: имя → что в нём. Общие у двух режимов (stake) — одно поле. */
export function modeFields(ids) {
    const out = {};
    for (const mode of (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean)) {
        for (const [name, about] of Object.entries(mode.fields ?? {})) if (!out[name]) out[name] = about;
    }
    return out;
}

/** Поле `mode` персонажа → только поля выбранных режимов, каждое { real, lens }; половину без пары дополняем второй. */
export function normalizeModeFields(value, ids) {
    const allowed = Object.keys(modeFields(ids));
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const name of allowed) {
        const field = value[name];
        const real = text(typeof field === 'object' ? field?.real : field);
        const lens = text(typeof field === 'object' ? field?.lens : field);
        if (real || lens) out[name] = { real: real || lens, lens: lens || real };
    }
    return out;
}

/** Строка для Писателя — в Inscription. */
export function writerModeLine(ids) {
    const modes = (Array.isArray(ids) ? ids : []).map(byId).filter(Boolean);
    if (!modes.length) return '';
    return `HOW THIS TURN READS (${modes.map(mode => mode.label).join(' + ')}): ${modes.map(mode => mode.writer).join(' ')}`;
}
