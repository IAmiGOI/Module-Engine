/**
 * Аудит входов хода: чего не хватает ролям, прежде чем они начнут достраивать пустоту правдоподобно.
 * Каждая находка — строка для журнала хода и, один раз за чат, уведомление пользователю. Чистые функции.
 *
 * Найденное этой сессией: персонаж в сцене без Указа и с пустым нравом (Отто играли «осторожным купцом»),
 * у персонажа пользователя Указ (Директор писал ему планы), в окне сцены ходы новее текущего (удалённая ветка
 * читалась как прошлое), строка действия пользователя обрезана до буквы.
 */
import { findCharacter, isUserCharacter, normalizeGreatBank } from './decision-great-bank.js';

const text = value => String(value ?? '').trim();
const filled = part => Object.values(part ?? {}).some(lines => Array.isArray(lines) && lines.some(line => text(line)));

/** До хода: ростер против банков, персонаж пользователя, окно сцены. `{ key, message }` — key для «один раз за чат». */
export function auditTurnInputs({ greatBank = {}, roster = [], user = '', windowEntries = [], turn = null } = {}) {
    const bank = normalizeGreatBank(greatBank);
    const found = [];
    for (const name of Array.isArray(roster) ? roster : []) {
        if (!text(name) || text(name).toLowerCase() === text(user).toLowerCase()) continue;
        const character = findCharacter(bank, name);
        if (!character) {
            found.push({ key: `nobank:${name}`, message: `${name} is in the scene with no character bank at all — the Resolver plays them from the scene alone.` });
            continue;
        }
        if (isUserCharacter(character)) continue;
        const spirit = filled(character.spiritual) && character.sectionsReady !== false;
        const decree = filled(character.decree);
        if (!spirit && !decree) found.push({ key: `empty:${character.name}`, message: `${character.name} is in the scene with neither a written character (spiritual) nor a Decree — the Resolver has only their source card or nothing.` });
        else if (!decree && ['main', 'side'].includes(character.importance)) found.push({ key: `nodecree:${character.name}`, message: `${character.name} (${character.importance}) is in the scene without a Decree — no aim and no "when …, they …" lines; the Director has not written it.` });
        else if (spirit && !filled({ 3: character.spiritual?.[3], 5: character.spiritual?.[5] })) found.push({ key: `notemper:${character.name}`, message: `${character.name} has no emotional display or speech patterns in their bank — the Resolver cannot keep their voice.` });
    }
    for (const character of Object.values(bank)) {
        if (isUserCharacter(character) && filled(character.decree)) found.push({ key: `userdecree:${character.name}`, message: `${character.name} is the user's character but carries a Decree — it is ignored; the Director should not write one.` });
    }
    const numbers = (Array.isArray(windowEntries) ? windowEntries : []).filter(entry => entry?.kind === 'turn').map(entry => Number(entry.turn)).filter(Number.isFinite);
    if (Number.isFinite(Number(turn)) && numbers.some(number => number > Number(turn))) {
        found.push({ key: `window:${turn}`, message: `The scene window holds turns after this one (${Math.max(...numbers)} > ${turn}) — deleted turns may still be read as the past.` });
    }
    return found;
}
