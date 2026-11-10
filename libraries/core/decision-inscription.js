import { modeFields, normalizeModeFields } from './turn-modes.js';
import { durationMinutes, DEFAULT_DURATION, clampMinutes } from './decision-duration.js';
import { CONFLICT_LEVELS } from './decision-tool-schemas-inscribe.js';

/**
 * Проверка и починка шаблона резолвера — чистые правила, без модели.
 *
 * Резолвер не пишет форму «идеально», и возвращать её лишним запросом дорого:
 * каждый возврат — 30–40 секунд ожидания. Поэтому движок здесь не судит, а
 * чинит, и отказывает только там, где без ответа модели ход не собрать: нет
 * beats, когда кто-то действует. Всё остальное дополняется и помечается
 * предупреждением в журнале.
 */

const text = value => String(value ?? '').trim();
const sameName = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

export const DEFAULT_NO_CHECK = "no roll — decided from the character's psychology";

/** Уровень противоречия: синонимы и слова пользователя сводятся к шкале. */
export function normalizeConflict(value) {
    if (!value || typeof value !== 'object') return { level: 'none', why: '' };
    const raw = text(value.level).toLowerCase();
    const synonyms = {
        none: 'none', no: 'none', null: 'none', quiet: 'none',
        minor: 'minor', small: 'minor', slight: 'minor', little: 'minor', some: 'minor', небольшое: 'minor',
        strong: 'strong', big: 'strong', strong_: 'strong', severe: 'strong', сильное: 'strong',
    };
    const level = CONFLICT_LEVELS.includes(raw) ? raw : (synonyms[raw] ?? 'none');
    return { level, why: text(value.why) };
}

/**
 * Шаблон → форма хода, которую понимают проекции, Push и запись хода.
 * @returns {{ ok: boolean, missing: string[], form?: object, warnings: string[] }}
 */
export const SHOWS = Object.freeze(['words', 'body', 'held back']);

