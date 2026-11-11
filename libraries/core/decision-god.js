import { isComplete, missingSections, renderCreation, allSections } from './decision-creation.js';
import { findScaleSystem, renderScaleSystem, discoveriesAfter, normalizeScaleSystems } from './decision-scales.js';
import { withoutCharacterEntries } from './decision-lorebook.js';
import {
    GOD_SYSTEM, GOD_BUILD_TASK, GOD_STUDY_TASK, GOD_THINK_BUILD, GOD_PRAYER_TASK, GOD_THINK_PRAYER, GOD_DECLARATION_TASK,
    GOD_MATERIAL_HEADER, NO_MATERIAL, GOD_SCALES_HEADER, GOD_PRAYERS_HEADER, GOD_RP_HEADER,
    GOD_QUESTIONS_HEADER, NO_QUESTIONS, fillPrompt,
} from './decision-prompts.js';

/**
 * God — чистые правила. Что считать поводом проснуться, что он читает (мир,
 * а не персонажей) и как собирается его короткий контекст. Ни модели, ни
 * хранения: ядро `cores/decision/god.js` только ведёт цикл.
 *
 * Поводы: Creation нет или в нём нет гарантированного раздела — построение;
 * в очереди есть Молитва — разбор; пришли ответы на вопросы — Декларация.
 */

const text = value => String(value ?? '').trim();
const unique = list => [...new Set((Array.isArray(list) ? list : []).map(text).filter(Boolean))];
const PRAYER_LIMIT = 12;

/** Мировые части карты — всё, что говорит о мире, а не о персонаже. */
export function worldFromCards(cards) {
    return (Array.isArray(cards) ? cards : []).map(card => {
        const parts = [
            ['Name', card?.name],
            ['Setting', card?.scenario],
            ['World', card?.description],
            ['Instructions', card?.post_history_instructions],
        ].filter(([, value]) => text(value)).map(([label, value]) => `${label}:\n${text(value)}`);
        return parts.length ? parts.join('\n\n') : '';
    }).filter(Boolean).join('\n\n');
}

/**
 * Материал мира: записи лорбука, которые не стали дата-банками персонажей, и
 * мировые части карт. Персонажи — не его: их ведут банки.
 */
export function godMaterial({ lorebookEntries = [], cards = [], marks = null, opening = '' } = {}) {
    const world = withoutCharacterEntries(lorebookEntries, marks)
        .filter(entry => entry && !entry.disable && text(entry.content));
    const books = new Map();
    for (const entry of world) {
        const book = text(entry.book) || 'Lorebook';
        if (!books.has(book)) books.set(book, []);
        books.get(book).push(entry);
    }
    const lorebook = [...books.entries()].map(([book, list]) => [
        `### Book: ${book}`,
        ...list.map(entry => `${text(entry.comment) || `Entry ${entry.uid}`}\n${text(entry.content)}`),
    ].join('\n\n')).join('\n\n');
    // Первое сообщение чата, как выбрано сейчас: где и когда начинается история.
    const start = text(opening) ? `### The story's opening — the chat's first message as it stands now\n${text(opening)}` : '';
    return [lorebook, worldFromCards(cards), start].filter(Boolean).join('\n\n');
}

/** Молитвы, которые ждут Бога: статус `queued`, от резолвера и от Советника. */
export function queuedPrayers(prayers) {
    return (Array.isArray(prayers) ? prayers : [])
        .filter(item => item && typeof item === 'object' && text(item.text) && text(item.status || 'queued') === 'queued')
        .slice(-PRAYER_LIMIT);
}

/**
 * Повод разбудить God. Все поводы одного пробуждения — один вызов:
 * построение (Creation нет или неполно), Молитвы, Декларация.
 * @returns {{ wake: object, kind: string, prayers: object[], declaration: object|null } | null}
 */
