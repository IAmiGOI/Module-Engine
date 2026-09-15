import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmptySpeakerCast, addCastMember, removeCastMember, updateCastMember, resolveEntityByName,
    findKnownMention, detectSpeakers, parseExplicitTag, findSpeechVerbSubject, findSentenceSubject,
    findVocativeAddressee, splitIntoSentences, hasPresenceVeto, findDepartureSubject,
} from '../libraries/core/speaker-detection.js';

function castWith(...members) {
    let cast = createEmptySpeakerCast();
    const ids = {};
    for (const member of members) {
        const result = addCastMember(cast, member);
        cast = result.cast;
        ids[member.name] = result.id;
    }
    return { cast, ids };
}

test('addCastMember adds a new entity and resolveEntityByName finds it case-insensitively', () => {
    const empty = createEmptySpeakerCast();
    const { cast, id } = addCastMember(empty, { name: 'Lisawoo', gender: 'F' });

    assert.equal(resolveEntityByName(cast, 'lisawoo'), id);
    assert.equal(cast.entities[id].canonicalName, 'Lisawoo');
    assert.equal(cast.entities[id].gender, 'F');
});

test('addCastMember throws when the name already exists (case-insensitively) — the caller decides how to handle a duplicate, this never silently merges', () => {
    const { cast } = castWith({ name: 'Sasha', gender: 'M' });
    assert.throws(() => addCastMember(cast, { name: 'sasha', gender: 'M' }), /already in the cast/);
});

test('addCastMember defaults gender to "unknown" when not given, rather than guessing', () => {
    const { cast, id } = addCastMember(createEmptySpeakerCast(), { name: 'Rowan' });
    assert.equal(cast.entities[id].gender, 'unknown');
});

test('removeCastMember removes an entity, and removing an unknown id is a harmless no-op', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    const removed = removeCastMember(cast, ids.Alex);
    assert.equal(resolveEntityByName(removed, 'Alex'), null);
    assert.deepEqual(removeCastMember(removed, 'nonexistent'), removed);
});

test('updateCastMember changes gender/color without touching the name or aliases', () => {
    const { cast, ids } = castWith({ name: 'Maria', gender: 'unknown' });
    const updated = updateCastMember(cast, ids.Maria, { gender: 'F', color: '#ff0000' });
    assert.equal(updated.entities[ids.Maria].gender, 'F');
    assert.equal(updated.entities[ids.Maria].color, '#ff0000');
    assert.equal(updated.entities[ids.Maria].canonicalName, 'Maria');
});

test('findKnownMention finds the EARLIEST known cast member mentioned in a sentence, ignoring any word that is not in the cast', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' }, { name: 'Maria', gender: 'F' });
    const mention = findKnownMention('Not gentle. Maria stepped forward, then Alex spoke.', cast);
    assert.equal(mention.id, ids.Maria);
});

test('findKnownMention returns null when NO known cast member is mentioned at all — it never guesses a stranger', () => {
    const { cast } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findKnownMention('Looks back. Pauses. Not gentle. Holds your hand.', cast), null);
});

test('parseExplicitTag recognizes the "Name: \\"text\\"" format and resolves it against the cast', () => {
    const { cast, ids } = castWith({ name: 'Sasha', gender: 'M' });
    const tagged = parseExplicitTag('Sasha: "Speaking."', cast);
    assert.deepEqual(tagged, { id: ids.Sasha, rawName: 'Sasha', quote: 'Speaking.', quoteStart: 8, quoteEnd: 17 });
    assert.equal('Sasha: "Speaking."'.slice(tagged.quoteStart, tagged.quoteEnd), 'Speaking.', 'quoteStart/quoteEnd must point at exactly the quote content, no more');
});

test('parseExplicitTag resolves a TITLED name ("Dr. Okumura") against the cast — a period inside the name must not break the tag format itself', () => {
    const { cast, ids } = castWith({ name: 'Dr. Okumura', gender: 'M' });
    const tagged = parseExplicitTag('Dr. Okumura: "We should start."', cast);
    assert.equal(tagged.id, ids['Dr. Okumura']);
});

