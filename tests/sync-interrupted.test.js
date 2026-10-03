import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';

/**
 * Обрыв синхронизации не должен плодить копии-конфликты (баг: по 4–5 копий одного персонажа).
 * Механика: проход качает карточку, ST при импорте ПЕРЕПИСЫВАЕТ её байты (другой хеш при том же содержимом); база и кэш хешей пишутся
 * только в контрольных точках, поэтому после обрыва следующий проход видит «обе стороны изменились» и, раньше, делал копию.
 */
function memorySide({ initial = {}, rewrite = null } = {}) {
    const files = new Map(Object.entries(initial).map(([path, text]) => [path, { text, modified: 1 }]));
    return {
        files,
        async manifest() {
            const out = {};
            for (const [path, { text, modified }] of files) out[path] = { hash: await computeGitBlobSha(new TextEncoder().encode(text)), size: text.length, modified };
            return out;
        },
        async read(path) { return new Blob([files.get(path).text]); },
        async write(path, blob, meta) {
            const text = await blob.text();
            files.set(path, { text: rewrite ? rewrite(text) : text, modified: meta?.modified ?? 1 });
        },
        async remove(path) { files.delete(path); },
    };
}
const hashOf = text => computeGitBlobSha(new TextEncoder().encode(text));
const copiesIn = side => [...side.files.keys()].filter(path => path.includes('(conflict'));
// «Тот же персонаж» = то же содержимое до пометки импорта ST.
const sameContent = async (_path, a, b) => (await a.text()).split('#')[0] === (await b.text()).split('#')[0];

test('an interrupted pull of a card that ST rewrites on import does not turn into a conflict copy on the next pass', async () => {
    const path = 'characters/Anna.png';
    const local = memorySide({ initial: { [path]: 'card v1' }, rewrite: text => `${text}#imported` });
    const remote = memorySide({ initial: { [path]: 'card v2' } });
    const oldBase = { [path]: await hashOf('card v1') };
    await runSync({ local, remote, base: oldBase, conflictLabel: 'Phone', sameContent });
    // Обрыв: результат прохода (база/кэш) не сохранён — следующий проход стартует со старой базой, а файл на диске уже переписан.
    const second = await runSync({ local, remote, base: oldBase, conflictLabel: 'Phone 2', sameContent });
    assert.equal(second.counts.conflicts, 0);
    assert.deepEqual(copiesIn(local), []);
    assert.deepEqual(copiesIn(remote), []);
    assert.equal(second.ok, true);
});

test('after the reconciled pass a third pass is quiet — nothing keeps moving back and forth', async () => {
    const path = 'characters/Anna.png';
    const local = memorySide({ initial: { [path]: 'card v1' }, rewrite: text => `${text}#imported` });
    const remote = memorySide({ initial: { [path]: 'card v2' } });
    const oldBase = { [path]: await hashOf('card v1') };
    await runSync({ local, remote, base: oldBase, conflictLabel: 'P', sameContent });
    const second = await runSync({ local, remote, base: oldBase, conflictLabel: 'P', sameContent });
    const third = await runSync({ local, remote, base: second.base, conflictLabel: 'P', sameContent });
    assert.deepEqual([third.counts.pushed, third.counts.pulled, third.counts.conflicts], [0, 0, 0]);
});

test('a conflict retried after an interruption reuses the copy it already made instead of creating another one', async () => {
    const local = memorySide({ initial: { 'chats/log.jsonl': 'from phone', 'chats/log (conflict Phone 2026-10-03 10-00-00).jsonl': 'from pc' } });
    const remote = memorySide({ initial: { 'chats/log.jsonl': 'from pc', 'chats/log (conflict Phone 2026-10-03 10-00-00).jsonl': 'from pc' } });
    local.files.get('chats/log.jsonl').modified = 9;
    await runSync({ local, remote, base: {}, conflictLabel: 'Phone 2026-10-03 10-05-00' });
    assert.deepEqual(copiesIn(local), ['chats/log (conflict Phone 2026-10-03 10-00-00).jsonl']);
    assert.deepEqual(copiesIn(remote), ['chats/log (conflict Phone 2026-10-03 10-00-00).jsonl']);
    assert.equal(local.files.get('chats/log.jsonl').text, 'from phone');
    assert.equal(remote.files.get('chats/log.jsonl').text, 'from phone');
});