export function godReason({ creation = null, prayers = [], declaration = null, questions = [], allowBuild = true, studied = true } = {}) {
    const open = queuedPrayers(prayers);
    const complete = isComplete(creation);
    const hasCreation = allSections(creation).some(section => text(section.text)) || (creation?.scales ?? []).length;
    const answers = renderableAnswers(declaration);
    // Вопрос без ответа держит построение: мир строится по ответам пользователя, а не вперёд них.
    const waiting = (Array.isArray(questions) ? questions : []).some(item => !text(item?.answer));
    const reasons = [];
    // Сначала вопросы, потом мир: первый запуск только изучает материал и спрашивает Советника.
    if (!hasCreation && !studied && allowBuild && !answers.length) reasons.push({ type: 'study' });
    // Достройка — задача на открытии чата, а не на каждом ходу: иначе God будился бы каждый ход без конца.
    else if (!complete && allowBuild && !waiting && !answers.length) reasons.push({ type: hasCreation ? 'build' : 'first' });
    if (open.length && complete) reasons.push({ type: 'prayer' });
    if (answers.length) reasons.push({ type: 'declaration' });
    if (!reasons.length) return null;

    // Порядок: Декларация меняет мир сильнее всего, затем молитвы, затем достройка.
    const primary = reasons.find(reason => reason.type === 'declaration')
        ?? reasons.find(reason => reason.type === 'prayer')
        ?? reasons[0];
    const detail = [
        primary.type === 'declaration' ? `${answers.length} answer(s) came back from the Counsellor` : '',
        primary.type === 'prayer' ? `${open.length} prayer(s): ${unique(open.map(item => text(item.text).slice(0, 60))).slice(0, 3).join('; ')}` : '',
        primary.type === 'build' ? `the Creation is not complete: ${missingSections(creation).join('; ')}` : '',
        primary.type === 'first' ? 'the Creation does not exist yet' : '',
        primary.type === 'study' ? 'God studies the material and asks before shaping the world' : '',
        Array.isArray(questions) && questions.length ? `${questions.length} question(s) wait for the Counsellor` : '',
    ].filter(Boolean).join('; ');
    const labels = {
        first: 'God shapes the world for the first time',
        study: 'God studies the world and asks',
        build: 'God finishes shaping the world',
        prayer: 'Prayers reach God',
        declaration: 'The Counsellor returns the Declaration',
    };
    return {
        wake: { type: 'god', label: labels[primary.type], detail },
        kind: primary.type,
        prayers: primary.type === 'prayer' ? open : [],
        declaration: primary.type === 'declaration' ? { answers } : null,
        questions: Array.isArray(questions) ? questions : [],
    };
}

/** Системы весов, которых касаются Молитвы (по имени системы внутри строки). */
export function systemsForPrayers(creation, prayers) {
    const systems = normalizeScaleSystems(creation?.scales);
    if (!systems.length) return [];
    const wanted = unique((Array.isArray(prayers) ? prayers : []).flatMap(item => {
        const lower = text(item?.text).toLowerCase();
        return systems.filter(system => lower.includes(text(system.name).toLowerCase())).map(system => system.name);
    }));
    return wanted.length ? wanted.map(name => findScaleSystem(systems, name)).filter(Boolean) : systems;
}

export function renderPrayers(prayers) {
    const list = queuedPrayers(prayers);
    if (!list.length) return 'No prayer waits.';
    return list.map(item => `- ${item.source === 'counsellor' ? '(from the Counsellor) ' : '(from the Resolver) '}${text(item.text)}`).join('\n');
}

/** Системы для контекста Молитвы: их правила целиком, без открытий (они — ответ). */
export function renderSystemsForPrayers(systems) {
    const list = Array.isArray(systems) ? systems : [];
    if (!list.length) return 'No system of weight is written yet. Answer from the Creation as it stands, or write the system first.';
    return list.map(system => renderScaleSystem(system, { discoveries: false })).join('\n\n');
}

/**
 * Контекст God: система → материал мира (или системы для Молитвы, или
 * Декларация) → что уже написано → RP-время → задание и CoT.
 */