test('parseExplicitTag leaves the id null for a name NOT in the cast — it never auto-creates the character', () => {
    const tagged = parseExplicitTag('Stranger: "Hello."', createEmptySpeakerCast());
    assert.equal(tagged.id, null);
    assert.equal(tagged.rawName, 'Stranger');
});

test('parseExplicitTag rejects a plain narrative sentence with no colon-quote format at all', () => {
    assert.equal(parseExplicitTag('The forest swallowed you both within twenty steps.', createEmptySpeakerCast()), null);
});

test('splitIntoSentences does not break a sentence apart at a period sitting INSIDE a quoted line', () => {
    const sentences = splitIntoSentences('She turns. "Stay close. Don\'t talk to anyone."');
    assert.equal(sentences.length, 2);
    assert.equal(sentences[1].text.trim(), '"Stay close. Don\'t talk to anyone."');
});

test('findSpeechVerbSubject reads the subject from "Name said" word order, matched against the cast', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findSpeechVerbSubject('Alex said, "No."', cast), ids.Alex);
});

test('findSpeechVerbSubject reads the subject from the inverted "said Name" word order', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findSpeechVerbSubject('"No," said Alex.', cast), ids.Alex);
});

test('findSpeechVerbSubject returns null when the sentence names nobody in the cast, even next to a real speech verb', () => {
    const { cast } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findSpeechVerbSubject('Someone said, "No."', cast), null);
});

test('findSentenceSubject finds the known cast member even when a pronoun ALSO appears later in the sentence', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    const subject = findSentenceSubject('Alex crossed her arms and looked away.', cast);
    assert.deepEqual(subject, { kind: 'name', id: ids.Alex });
});

test('findSentenceSubject falls back to a bare pronoun when no known cast member is mentioned at all', () => {
    const subject = findSentenceSubject('She crossed her arms and looked away.', createEmptySpeakerCast());
    assert.deepEqual(subject, { kind: 'pronoun', value: 'She' });
});

test('findVocativeAddressee resolves a name addressed at the START of a quote against the cast', () => {
    const { cast, ids } = castWith({ name: 'Sasha', gender: 'M' });
    assert.equal(findVocativeAddressee('Sasha, don\'t.', cast), ids.Sasha);
});

test('findVocativeAddressee returns null for an addressed name that is NOT in the cast', () => {
    assert.equal(findVocativeAddressee('Stranger, don\'t.', createEmptySpeakerCast()), null);
});

// --- End-to-end detectSpeakers() — the actual scenario the owner complained about ---

test('detectSpeakers NEVER creates a cast member — the returned segments carry only ids already present in the input cast', () => {
    const text = 'Not gentle — efficient. Looks back. Pauses. Holds your hand. Tighter than yesterday. "Stop calling yourself a burden."';
    const { segments } = detectSpeakers(text, createEmptySpeakerCast());

    // No exception, no invented registry to inspect — the API doesn't even
    // return one anymore. Every dialogue segment must be unattributed.
    const dialogue = segments.filter(segment => segment.type === 'dialogue');
    assert.equal(dialogue.length, 1);
    assert.equal(dialogue[0].speakerId, null);
    assert.equal(dialogue[0].confidence, 0);
});

test('detectSpeakers attributes an UNTAGGED quote to the KNOWN cast member named in its own preceding action sentence', () => {
    const { cast, ids } = castWith({ name: 'Lisawoo', gender: 'F' });
    const text = 'Lisawoo looks you over. "Stay close. Don\'t talk to anyone before I introduce you." She turns and walks into the tree line.';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Lisawoo);
});

test('detectSpeakers resolves a LATER pronoun-tagged quote ("Half a day," she says) back to the same earlier-named KNOWN cast member, via gender-matched recency', () => {
    const { cast, ids } = castWith({ name: 'Lisawoo', gender: 'F' });
    const text = 'Lisawoo looks back. "Half a day," she says.';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Lisawoo);
});

