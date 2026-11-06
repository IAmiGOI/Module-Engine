/**
 * Форма хода — проверки до записи. Чистая функция: не знает ни моделей, ни
 * шин. Всё, что движок обязан потребовать от `submit_turn`, собрано здесь,
 * чтобы отказ был перечнем недостающего, а не исключением.
 */

const TEXT_FIELDS = Object.freeze(['decision', 'decisionReason', 'action', 'actionReason']);
// Решение «держится между ходами»: пропущенное берётся из прошлой формы, а не возвращает форму лишним запросом.
const CARRIED = Object.freeze(['decision', 'decisionReason']);
const MAX_MINUTES = 1440;

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

function hasAssessment(assessments, id) {
    if (!id) return false;
    if (assessments instanceof Map) return assessments.has(id);
    if (assessments && typeof assessments === 'object') return Boolean(assessments[id]);
    return false;
}

export const DEFAULT_NO_CHECK = "no roll — decided from the character's psychology";

/**
 * @returns {{ ok: boolean, missing: string[], normalized?: object }}
 */
export function validateTurn({ form, roster = [], assessments = new Map(), user = '', previous = null } = {}) {
    const missing = [];
    const defaulted = [];
    const carried = [];
    const before = name => (Array.isArray(previous?.characters) ? previous.characters : []).find(character => sameName(character?.name, name)) ?? null;
    const filled = new Map();
    if (!form || typeof form !== 'object') return { ok: false, missing: ['form'] };
    const minutes = Number(form.scene?.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) missing.push('scene.minutes (0–1440)');
    if (!nonEmpty(form.resolution)) missing.push('resolution');
    if (!nonEmpty(form.userResult)) missing.push('userResult');
    const characters = Array.isArray(form.characters) ? form.characters : null;
    if (!characters) missing.push('characters');
    // Персонаж пользователя в форме не нужен: за него отвечает userResult. Не требуется, а вписанный — отбрасывается.
    const isUser = name => Boolean(String(user ?? '').trim()) && sameName(name, user);
    const list = (characters ?? []).filter(character => !isUser(character?.name));
    const active = (Array.isArray(roster) ? roster : []).map(name => String(name).trim()).filter(name => name && !isUser(name));

    for (const name of active) {
        const matches = list.filter(character => sameName(character?.name, name));
        if (!matches.length) missing.push(`characters: "${name}" from the active roster is missing`);
        if (matches.length > 1) missing.push(`characters: "${name}" appears more than once`);
    }
    for (const character of list) {
        const name = String(character?.name ?? '').trim();
        if (!name) missing.push('characters[].name');
        else if (active.length && !active.some(activeName => sameName(activeName, name))) missing.push(`characters: "${name}" is not in the active roster`);
        // «idle» — в сцене, но ничего не делает: ни полей, ни броска не нужно, в Push — только фоном.
        if (character?.idle === true) continue;
        for (const field of TEXT_FIELDS) {
            if (nonEmpty(character?.[field])) continue;
            const kept = CARRIED.includes(field) ? before(name)?.[field] : null;
            if (nonEmpty(kept)) {
                filled.set(character, { ...(filled.get(character) ?? {}), [field]: kept });
                if (!carried.includes(name)) carried.push(name);
            } else missing.push(`characters[${name || '?'}].${field}`);
        }
        const rolled = nonEmpty(character?.assessId);
        // Почему вышло или нет — только после броска; без броска итог решён самим решением.
        if (rolled && !nonEmpty(character?.outcome)) missing.push(`characters[${name || '?'}].outcome`);
        const noCheck = nonEmpty(character?.noCheck);
        // Нет ни броска, ни noCheck — не повод возвращать форму (лишний запрос модели): ставится причина по умолчанию.
        if (!rolled && !noCheck) defaulted.push(name || '?');
        else if (rolled && !hasAssessment(assessments, character.assessId)) missing.push(`characters[${name || '?'}].assessId: "${character.assessId}" was not returned by assess`);
    }

    // Писателю нужен ход шагами по порядку: без них Push повторял каждое событие трижды, и писатель пересказывал реплики.
    const acting = list.some(character => character?.idle !== true);
    const beats = Array.isArray(form.beats) ? form.beats.filter(beat => nonEmpty(beat?.text)) : [];
    if (acting && !beats.length) missing.push('beats: give the turn in order — every action and every line of the characters who act, each once (a line beat is what the words mean, in direct form)');

    const normalized = {
        ...form,
        scene: { ...(form.scene ?? {}), minutes },
        characters: list.map(character => ({
            ...character, ...(filled.get(character) ?? {}), name: String(character?.name ?? '').trim(),
            ...(character?.idle !== true && !nonEmpty(character?.assessId) && !nonEmpty(character?.noCheck) ? { noCheck: DEFAULT_NO_CHECK } : {}),
        })),
    };
    const warnings = defaulted.length ? [`no roll and no noCheck for ${defaulted.join(', ')} — "${DEFAULT_NO_CHECK}" was filled in`] : [];
    if (carried.length) warnings.push(`decision kept from the previous turn for ${carried.join(', ')}`);
    return { ok: missing.length === 0, missing, normalized, warnings };
}
