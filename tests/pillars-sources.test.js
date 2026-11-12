import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toLaneEntries, toLane, toLedger, toBookVolume, toCharter, toSky, toCourt,
    textToBlocks, page, makeRecord, constellationStars, clockLabel, BOOK_PARTS, gap, charterPatch,
} from '../libraries/core/pillars-sources.js';
import { lanesFrom, splitEntry } from '../libraries/core/court-lanes.js';

const cycle = (overrides = {}) => ({
    id: 'c1', event: 'turn', turn: 4, at: 1730000000000, clockMinutes: 600,
    rows: [], ...overrides,
});

test('a lane record reads as what happened, in the words the engine already uses', () => {
    const entry = cycle({
        rows: [
            { kind: 'call', name: 'inscribe', args: { characters: [{ character: 'Emilia' }, { character: 'Puck' }], stop: 'dawn' } },
            { kind: 'push', text: 'INSCRIPTION' },
        ],
    });
    const records = toLaneEntries([entry]);
    const resolver = records.find(record => record.lane === 'resolver');
    const writer = records.find(record => record.lane === 'writer');
    assert.equal(resolver.title, 'Inscription — Emilia, Puck');
    assert.equal(resolver.when, 'Turn 4 · RP 10:00');
    assert.deepEqual(resolver.fields, [['Stops at', 'dawn']]);
    assert.ok(writer, 'the Inscription goes to the Writer lane too');
    assert.equal(writer.title, 'The Writer gets the Inscription');
    assert.equal(toLane([entry], 'resolver').length, 1);
    assert.deepEqual(toLane([entry], 'writer').map(record => record.lane), ['writer']);
});

test('an open question of God becomes a record with a prompt — the "God awaits your answer" state', () => {
    const entry = cycle({ event: 'god', rows: [{ kind: 'god_questions', questions: [{ id: 'gq1', question: 'Is the law older?', why: 'It shapes the slums.' }] }] });
    const records = toLaneEntries([entry]);
    const ask = records.find(record => record.ask);
    assert.equal(ask.lane, 'god');
    assert.equal(ask.ask.prompt, 'Is the law older?');
    assert.equal(ask.ask.id, 'gq1');
    assert.equal(ask.title, 'God asks you');
    assert.equal(ask.summary, 'It shapes the slums.'); // summary — first row piece is a call; here it falls back to empty
});

test('the ledger keeps replies, telegrams and prayers, newest first', () => {
    const chat = [
        cycle({ turn: 2, rows: [{ kind: 'message', text: 'Make it darker' }, { kind: 'telegram', text: 'A guard knows her face' }] }),
        cycle({ turn: 5, rows: [{ kind: 'prayer', text: 'Let the slums have law' }] }),
        cycle({ turn: 3, rows: [{ kind: 'telemetry', text: 'ignored kind' }, { kind: 'counsellor_reply', text: 'Noted.' }] }),
    ];
    const ledger = toLedger(chat);
    assert.deepEqual(ledger.map(record => record.turn), [5, 3, 2, 2]);
    assert.equal(ledger[0].title, 'Prayer');
    assert.ok(ledger.some(record => record.title === 'Telegram'));
    assert.ok(ledger.some(record => record.summary === 'Noted.'));
});

