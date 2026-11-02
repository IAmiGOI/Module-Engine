/**
 * Push — то, что прозаик получает вместо решения директора. Движок собирает
 * его сам из формы: место, время, развязка, результат действия пользователя,
 * строки персонажей со словами степени. Причины остаются подтекстом — их
 * прозаик не проговаривает (это правило его промпта).
 */

function line(value) {
    return String(value ?? '').trim();
}

/** Действие и причина — часть одной фразы: точка в конце сделала бы «… — слова.» с двойной пунктуацией. */
function phrase(value) {
    return line(value).replace(/[.;:,]+$/, '');
}

function minutesLabel(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return 'This turn took no measurable time.';
    const rounded = Math.round(value);
    return `This turn took ${rounded} minute${rounded === 1 ? '' : 's'}.`;
}

function assessmentOf(assessments, id) {
    if (assessments instanceof Map) return assessments.get(id) ?? null;
    return assessments?.[id] ?? null;
}

/**
 * @param {{ form: object, assessments?: Map|object, place?: string, timeBefore?: string, timeAfter?: string }} input
 * @returns {string}
 */
export function buildPush({ form, assessments = new Map(), place = '', timeBefore = '', timeAfter = '' } = {}) {
    const lines = [minutesLabel(form?.scene?.minutes)];
    const where = line(place) || line(form?.scene?.place);
    if (where) lines.push(`Place: ${where}.`);
    const when = line(timeAfter) || line(timeBefore);
    if (when) lines.push(`Time: ${when}.`);
    lines.push(`Resolution: ${line(form?.resolution)}`);
    lines.push(`The user's action: ${line(form?.userResult)}`);

    for (const character of Array.isArray(form?.characters) ? form.characters : []) {
        const name = line(character?.name) || 'Someone';
        const words = line(assessmentOf(assessments, character?.assessId)?.words);
        const degree = words ? ` — ${words}` : '';
        lines.push(`${name} will ${phrase(character?.action)} because ${phrase(character?.actionReason)}${degree}.`);
        if (line(character?.decision)) lines.push(`(${name}'s decision: ${line(character.decision)} — ${line(character.decisionReason)})`);
        if (line(character?.outcome)) lines.push(`Why it goes this way: ${line(character.outcome)}`);
        if (line(character?.speech)) lines.push(`${name} says: "${line(character.speech)}"`);
    }
    return lines.filter(Boolean).join('\n');
}
