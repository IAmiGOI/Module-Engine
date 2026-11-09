/**
 * «Что сейчас» — без модели, из последней принятой формы хода: место, время,
 * чем кончился ход, кто в сцене и что каждый делал последним. Директору и
 * писателю это даётся готовой строкой, чтобы они не собирали положение сцены
 * заново из сжатых ходов (и не путались, кто где стоит и кто ушёл).
 */
const text = value => String(value ?? '').trim();

// Уход — только когда персонаж подлежащее и рядом глагол ухода: «Diethard… walks off», «Felt is gone into the crowd»,
// «X is out of sight». «leaves» не считаем вовсе: «leaves the plate and comes closer» — не уход. Голые слова («left behind», «leaving Sasha», «gone quiet», «Sasha
// leaves his quarter») давали ложные «ушёл», и директор каждый ход удалял и заново добавлял персонажа в ростер.
const LEAVE_PATTERNS = [
    String.raw`[^.;!?—]{0,80}?\b(?:walks|walked|runs|ran|slips|slipped|storms|stormed|heads|headed|hurries|hurried|strides|strode|wanders|wandered)\s+(?:off|away)\b(?!\s+(?:the|a|an|his|her|their|its|of|with)\b)`,
    String.raw`[^.;!?—]{0,60}?\s(?:departs|departed)\b`,
    String.raw`[^.;!?—]{0,60}?\b(?:vanishes|vanished|disappears|disappeared)\b`,
    String.raw`[^.;!?—]{0,60}?\s(?:is|was|has|had)\s+(?:already\s+)?gone\b(?=\s*(?:[.,;!?—]|$|into\b|from\b|down\b|off\b|out\b|through\b))`,
    String.raw`[^.;!?—]{0,60}?\bout of sight\b`,
];

function sentences(value) {
    return text(value).split(/(?<=[.!?;])\s+/).map(text).filter(Boolean);
}

