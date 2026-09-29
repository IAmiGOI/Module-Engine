import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacroEngine } from '../libraries/core/pm-macros.js';

const engine = options => createMacroEngine({ values: { user: 'Sasha', char: 'Lena' }, ...options });

test('user and char macros and the legacy angle-bracket forms are replaced', () => {
    assert.equal(engine().substitute('{{user}} meets {{CHAR}}; <USER> waves to <BOT>'), 'Sasha meets Lena; Sasha waves to Lena');
});

test('a multi-line comment vanishes even when it contains braces and other macros', () => {
    assert.equal(engine().substitute('a{{// note\n{{user}} and } stuff\n}}b'), 'ab');
    assert.equal(engine().substitute('a{{//Toggle}}b'), 'ab');
});

test('trim removes the newlines around it', () => {
    assert.equal(engine().substitute('one\n\n{{trim}}\n\ntwo'), 'onetwo');
    assert.equal(engine().substitute('{{setvar::t::past}}\n{{trim}}\nrest'), 'rest');
});

test('a variable set earlier in the text is read later, and nested macros inside a value are resolved', () => {
    const e = engine();
    assert.equal(e.substitute('{{setvar::who::{{user}}, hi}}[{{getvar::who}}]'), '[Sasha, hi]');
    assert.equal(e.vars.get('who'), 'Sasha, hi');
});

test('variables live across blocks of one engine and add/inc/dec follow numbers or strings', () => {
    const e = engine();
    e.substitute('{{setvar::n::5}}{{incvar::n}}{{addvar::n::10}}{{decvar::n}}');
    assert.equal(e.substitute('{{getvar::n}}'), '15');
    e.substitute('{{setvar::s::a}}{{addvar::s::b}}');
    assert.equal(e.substitute('{{getvar::s}}'), 'ab');
});

test('global variables are shared through the given map', () => {
    const globals = new Map();
    engine({ globals }).substitute('{{setglobalvar::k::v}}');
    assert.equal(engine({ globals }).substitute('{{getglobalvar::k}}'), 'v');
});

test('random is frozen with a seed and reports that randomness was used', () => {
    const a = engine({ seed: 'chat-1' }), b = engine({ seed: 'chat-1' });
    const text = '{{random::a::b::c::d}} {{random:x,y,z}} {{roll:2d6}}';
    assert.equal(a.substitute(text), b.substitute(text));
    assert.equal(a.state.usedRandom, true);
    assert.equal(engine().state.usedRandom, false);
});

test('our own macros take priority and may be functions', () => {
    const e = engine({ macros: { 'rp-time_year': '2148', 'rp-time_period': () => 'evening' } });
    assert.equal(e.substitute('{{rp-time_year}} ({{rp-time_period}})'), '2148 (evening)');
});

test('unknown and broken macros stay in the text and are listed as unresolved', () => {
    const e = engine();
    assert.equal(e.substitute("{{nope}} </{{char}'s abilities>"), "{{nope}} </{{char}'s abilities>");
    assert.equal(e.state.unresolved.includes('nope'), true);
});

test('text without macros is returned untouched', () => {
    assert.equal(engine().substitute('plain'), 'plain');
});