test('a book volume: contents, five parts per character, every page has a folio at the outer edge', () => {
    const great = {
        emilia: {
            name: 'Emilia', importance: 'main',
            material: { 1: ['Silver hair to the waist'], 5: ['A white cloak'] },
            spiritual: { 1: ['No one is left behind'] },
            decree: { 1: ['She carries the Dragon Insignia'] },
            knowledge: { items: [{ id: 'k1', fact: 'A stranger knows her name' }] },
            history: [{ at: 'Day 1, 09:29', by: 'director', old: '', new: 'Relies on Subaru', comment: '' }],
        },
        felt: { name: 'Felt', importance: 'side', material: {}, spiritual: {}, decree: {}, knowledge: { items: [] }, history: [] },
    };
    const book = toBookVolume('bank', { great });
    assert.equal(book.kind, 'bank');
    assert.equal(book.coverEmblem, 'bank');
    assert.equal(book.characters.length, 2);
    assert.equal(book.characters[0].name, 'Emilia', 'main cast first');
    // contents + 2 characters × 5 parts
    assert.equal(book.spreads.length, 1 + 2 * BOOK_PARTS.length);
    assert.deepEqual(book.spreads[0].right.blocks[1].pairs.map(([name]) => name.split(' · ')[0]), ['Emilia', 'Felt']);
    const materialSpread = book.spreads[1];
    assert.equal(materialSpread.left.blocks.find(block => block.type === 'heading').text, 'Emilia');
    const right = materialSpread.right.blocks;
    assert.equal(right[0].text, 'Material');
    assert.deepEqual(right[1].pairs, [['Appearance', 'Silver hair to the waist'], ['Clothing', 'A white cloak']]);
    assert.equal(materialSpread.right.folio, '4', 'folios run 2n+2 / 2n+3');
    const parts = book.spreads.slice(1).filter(spread => spread.left.blocks.some(block => block.type === 'note' && /chapter/.test(block.text)));
    assert.equal(parts.length, 10);
    const historySpread = book.spreads.find(spread => spread.right.blocks[0]?.text === 'History');
    assert.equal(historySpread.right.blocks[1].type, 'amend');
    assert.equal(historySpread.right.blocks[1].now, 'Relies on Subaru');
    const knowledgeSpread = book.spreads.find(spread => spread.right.blocks[0]?.text === 'Knowledge');
    assert.equal(knowledgeSpread.right.blocks[1].type, 'pairs');
    assert.deepEqual(book.ribbons.map(ribbon => ribbon.id), [...BOOK_PARTS]);
    assert.equal(book.thumbs[0].id, 'contents');
});

test('a world volume reads Creation and Scales as the same book, with Prayers at the end', () => {
    const world = toBookVolume('world', {
        creation: {
            sections: [{ key: 'history', title: 'History', text: 'Four hundred years ago the Witch…' }],
            scales: [{ id: 'mana', name: 'Mana and Gates', principle: 'A gate has a number', rules: [{ name: 'Pool', needs: 'a gate', yields: 'mana' }] }],
        },
        prayers: [{ id: 'p1', who: 'Sasha', text: 'Let the slums have law' }],
    });
    assert.equal(world.kind, 'world');
    assert.equal(world.coverEmblem, 'world');
    assert.deepEqual(world.ribbons.map(ribbon => ribbon.label), ['Creation', 'Scales', 'Prayers']);
    const creationSpread = world.spreads[1];
    assert.equal(creationSpread.left.blocks.find(block => block.type === 'heading').text, 'History');
    assert.ok(creationSpread.right.blocks.some(block => block.type === 'text' && /Witch/.test(block.text)));
    assert.deepEqual(creationSpread.right.blocks.at(-1).actions, [{ id: 'amend', label: 'amend the page' }]);
    const prayerSpread = world.spreads.at(-1);
    assert.equal(prayerSpread.right.blocks[1].type, 'pairs');
    assert.deepEqual(prayerSpread.right.blocks[1].pairs, [['Sasha', 'Let the slums have law']]);
});

