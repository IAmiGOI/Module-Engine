import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, satisfies, isValidRange } from '../libraries/core/semver.js';
import { parseModuleHeader } from '../libraries/core/module-header.js';
import { resolveLoadOrder } from '../libraries/core/module-order.js';
import { scanModuleSource, rewriteImports, listImports, computeSourceHash } from '../libraries/core/module-scan.js';

test('parseVersion() reads MAJOR.MINOR.PATCH and ignores a pre-release tail', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion('v0.2.1-beta+7'), [0, 2, 1]);
    assert.equal(parseVersion('1.2'), null);
    assert.equal(parseVersion('nope'), null);
    assert.equal(compareVersions([1, 2, 3], [1, 10, 0]), -1);
});

test('satisfies() covers caret, tilde, comparators, wildcards and AND', () => {
    assert.equal(satisfies('1.4.0', '^1.2.0'), true);
    assert.equal(satisfies('2.0.0', '^1.2.0'), false);
    assert.equal(satisfies('0.2.9', '^0.2.1'), true);
    assert.equal(satisfies('0.3.0', '^0.2.1'), false, '0.x caret locks the minor');
    assert.equal(satisfies('0.0.4', '^0.0.3'), false, '0.0.x caret locks the patch');
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
    assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
    assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
    assert.equal(satisfies('1.2.0', '>= 1.2.0'), true, 'space after operator');
    assert.equal(satisfies('1.9.9', '1.x'), true);
    assert.equal(satisfies('2.0.0', '1.x'), false);
    assert.equal(satisfies('1.2.5', '1.2'), true);
    assert.equal(satisfies('1.3.0', '1.2'), false);
    assert.equal(satisfies('9.9.9', '*'), true);
    assert.equal(satisfies('9.9.9', ''), true);
    assert.equal(satisfies('1.0.0', '>1.0.0'), false);
    assert.equal(satisfies('1.0.1', '>1.0.0'), true);
    assert.equal(satisfies('1.0.0', '<=1.0.0'), true);
});

test('satisfies() refuses a range it cannot read instead of silently saying yes', () => {
    assert.equal(satisfies('1.0.0', '^banana'), false);
    assert.equal(isValidRange('^banana'), false);
    assert.equal(isValidRange('^1.2.0'), true);
    assert.equal(satisfies('garbage', '*'), false);
});

const GOOD_HEADER = `/*@module
id: community.dice
title: Dice
description: Rolls dice.
version: 1.2.0
engine: ^0.2
requires: module.tracker@^1.0, core.map
rights: tracking.poll, ui.notify
network: false
*/
export const x = 1;`;

test('parseModuleHeader() reads every field without executing anything', () => {
    const result = parseModuleHeader(GOOD_HEADER);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.deepEqual(result.meta, {
        id: 'community.dice', title: 'Dice', description: 'Rolls dice.', version: '1.2.0', engine: '^0.2',
        requires: [{ id: 'module.tracker', range: '^1.0' }, { id: 'core.map', range: '*' }],
        rights: ['tracking.poll', 'ui.notify'], network: false, folder: null, factory: 'default',
    });
});

test('parseModuleHeader() applies defaults and tolerates a BOM and CRLF', () => {
    const result = parseModuleHeader('﻿/*@module\r\nid: module.tiny\r\nversion: 0.1.0\r\n*/');
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.meta.title, 'module.tiny');
    assert.equal(result.meta.engine, '*');
    assert.deepEqual(result.meta.requires, []);
    assert.equal(result.meta.network, false);
});

test('parseModuleHeader() rejects a missing header, bad id/version/range, unknown and duplicate keys', () => {
    assert.equal(parseModuleHeader('export const x = 1;').ok, false);
    assert.equal(parseModuleHeader('').ok, false);
    const bad = parseModuleHeader('/*@module\nid: Dice\nversion: 1.2\nengine: ^zzz\nrights: a\nwat: 1\nid: other.one\nnetwork: maybe\nrequires: Bad Id\n*/');
    assert.equal(bad.ok, false);
    const joined = bad.errors.join('\n');
    for (const needle of ['"id"', '"version"', '"engine"', 'unknown header key "wat"', 'duplicate header key "id"', '"network"', '"requires"']) {
        assert.ok(joined.includes(needle), `expected an error mentioning ${needle}, got:\n${joined}`);
    }
});

test('parseModuleHeader() only looks at the TOP of the file', () => {
    assert.equal(parseModuleHeader('const a = 1;\n/*@module\nid: module.late\nversion: 1.0.0\n*/').ok, false);
});

const meta = (id, version, requires = [], engine = '*') => ({ id, version, engine, requires: requires.map(([rid, range = '*']) => ({ id: rid, range })) });

test('resolveLoadOrder() puts dependencies first, deterministically', () => {
    const { order, blocked } = resolveLoadOrder([
        meta('module.c', '1.0.0', [['module.b']]),
        meta('module.b', '1.0.0', [['module.a']]),
        meta('module.a', '1.0.0'),
        meta('module.z', '1.0.0'),
    ], { engineVersion: '0.2.1' });
    assert.deepEqual(blocked, []);
    assert.deepEqual(order, ['module.a', 'module.z', 'module.b', 'module.c']);
});