export function repairInscription({ form, roster = [], assessments = new Map(), user = '', nowValue = null, timeOfDay = null, previous = null, departed = [], modes = null, userMessage = '', strictLines = false } = {}) {
    const missing = [];
    const warnings = [];
    if (!form || typeof form !== 'object') return { ok: false, missing: ['inscribe'], warnings };
    const isUser = name => Boolean(text(user)) && sameName(name, user);
    const active = (Array.isArray(roster) ? roster : []).map(name => text(name)).filter(name => name && !isUser(name));
    const all = (Array.isArray(form.characters) ? form.characters : [])
        .filter(character => character && typeof character === 'object')
        .filter(character => !isUser(character.name))
        .map(character => ({ ...character, name: text(character.name) }));

    // Один и тот же персонаж дважды: оставляем первый, второй теряется не молча.
    const seen = new Map();
    const deduped = [];
    for (const character of all) {
        const key = text(character.name).toLowerCase();
        if (!character.name) continue;
        if (seen.has(key)) { warnings.push(`"${character.name}" was listed twice — the first entry was kept`); continue; }
        seen.set(key, character);
        deduped.push(character);
    }

    const characters = [];
    for (const character of deduped) {
        if (character.idle === true) {
            characters.push({ ...character, idle: true, ...(text(character.busy) ? { busy: text(character.busy) } : {}) });
            continue;
        }
        // Поля шаблона и старые имена (action/decision/feeling) принимаются оба: модель путает их, и это не повод
        // возвращать ход лишним запросом — движок читает, что понял.
        const feels = text(character.feels) || text(character.feeling);
        // `next` — следующий шаг к цели с того места, где сцена сейчас (новый шаблон); `decreeWants` — прежнее имя.
        const decreeWants = text(character.next) || text(character.decreeWants) || text(character.decision) || text(character.actionReason);
        const heard = text(character.heard);
        const does = text(character.does) || text(character.action);
        // Молчащему модель пишет «None» — это не реплика: иначе она попадала в ALREADY SAID как сказанное.
        const said = text(character.says) || text(character.speech);
        let says = /^(none|null|n\/a|nothing|-+|—)\.?$/i.test(said) ? '' : said;
        // Что персонаж хочет передать (means, real) и как это выходит сейчас (shows, lens): словами, телом или сдержано.
        // «Хочет спросить» не равно «говорит»: не words — says пуст. Первый раз — назад резолверу, повтор — движок чинит сам.
        const means = text(character.means);
        let shows = SHOWS.includes(text(character.shows).toLowerCase()) ? text(character.shows).toLowerCase() : '';
        if (!shows && (means || says) && strictLines) missing.push(`characters: "${character.name}" needs "shows" — how what they mean to get across comes out now: ${SHOWS.join(' / ')}`);
        if (!shows && (means || says)) shows = says ? 'words' : 'body';
        if (says && shows !== 'words') {
            if (strictLines) missing.push(`characters: "${character.name}" shows "${shows}" yet has "says" — what does not come out in words stays out of says; if they do speak, shows is words`);
            else { says = ''; warnings.push(`"${character.name}" shows "${shows}" — their says was cleared`); }
        }
        const conflict = normalizeConflict(character.conflict);
        if ((conflict.level === 'minor' || conflict.level === 'strong') && !conflict.why) {
            warnings.push(`"${character.name}" has a ${conflict.level} conflict with no reason — it was recorded without one`);
        }
        const rolled = text(character.assessId);
        const outcome = text(character.outcome);
        // Почему вышло или нет — только после броска. Без броска итог решён самим решением.
        if (rolled && !outcome) {
            warnings.push(`"${character.name}" has an assess id but no outcome — the writer gets it without a reason`);
        }
        const mode = normalizeModeFields(character.mode, modes);
        if (Object.keys(modeFields(modes)).length && !Object.keys(mode).length) warnings.push(`"${character.name}" acts but has no "mode" fields for this turn`);
        characters.push({
            ...character,
            name: character.name,
            mode,
            ...(heard ? { heard } : {}),
            feels,
            decreeWants,
            conflict,
            does,
            says,
            ...(means ? { means } : {}),
            ...(shows ? { shows } : {}),
            ...(rolled ? { assessId: rolled, ...(outcome ? { outcome } : {}) } : {}),
            ...(!rolled ? { noCheck: text(character.noCheck) || DEFAULT_NO_CHECK } : {}),
            // Форма проекций и Push: у резолвера действие — `does`, у писателя — `action`.
            action: does,
            actionReason: decreeWants,
            feeling: feels,
        });
    }

    // Ростер: входящие добавляются, вышедшие убираются. Отдельного вызова в шаблоне больше нет.
    // Если персонаж заполнен действиями и при этом «вышел», он действует в этой сцене — выход отменяется:
    // молча вычеркнуть действующего хуже, чем оставить его в сцене.
    const removals = new Set((Array.isArray(form.roster?.remove) ? form.roster.remove : []).map(name => text(name).toLowerCase()).filter(Boolean));
    const filled = name => characters.some(character => sameName(character.name, name) && character.idle !== true && (text(character.does) || text(character.says)));
    for (const name of [...removals]) {
        const actual = active.find(activeName => activeName.toLowerCase() === name);
        if (actual && filled(actual)) {
            removals.delete(name);
            warnings.push(`"${actual}" was marked as leaving but acts this turn — kept in the scene`);
        }
    }
    const numbered = [];
    for (const name of active) if (!removals.has(name.toLowerCase())) numbered.push(name);
    for (const entry of Array.isArray(form.roster?.add) ? form.roster.add : []) {
        const name = text(entry?.name);
        if (!name || isUser(name)) continue;
        if (!numbered.some(existing => sameName(existing, name))) numbered.push(name);
    }
    // Ушёл в прошлом исходе и в этот ход не вписан — ушёл: движок убирает его сам, резолверу решать нечего.
    for (const name of departed) {
        const index = numbered.findIndex(existing => sameName(existing, name));
        if (index >= 0 && !characters.some(character => sameName(character.name, name))) numbered.splice(index, 1);
    }
    // Кто здесь и не вписан — в фоне, со своим прошлым занятием: шаблон перечисляет только действующих.
    const before = Array.isArray(previous?.characters) ? previous.characters : [];
    for (const name of [...numbered]) {
        if (characters.some(character => sameName(character.name, name))) continue;
        const busy = text(before.find(character => sameName(character?.name, name))?.busy);
        characters.push({ name, idle: true, ...(busy ? { busy } : {}), action: '', feeling: '' });
    }
    // Заполненный персонаж, которого нет в ростере, входит в сцену этим ходом.
    for (const character of characters) {
        if (!numbered.some(name => sameName(name, character.name))) numbered.push(character.name);
    }
    // Персонаж, который ушёл и в этом ходу ничего не делает, из формы выпадает: он больше не в сцене.
    const present = characters.filter(character => numbered.some(name => sameName(name, character.name)));
    if (present.length !== characters.length) warnings.push(`characters who left the scene were dropped from the form: ${characters.filter(character => !present.includes(character)).map(character => character.name).join(', ')}`);
    characters.length = 0;
    characters.push(...present);

    let beats = (Array.isArray(form.beats) ? form.beats : [])
        .filter(beat => beat && typeof beat === 'object' && text(beat.text))
        .map(beat => ({ who: text(beat.who), kind: text(beat.kind).toLowerCase() === 'line' ? 'line' : 'action', text: text(beat.text) }));
    // Реплика — только у того, у кого есть says: Писатель видит биты, а не форму, и пустой says с битом LINE
    // всё равно давал реплику на странице. Первый раз — назад резолверу; повтор — движок убирает такие биты сам.
    const silent = characters.filter(character => character.idle !== true && !text(character.says)).map(character => character.name);
    const unsaid = beats.filter(beat => beat.kind === 'line' && silent.some(name => sameName(name, beat.who)));
    if (unsaid.length && strictLines) {
        missing.push(`beats: a line beat for ${[...new Set(unsaid.map(beat => beat.who))].map(name => `"${name}"`).join(', ')}, whose "says" is empty — if they speak, put what they say in "says"; if they do not, the beat is what they do instead`);
    } else if (unsaid.length) {
        beats = beats.filter(beat => !unsaid.includes(beat));
        warnings.push(`line beats were dropped for characters whose "says" is empty: ${[...new Set(unsaid.map(beat => beat.who))].join(', ')}`);
    }
    const acting = characters.some(character => character.idle !== true);
    if (acting && !beats.length) missing.push('beats: give the turn in order — every action and every line of the characters who act, each once (a line beat is what the words mean, in direct form)');

    // Шкала длительности: не разобрана — короткая сцена и предупреждение, а не возврат формы.
    // Старое поле `scene.minutes` принимается как есть: форма, написанная до шаблона, не должна падать.
    const rawDuration = text(form.scene?.duration);
    const legacyMinutes = Number(form.scene?.minutes);
    let minutes = durationMinutes(rawDuration, { nowValue, timeOfDay });
    if (minutes === null && Number.isFinite(legacyMinutes)) minutes = clampMinutes(legacyMinutes);
    if (minutes === null) {
        minutes = durationMinutes(DEFAULT_DURATION);
        // Без длительности — короткая сцена по умолчанию; предупреждение — только за слово не со шкалы.
        if (rawDuration) warnings.push(`the scene duration "${rawDuration}" was not on the scale — "a few minutes" was used`);
    }
    minutes = clampMinutes(minutes);

    // Действие пользователя доходит до Писателя только этой строкой: «S» вместо неё — и прикосновение пропадало со страницы.
    // Пусто или обрывок — ставится само сообщение пользователя: хотя бы его действие целиком.
    let userResult = text(form.userResult);
    if (userResult.split(/\s+/).filter(Boolean).length < 4 && text(userMessage)) {
        userResult = `${text(user) || 'The user'}: ${text(userMessage)}`;
        warnings.push('userResult was empty or cut short — the user\'s own message was used for it');
    }
    const resolution = text(form.stop) || text(form.resolution);
    if (!resolution) missing.push('stop: where the turn ends, in one sentence');
    const formOut = {
        characters,
        beats,
        resolution,
        stop: resolution,
        userResult,
        scene: { duration: rawDuration, minutes, ...(text(form.scene?.place) ? { place: text(form.scene.place) } : {}) },
        roster: { active: numbered },
    };
    for (const character of characters) {
        if (text(character.assessId) && !hasAssessment(assessments, character.assessId)) {
            // Броска нет в карте цикла: форма всё равно идёт дальше без степени, а не держит ход.
            warnings.push(`"${character.name}" cites assess "${character.assessId}", which assess did not return — the writer gets it without degree words`);
            delete character.assessId;
            delete character.outcome;
        }
    }
    return { ok: missing.length === 0, missing, form: formOut, warnings };
}

function hasAssessment(assessments, id) {
    if (!id) return false;
    if (assessments instanceof Map) return assessments.has(id);
    if (assessments && typeof assessments === 'object') return Boolean(assessments[id]);
    return false;
}
