/**
 * Inscription (бывший Push) — то, что прозаик получает вместо решения
 * резолвера. Движок собирает его сам из шаблона хода: время и место, результат
 * действия пользователя, beats по порядку, END и фон. Причины и цели идут
 * отдельным блоком «не для страницы» — их прозаик не проговаривает.
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

/** Фон: кто здесь и чем занят сам — писатель показывает это штрихом, а не реакцией на главный разговор. */
function backgroundLine(characters) {
    const idle = characters.filter(character => character?.idle === true && line(character?.name));
    if (!idle.length) return '';
    const busy = idle.filter(character => line(character.busy));
    const plain = idle.filter(character => !line(character.busy)).map(character => line(character.name));
    const parts = [];
    if (busy.length) parts.push(`In the background, busy with their own concerns — at most a passing touch, no lines:\n${busy.map(character => `- ${line(character.name)}: ${line(character.busy)}`).join('\n')}`);
    if (plain.length) parts.push(`In the background, doing nothing notable this turn: ${plain.join(', ')}. Do not give them actions or lines.`);
    return parts.join('\n');
}

/**
 * Inscription шагами (проверено на GLM 4.7, стенд в части «реплики»): каждое событие один раз и по порядку,
 * реплика — смыслом в прямой форме, конец — только где ход стоп, причины — отдельным блоком «не для страницы».
 * Прежний Push рассказывал каждое событие трижды (развязка, действие, «why it goes»), и писатель отрабатывал
 * каждое упоминание: пересказом и репликой.
 */
function buildBeatInscription({ form, assessments, place, timeBefore, timeAfter, modeLine = '', previousForm = null }) {
    const head = [minutesLabel(form?.scene?.minutes)];
    const where = line(place) || line(form?.scene?.place);
    if (where) head.push(`Place: ${where}.`);
    const when = line(timeAfter) || line(timeBefore);
    if (when) head.push(`Time: ${when}.`);
    const characters = Array.isArray(form?.characters) ? form.characters : [];
    const byName = name => characters.find(character => line(character?.name).toLowerCase() === line(name).toLowerCase()) ?? null;
    const told = new Set();
    const beats = form.beats.map((beat, index) => {
        const who = line(beat?.who) || 'Someone';
        const kind = String(beat?.kind ?? '').toLowerCase() === 'line' ? 'LINE (meaning)' : 'ACTION';
        let text = `${index + 1}. ${who} — ${kind}: ${line(beat?.text)}`;
        const character = byName(who);
        const words = line(assessmentOf(assessments, character?.assessId)?.words);
        // Как прошла попытка — у первого действия того, кто бросал.
        if (words && kind === 'ACTION' && !told.has(who)) {
            told.add(who);
            text += ` (it goes ${words}${line(character?.outcome) ? ` — ${line(character.outcome)}` : ''})`;
        }
        return text;
    });
    const reasons = characters.filter(character => character?.idle !== true && line(character?.name)).map(character => {
        // Что чувствует и чего хочет по Указу и карте — резолверу, не странице: это уводит писателя в объяснения.
        const end = value => line(value).replace(/[.\s]+$/, '') + '.';
        const conflict = character?.conflict && String(character.conflict.level ?? 'none') !== 'none'
            ? `Conflict: ${end(`${character.conflict.level}${line(character.conflict.why) ? ` — ${line(character.conflict.why)}` : ''}`)}`
            : '';
        const parts = [
            line(character.feels) ? `Feels: ${end(character.feels)}` : '',
            line(character.decreeWants) ? `Wants: ${end(character.decreeWants)}` : '',
            conflict,
        ].filter(Boolean);
        return parts.length ? `- ${line(character.name)}: ${parts.join(' ')}` : '';
    }).filter(Boolean);
    // Форма режима: Писателю — только lens; real (правда) не уходит на страницу даже совпадая.
    const lenses = characters.filter(character => character?.idle !== true && line(character?.name)).map(character => {
        // Тот же lens, что в прошлом ходу, Писатель уже показал — повтор он переписал бы снова.
        const before = (Array.isArray(previousForm?.characters) ? previousForm.characters : []).find(other => line(other?.name).toLowerCase() === line(character.name).toLowerCase());
        const fields = Object.entries(character?.mode ?? {}).filter(([name, field]) => line(field?.lens) && line(field.lens) !== line(before?.mode?.[name]?.lens));
        return fields.length ? `- ${line(character.name)}: ${fields.map(([name, field]) => `${name.replace(/_/g, ' ')} — ${line(field.lens)}`).join('; ')}` : '';
    }).filter(Boolean);
    return [
        head.join(' '),
        line(modeLine),
        lenses.length ? `AS IT SHOWS:\n${lenses.join('\n')}` : '',
        `THE USER'S ACTION, AND HOW IT LANDS: ${line(form?.userResult)}`,
        `BEATS — in this order, each one happens once:\n${beats.join('\n')}`,
        `END: ${line(form?.stop ?? form?.resolution)} Stop there.`,
        backgroundLine(characters),
        reasons.length ? `NOT FOR THE PAGE — why they act, so you can play it right:\n${reasons.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * @param {{ form: object, assessments?: Map|object, place?: string, timeBefore?: string, timeAfter?: string }} input
 * @returns {string}
 */
export function buildInscription({ form, assessments = new Map(), place = '', timeBefore = '', timeAfter = '', modeLine = '', previousForm = null } = {}) {
    if (Array.isArray(form?.beats) && form.beats.some(beat => line(beat?.text))) return buildBeatInscription({ form, assessments, place, timeBefore, timeAfter, modeLine, previousForm });
    const lines = [minutesLabel(form?.scene?.minutes)];
    const where = line(place) || line(form?.scene?.place);
    if (where) lines.push(`Place: ${where}.`);
    const when = line(timeAfter) || line(timeBefore);
    if (when) lines.push(`Time: ${when}.`);
    lines.push(`Resolution: ${line(form?.resolution)}`);
    lines.push(`The user's action: ${line(form?.userResult)}`);

    const characters = Array.isArray(form?.characters) ? form.characters : [];
    for (const character of characters) {
        if (character?.idle === true) continue;
        const name = line(character?.name) || 'Someone';
        const words = line(assessmentOf(assessments, character?.assessId)?.words);
        const degree = words ? ` — ${words}` : '';
        // Причины и цель — пометкой «не для страницы»: склейка «will … because …» читалась готовой фразой, и писатель вставлял её в текст.
        lines.push(`${name} does: ${phrase(character?.action)}${degree}.`);
        // Смысл реплики — отдельной строкой с прямым указанием: внутри абзаца действий писатель пересказывал его и повторял цитатой.
        if (line(character?.says)) lines.push(`${name} says, in meaning only (write it once, as ${name}'s spoken line in their own voice; do not also narrate it): ${line(character.says)}`);
        if (line(character?.actionReason)) lines.push(`(Why — for you, not for the page: ${line(character.actionReason)})`);
        if (line(character?.decision)) lines.push(`(${name}'s aim — for you, not for the page: ${line(character.decision)} — ${line(character.decisionReason)})`);
        if (line(character?.outcome)) lines.push(`Why it goes this way: ${line(character.outcome)}`);
        if (line(character?.speech)) lines.push(`${name} says: "${line(character.speech)}"`);
    }
    const background = backgroundLine(characters);
    if (background) lines.push(background);
    return lines.filter(Boolean).join('\n');
}