function escape(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Кто из ростера, судя по исходу прошлого хода, ушёл из сцены. */
export function departedFrom(resolution, roster = [], { user = '' } = {}) {
    const list = (Array.isArray(roster) ? roster : []).map(text).filter(name => name && name.toLowerCase() !== text(user).toLowerCase());
    const everyone = [...list, text(user)].filter(Boolean);
    const out = [];
    for (const sentence of sentences(resolution)) {
        for (const name of list) {
            const first = name.split(/\s+/)[0];
            const labels = [...new Set([name, ...(first.length >= 3 ? [first] : [])])];
            const hit = labels.some(label => LEAVE_PATTERNS.some(pattern => {
                const match = new RegExp(`\\b${escape(label)}\\b(${pattern})`, 'i').exec(sentence);
                if (!match) return false;
                // «Emilia's smile disappears» — исчезает не она.
                if (/^['’]s\b/i.test(match[1])) return false;
                // Между именем и глаголом не должно стоять другое имя: «Felt…, leaving Sasha» — это не уход Саши.
                const between = match[1];
                return !everyone.some(other => other !== name && new RegExp(`\\b${escape(other.split(/\s+/)[0])}\\b`, 'i').test(between));
            }));
            if (hit && !out.includes(name)) out.push(name);
        }
    }
    return out;
}

/** Последняя принятая форма хода из журнала директора (не отвергнутая). */
export function lastAcceptedForm(cycles, { beforeTurn = null } = {}) {
    const list = Array.isArray(cycles) ? cycles : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const cycle = list[index];
        if (!['turn', 'regenerate', 'swipe'].includes(cycle?.event) || cycle?.rejected) continue;
        // Только ходы раньше текущего: сам текущий (и его отброшенные попытки) — не «где мы были».
        if (Number.isFinite(beforeTurn) && !(Number(cycle.turn) < beforeTurn)) continue;
        if (cycle?.form && typeof cycle.form === 'object') return cycle.form;
    }
    return null;
}

/**
 * Блок CURRENT SCENE. Без принятых ходов — пусто. Всё механическое движок решает сам и подаёт как данность:
 * кто здесь, кто в стороне, кто ушёл. Резолвер раньше тратил ризонинг на «Puck idle? он в ростере, но занят
 * внизу…» — противоречивые строки сцены звали его спорить с ней; теперь у каждого одно место.
 */
export function renderCurrentScene({ form = null, roster = [], user = '', clock = '' } = {}) {
    if (!form) return '';
    const place = text(form.meta?.place) || text(form.scene?.place);
    const when = text(form.meta?.timeAfter) || text(clock);
    const characters = Array.isArray(form.characters) ? form.characters : [];
    const present = (Array.isArray(roster) ? roster : []).map(text).filter(Boolean);
    const departed = departedFrom(form.resolution, present, { user });
    const here = present.filter(name => !departed.some(gone => gone.toLowerCase() === name.toLowerCase()));
    const entryOf = name => characters.find(character => text(character?.name).toLowerCase() === name.toLowerCase()) ?? null;
    const lines = ['CURRENT SCENE (settled by the engine — take it as given and start from here):'];
    if (place) lines.push(`- Place: ${place}.`);
    if (when) lines.push(`- Time: ${when}.`);
    if (text(form.resolution)) lines.push(`- How the previous turn ended: ${text(form.resolution)}`);
    if (text(form.userResult)) lines.push(`- ${text(user) || 'The user'}: ${text(form.userResult)}`);
    const acting = here.filter(name => entryOf(name) && entryOf(name).idle !== true);
    const background = here.filter(name => !acting.includes(name));
    if (acting.length) {
        lines.push(`- Here with ${text(user) || 'the user'}:`);
        for (const name of acting) {
            const entry = entryOf(name);
            lines.push(`  - ${name} — last: ${text(entry.action) || 'present'}${text(entry.decision) ? `; aim: ${text(entry.decision)}` : ''}`);
        }
    }
    if (background.length) {
        lines.push(`- Here in the background, on their own: ${background.map(name => (text(entryOf(name)?.busy) ? `${name} (${text(entryOf(name).busy)})` : name)).join(', ')}.`);
    }
    if (departed.length) lines.push(`- Gone in that ending: ${departed.join(', ')}. They are not part of this turn unless they come back with a reason.`);
    return lines.join('\n');
}

/**
 * ALREADY SAID — что каждый говорил и просил в последних принятых ходах (смыслом, из формы). Правило
 * «не повторяться» без этого держалось на памяти модели; со списком следующий шаг сверяется с ним.
 */
export function renderAlreadySaid(cycles, { beforeTurn = null, turns = 3, user = '' } = {}) {
    const list = Array.isArray(cycles) ? cycles : [];
    const forms = [];
    for (let index = list.length - 1; index >= 0 && forms.length < turns; index -= 1) {
        const cycle = list[index];
        if (!['turn', 'regenerate', 'swipe'].includes(cycle?.event) || cycle?.rejected || !cycle?.form) continue;
        if (Number.isFinite(beforeTurn) && !(Number(cycle.turn) < beforeTurn)) continue;
        if (forms.some(item => item.turn === cycle.turn)) continue;
        forms.unshift({ turn: cycle.turn, form: cycle.form });
    }
    const said = new Map();
    for (const { turn, form } of forms) {
        for (const character of Array.isArray(form.characters) ? form.characters : []) {
            const name = text(character?.name), line = text(character?.says).replace(/^(none|null|n\/a|nothing|-+|—)\.?$/i, '');
            if (!name || !line || name.toLowerCase() === text(user).toLowerCase()) continue;
            if (!said.has(name)) said.set(name, []);
            said.get(name).push(`(turn ${turn}) ${line}`);
        }
    }
    if (!said.size) return '';
    const lines = ['ALREADY SAID (the last turns, in meaning — none of this is said or asked again; build on it):'];
    for (const [name, items] of said) lines.push(`- ${name}:\n${items.map(item => `  - ${item}`).join('\n')}`);
    return lines.join('\n');
}
