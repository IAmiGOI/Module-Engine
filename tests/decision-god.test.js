import test from 'node:test';
import assert from 'node:assert/strict';
import { createGod } from '../cores/decision/god.js';
import { createCreationStore } from '../cores/decision/creation.js';
import {
    godReason, godMaterial, queuedPrayers, buildGodContext, discoveriesBlock, systemsForPrayers, renderSystemsForPrayers,
} from '../libraries/core/decision-god.js';
import { blankCreation, applySection, CREATION_SECTIONS } from '../libraries/core/decision-creation.js';
import { normalizeScaleSystem } from '../libraries/core/decision-scales.js';
import {
    GOD_SYSTEM, GOD_BUILD_TASK, GOD_THINK_BUILD, GOD_PRAYER_TASK, GOD_THINK_PRAYER, GOD_DECLARATION_TASK,
    GOD_MATERIAL_HEADER, GOD_PRAYERS_HEADER, GOD_SCALES_HEADER, GOD_RP_HEADER,
} from '../libraries/core/decision-prompts.js';

const tc = (name, args) => ({ id: `${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: { ...args } });
const comment = 'This is a full sentence of reason.';

const prayer = (text, source = 'resolver') => ({ id: `prayer_${Math.random().toString(36).slice(2, 6)}`, at: 1, turn: 3, text, source, status: 'queued' });

function fullCreation() {
    let state = blankCreation();
    for (const section of CREATION_SECTIONS) state = applySection(state, { title: section.name, text: `${section.name} is written.` }).state;
    return state;
}

const mana = () => normalizeScaleSystem({
    system: 'Mana', principle: 'Will made real.', payment: 'mana and focus',
    rules: [{ name: 'Shape', needs: 'a clear image', yields: 'matter', weight: 'moderate; rises with distance' }],
});

/** Фейковое ядро: память чата в памяти, модель — очередь готовых ответов. */
function harness({ answers = [], creation = null, prayers = [], declaration = null, questions = [], studied = true } = {}) {
    const memory = new Map();
    if (creation) memory.set('creation', creation);
    const papers = {
        prayers: prayers.map(item => ({ ...item })),
        telegrams: [], awaitingDecree: null, petitions: [], counsellor: {},
        director: { lastRunAt: 0, lastReason: '' },
        god: { questions: questions.map(item => ({ ...item })), declaration: declaration ?? null, lastRunAt: 0, lastReason: '', studiedAt: studied ? 1 : 0 },
    };
    const cycles = [];
    const events = [];
    const queue = [...answers];
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback ?? null;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return params.value; }
        if (contract === 'model.generate') {
            const next = queue.shift();
            if (!next) throw new Error('the fake model ran out of answers');
            // Очередь — готовые ответы модели: либо `{ text, toolCalls }`, либо один вызов (короткая запись).
            return next.toolCalls ? next : { text: '', toolCalls: next };
        }
        if (contract === 'lorebook.entries') return [{ book: 'World', uid: 1, comment: 'The Reef', content: 'Three islands and a reef.' }];
        if (contract === 'stCharacter.chatCharacters') return [{ name: 'Aria', scenario: 'A drowned world.' }];
        return null;
    };
    const store = {
        clock: () => ({ minutes: 6 * 1440 + 600, updatedAt: 1 }),
        window: () => ({ entries: [{ kind: 'turn', turn: 6, text: 'TURN 6' }] }),
        cycles: () => cycles,
        papers: () => JSON.parse(JSON.stringify(papers)),
        appendCycle: async cycle => { cycles.push(cycle); return cycle; },
        markPrayersRead: async at => { papers.prayers = papers.prayers.map(item => ({ ...item, status: 'read', readAt: at })); },
        saveGod: async patch => { papers.god = { ...papers.god, ...patch }; },
        consumeDeclaration: async at => { papers.god = { ...papers.god, declaration: null, lastRunAt: at }; },
        addGodQuestions: async (list, { turn = null, at = 0 } = {}) => {
            papers.god.questions = [...papers.god.questions, ...list.map(item => ({ ...item, id: item.id ?? `gq_${Math.random().toString(36).slice(2, 6)}`, at, turn, answer: '' }))];
            return papers.god;
        },
        saveAwaitingDecree: async () => {},
        saveDirector: async () => {},
        markPetitionsRead: async () => {},
        markTelegramsRead: async () => {},
    };
    const settings = {
        decider: { workerId: 'resolver', maxTokens: 8000, temperature: 0.7, topP: 1, topK: 0, reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 },
        director: { workerId: '', maxSteps: 10, decreeTimeoutMs: 5000 },
        god: { workerId: '', maxSteps: 20, maxQuestions: 5 },
        retry: { maxAttempts: 3, turnBudgetMs: 120000, backgroundBudgetMs: 600000, backups: {} },
    };
    const creationStore = createCreationStore({ call, store, publishEvent: (event, payload) => events.push([event, payload ?? {}]) });
    const god = createGod({
        call, callTool: async () => ({ ok: true }), store,
        getSettings: () => settings,
        getWorkers: () => [{ id: 'resolver', format: 'openai', model: 'flash' }],
        publishEvent: (event, payload) => events.push([event, payload ?? {}]),
        creation: creationStore, enqueue: job => job(),
        now: (() => { let value = 1000; return () => (value += 10); })(),
    });
    return { god, creationStore, papers, cycles, events, memory, settings };
}

test('God wakes to build the Creation when there is none, and the Creation lands in the chat memory', async () => {
    const answers = [
        [tc('creation_write', { sections: [{ title: 'Geography', text: 'Three islands and a reef.' }, { title: 'History', text: 'The old war.' }], comment })],
        [tc('scale_write', { system: 'Mana', principle: 'Will made real.', payment: 'mana and focus', rules: [{ name: 'Shape', needs: 'an image', yields: 'matter', weight: 'moderate' }], comment })],
        [tc('review_creation', { sections: [], systems: [], references: [], material: '', comment })],
        [tc('await', { reason: 'The world is written.', comment })],
    ];
    const { god, creationStore, events } = harness({ answers });
    const reason = await god.reasonNow();
    assert.equal(reason.kind, 'first');
    const result = await god.run({ runId: 'god_1', reason });
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, ['Geography', 'History']);
    assert.deepEqual(result.systems, ['Mana']);
    const state = creationStore.state();
    assert.equal(state.sections.find(section => section.title === 'Geography').text, 'Three islands and a reef.');
    assert.equal(state.sections.find(section => section.title === 'History').text, 'The old war.');
    assert.equal(state.scales.length, 1);
    assert.equal(state.scales[0].name, 'Mana');
    assert.ok(events.some(([event]) => event === 'decision.creation.written'));
});

test('a Prayer wakes God; the answer is a Discovery on its system, and the Prayer is marked read', async () => {
    const creation = { ...fullCreation(), scales: [mana()] };
    const answers = [
        [tc('discovery_write', { system: 'Mana', rule: 'Shape', text: 'Iron can be shaped into a bomb, once.', comment })],
        [tc('await', { reason: 'The prayer is answered.', comment })],
    ];
    const { god, creationStore, papers } = harness({ answers, creation, prayers: [prayer('Mana shaped iron into a bomb.')] });
    const reason = await god.reasonNow();
    assert.equal(reason.kind, 'prayer');
    assert.equal(reason.prayers.length, 1);
    const result = await god.run({ runId: 'god_2', reason });
    assert.equal(result.ok, true);
    const system = creationStore.state().scales.find(item => item.name === 'Mana');
    assert.equal(system.discoveries.length, 1);
    assert.match(system.discoveries[0].text, /shaped into a bomb/);
    assert.equal(papers.prayers[0].status, 'read', 'an answered Prayer does not wake God again');
    assert.equal(await god.reasonNow(), null, 'with a complete Creation and no Prayer left, God is silent');
});

test('a Declaration wakes God and is consumed after the Creation is updated', async () => {
    const creation = { ...fullCreation(), scales: [mana()] };
    const declaration = { answers: [{ question: 'Is there iron ore?', answer: 'Yes, under the reef.', at: 2 }], at: 2, delivered: false };
    const answers = [
        [tc('creation_write', { sections: [{ title: 'Geography', text: 'Three islands, and iron under the reef.' }], comment })],
        [tc('review_creation', { sections: [], systems: [], references: [], material: '', comment })],
        [tc('await', { reason: 'The Declaration is written in.', comment })],
    ];
    const { god, creationStore, papers } = harness({ answers, creation, declaration });
    const reason = await god.reasonNow();
    assert.equal(reason.kind, 'declaration');
    const result = await god.run({ runId: 'god_3', reason });
    assert.equal(result.ok, true);
    assert.match(creationStore.state().sections.find(section => section.title === 'Geography').text, /iron under the reef/);
    assert.equal(papers.god.declaration, null, 'a delivered Declaration does not wake God again');
});

test('ask puts God\'s questions into the Counsellor queue, and the limit is honest', async () => {
    const creation = { ...fullCreation(), scales: [mana()] };
    const answers = [
        [tc('ask', { questions: [{ question: 'Is there iron ore?', why: 'the mines' }], comment })],
        [tc('await', { reason: 'Asked.', comment })],
    ];
    const { god, papers } = harness({ answers, creation, prayers: [prayer('Mana was used.')], declaration: null });
    // Декларации нет — будим Молитвой, ask всё равно работает.
    const reason = await god.reasonNow();
    await god.run({ runId: 'god_4', reason });
    assert.equal(papers.god.questions.length, 1);
    assert.equal(papers.god.questions[0].question, 'Is there iron ore?');
});

test('Creation never wakes God on an ordinary turn without a Prayer: the build belongs to the opening of the chat', async () => {
    const { god } = harness({ answers: [] });
    assert.deepEqual(await god.maybeRun(), { skipped: true });
    // Со Страницей, которая зовёт `allowBuild: true`, первый запуск строится.
    const reason = await god.reasonNow({ allowBuild: true });
    assert.equal(reason.kind, 'first');
});

test('a new world is studied first: God asks before it shapes, and an open question holds the build', async () => {
    const fresh = harness({ studied: false });
    assert.equal((await fresh.god.reasonNow({ allowBuild: true })).kind, 'study');
    const waiting = harness({ questions: [{ id: 'q1', question: 'Where does the story start?', answer: '' }] });
    assert.equal(await waiting.god.reasonNow({ allowBuild: true }), null, 'no build while the user has not answered');
    const answered = harness({ declaration: { answers: [{ id: 'q1', question: 'Where does the story start?', answer: 'Before arc 1.' }] } });
    const reason = await answered.god.reasonNow({ allowBuild: true });
    assert.equal(reason.kind, 'declaration');
});

test('a full Creation and no Prayer mean no reason: God stays silent', async () => {
    const { god } = harness({ creation: { ...fullCreation(), scales: [mana()] } });
    assert.equal(await god.reasonNow({ allowBuild: true }), null);
});

test('the God context carries the world material, never the characters as cards, and the task with the CoT at the end', () => {
    const material = godMaterial({
        lorebookEntries: [
            { book: 'World', uid: 1, comment: 'The Reef', content: 'Three islands.' },
            { book: 'World', uid: 2, comment: 'Aria', content: 'A girl with a sword.' },
        ],
        cards: [{ name: 'Aria', scenario: 'A drowned world.' }],
        marks: { World: { marks: [{ uid: 2, name: 'Aria' }] } },
    });
    assert.match(material, /Three islands/);
    assert.match(material, /A drowned world/);
    assert.doesNotMatch(material, /A girl with a sword/, 'a character entry is a data bank, not the world');
    const built = buildGodContext({ material, kind: 'build', maxQuestions: 5, rpTime: 'Day 1, 08:00' });
    assert.equal(built.messages[0].content, GOD_SYSTEM);
    assert.ok(built.messages.some(message => message.content.startsWith(GOD_MATERIAL_HEADER)));
    assert.ok(built.messages.some(message => message.content === `${GOD_RP_HEADER} Day 1, 08:00`));
    const last = built.messages.at(-1).content;
    assert.ok(last.includes(GOD_THINK_BUILD));
    assert.ok(last.startsWith(GOD_BUILD_TASK.replace('{{material}}', material).replace('{{max_questions}}', '5')));
});

test('the Prayer context shows the Prayer and the systems it touches, with the rules and without the old Discoveries', () => {
    const creation = { ...fullCreation(), scales: [mana(), normalizeScaleSystem({ system: 'Craft', principle: 'Hands.', rules: [] })] };
    const prayers = [prayer('Mana shaped iron into a blade.')];
    assert.deepEqual(systemsForPrayers(creation, prayers).map(system => system.name), ['Mana']);
    const context = buildGodContext({ creation, kind: 'prayer', prayers, rpTime: 'Day 1, 08:00' });
    assert.ok(context.messages.some(message => message.content.startsWith(GOD_PRAYERS_HEADER)));
    assert.ok(context.messages.some(message => message.content.startsWith(GOD_SCALES_HEADER)));
    const systems = context.messages.find(message => message.content.startsWith(GOD_SCALES_HEADER)).content;
    assert.match(systems, /Shape/);
    assert.match(systems, /moderate/);
    assert.doesNotMatch(systems, /DISCOVERIES/);
    const task = context.messages.at(-1).content;
    assert.ok(task.includes(GOD_PRAYER_TASK.replace('{{prayers}}', renderSystemsForPrayers([mana()])).slice(0, 20)));
    assert.ok(task.includes(GOD_THINK_PRAYER));
});

test('the Declaration context is one block of answers and the task says the answer wins', () => {
    const context = buildGodContext({ creation: { ...fullCreation(), scales: [mana()] }, kind: 'declaration', declaration: { answers: [{ question: 'Is there iron?', answer: 'Yes, under the reef.' }] } });
    const escaped = GOD_DECLARATION_TASK.replace('{{declaration}}', 'Q: Is there iron?\nA: Yes, under the reef.');
    assert.equal(context.messages.at(-1).content, escaped);
    assert.match(context.messages.at(-1).content, /the answer wins/);
});

test('only unanswered Prayers are a reason, and the last twelve at most', () => {
    assert.equal(queuedPrayers([{ text: 'x', status: 'read' }]).length, 0);
    assert.equal(queuedPrayers([{ text: 'x' }]).length, 1, 'a line without a status is unread');
    const many = Array.from({ length: 20 }, (_, index) => ({ text: `prayer ${index}`, status: 'queued' }));
    assert.equal(queuedPrayers(many).length, 12);
    assert.equal(queuedPrayers(many).at(-1).text, 'prayer 19');
});

test('new Discoveries since the resolver\'s snapshot travel as a short block at the task', () => {
    const creation = {
        ...fullCreation(),
        scales: [normalizeScaleSystem({
            system: 'Mana', rules: [{ name: 'Shape', needs: 'an image', yields: 'matter', weight: 'moderate' }],
            discoveries: [{ at: '[Day 1]', rule: 'Shape', text: 'old news', seq: 1 }, { at: '[Day 2]', rule: 'Shape', text: 'iron can burn', seq: 2 }],
        })],
        snapshots: { at: '[Day 1]', seq: 1 },
    };
    // Блок считается от номера снимка резолвера: всё новее снимка — новое для него.
    const block = discoveriesBlock(creation, 1);
    assert.match(block, /iron can burn/);
    assert.doesNotMatch(block, /old news/);
    assert.equal(discoveriesBlock(creation, 2), '');
});

test('while building, God cannot rest before a clean review form; an open item comes back to him', async () => {
    const world = harness({ answers: [
        [tc('await', { reason: 'Done.', comment })],
        [tc('review_creation', { sections: [], systems: [], references: [{ file: 'Creation/Scales/magic.md', exists: false }], material: '', comment })],
        [tc('review_creation', { sections: [], systems: [], references: [], material: '', comment })],
        [tc('await', { reason: 'Done.', comment })],
    ] });
    const result = await world.god.run({ runId: 'g-review', reason: { kind: 'first', wake: { type: 'god', label: 'build', detail: '' } } });
    const trace = result.cycle.toolCalls.map(item => item.name);
    assert.deepEqual(trace.filter(name => name === 'review_creation').length, 2);
    assert.equal(trace.at(-1), 'await');
});

test('each file written while building gets a form built from its own subsections, and must be reviewed before God rests', async () => {
    const geography = '# Geography\n\n### Lugunica\nA kingdom.\n\n### Gusteko\nThe north.';
    const all = count => Array.from({ length: count }, (_, index) => ({ item: String(index), done: true }));
    const world = harness({ answers: [
        [tc('create', { path: 'Creation/geography.md', text: geography, comment })],
        [tc('await', { reason: 'Done.', comment })],
        [tc('review_file', { file: 'Creation/geography.md', items: [{ item: 'travel table', done: false, missing: 'no table' }], comment })],
        [tc('review_file', { file: 'Creation/geography.md', items: all(7), comment })],
        [tc('review_creation', { references: [], material: '', comment })],
        [tc('await', { reason: 'Done.', comment })],
    ] });
    const result = await world.god.run({ runId: 'g-files', reason: { kind: 'first', wake: { type: 'god', label: 'build', detail: '' } } });
    const calls = result.cycle.toolCalls;
    const form = calls.find(item => item.name === 'create').result.review.form;
    assert.equal(form.length, 7, 'the whole-file items, the marking item and one per place');
    assert.ok(form.some(item => item.startsWith('"Lugunica"')) && form.some(item => item.startsWith('"Gusteko"')));
    assert.equal(calls.filter(item => item.name === 'review_file')[0].result.ok, false, 'a form answered short is refused');
    assert.equal(calls.at(-1).name, 'await');
});

test('after an edit the form holds only the changed subsections', async () => {
    const { godFileForm } = await import('../libraries/core/god-file-form.js');
    const before = '# Geography\nintro\n\n### A\none\n\n### B\ntwo';
    const after = '# Geography\nintro\n\n### A\none\n\n### B\ntwo, changed';
    assert.deepEqual(godFileForm('Creation/geography.md', after, before).map(item => item.slice(0, 3)), ['"B"']);
    assert.ok(godFileForm('Creation/geography.md', `${after}\n\n### C\nthree`, after).length > 1, 'a new subsection brings the whole-file items back');
    const system = '# Magic\n**Principle:** x\n\n## Cast\nNeeds: a\n\n## Ward\nNeeds: b\n\n## Discoveries\n';
    assert.equal(godFileForm('Creation/Scales/magic.md', system).filter(item => /^"(Cast|Ward)"/.test(item)).length, 2, 'every rule of a system is its own item; Discoveries is not');
    const scales = '# Scales\n| System | Principle | Who has it | Payment |\n|---|---|---|---|\n| Magic | mana | many | od |\n| Spirit Arts | pacts | few | mana |';
    assert.equal(godFileForm('Creation/scales.md', scales).filter(item => item.startsWith('System "')).length, 2, 'every row of the Scales table is its own item');
});
