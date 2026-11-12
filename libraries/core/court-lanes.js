/**
 * Дорожки окна The Court: какая из пяти ролей сделала цикл или строку ленты,
 * человеческий заголовок вызова инструмента и резюме записи. Чистая модель
 * без DOM: окно только рисует готовое (часть 21).
 */

export const LANES = Object.freeze([
    { id: 'god', label: 'God', empty: 'God has not shaped this world yet.' },
    { id: 'director', label: 'Director', empty: 'No Decrees yet.' },
    { id: 'counsellor', label: 'Counsellor', empty: 'The Counsellor has nothing to report yet.' },
    { id: 'simulator', label: 'Simulator', empty: 'Nobody has been modelled yet.' },
    { id: 'resolver', label: 'Resolver', empty: 'No turns yet.' },
    { id: 'writer', label: 'Writer', empty: 'The Writer has not written yet.' },
]);
export const LANE_IDS = Object.freeze(LANES.map(lane => lane.id));

const text = value => String(value ?? '').trim();
const names = list => (Array.isArray(list) ? list : []).map(item => text(item?.character ?? item?.name)).filter(Boolean);
const joinNames = list => {
    const all = [...new Set(names(list))];
    return all.length > 3 ? `${all.slice(0, 3).join(', ')} +${all.length - 3}` : all.join(', ');
};

const EVENT_LANE = {
    turn: 'resolver', regenerate: 'resolver', swipe: 'resolver', after_turn: 'resolver', typing: 'resolver', time: 'resolver',
    message: 'counsellor', counsellor: 'counsellor', counsellor_day: 'counsellor', settings: 'counsellor',
    decree: 'director', director: 'director', bootstrap: 'director', researcher: 'director',
    god: 'god', creation: 'god', prayer_answer: 'god', seraph: 'god',
    simulator: 'simulator',
};
// Строки, которые относятся к Writer, даже если лежат в цикле хода резолвера.
const WRITER_ROWS = new Set(['push', 'writer_check']);

/** Роль цикла по событию; неизвестное — по первому вызову инструмента, иначе Resolver. */
export function laneOfEntry(entry) {
    const event = text(entry?.event);
    if (EVENT_LANE[event]) return EVENT_LANE[event];
    if (/god|creation|scale|prayer_answer|seraph/i.test(event)) return 'god';
    if (/decree|director/i.test(event)) return 'director';
    if (/counsel|petition/i.test(event)) return 'counsellor';
    const first = (entry?.rows ?? []).find(row => row.kind === 'call' || row.kind === 'petition');
    if (first?.name === 'decree') return 'director';
    if (first?.kind === 'petition' || ['nothing_yet', 'reply'].includes(first?.name)) return 'counsellor';
    if (['creation_write', 'scale_write', 'discovery', 'ask'].includes(first?.name)) return 'god';
    return 'resolver';
}

/** Запись ленты → куски по дорожкам: строки писателя уходят в его дорожку, остальное — в дорожку цикла. */
export function splitEntry(entry) {
    const lane = laneOfEntry(entry);
    const own = [];
    const writer = [];
    for (const row of entry?.rows ?? []) (WRITER_ROWS.has(row.kind) ? writer : own).push(row);
    const parts = {};
    if (own.length || entry?.running || !writer.length) parts[lane] = { ...entry, lane, rows: own };
    if (writer.length) parts.writer = { ...entry, id: `${entry.id}_writer`, lane: 'writer', title: 'The Writer gets the Inscription', detail: '', rows: writer, running: false, waiting: false };
    return parts;
}

/** Все записи → { god: [...], director: [...], ... } в исходном порядке; `turn` — только этот ход. */
export function lanesFrom(entries, { turn = null } = {}) {
    const lanes = Object.fromEntries(LANE_IDS.map(id => [id, []]));
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (turn !== null && turn !== '' && Number(entry?.turn) !== Number(turn)) continue;
        for (const [lane, part] of Object.entries(splitEntry(entry))) lanes[lane].push(part);
    }
    return lanes;
}

/** Номера ходов, которые есть в ленте, — для шкалы ходов. */
export function turnsIn(entries) {
    return [...new Set((Array.isArray(entries) ? entries : []).map(entry => Number(entry?.turn)).filter(Number.isFinite))].sort((a, b) => a - b);
}

