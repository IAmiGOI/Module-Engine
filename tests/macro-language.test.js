import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parse, run, execute, collectGetKeys, MacroSyntaxError, MacroRuntimeError, MacroTimeoutError } from '../libraries/core/macro-language.js';

function runSource(source, options) {
    return run(parse(tokenize(source)), options);
}

test('a program with just "return <expr>" returns that expression\'s value', () => {
    assert.equal(runSource('return 42'), '42');
    assert.equal(runSource('return "hello"'), 'hello');
});

test('set/return round-trips a variable', () => {
    assert.equal(runSource('set x to 5\nreturn x'), '5');
});

test('arithmetic: + - * / mod, with standard precedence and parentheses', () => {
    assert.equal(runSource('return 2 + 3 * 4'), '14');
    assert.equal(runSource('return (2 + 3) * 4'), '20');
    assert.equal(runSource('return 10 / 4'), '2.5');
    assert.equal(runSource('return 10 mod 3'), '1');
    assert.equal(runSource('return -5 + 2'), '-3');
});

test('+ concatenates when either side is non-numeric, adds when both are numeric', () => {
    assert.equal(runSource('return "a" + "b"'), 'ab');
    assert.equal(runSource('return 1 + 2'), '3');
    assert.equal(runSource('return "x" + 1'), 'x1');
});

test('division by zero is a MacroRuntimeError, not Infinity/NaN', () => {
    assert.throws(() => runSource('return 1 / 0'), MacroRuntimeError);
});

test('comparisons: is / is not / > < >= <=', () => {
    assert.equal(runSource('return 1 is 1'), 'true');
    assert.equal(runSource('return 1 is not 2'), 'true');
    assert.equal(runSource('return 5 > 3'), 'true');
    assert.equal(runSource('return 5 <= 5'), 'true');
});

test('logical and/or/not, with short-circuiting for "and"/"or"', () => {
    assert.equal(runSource('return true and false'), 'false');
    assert.equal(runSource('return true or false'), 'true');
    assert.equal(runSource('return not true'), 'false');
});

test('if/then/else branches correctly on truthiness', () => {
    assert.equal(runSource('if 1 > 0 then\nreturn "yes"\nelse\nreturn "no"\nend'), 'yes');
    assert.equal(runSource('if 0 > 1 then\nreturn "yes"\nelse\nreturn "no"\nend'), 'no');
});

test('repeat N times loops exactly N times', () => {
    assert.equal(runSource('set n to 0\nrepeat 5 times\nset n to n + 1\nend\nreturn n'), '5');
});

test('while loops until its condition goes false', () => {
    assert.equal(runSource('set n to 0\nwhile n < 3\nset n to n + 1\nend\nreturn n'), '3');
});

test('a "return" inside a nested if/repeat/while exits the whole program immediately', () => {
    assert.equal(runSource('repeat 10 times\nreturn "early"\nend\nreturn "late"'), 'early');
});

test('get "key" resolves through the injected get() callback, synchronously', () => {
    const result = runSource('return get "someKey"', { get: key => key === 'someKey' ? 'resolved-value' : undefined });
    assert.equal(result, 'resolved-value');
});

test('save x as "key" calls the injected save() callback with the evaluated value', () => {
    const saved = [];
    runSource('save 1 + 2 as "total"', { save: (key, value) => saved.push({ key, value }) });
    assert.deepEqual(saved, [{ key: 'total', value: 3 }]);
});

test('a program that runs past its time limit throws MacroTimeoutError', () => {
    assert.throws(() => runSource('while true\nend\nreturn 1', { timeLimitMs: 5 }), MacroTimeoutError);
});

test('a syntax error (missing "end") throws MacroSyntaxError with a line number', () => {
    try {
        parse(tokenize('if true then\nreturn 1'));
        assert.fail('expected a MacroSyntaxError');
    } catch (error) {
        assert.ok(error instanceof MacroSyntaxError);
        assert.ok(Number.isInteger(error.line));
    }
});

test('execute() never throws — a syntax error becomes { ok: false, error }', () => {
    const result = execute('if true then\nreturn 1');
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof MacroSyntaxError);
});

test('execute() never throws — a runtime error becomes { ok: false, error }', () => {
    const result = execute('return 1 / 0');
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof MacroRuntimeError);
});

test('execute() on success returns { ok: true, value }', () => {
    assert.deepEqual(execute('return 1 + 1'), { ok: true, value: '2' });
});

test('collectGetKeys() finds every get "..." literal anywhere in the program, without running it', () => {
    const ast = parse(tokenize('set a to get "keyA"\nif get "keyB" > 0 then\nreturn get "keyC"\nend\nreturn a'));

    assert.deepEqual(collectGetKeys(ast).sort(), ['keyA', 'keyB', 'keyC']);
});

test('collectGetKeys() on a program with no get at all returns an empty list', () => {
    const ast = parse(tokenize('return 1 + 1'));

    assert.deepEqual(collectGetKeys(ast), []);
});