test('detectSpeakers attributes THREE untagged quotes in ONE paragraph to three DIFFERENT KNOWN cast members by local subject, not by alternating turns', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' }, { name: 'Maria', gender: 'F' }, { name: 'Sasha', gender: 'unknown' });
    const text = 'Alex crossed his arms. "No." Maria stepped forward. "Let him go." "Enough," Sasha snapped.';
    const { segments } = detectSpeakers(text, cast);

    const dialogueIds = segments.filter(segment => segment.type === 'dialogue').map(segment => segment.speakerId);
    assert.deepEqual(dialogueIds, [ids.Alex, ids.Maria, ids.Sasha]);
});

test('detectSpeakers gives the explicit "Name: \\"text\\"" line format the maximum confidence (1) when the name is in the cast', () => {
    const { cast, ids } = castWith({ name: 'Sasha', gender: 'M' });
    const { segments } = detectSpeakers('Sasha: "Speaking."', cast);
    assert.equal(segments[0].confidence, 1);
    assert.equal(segments[0].speakerId, ids.Sasha);
});

test('detectSpeakers leaves a quote with NO recoverable KNOWN subject unattributed (speakerId null, confidence 0) rather than guessing', () => {
    const { segments } = detectSpeakers('"Where did everyone go?"', createEmptySpeakerCast());
    const dialogue = segments[0];
    assert.equal(dialogue.speakerId, null);
    assert.equal(dialogue.confidence, 0);
});

test('detectSpeakers falls back to defaultSpeakerName ONLY when it already matches a known cast member — it never adds a new one', () => {
    const { cast, ids } = castWith({ name: 'Lisawoo', gender: 'F' });
    const text = 'She looks at you. "Burden." She repeats the word like she\'s tasting something spoiled.';
    const { segments } = detectSpeakers(text, cast, { defaultSpeakerName: 'Lisawoo' });

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Lisawoo);
});

test('detectSpeakers silently ignores a defaultSpeakerName that is NOT in the cast — no crash, no invented entity, just unresolved', () => {
    const text = 'She looks at you. "Burden."';
    const { segments } = detectSpeakers(text, createEmptySpeakerCast(), { defaultSpeakerName: 'Lisawoo' });

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, null);
});

test('detectSpeakers lets a KNOWN name actually found in the text win over defaultSpeakerName — the fallback is last resort, not an override', () => {
    const { cast, ids } = castWith({ name: 'Maria', gender: 'F' }, { name: 'Lisawoo', gender: 'F' });
    const text = 'Maria steps forward. "Let him go."';
    const { segments } = detectSpeakers(text, cast, { defaultSpeakerName: 'Lisawoo' });

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Maria);
});

// --- Real bugs from a beta tester's live transcripts (ROADMAP.md 5.42) ---

test('detectSpeakers paints ONLY the quote itself, never unrelated narration fused ahead of it by the "ends-in-a-colon" merge rule in splitIntoSentences() — a real bug: "From your left, barely audible:" (narration, dramatic colon) turned the SPEAKER\'S color, not just "...He has a point."', () => {
    const { cast, ids } = castWith({ name: 'Reine', gender: 'F' });
    const text = 'From your left, barely audible:\n\nReine: "...He has a point."';
    const { segments } = detectSpeakers(text, cast);
    const dialogue = segments.find(segment => segment.type === 'dialogue');

    assert.equal(dialogue.speakerId, ids.Reine, 'still correctly attributed to Reine');
    assert.equal(text.slice(dialogue.start, dialogue.end), dialogue.text, 'the paint span must equal EXACTLY the quote text');
    assert.equal(dialogue.text.includes('barely audible'), false, 'narration must never leak into the painted span');
});

test('detectSpeakers paints ONLY the quote for the explicit "Name:" tag format too — a short fused prefix (blank lines + "Damion:") must not extend the painted span before the actual quote', () => {
    const { cast, ids } = castWith({ name: 'Damion', gender: 'M' });
    const text = 'He bites into the piece.\n\nDamion: "...sorry..."';
    const { segments } = detectSpeakers(text, cast);
    const dialogue = segments.find(segment => segment.type === 'dialogue');

    assert.equal(dialogue.rule, 'explicitTag');
    assert.equal(dialogue.speakerId, ids.Damion);
    assert.equal(text.slice(dialogue.start, dialogue.end), dialogue.text);
});