/** Заголовок вызова по смыслу, а не имя инструмента. */
export function toolLabel(name, args = {}) {
    const a = args && typeof args === 'object' ? args : {};
    switch (text(name)) {
        case 'inscribe': return `Inscription — ${joinNames(a.characters) || 'the scene'}`;
        case 'submit_turn': return `The turn — ${joinNames(a.characters) || 'the scene'}`;
        case 'after_turn': return 'After the turn — outcome and changes';
        case 'assess': return `Roll — ${text(a.character) || 'someone'}: ${text(a.action) || 'an attempt'}`;
        case 'decree': return `Decree for ${joinNames(a.decrees) || text(a.character) || 'someone'}`;
        case 'petition': return `Petition about ${text(a.character) || 'someone'}`;
        case 'nothing_yet': return 'Nothing for the Director yet';
        case 'reply': return 'Answer to you';
        case 'prayer': return 'Prayer to God';
        case 'bank_edit': return `Bank edit — ${joinNames(a.edits) || 'a character'}`;
        case 'character_knowledge': return `Knowledge — ${text(a.character) || 'a character'}`;
        case 'character_bank': return `Data bank — ${text(a.name ?? a.character) || 'a character'}`;
        case 'update_roster': return 'Who is in the scene';
        case 'cast': return `Who is here — ${(Array.isArray(a.present) ? a.present : []).join(', ') || 'nobody'}`;
        case 'account': return `${text(a.person) || 'Someone'} — ${text(a.says) ? 'speaks' : (text(a.does) || 'carries on').slice(0, 60)}`;
        case 'edit': {
            const paths = [...new Set((Array.isArray(a.edits) ? a.edits : []).map(item => text(item?.path).replace(/^Characters\//, '')).filter(Boolean))];
            return `Edit — ${paths.slice(0, 3).join(', ') || 'files'}${paths.length > 3 ? ` +${paths.length - 3}` : ''}`;
        }
        case 'view': return text(a.path) ? `Read ${text(a.path).replace(/^Characters\//, '')}` : 'List the files';
        case 'create': return `Create ${text(a.path).replace(/^Characters\//, '') || 'a file'}`;
        case 'resolve_proposals': return 'Proposals of the Resolver';
        case 'creation_write': return `Creation — ${(Array.isArray(a.sections) ? a.sections : []).map(section => text(section?.title)).filter(Boolean).join(', ') || 'a section'}`;
        case 'scale_write': return `Scales — ${text(a.system) || 'a system'}`;
        case 'ask': return 'Questions for you';
        case 'await': return 'Rests';
        default: return text(name) || 'A tool';
    }
}

/** Поля вызова, которые стоит показать человеку, — пары [подпись, текст]; остальное в «Raw». */
export function toolFields(name, args = {}) {
    const a = args && typeof args === 'object' ? args : {};
    const pick = pairs => pairs.filter(([, value]) => text(value));
    switch (text(name)) {
        case 'decree': return (Array.isArray(a.decrees) ? a.decrees : [a]).flatMap(item => pick([
            [`${text(item?.character)} — values and facts`, item?.valuesAndFacts], ['Sees themselves as', item?.selfView],
            ['Long goal', item?.goals?.long], ['Today', item?.goals?.today],
            ['Mood', typeof item?.mood === 'object' ? Object.entries(item.mood ?? {}).map(([axis, value]) => `${axis}: ${value}`).join(', ') : item?.mood],
            ['Resolving', item?.resolving],
        ]));
        case 'petition': return pick([['Problem', a.problem], ['From the Ledger', a.excerpt], ['Promote', a.promote ? `${text(a.promote.level)} — ${text(a.promote.reason)}` : '']]);
        case 'inscribe': return pick([['Stops at', a.stop], ['Lasts', a.scene?.duration]]);
        case 'edit': return (Array.isArray(a.edits) ? a.edits : []).map(item => [text(item?.path).replace(/^Characters\//, ''), `${text(item?.old) || '(add)'}  →  ${text(item?.new) || '(remove)'}`]);
        case 'create': return pick([[text(a.path), a.text]]);
        case 'nothing_yet': case 'rest': return pick([['Why', a.reason]]);
        case 'reply': case 'prayer': return pick([['Text', a.text]]);
        case 'account': return pick([['Took', a.took], ['Learned', a.learned], ['Inner', a.inner], ['Busy with', a.busy_with], ['Wants', a.wants], ['Holds back', a.holds_back], ['Does', a.does], ['Tries', a.tries], ['Says', a.says], ['Shows', a.shows], ['Shift', a.shift]]);
        case 'cast': return pick([['Here', (Array.isArray(a.present) ? a.present : []).join(', ')]]);
        default: return [];
    }
}

/** Одна строка-резюме записи: то, что человек хочет увидеть, не раскрывая её. */
export function entrySummary(entry) {
    const rows = entry?.rows ?? [];
    const pieces = [];
    for (const row of rows) {
        if (row.kind === 'message') pieces.push(`You: ${row.text}`);
        else if (row.kind === 'counsellor_reply') pieces.push(`Answered: ${row.text}`);
        else if (row.kind === 'petition') pieces.push(`Petition about ${row.character || 'someone'}`);
        else if (row.kind === 'nothing') pieces.push(`Nothing yet — ${row.reason}`);
        else if (row.kind === 'telegram') pieces.push(`Telegram: ${row.text}`);
        else if (row.kind === 'prayer') pieces.push(`Prayer: ${row.text}`);
        else if (row.kind === 'assess') pieces.push(`${row.character || 'someone'} — ${row.degree || row.words || 'rolled'}`);
        else if (row.kind === 'call' && !['await', 'assess'].includes(row.name)) pieces.push(toolLabel(row.name, row.args));
        else if (row.kind === 'form' && row.resolution) pieces.push(row.resolution);
        else if (row.kind === 'writer_check') pieces.push(row.violated?.length ? `Check: ${row.violated.join(', ')}` : 'Checked');
        else if (row.kind === 'push') pieces.push('Inscription sent');
    }
    const line = pieces.filter(Boolean).join(' · ');
    return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

/** Какая роль работает сейчас — по живым записям. */
export function workingLanes(entries) {
    return [...new Set((Array.isArray(entries) ? entries : []).filter(entry => entry?.running).map(laneOfEntry))];
}