test('resolveLoadOrder() blocks a missing/incompatible dependency and everything that depends on it, but not the rest', () => {
    const { order, blocked } = resolveLoadOrder([
        meta('module.ok', '1.0.0'),
        meta('module.needsGhost', '1.0.0', [['module.ghost']]),
        meta('module.child', '1.0.0', [['module.needsGhost']]),
        meta('module.old', '1.0.0', [['module.ok', '^2.0.0']]),
    ], { engineVersion: '0.2.1' });
    assert.deepEqual(order, ['module.ok']);
    const reasons = Object.fromEntries(blocked.map(b => [b.id, b.reason]));
    assert.match(reasons['module.needsGhost'], /not installed/);
    assert.match(reasons['module.child'], /cannot load/);
    assert.match(reasons['module.old'], /found 1\.0\.0/);
});

test('resolveLoadOrder() checks the engine version and accepts non-Module requirements from `available`', () => {
    const { order, blocked } = resolveLoadOrder([
        meta('module.future', '1.0.0', [], '^9.0.0'),
        meta('module.usesCore', '1.0.0', [['core.map', '>=0.3.0']]),
    ], { engineVersion: '0.2.1', available: new Map([['core.map', '0.3.5']]) });
    assert.deepEqual(order, ['module.usesCore']);
    assert.match(blocked.find(b => b.id === 'module.future').reason, /needs engine \^9\.0\.0/);
});

test('resolveLoadOrder() blocks a dependency cycle', () => {
    const { order, blocked } = resolveLoadOrder([
        meta('module.a', '1.0.0', [['module.b']]),
        meta('module.b', '1.0.0', [['module.a']]),
        meta('module.fine', '1.0.0'),
    ], { engineVersion: '0.2.1' });
    assert.deepEqual(order, ['module.fine']);
    assert.deepEqual(blocked.map(b => b.id).sort(), ['module.a', 'module.b']);
    assert.ok(blocked.every(b => /cycle/.test(b.reason)));
});

test('resolveLoadOrder() will not guess between two Modules sharing an id: it blocks that id entirely', () => {
    const { order, blocked } = resolveLoadOrder([meta('module.dup', '1.0.0'), meta('module.dup', '2.0.0'), meta('module.fine', '1.0.0')], { engineVersion: '0.2.1' });
    assert.deepEqual(order, ['module.fine']);
    assert.match(blocked.find(b => b.id === 'module.dup').reason, /duplicate/);
});

test('scanModuleSource() calls clean code scanned-safe and allows stme: imports', () => {
    const source = `import { h } from 'stme:ui/tree';\nimport { Button } from "stme:widgets";\nexport const a = 1;`;
    const result = scanModuleSource(source);
    assert.equal(result.tier, 'scanned-safe');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(listImports(source).map(i => i.specifier), ['stme:ui/tree', 'stme:widgets']);
});

test('scanModuleSource() rejects foreign imports, eval, dynamic import and computed global access', () => {
    for (const code of [
        `import x from 'https://evil.example/x.js';`,
        `import './sibling.js';`,
        `export { y } from "data:text/javascript,1";`,
        `eval('1')`,
        `const f = new Function('return 1');`,
        `const m = await import('stme:ui/tree');`,
        `window['fe' + 'tch']('x')`,
        `globalThis[name]()`,
        `({}).constructor.constructor('return 1')()`,
    ]) {
        assert.equal(scanModuleSource(code).tier, 'rejected', code);
    }
});

test('scanModuleSource() marks network/storage/ST access scanned-unsafe, with line numbers and a denied http contract', () => {
    const result = scanModuleSource(`const a = 1;\nawait fetch('/api');\n`);
    assert.equal(result.tier, 'scanned-unsafe');
    assert.equal(result.findings[0].rule, 'network');
    assert.equal(result.findings[0].line, 2);
    assert.deepEqual(result.deniedContracts, ['http.request']);
    assert.equal(scanModuleSource(`localStorage.x`).tier, 'scanned-unsafe');
    assert.equal(scanModuleSource(`SillyTavern.getContext()`).tier, 'scanned-unsafe');
});

test('scanModuleSource() does not punish network a Module honestly declared', () => {
    const result = scanModuleSource(`await fetch('/x')`, { declaredNetwork: true });
    assert.equal(result.tier, 'scanned-safe');
    assert.deepEqual(result.deniedContracts, []);
});

test('rewriteImports() swaps stme: specifiers for real URLs and fails loudly on an unknown one', () => {
    const resolve = path => (path === 'ui/tree' ? 'http://x/cores/ui/tree.js' : null);
    const ok = rewriteImports(`import { h } from 'stme:ui/tree';`, resolve);
    assert.equal(ok.ok, true);
    assert.equal(ok.source, `import { h } from 'http://x/cores/ui/tree.js';`);
    const bad = rewriteImports(`import q from "stme:nope";`, resolve);
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /unknown/);
});

test('computeSourceHash() is a stable SHA-256 of the exact text', async () => {
    const a = await computeSourceHash('abc');
    assert.equal(a, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.notEqual(await computeSourceHash('abc '), a);
});

test('rewriteImports() touches only real imports: `stme:<path>` mentioned in a comment or a string is left alone (found live: the catalog example failed to load)', () => {
    const resolve = path => (path === 'ui/tree' ? 'http://x/tree.js' : null);
    const source = "// imports only `stme:<path>` — see \"stme:nothing\"\nimport { h } from 'stme:ui/tree';\nconst note = 'stme:nothing';";
    const result = rewriteImports(source, resolve);
    assert.equal(result.ok, true, result.errors.join());
    assert.equal(result.source, "// imports only `stme:<path>` — see \"stme:nothing\"\nimport { h } from 'http://x/tree.js';\nconst note = 'stme:nothing';");
});