test('the charter turns settings into articles with blanks, and prompts into appendices', () => {
    const settings = {
        decider: { workerId: 'director', maxTokens: 24000 }, writer: { workerId: 'writer', maxTokens: 6000 },
        god: { workerId: 'god', maxTokens: 32000 }, windowLimit: 40, compressedLimitTokens: 300000, archiveLimitTokens: 200000,
        gameDefaults: {},
    };
    const workers = [{ id: 'director', model: 'Claude Opus', name: 'Anthropic main' }, { id: 'writer', model: 'Kimi K2' }, { id: 'god', model: 'Claude Opus' }];
    const prompts = [{ id: 'built-in/director/sys.md', name: 'DIRECTOR_SYSTEM', text: 'You are the Resolver.' }];
    const charter = toCharter(settings, { workers, prompts });
    assert.equal(charter.kind, 'charter');
    assert.deepEqual(charter.chapters.map(chapter => chapter.id), ['voices', 'story', 'memory']);
    const god = charter.chapters[0].articles.find(article => article.id === 'voices-god');
    const blanks = god.text.filter(piece => typeof piece === 'object');
    assert.deepEqual(blanks.map(blank => blank.key), ['god-model', 'god-profile', 'god-tokens']);
    assert.equal(blanks[0].value, 'Claude Opus');
    assert.ok(blanks[0].options.includes('Claude Opus'));
    assert.ok(god.text.some(piece => piece === 'God'), 'the voice name is plain text, not a blank');
    const story = charter.chapters[1].articles.find(article => article.id === 'story-difficulty');
    const difficulty = story.text.find(piece => typeof piece === 'object');
    assert.equal(difficulty.value, 'Normal', 'a missing game setting falls back to its Classic value');
    assert.ok(difficulty.options.includes('Brutal'));
    assert.equal(charter.appendices.length, 1);
    assert.equal(charter.appendices[0].letter, 'A');
    assert.match(charter.appendices[0].meta, /tokens/);
    assert.ok(charter.appendices[0].usage, 'each appendix says where the prompt lands in context');
});

test('the sky: saved worlds are constellations, the present world is a loose scatter with a seal action', () => {
    const canon = {
        key: 'books:a::cards:emilia',
        canons: [{ id: 'c1', name: 'The Ashen Vale', createdAt: 1730000000000, great: { maren: {}, tobias: {} }, banks: {}, cast: [{ name: 'Maren', main: true }, { name: 'Tobias', main: true }, { name: 'Wren' }] }],
        current: { name: 'ReZero', meta: 'Day 1 · 10:52 · not yet bound', cast: [{ name: 'Emilia', main: true }, { name: 'Felt' }] },
    };
    const sky = toSky(canon);
    assert.equal(sky.kind, 'sky');
    assert.equal(sky.constellations.length, 2);
    const saved = sky.constellations[0];
    assert.equal(saved.name, 'The Ashen Vale');
    assert.ok(saved.line.startsWith('M'), 'a sealed constellation has a drawn line');
    assert.deepEqual(saved.stars.map(star => star.name), ['Maren', 'Tobias', 'Wren']);
    assert.equal(saved.stars[0].r, 5, 'main cast stars are bigger');
    assert.deepEqual(saved.actions.map(action => action.id), ['choose', 'export', 'delete']);
    assert.equal(saved.actions[0].call, 'decision.canonApply');
    const now = sky.constellations[1];
    assert.equal(now.unsealed, true);
    assert.equal(now.line, '', 'the present world is a scatter without lines');
    assert.equal(now.actions[0].call, 'decision.canonSave');
    assert.deepEqual(constellationStars([], 1), { stars: [], line: '', low: 0 });
});

test('the court: five roles at their angles, working ones lit, an open question lights God, turns and files', () => {
    const entries = [
        cycle({ id: 'c1', event: 'turn', running: true, rows: [{ kind: 'call', name: 'inscribe', args: { characters: [{ character: 'Emilia' }] } }] }),
        cycle({ id: 'c2', event: 'god', rows: [{ kind: 'god_questions', questions: [{ id: 'gq1', question: 'Older?', why: '' }] }] }),
    ];
    const court = toCourt({
        entries, working: ['resolver'], clock: { minutes: 652 }, name: 'ReZero RPG', place: 'the fountain',
        god: { questions: [{ id: 'gq1', question: 'Older?' }, { id: 'gq2', question: 'Answered?', answer: 'Yes' }] },
        files: [{ path: 'Creation/History.md', text: 'Four hundred years…', role: 'god' }],
        turns: [1, 2, 4],
    });
    assert.equal(court.kind, 'court');
    assert.deepEqual(court.roles.map(role => role.id), ['god', 'director', 'counsellor', 'resolver', 'writer']);
    const byId = Object.fromEntries(court.roles.map(role => [role.id, role]));
    assert.equal(byId.resolver.lit, true);
    assert.equal(byId.god.lit, true, 'an open question lights God');
    assert.equal(byId.director.lit, false);
    assert.equal(byId.god.records[0].ask.prompt, 'Older?');
    assert.equal(byId.god.records.some(record => record.ask?.id === 'gq2'), false, 'answered questions are not asked again');
    assert.equal(court.rpTime, '10:52');
    assert.deepEqual(court.turns, [{ n: 1, label: '1' }, { n: 2, label: '2' }, { n: 4, label: '4' }]);
    assert.equal(court.files[0].path, 'Creation/History.md');
    assert.equal(court.files[0].tokens, 5);
    assert.ok(court.files[0].usage);
});

