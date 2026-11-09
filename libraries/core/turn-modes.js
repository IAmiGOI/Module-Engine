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
        resolver: 'An everyday moment: nothing big is at stake. Keep the turn short; it is made of the small concrete things happening here.',
        writer: 'An everyday moment: plain, light prose and short exchanges.',
        fields: {},
    },
    {
        id: 'elder', label: 'Elder',
        when: 'an important talk: a confession, a hard truth, a decision about trust',
        resolver: 'An important talk: what is said here can change how the characters see each other. Track what each one takes from it and what it changes for them.',
        writer: 'A weighty talk: give each line room on the page; the pace slows around what is said.',
        fields: { view_of: 'how they see the speaker' },
    },
    {
        id: 'merchant', label: 'Merchant',
        when: 'trade or a deal: goods, services, payment, terms',
        resolver: 'A deal is on the table. Track what is offered, on what terms, what each side really has and controls — a character offers and promises only what their bank says they have — and what each wants from it. The deal can move by agreement, a counter-demand, a refusal, a test or a delay.',
        writer: 'A deal: the terms, sums and conditions are written as the characters say them; the prose stays concrete.',
        fields: { deal: 'what is being dealt and on what terms', stake: 'what they want from the deal' },
    },
    {
        id: 'king', label: 'King',
        when: 'politics: power, factions, leverage, alliances',
        resolver: 'Power is in play: track who holds which position, what each can bring to bear, and what of this reaches beyond the room. A large matter is rarely settled in a single turn.',
        writer: 'Politics: carried in subtext — the narration does not explain who holds the advantage.',
        fields: { stake: 'what their side wants from the others' },
    },
    {
        id: 'warrior', label: 'Warrior',
        when: 'a fight, a chase or direct danger',
        resolver: 'Danger. Roll every attempt that can fail; track positions, wounds and who can see whom. Things happen fast and in order.',
        writer: 'Danger: short, sharp sentences, physical and immediate, with no reflection in the middle of the action.',
        fields: { position: 'where they are relative to the others', condition: 'what shape they are in' },
    },
    {
        id: 'hunter', label: 'Hunter',
        when: 'stealth, searching, following someone or investigating',
        resolver: 'A search or stealth. Roll noticing and hiding; decide what is found and what is missed, and what the searched-for does meanwhile.',
        writer: 'A search or stealth: the narration follows traces and details — what is noticed and what slips past.',
        fields: { aware_of: 'whom and what they have noticed' },
    },
    {
        id: 'artist', label: 'Artist',
        when: 'a place or moment that should be shown: arriving somewhere new, a view, a striking change of scene',
        resolver: 'A moment to be shown: a place or a change of scene matters this turn. Decide what is there and what draws the eye first.',
        writer: 'A moment to be shown: describe the place or the moment, choosing which details the eye falls on first and which stay with it.',
        fields: { focus: 'what the eye lingers on' },
    },
    {
        id: 'bard', label: 'Bard',
        when: 'a warm, close, quiet scene between people',
        resolver: 'A warm, close scene: what the people here feel for each other is what this turn is about; there is no hurry to move the plot.',
        writer: 'A warm, close moment: slow, sensory narration, with weight in what goes unsaid.',
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
    return `THIS TURN — ${modes.map(mode => mode.label).join(' + ')}:\n${modes.map(mode => `- ${mode.resolver}`).join('\n')}\nThis tells you what kind of moment the scene is and what to keep track of in it — never how anyone behaves. How each character acts and speaks in it comes from their own bank and Decree alone.${form}`;
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
