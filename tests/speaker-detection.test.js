import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmptySpeakerRegistry, registerSpeakerEntity, resolveEntityByName, addSpeakerAlias,
    applyGenderSignal, computeEntityGender, detectSpeakers, parseExplicitTag,
    findSpeechVerbSubject, findSentenceSubject, findVocativeAddressee, splitIntoSentences,
} from '../libraries/core/speaker-detection.js';

test('registerSpeakerEntity adds a new entity once and resolveEntityByName finds it case-insensitively', () => {
    const empty = createEmptySpeakerRegistry();
    const { registry, id } = registerSpeakerEntity(empty, 'Lisawoo');

    assert.equal(resolveEntityByName(registry, 'lisawoo'), id);
    assert.equal(registry.entities[id].canonicalName, 'Lisawoo');
});

test('registerSpeakerEntity called twice with the same name returns the SAME id, never a duplicate entity', () => {
    const empty = createEmptySpeakerRegistry();
    const first = registerSpeakerEntity(empty, 'Sasha');
    const second = registerSpeakerEntity(first.registry, 'Sasha');

    assert.equal(second.id, first.id);
    assert.equal(Object.keys(second.registry.entities).length, 1);
});

test('addSpeakerAlias refuses an alias already claimed by a DIFFERENT entity, so two characters can never merge by accident', () => {
    const empty = createEmptySpeakerRegistry();
    const a = registerSpeakerEntity(empty, 'Alex');
    const b = registerSpeakerEntity(a.registry, 'Maria');

    const attempted = addSpeakerAlias(b.registry, b.id, 'Alex');

    assert.deepEqual(attempted.entities[b.id].aliases, ['Maria']);
});

test('computeEntityGender resolves M/F from accumulated votes, majority wins, and a single contradicting vote does not flip an established gender', () => {
    const empty = createEmptySpeakerRegistry();
    const { registry, id } = registerSpeakerEntity(empty, 'Lisawoo');
    let withVotes = applyGenderSignal(registry, id, 'F');
    withVotes = applyGenderSignal(withVotes, id, 'F');
    withVotes = applyGenderSignal(withVotes, id, 'M'); // one stray contradiction

    const result = computeEntityGender(withVotes.entities[id]);

    assert.equal(result.gender, 'F');
});

test('computeEntityGender reports "they" only when there is no M/F signal at all, never overriding a confirmed binary gender', () => {
    const empty = createEmptySpeakerRegistry();
    const { registry, id } = registerSpeakerEntity(empty, 'Rowan');
    const theyOnly = applyGenderSignal(registry, id, 'they');

    assert.equal(computeEntityGender(theyOnly.entities[id]).gender, 'they');
});

test('parseExplicitTag recognizes the "Name: \\"text\\"" format and rejects a plain narrative sentence', () => {
    const tagged = parseExplicitTag('Sasha: "Speaking."');
    assert.deepEqual(tagged, { name: 'Sasha', quote: 'Speaking.' });

    assert.equal(parseExplicitTag('The forest swallowed you both within twenty steps.'), null);
});

test('splitIntoSentences does not break a sentence apart at a period sitting INSIDE a quoted line', () => {
    const sentences = splitIntoSentences('She turns. "Stay close. Don\'t talk to anyone."');
    assert.equal(sentences.length, 2);
    assert.equal(sentences[1].text.trim(), '"Stay close. Don\'t talk to anyone."');
});

test('findSpeechVerbSubject reads the subject from "Name said" word order', () => {
    assert.equal(findSpeechVerbSubject('Alex said, "No."'), 'Alex');
});

test('findSpeechVerbSubject reads the subject from the inverted "said Name" word order', () => {
    assert.equal(findSpeechVerbSubject('"No," said Alex.'), 'Alex');
});

test('findSpeechVerbSubject returns null when the sentence has no speech verb at all, instead of guessing', () => {
    assert.equal(findSpeechVerbSubject('Alex crossed his arms.'), null);
});

test('findSentenceSubject prefers a proper noun over a pronoun when both appear ("Alex crossed her arms" is about Alex, not some third "her")', () => {
    const subject = findSentenceSubject('Alex crossed her arms and looked away.');
    assert.equal(subject.kind, 'name');
    assert.equal(subject.value, 'Alex');
});

test('findVocativeAddressee extracts a name addressed at the START of a quote, distinct from the speaker', () => {
    assert.equal(findVocativeAddressee('Sasha, don\'t.'), 'Sasha');
});

test('findVocativeAddressee extracts a name addressed at the END of a quote', () => {
    assert.equal(findVocativeAddressee('Enough of this, Sasha.'), 'Sasha');
});

test('findVocativeAddressee returns null for a quote with no vocative at all', () => {
    assert.equal(findVocativeAddressee('Stay close.'), null);
});

// --- End-to-end detectSpeakers() on real prose, including the paragraphs discussed with the project owner ---