test('a conflict between two edits of a conflict copy itself never makes a copy of the copy', async () => {
    const copy = 'chats/log (conflict Phone 2026-10-03 10-00-00).jsonl';
    const local = memorySide({ initial: { [copy]: 'edited here' } });
    const remote = memorySide({ initial: { [copy]: 'edited there' } });
    local.files.get(copy).modified = 9;
    const result = await runSync({ local, remote, base: { [copy]: await hashOf('original') }, conflictLabel: 'PC 2026-10-03 11-00-00' });
    assert.deepEqual(copiesIn(local), [copy]);
    assert.deepEqual(copiesIn(remote), [copy]);
    assert.equal(result.counts.conflicts, 1);
    assert.equal(remote.files.get(copy).text, 'edited here');
});

test('a real conflict between genuinely different cards still keeps both versions', async () => {
    const path = 'characters/Anna.png';
    const local = memorySide({ initial: { [path]: 'card local' } });
    const remote = memorySide({ initial: { [path]: 'card remote' } });
    local.files.get(path).modified = 9;
    const result = await runSync({ local, remote, base: { [path]: await hashOf('card base') }, conflictLabel: 'Phone', sameContent });
    assert.equal(result.counts.conflicts, 1);
    assert.equal(copiesIn(local).length, 1);
    assert.equal(copiesIn(remote).length, 1);
});

// ── через настоящее Ядро: журнал состояния между проходами ──────────────────────────────────────────────────────────────────────
import { createFakeNetwork, createFakeClock } from './helpers/fake-sync-network.js';
import { createFakeDevice } from './helpers/fake-sync-device.js';
import { createFakeGithub } from './helpers/fake-github.js';

function githubDevice(files = {}, options = {}) {
    const network = createFakeNetwork(), clock = createFakeClock(), fake = createFakeGithub();
    const device = createFakeDevice({ id: '0000000000000001', name: 'PC', network, clock, files, ...options, overrides: { github: { enabled: true, repository: 'o/r', token: 'secret-token' } } });
    device.setHttp(fake.http);
    return { device, fake };
}
/** «Падение» между контрольными точками: запись базы и кэша не удаётся — как будто процесс умер, пока проход ещё шёл. */
function breakBaseWrites(device) {
    const set = device.state.set.bind(device.state);
    let transferring = false;   // скан до передач пишет кэш как обычно; «падение» — только после первого файла
    device.state.set = (key, value) => {
        if (key.startsWith('journal:')) transferring = true;
        if (transferring && (key.startsWith('base:') || key === 'cache')) throw new Error('crashed');
        return set(key, value);
    };
    return () => { device.state.set = set; };
}

test('the core writes a journal after every file and clears it once the base is saved', async () => {
    const { device } = githubDevice({ 'worlds/a.json': 'A', 'worlds/b.json': 'B' });
    const heal = breakBaseWrites(device);
    await device.call('sync.run', { target: 'github' }).catch(() => {});
    const journal = device.state.get('journal:github');
    assert.deepEqual(journal.map(item => item.path).sort(), ['worlds/a.json', 'worlds/b.json']);
    heal();
    await device.call('sync.run', { target: 'github' });
    assert.deepEqual(device.state.get('journal:github'), []);
    await device.core.stop();
});

test('a pass that crashed before saving its base is picked up from the journal: no conflict copy appears for files it had already moved', async () => {
    const { device, fake } = githubDevice({ 'worlds/a.json': 'A1' });
    await device.call('sync.run', { target: 'github' });                 // нормальный проход: база знает a.json = A1
    device.put('worlds/a.json', 'A2');                                    // правим локально
    const heal = breakBaseWrites(device);
    await device.call('sync.run', { target: 'github' }).catch(() => {});  // файл доехал, а база не сохранилась
    heal();
    const second = await device.call('sync.run', { target: 'github' });
    assert.equal(second.github.counts.conflicts, 0);
    assert.deepEqual(device.paths().filter(path => path.includes('(conflict')), []);
    assert.deepEqual(Object.keys(fake.files()).filter(path => path.includes('(conflict')), []);
    await device.core.stop();
});

test('end to end: a card ST rewrites on import survives an interrupted pull without a single copy, on both sides', async () => {
    const lossy = (path, text) => (path.startsWith('characters/') ? `${text}|imported` : null);
    const { device, fake } = githubDevice({ 'characters/Anna.png': 'CARD' }, { lossy });
    await device.call('sync.run', { target: 'github' });                  // карточка уехала в GitHub
    const other = githubDevice({}, { lossy });                            // второе устройство качает её и теряет базу при обрыве
    other.device.setHttp(fake.http);
    const heal = breakBaseWrites(other.device);
    await other.device.call('sync.run', { target: 'github' }).catch(() => {});
    heal();
    for (let pass = 0; pass < 3; pass += 1) await other.device.call('sync.run', { target: 'github' });
    for (const names of [other.device.paths(), Object.keys(fake.files())]) assert.deepEqual(names.filter(path => path.includes('(conflict')), []);
    await device.core.stop(); await other.device.core.stop();
});
