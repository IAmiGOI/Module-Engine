/**
 * «Что сейчас» — без модели, из последней принятой формы хода: место, время,
 * чем кончился ход, кто в сцене и что каждый делал последним. Директору и
 * писателю это даётся готовой строкой, чтобы они не собирали положение сцены
 * заново из сжатых ходов (и не путались, кто где стоит и кто ушёл).
 */
const text = value => String(value ?? '').trim();

const LEAVE_WORDS = /\b(left|leaves|leaving|walks off|walked off|walks away|walked away|is gone|was gone|gone|out of sight|disappears|disappeared|vanishes|vanished|runs off|ran off|departs|departed|slips away|slipped away)\b/i;

function sentences(value) {
    return text(value).split(/(?<=[.!?;])\s+|\s+—\s+/).map(text).filter(Boolean);
}

function lastMention(sentence, name, before) {
    const full = text(name);
    if (!full) return -1;
    const first = full.split(/\s+/)[0];
    const patterns = [full, ...(first.length >= 3 ? [first] : [])].map(value => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
    let at = -1;
    for (const pattern of patterns) {
        for (const match of sentence.matchAll(pattern)) if (match.index < before && match.index > at) at = match.index;
    }
    return at;
}

/** Кто из ростера, судя по исходу прошлого хода, ушёл из сцены: ближайший названный перед словом ухода. */
export function departedFrom(resolution, roster = [], { user = '' } = {}) {
    const list = (Array.isArray(roster) ? roster : []).map(text).filter(name => name && name.toLowerCase() !== text(user).toLowerCase());
    const out = [];
    for (const sentence of sentences(resolution)) {
        for (const leave of sentence.matchAll(new RegExp(LEAVE_WORDS.source, 'gi'))) {
            let best = null;
            let bestAt = -1;
            for (const name of list) {
                const at = lastMention(sentence, name, leave.index);
                if (at > bestAt) { bestAt = at; best = name; }
            }
            if (best && leave.index - bestAt <= 150 && !out.includes(best)) out.push(best);
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