test('detectSpeakers attributes an UNTAGGED quote to the subject of its own preceding action sentence, not to whoever spoke last', () => {
    const text = 'She looks you over. "Stay close. Don\'t talk to anyone before I introduce you." She turns and walks into the tree line.';
    const withName = 'Lisawoo looks you over. "Stay close. Don\'t talk to anyone before I introduce you." She turns and walks into the tree line.';
    const { registry, segments } = detectSpeakers(withName);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.ok(dialogue);
    assert.equal(registry.entities[dialogue.speakerId].canonicalName, 'Lisawoo');
});

test('detectSpeakers resolves a LATER pronoun-tagged quote ("Half a day," she says) back to the same earlier-named subject, via gender-matched recency, not string identity', () => {
    const text = 'Lisawoo looks back. "Half a day," she says.';
    const { registry, segments } = detectSpeakers(text);

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(registry.entities[dialogue.speakerId].canonicalName, 'Lisawoo');
    assert.equal(dialogue.confidence > 0, true);
});

test('detectSpeakers attributes THREE untagged quotes in ONE paragraph to three DIFFERENT speakers by local subject, not by alternating turns', () => {
    const text = 'Alex crossed his arms. "No." Maria stepped forward. "Let him go." "Enough," Sasha snapped.';
    const { registry, segments } = detectSpeakers(text);

    const dialogues = segments.filter(segment => segment.type === 'dialogue');
    const names = dialogues.map(segment => registry.entities[segment.speakerId]?.canonicalName);

    assert.deepEqual(names, ['Alex', 'Maria', 'Sasha']);
});

test('detectSpeakers gives the explicit "Name: \\"text\\"" line format the maximum confidence (1) and does not run any heuristic on it', () => {
    const { registry, segments } = detectSpeakers('Sasha: "Speaking."');
    const dialogue = segments[0];

    assert.equal(dialogue.confidence, 1);
    assert.equal(registry.entities[dialogue.speakerId].canonicalName, 'Sasha');
});

test('detectSpeakers folds a pronoun gender signal from surrounding narration into the registry, so a later resolver can tell the entity apart by gender', () => {
    const text = 'Her tail streams behind her as Lisawoo walks. "Stay close."';
    const { registry, segments } = detectSpeakers(text);
    const dialogue = segments.find(segment => segment.type === 'dialogue');

    assert.equal(computeEntityGender(registry.entities[dialogue.speakerId]).gender, 'F');
});

test('detectSpeakers leaves a quote with NO recoverable subject unattributed (speakerId null, confidence 0) rather than guessing via turn alternation', () => {
    const { segments } = detectSpeakers('"Where did everyone go?"');
    const dialogue = segments[0];

    assert.equal(dialogue.speakerId, null);
    assert.equal(dialogue.confidence, 0);
});

test('detectSpeakers falls back to defaultSpeakerName for a pronoun-only quote when the message NEVER names its speaker anywhere in its own text — the realistic case for a single-character reply excerpted mid-conversation', () => {
    const text = 'She looks at you. "Burden." She repeats the word like she\'s tasting something spoiled.';
    const { registry, segments } = detectSpeakers(text, createEmptySpeakerRegistry(), { defaultSpeakerName: 'Lisawoo' });

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(registry.entities[dialogue.speakerId]?.canonicalName, 'Lisawoo');
});

test('detectSpeakers lets a name ACTUALLY found in the text win over defaultSpeakerName — the fallback is last resort, not an override', () => {
    const text = 'Maria steps forward. "Let him go."';
    const { registry, segments } = detectSpeakers(text, createEmptySpeakerRegistry(), { defaultSpeakerName: 'Lisawoo' });

    const dialogue = segments.find(segment => segment.type === 'dialogue');
    assert.equal(registry.entities[dialogue.speakerId]?.canonicalName, 'Maria');
});

test('detectSpeakers does NOT mint an entity for an ordinary sentence-initial capitalized word ("Looks back.", "Not now.") that merely happens to open a sentence — a real bug caught on live RP transcript excerpts', () => {
    const text = 'She ducks under the first, steps over the second. Pauses. Looks back.\n"Half a day," she says.';
    const { registry } = detectSpeakers(text);

    const names = Object.values(registry.entities).map(entity => entity.canonicalName);
    assert.deepEqual(names, [], 'no entity should be minted from "Pauses"/"Looks" at all');
});

test('detectSpeakers does not mistake a pronoun CONTRACTION ("She\'ll ask...") for a proper-noun subject next to a speech verb', () => {
    const text = 'She\'ll ask you questions. Direct ones.';
    const { registry } = detectSpeakers(text);

    assert.equal(Object.keys(registry.entities).length, 0);
});

test('detectSpeakers reuses the SAME entity id across multiple calls when the same registry is threaded through, instead of re-discovering a new one each time', () => {
    const first = detectSpeakers('Lisawoo walks ahead. "Half a day."');
    const second = detectSpeakers('Lisawoo looks back. "You will know."', first.registry);

    const firstId = first.segments.find(segment => segment.type === 'dialogue').speakerId;
    const secondId = second.segments.find(segment => segment.type === 'dialogue').speakerId;
    assert.equal(firstId, secondId);
    assert.equal(Object.keys(second.registry.entities).length, 1);
});
