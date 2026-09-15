import test from 'node:test';
import assert from 'node:assert/strict';
import { findMostRecentLocationMention } from '../libraries/core/location-mention.js';

function msg(text) {
    return { text };
}

const NODES = [{ id: 'tavern', name: 'Tavern' }, { id: 'market', name: 'Market Square' }, { id: 'gate', name: 'City Gate' }];

test('findMostRecentLocationMention finds a known location mentioned in the messages', () => {
    const messages = [msg('You wake up.'), msg('You head toward the Tavern.')];
    assert.equal(findMostRecentLocationMention(messages, NODES), 'tavern');
});

test('findMostRecentLocationMention returns null when no known location is mentioned anywhere', () => {
    const messages = [msg('You wake up.'), msg('A bird sings.')];
    assert.equal(findMostRecentLocationMention(messages, NODES), null);
});

test('findMostRecentLocationMention prefers the LATER message when two different locations are mentioned across messages', () => {
    const messages = [msg('You leave the Tavern.'), msg('You arrive at the Market Square.')];
    assert.equal(findMostRecentLocationMention(messages, NODES), 'market');
});

test('findMostRecentLocationMention prefers the LATER occurrence within the SAME message', () => {
    const messages = [msg('You think about the Tavern, then decide to head to the City Gate instead.')];
    assert.equal(findMostRecentLocationMention(messages, NODES), 'gate');
});

test('findMostRecentLocationMention is whole-word and case-insensitive — no partial-word false hits', () => {
    const nodes = [{ id: 'bar', name: 'Bar' }];
    assert.equal(findMostRecentLocationMention([msg('The barber trims his beard.')], nodes), null, '"Bar" must not match inside "barber"');
    assert.equal(findMostRecentLocationMention([msg('He walks into the BAR.')], nodes), 'bar', 'different case still matches');
});

test('findMostRecentLocationMention never returns a location not in the known set — closed-set only, no guessing', () => {
    const messages = [msg('You arrive at the Lost City of Atlantis.')];
    assert.equal(findMostRecentLocationMention(messages, NODES), null);
});

test('findMostRecentLocationMention skips nodes without a name and empty message text without crashing', () => {
    const nodes = [{ id: 'noname' }, { id: 'tavern', name: 'Tavern' }];
    const messages = [{ text: '' }, msg('At the Tavern now.')];
    assert.equal(findMostRecentLocationMention(messages, nodes), 'tavern');
});

test('findMostRecentLocationMention returns null for an empty node list or empty message list', () => {
    assert.equal(findMostRecentLocationMention([msg('At the Tavern.')], []), null);
    assert.equal(findMostRecentLocationMention([], NODES), null);
});