test('the one-function extension point: plain text becomes page blocks a new source can plug in', () => {
    const blocks = textToBlocks('# History\nA long war.\n\n- Era: the Pact\n- Ruler: none');
    assert.deepEqual(blocks, [
        { type: 'heading', text: 'History' },
        { type: 'text', text: 'A long war.' },
        { type: 'pairs', pairs: [['Era', 'the Pact']] },
        { type: 'pairs', pairs: [['Ruler', 'none']] },
    ]);
    assert.deepEqual(page(blocks, 12), { blocks, folio: '12' });
    assert.deepEqual(makeRecord({ id: ' x ', turn: '3', fields: [['A', 'b'], ['C', '']] }).fields, [['A', 'b']]);
    assert.equal(clockLabel(652), '10:52');
    assert.equal(gap('k', 'v', ['v', 'w', 'w']).options.join(','), 'v,w');
});

test('lane records keep the same split the Court window uses (no second model of the same feed)', () => {
    const entry = cycle({ rows: [{ kind: 'call', name: 'decree', args: { decrees: [{ character: 'Felt' }] } }, { kind: 'push', text: 'PUSH' }] });
    const ours = toLaneEntries([entry]).map(record => record.lane).sort();
    const theirs = Object.keys(splitEntry(entry)).sort();
    assert.deepEqual(ours, theirs);
    assert.deepEqual(Object.keys(lanesFrom([entry])).sort(), ['counsellor', 'director', 'god', 'resolver', 'simulator', 'writer']);
});

test('book spreads say whose they are, so a thumb or ribbon finds its page', () => {
    const volume = toBookVolume('bank', { great: { a: { name: 'Ann', importance: 'main' } } });
    assert.equal(volume.spreads[0].who, 'contents');
    assert.deepEqual(volume.spreads.slice(1).map(s => [s.who, s.part]), BOOK_PARTS.map(part => ['a', part]));
    const world = toBookVolume('world', { creation: { sections: [{ key: 'history', title: 'History', text: 'Old.' }], scales: [{ id: 'mana', name: 'Mana' }] } });
    assert.deepEqual(world.spreads.map(s => s.who), ['contents', 'history', 'mana', 'prayers']);
    assert.deepEqual(world.spreads.map(s => s.group ?? null), [null, 'creation', 'scales', 'prayers']);
});

test('sealing the Charter turns changed gaps into whole-role settings and game options', () => {
    const settings = { decider: { workerId: 'w1', maxTokens: 8000, temperature: 0.7 }, windowLimit: 50 };
    const workers = [{ id: 'w1', model: 'opus' }, { id: 'w2', model: 'kimi' }];
    const { configure, game } = charterPatch(settings, workers, [
        { key: 'resolver-tokens', value: '16000' },
        { key: 'resolver-model', value: 'kimi' },
        { key: 'memory-window', value: '100' },
        { key: 'story-difficulty', value: 'Hard' },
        { key: 'unknown', value: 'x' },
    ]);
    assert.deepEqual(configure, { decider: { workerId: 'w2', maxTokens: 16000, temperature: 0.7 }, windowLimit: 100 });
    assert.deepEqual(game, { difficulty: 'hard' });
});