test('detectSpeakers recognizes "Dr. Okumura" as ONE cast member across the sentence-splitting title abbreviation — a real bug: "Dr." was read as ending a sentence, splitting the name and losing recognition of the doctor as the subject', () => {
    const { cast, ids } = castWith({ name: 'Dr. Okumura', gender: 'M' }, { name: 'Damion', gender: 'M' });
    const text = 'Dr. Okumura turned the penlight between his fingers. "I want to evaluate the sites."';
    const { segments } = detectSpeakers(text, cast);
    const dialogue = segments.find(segment => segment.type === 'dialogue');

    assert.equal(dialogue.speakerId, ids['Dr. Okumura'], 'the title must not break recognition of the name it belongs to');
});

test('splitIntoSentences does not treat the period after a title abbreviation ("Dr.", "Mr.", "Mrs.") as a sentence boundary', () => {
    const sentences = splitIntoSentences('Dr. Okumura nodded. He smiled.');
    assert.equal(sentences.length, 2);
    assert.equal(sentences[0].text.trim(), 'Dr. Okumura nodded.');
});

test('splitIntoSentences recognizes the single-character ellipsis "…" as a sentence terminator, same as "..."', () => {
    const sentences = splitIntoSentences('He looked away… She said nothing.');
    assert.equal(sentences.length, 2);
    assert.equal(sentences[0].text.trim(), 'He looked away…');
});

// --- Presence veto / departure (ROADMAP.md 5.41, ported from scene-director's PresenceEngine idea) ---

test('hasPresenceVeto detects an absence-context phrase ("thinks of")', () => {
    assert.equal(hasPresenceVeto('Maria thinks of Alex often.'), true);
});

test('hasPresenceVeto does not fire on an ordinary sentence with no absence phrasing', () => {
    assert.equal(hasPresenceVeto('Maria crossed the room.'), false);
});

test('findDepartureSubject finds a KNOWN cast member adjacent to an explicit departure verb', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findDepartureSubject('Alex leaves the room.', cast), ids.Alex);
});

test('findDepartureSubject returns null when nobody in the cast is mentioned, even next to a departure verb', () => {
    const { cast } = castWith({ name: 'Alex', gender: 'M' });
    assert.equal(findDepartureSubject('Someone leaves the room.', cast), null);
});

test('detectSpeakers does NOT attribute a quote to a cast member who is only mentioned in an ABSENCE context ("thinks of") — falls back to whoever is actually established as present', () => {
    const { cast, ids } = castWith({ name: 'Maria', gender: 'F' }, { name: 'Alex', gender: 'M' });
    const text = 'Maria sits by the window. She thinks of Alex often. "I miss him," she says.';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Maria, 'the pronoun must resolve to Maria (actually present), not Alex (merely thought of)');
});

test('detectSpeakers removes a cast member from the subject stack once they EXPLICITLY leave — a later quote must not fall back to them', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' }, { name: 'Maria', gender: 'F' });
    const text = 'Alex leaves the room. Maria enters. "Where did he go?"';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Maria, 'nearestSubject must land on Maria — Alex was purged from the stack on departure');
});

test('detectSpeakers: a departed cast member mentioned again LATER in a fresh, non-absence sentence can still be attributed normally — departure only purges the STACK, the cast list itself is untouched', () => {
    const { cast, ids } = castWith({ name: 'Alex', gender: 'M' });
    const text = 'Alex leaves the room. Alex said, "Wait for me."';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Alex, 'a fresh explicit mention (speechVerb rule) still works after a departure — only the passive stack fallback is affected');
});

test('detectSpeakers matching against a cast with an alias attributes the quote correctly by the NICKNAME used in the text', () => {
    const { cast, ids } = castWith({ name: 'Selanawoo', gender: 'F', aliases: ['Selanawoo', 'Sela'] });
    const text = 'Sela laughs. "You came back."';
    const { segments } = detectSpeakers(text, cast);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(dialogue.speakerId, ids.Selanawoo);
});
