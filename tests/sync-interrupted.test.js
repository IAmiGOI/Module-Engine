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
