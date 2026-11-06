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
    if (Array.isArray(assessments)) return assessments.find(item => item?.id === id) ?? null;
    return assessments?.[id] ?? null;
}

/** Сокращённое действие для строки броска: одна короткая фраза, без хвоста. */
export function shortAction(value, max = 44) {
    const text = phrase(value).replace(/\s+/g, ' ') || 'makes the attempt';
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const at = cut.lastIndexOf(' ');
    return `${(at > 12 ? cut.slice(0, at) : cut).replace(/[.,;:!?]+$/, '')}…`;
}

/**
 * Строки броска для показа в чате (опция Show rolls): по одной на бросок —
 * кто, что (сокращённо), степень словами. Шансы и числа не выводятся
 * никогда — это игра, а не отладка.
 */
function allAssessments(assessments) {
    if (assessments instanceof Map) return [...assessments.entries()].map(([id, value]) => ({ id, ...value }));
    if (Array.isArray(assessments)) return assessments;
    if (assessments && typeof assessments === 'object') return Object.entries(assessments).map(([id, value]) => ({ id, ...value }));
    return [];
}

export function buildRollLines({ form, assessments = new Map() } = {}) {
    const lines = [];
    const used = new Set();
    for (const character of Array.isArray(form?.characters) ? form.characters : []) {
        if (character?.idle === true) continue;
        const found = assessmentOf(assessments, character?.assessId);
        const words = line(found?.words);
        if (!words) continue;
        used.add(line(character?.assessId));
        const name = line(character?.name) || 'Someone';
        lines.push(`${name} — ${shortAction(character?.action)} — ${words}`);
    }
    // Бросок попытки пользователя в форме не цитируется (его итог — userResult), но это главный бросок хода: он идёт первым.
    const own = allAssessments(assessments)
        .filter(item => line(item?.words) && !used.has(line(item?.id)))
        .map(item => `${line(item?.character) || 'Someone'} — ${shortAction(item?.action)} — ${line(item.words)}`);
    return [...own, ...lines];
}

/** Та же строка, склеенная в одну (совместимость и тесты). */
export function buildRollLine({ form, assessments = new Map() } = {}) {
    return buildRollLines({ form, assessments }).join('; ');
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

    const characters = Array.isArray(form?.characters) ? form.characters : [];
    const idle = characters.filter(character => character?.idle === true).map(character => line(character?.name)).filter(Boolean);
    for (const character of characters) {
        if (character?.idle === true) continue;
        const name = line(character?.name) || 'Someone';
        const words = line(assessmentOf(assessments, character?.assessId)?.words);
        const degree = words ? ` — ${words}` : '';
        // Причины и цель — пометкой «не для страницы»: склейка «will … because …» читалась готовой фразой, и писатель вставлял её в текст.
        lines.push(`${name} does: ${phrase(character?.action)}${degree}.`);
        if (line(character?.actionReason)) lines.push(`(Why — for you, not for the page: ${line(character.actionReason)})`);
        if (line(character?.decision)) lines.push(`(${name}'s aim — for you, not for the page: ${line(character.decision)} — ${line(character.decisionReason)})`);
        if (line(character?.outcome)) lines.push(`Why it goes this way: ${line(character.outcome)}`);
        if (line(character?.speech)) lines.push(`${name} says: "${line(character.speech)}"`);
    }
    if (idle.length) lines.push(`In the background, doing nothing notable this turn: ${idle.join(', ')}. Do not give them actions or lines.`);
    return lines.filter(Boolean).join('\n');
}