export function buildGodContext({
    material = '', creation = null, kind = 'build', prayers = [], declaration = null, rpTime = '', questions = [], maxQuestions = 5,
} = {}) {
    const state = creation ?? null;
    const messages = [{ role: 'system', content: GOD_SYSTEM }];
    if (kind === 'prayer') {
        const systems = systemsForPrayers(state, prayers);
        messages.push({ role: 'system', content: `${GOD_PRAYERS_HEADER}\n\n${renderPrayers(prayers)}` });
        messages.push({ role: 'system', content: `${GOD_SCALES_HEADER}\n${renderSystemsForPrayers(systems)}` });
        const written = renderCreation(state);
        if (written) messages.push({ role: 'system', content: written });
        if (rpTime) messages.push({ role: 'system', content: `${GOD_RP_HEADER} ${rpTime}` });
        messages.push({ role: 'user', content: `${fillPrompt(GOD_PRAYER_TASK, { prayers: renderPrayers(prayers), scales: renderSystemsForPrayers(systems) })}\n\n${GOD_THINK_PRAYER}` });
        return { messages, prompt: messages.map(message => message.content).join('\n\n'), kind };
    }
    if (kind === 'study') {
        messages.push({ role: 'system', content: `${GOD_MATERIAL_HEADER}\n\n${text(material) || NO_MATERIAL}` });
        if (rpTime) messages.push({ role: 'system', content: `${GOD_RP_HEADER} ${rpTime}` });
        messages.push({ role: 'user', content: fillPrompt(GOD_STUDY_TASK, { material: text(material) || NO_MATERIAL, max_questions: Number(maxQuestions) || 5 }) });
        return { messages, prompt: messages.map(message => message.content).join('\n\n'), kind };
    }
    // Декларация до мира — построение с ответами пользователя как законом.
    if (kind === 'declaration' && !renderCreation(state)) {
        messages.push({ role: 'system', content: `${GOD_MATERIAL_HEADER}\n\n${text(material) || NO_MATERIAL}` });
        if (rpTime) messages.push({ role: 'system', content: `${GOD_RP_HEADER} ${rpTime}` });
        messages.push({ role: 'user', content: `${fillPrompt(GOD_DECLARATION_TASK, { declaration: renderDeclaration(declaration) })}\n\n${fillPrompt(GOD_BUILD_TASK, { material: 'the material is above', max_questions: 0 })}\n\n${GOD_THINK_BUILD}` });
        return { messages, prompt: messages.map(message => message.content).join('\n\n'), kind };
    }
    if (kind === 'declaration') {
        const written = renderCreation(state);
        if (written) messages.push({ role: 'system', content: written });
        if (rpTime) messages.push({ role: 'system', content: `${GOD_RP_HEADER} ${rpTime}` });
        messages.push({ role: 'user', content: fillPrompt(GOD_DECLARATION_TASK, { declaration: renderDeclaration(declaration) }) });
        return { messages, prompt: messages.map(message => message.content).join('\n\n'), kind };
    }
    messages.push({ role: 'system', content: `${GOD_MATERIAL_HEADER}\n\n${text(material) || NO_MATERIAL}` });
    const written = renderCreation(state);
    if (written) messages.push({ role: 'system', content: written });
    if (Array.isArray(questions) && questions.length) {
        messages.push({ role: 'system', content: `${GOD_QUESTIONS_HEADER}\n\n${questions.map(item => `- ${text(item.question)}`).join('\n') || NO_QUESTIONS}` });
    }
    if (rpTime) messages.push({ role: 'system', content: `${GOD_RP_HEADER} ${rpTime}` });
    messages.push({ role: 'user', content: `${fillPrompt(GOD_BUILD_TASK, { material: text(material) || NO_MATERIAL, max_questions: Number(maxQuestions) || 5 })}\n\n${GOD_THINK_BUILD}` });
    return { messages, prompt: messages.map(message => message.content).join('\n\n'), kind };
}

/** Декларация → строки: вопрос и ответ. */
export function renderDeclaration(declaration) {
    const answers = renderableAnswers(declaration);
    if (!answers.length) return 'The Declaration is empty.';
    return answers.map(item => `Q: ${text(item.question)}\nA: ${text(item.answer)}`).join('\n\n');
}

function renderableAnswers(declaration) {
    return (Array.isArray(declaration?.answers) ? declaration.answers : [])
        .filter(item => item && typeof item === 'object' && text(item.answer))
        .map(item => ({ question: text(item.question), answer: text(item.answer), at: Number(item.at) || 0 }));
}

/** Короткий блок у задания резолвера: открытия, которых он ещё не видел. */
export function discoveriesBlock(creation, sinceSeq = 0) {
    // Считается от снимка резолвера, а не от записи: всё, что новее снимка, — новое для него.
    const entries = discoveriesAfter(creation?.scales ?? [], Number(sinceSeq) || 0);
    if (!entries.length) return '';
    return [
        'NEW DISCOVERIES (found since the world was last read; from here on they are the law of the world):',
        ...entries.map(item => `- ${item.at ? `${item.at} ` : ''}**${item.system}**${item.rule ? ` — ${item.rule}` : ''}: ${item.text}`),
    ].join('\n\n');
}

/** Вопросы God для очереди Советника — безопасная форма. */
export function godQuestions(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.question))
        .map(item => ({ question: text(item.question), why: text(item.why) }))
        .slice(0, 5);
}
