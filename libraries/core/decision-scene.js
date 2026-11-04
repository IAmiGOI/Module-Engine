/**
 * «Что сейчас» — без модели, из последней принятой формы хода: место, время,
 * чем кончился ход, кто в сцене и что каждый делал последним. Директору и
 * писателю это даётся готовой строкой, чтобы они не собирали положение сцены
 * заново из сжатых ходов (и не путались, кто где стоит и кто ушёл).
 */
const text = value => String(value ?? '').trim();

// Уход — только когда персонаж подлежащее и рядом глагол ухода: «Diethard… walks off», «Felt is gone into the crowd»,
// «X leaves the square», «X is out of sight». Голые слова («left behind», «leaving Sasha», «gone quiet», «Sasha
// leaves his quarter») давали ложные «ушёл», и директор каждый ход удалял и заново добавлял персонажа в ростер.
const LEAVE_PATTERNS = [
    String.raw`[^.;!?—]{0,80}?\b(?:walks|walked|runs|ran|slips|slipped|storms|stormed|heads|headed|hurries|hurried|strides|strode|wanders|wandered)\s+(?:off|away|out)\b`,
    String.raw`[^.;!?—]{0,60}?\s(?:has\s+|had\s+)?(?:left|leaves|departs|departed)\s+(?:the|for|through|without|again)\b`,
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

/** Блок CURRENT SCENE. Без принятых ходов — пусто. */
export function renderCurrentScene({ form = null, roster = [], user = '', clock = '' } = {}) {
    if (!form) return '';
    const place = text(form.meta?.place) || text(form.scene?.place);
    const when = text(form.meta?.timeAfter) || text(clock);
    const characters = Array.isArray(form.characters) ? form.characters : [];
    const acting = characters.filter(character => character?.idle !== true && text(character?.name));
    const idle = characters.filter(character => character?.idle === true).map(character => text(character.name)).filter(Boolean);
    const present = (Array.isArray(roster) ? roster : []).map(text).filter(Boolean);
    const departed = departedFrom(form.resolution, present, { user });
    const lines = ['CURRENT SCENE (where the previous turn left things — start from here):'];
    if (place) lines.push(`- Place: ${place}.`);
    if (when) lines.push(`- Time: ${when}.`);
    if (text(form.resolution)) lines.push(`- How the previous turn ended: ${text(form.resolution)}`);
    if (text(form.userResult)) lines.push(`- ${text(user) || 'The user'}: ${text(form.userResult)}`);
    for (const character of acting) lines.push(`- ${text(character.name)} last: ${text(character.action) || text(character.decision) || 'present'}`);
    if (idle.length) lines.push(`- Present, doing nothing notable: ${idle.join(', ')}.`);
    if (present.length) lines.push(`- In the scene now (active roster): ${present.join(', ')}.`);
    if (departed.length) lines.push(`- Left the scene in that ending: ${departed.join(', ')}. Remove them with update_roster before you decide, unless they come back this turn with a reason.`);
    return lines.join('\n');
}
