/**
 * Speaker detection — pure heuristics that turn narrative prose into
 * `{ narration | dialogue, speaker }` segments, plus a plain-object entity
 * registry (name/aliases/gender) that accumulates confidence across calls.
 * No LLM, no ST, no DOM — a pure Библиотека per LIBRARIES.md's "Library
 * before Core" rule; [cores/speaker/index.js](../../cores/speaker/index.js)
 * is the only real consumer, adding per-chat persistence and contracts on
 * top of what's here.
 *
 * English prose only (no Russian verb-gender agreement to lean on — see the
 * project's own design-log discussion). Because a single paragraph can carry
 * several unattributed speakers, attribution here is resolved PER SENTENCE,
 * never by alternating turns between two speakers — that heuristic breaks
 * the moment a third speaker joins mid-paragraph.
 *
 * **Known, accepted limitation (no dictionary is used anywhere in this
 * file, by design — see LIBRARIES.md).** A short 2-word sentence-initial
 * fragment directly before a quote ("Amber, steady. \"Stop calling
 * yourself a burden.\"") is accepted as a plausible new subject the same
 * way a real 2-word introduction is ("Lisawoo walks. \"Half a day.\"") —
 * the two are genuinely indistinguishable from the text alone when the
 * word (like "Amber") happens to be both a common noun/description AND a
 * real name. This was found live against a real transcript excerpt
 * (ROADMAP.md 5.39) and left as-is rather than chased further: fixing it
 * would need real-world knowledge (a name dictionary or an LLM call),
 * which this file deliberately does not use.
 */

const SPEECH_VERBS = [
    'say', 'says', 'said', 'ask', 'asks', 'asked', 'reply', 'replies', 'replied',
    'whisper', 'whispers', 'whispered', 'murmur', 'murmurs', 'murmured',
    'mutter', 'mutters', 'muttered', 'snap', 'snaps', 'snapped', 'call', 'calls', 'called',
    'answer', 'answers', 'answered', 'shout', 'shouts', 'shouted', 'yell', 'yells', 'yelled',
    'breathe', 'breathes', 'breathed', 'sigh', 'sighs', 'sighed', 'growl', 'growls', 'growled',
    'whisper', 'whimpered', 'whimpers', 'whimper', 'add', 'adds', 'added', 'continue', 'continues', 'continued',
    'whispers', 'shrug', 'shrugs', 'shrugged', 'whisper', 'protest', 'protests', 'protested',
];

/**
 * Common third-person-singular ACTION verb forms (not speech), used in one
 * direction only: a sentence-initial capitalized word matching one of these
 * is almost certainly the sentence's OWN elliptical verb with an implied
 * subject ("Looks back." = "[She] looks back.") — extremely common in
 * present-tense RP prose as a snappy one/two-beat sentence — not a new
 * character's name, even though English capitalizes it for the same reason
 * a name would be. Deliberately NOT exhaustive (no dictionary is used
 * anywhere in this file) — missing a form here just means that one
 * ambiguous word falls through to the word-count heuristic below instead,
 * never a hard failure.
 */
const ACTION_VERB_FORMS = new Set([
    'looks', 'look', 'looked', 'pauses', 'pause', 'paused', 'holds', 'hold', 'held',
    'shoulders', 'shoulder', 'shouldered', 'stands', 'stand', 'stood', 'turns', 'turn', 'turned',
    'walks', 'walk', 'walked', 'nods', 'nod', 'nodded', 'watches', 'watch', 'watched',
    'waits', 'wait', 'waited', 'stares', 'stare', 'stared', 'reaches', 'reach', 'reached',
    'pulls', 'pull', 'pulled', 'drops', 'drop', 'dropped', 'wipes', 'wipe', 'wiped',
    'ties', 'tie', 'tied', 'finishes', 'finish', 'finished', 'tears', 'tear', 'tore',
    'chews', 'chew', 'chewed', 'swallows', 'swallow', 'swallowed', 'picks', 'pick', 'picked',
    'winds', 'wind', 'wound', 'inspects', 'inspect', 'inspected', 'tucks', 'tuck', 'tucked',
    'loops', 'loop', 'looped', 'sways', 'sway', 'swayed', 'stops', 'stop', 'stopped',
    'moves', 'move', 'moved', 'raises', 'raise', 'raised', 'lowers', 'lower', 'lowered',
    'closes', 'close', 'closed', 'opens', 'open', 'opened', 'shakes', 'shake', 'shook',
    'shifts', 'shift', 'shifted', 'leans', 'lean', 'leaned', 'kneels', 'kneel', 'knelt',
    'exhales', 'exhale', 'exhaled', 'inhales', 'inhale', 'inhaled', 'hesitates', 'hesitate', 'hesitated',
    'crosses', 'cross', 'crossed', 'steps', 'step', 'stepped', 'spits', 'spit', 'inspects',
    'blinks', 'blink', 'blinked', 'ducks', 'duck', 'ducked', 'crackles', 'crackle', 'crackled',
]);

const MALE_TITLES = ['mr', 'sir', 'lord', 'king', 'prince', 'father', 'mister'];
const FEMALE_TITLES = ['ms', 'mrs', 'miss', 'lady', 'queen', 'princess', 'mother', 'madam', 'ma\'am'];

/** Proper-noun-ish tokens that are almost never a person's name — filtered out of subject/vocative candidates. */
const NAME_STOPWORDS = new Set([
    'the', 'a', 'an', 'i', 'you', 'he', 'she', 'it', 'they', 'we', 'this', 'that', 'these', 'those',
    'her', 'him', 'them', 'his', 'their', 'theirs', 'hers', 'its',
    'stay', 'don\'t', 'half', 'one', 'two', 'three', 'no', 'not', 'yes', 'ok', 'okay', 'well', 'oh', 'ah',
    // Comparatives/intensifiers/degree-adverbs — a closed enough word class
    // that a short list beats a suffix rule (a suffix rule on "-er" would
    // also reject real names like "Piper"/"Tyler"/"Amber"). Found live on a
    // real transcript excerpt: "Tighter than yesterday." (bandage-tying
    // beat, no subject at all) minted a bogus "Tighter" speaker.
    'tighter', 'harder', 'softer', 'closer', 'quieter', 'louder', 'slower', 'faster', 'longer', 'shorter',
    'better', 'worse', 'more', 'less', 'still', 'already', 'instead', 'meanwhile', 'perhaps', 'maybe', 'finally',
]);

/** Defensive default — every function here degrades to "no signal" rather than throwing on ragged input. */
export function createEmptySpeakerRegistry() {
    return { nextId: 1, entities: {} };
}

function normalizeAlias(name) {
    return String(name ?? '').trim().toLowerCase();
}

/** `resolveX` — always returns a valid entity id, never throws; matches by exact alias first, case-insensitive. */
export function resolveEntityByName(registry, name) {
    const alias = normalizeAlias(name);
    if (!alias) return null;
    for (const [id, entity] of Object.entries(registry.entities)) {
        if (entity.aliases.some(a => normalizeAlias(a) === alias)) return id;
    }
    return null;
}

/**
 * `applyX` — mutates a SHALLOW COPY of `registry` (never the original, so a
 * caller can diff old/new state for a Block-changed event) and returns
 * `{ registry, id }`. Adds `name` as a new entity, or returns the existing
 * match unchanged — never creates a duplicate for a name already known under
 * any alias.
 */
export function registerSpeakerEntity(registry, name, { role = 'npc' } = {}) {
    const existingId = resolveEntityByName(registry, name);
    if (existingId) return { registry, id: existingId };

    const id = `speaker${registry.nextId}`;
    const entity = {
        canonicalName: String(name).trim(),
        aliases: [String(name).trim()],
        genderVotes: { M: 0, F: 0 },
        theyVotes: 0,
        role,
        color: null,
    };
    return {
        id,
        registry: { nextId: registry.nextId + 1, entities: { ...registry.entities, [id]: entity } },
    };
}

/** Adds `alias` to an existing entity, unless it (or a different entity's alias) already covers it — never duplicates or reparents an alias. */
export function addSpeakerAlias(registry, id, alias) {
    if (!registry.entities[id] || resolveEntityByName(registry, alias)) return registry;
    const entity = registry.entities[id];
    return { ...registry, entities: { ...registry.entities, [id]: { ...entity, aliases: [...entity.aliases, alias] } } };
}

/** Accumulates a gender signal (never overwrites outright) — one stray contradiction can't erase prior confirmed votes. */
export function applyGenderSignal(registry, id, gender) {
    const entity = registry.entities[id];
    if (!entity) return registry;
    if (gender === 'M' || gender === 'F') {
        const genderVotes = { ...entity.genderVotes, [gender]: entity.genderVotes[gender] + 1 };
        return { ...registry, entities: { ...registry.entities, [id]: { ...entity, genderVotes } } };
    }
    if (gender === 'they') {
        return { ...registry, entities: { ...registry.entities, [id]: { ...entity, theyVotes: entity.theyVotes + 1 } } };
    }
    return registry;
}

/** `computeX` — pure derivation from accumulated votes; `they` only wins when it has no M/F contradiction at all. */
export function computeEntityGender(entity) {
    if (!entity) return { gender: 'unknown', confidence: 0 };
    const { M, F } = entity.genderVotes;
    if (M === 0 && F === 0 && entity.theyVotes > 0) return { gender: 'they', confidence: Math.min(1, entity.theyVotes / 3) };
    if (M === 0 && F === 0) return { gender: 'unknown', confidence: 0 };
    const total = M + F;
    return M >= F ? { gender: 'M', confidence: M / total } : { gender: 'F', confidence: F / total };
}

function genderFromPronoun(word) {
    const w = word.toLowerCase();
    if (['she', 'her', 'hers'].includes(w)) return 'F';
    if (['he', 'him', 'his'].includes(w)) return 'M';
    if (['they', 'them', 'their', 'theirs'].includes(w)) return 'they';
    return null;
}

function genderFromTitle(token) {
    const t = token.toLowerCase().replace(/\.$/, '');
    if (MALE_TITLES.includes(t)) return 'M';
    if (FEMALE_TITLES.includes(t)) return 'F';
    return null;
}

/** A run of capitalized words (allows a leading title) — the closest thing to a proper-noun match without a real NER model. */
const PROPER_NOUN_RE = /\b((?:(?:Mr|Mrs|Ms|Miss|Sir|Lady|Lord|Dr)\.?\s+)?[A-Z][a-zA-Z'’]*(?:\s+[A-Z][a-zA-Z'’]*)?)\b/;

/** A pronoun contraction ("She'll", "He's", "They're"...) — `PROPER_NOUN_RE` matches these whole (it allows apostrophes for real names like "D'Angelo"), so they need their own filter rather than a fixed word list. */
const PRONOUN_CONTRACTION_RE = /^(she|he|it|they|you|we|i)['’](ll|s|d|re|ve|m)$/i;

/** `sanitizeX` — trims a matched proper-noun span down to a usable name, or null if it's just a stopword/pronoun-contraction/sentence-initial common word. */
function sanitizeNameCandidate(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const firstWord = trimmed.split(/\s+/)[0];
    const lowerFirst = firstWord.toLowerCase();
    if (NAME_STOPWORDS.has(lowerFirst) || PRONOUN_CONTRACTION_RE.test(firstWord) || ACTION_VERB_FORMS.has(lowerFirst)) return null;
    return trimmed;
}

/**
 * Splits raw text into sentence-ish spans, one attribution unit each.
 *
 * A quote's own closing punctuation decides what happens next — the same
 * signal a human reader uses: a COMMA before the closing quote mark
 * (`"Enough," Sasha snapped.`) means the clause that follows is a dialogue
 * TAG describing this same quote, so it stays in the same unit (the verb+
 * subject search below needs to see it together with the quote). A period/
 * `!`/`?` before the closing quote (`"No." Maria stepped forward.`) means
 * the quote is grammatically complete on its own — what follows is an
 * unrelated new sentence, and merging it in was the exact bug this rule
 * fixes: a full unrelated action sentence right after a closed quote was
 * being read as that quote's OWN speech-verb subject.
 */
export function splitIntoSentences(text) {
    const sentences = [];
    let inQuote = false;
    let start = 0;
    let awaitingTag = false; // true once we've closed a quote whose last inner character was a comma

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const isQuoteChar = ch === '"' || ch === '“' || ch === '”';
        if (isQuoteChar) {
            if (!inQuote) {
                // Opening a quote ends whatever plain narration preceded it — a
                // quote is always its own unit, never fused to the sentence before
                // it — EXCEPT a `Name:` prefix immediately before it (explicit tag
                // format), which must stay attached for parseExplicitTag() to see.
                const precedingIsTagPrefix = /:\s*$/.test(text.slice(start, i));
                if (!awaitingTag && !precedingIsTagPrefix && text.slice(start, i).trim()) { sentences.push({ text: text.slice(start, i), start, end: i }); start = i; }
                inQuote = true;
            } else {
                inQuote = false;
                const lastInner = text.slice(start, i).replace(/["“]/, '').trimEnd();
                awaitingTag = lastInner.endsWith(',');
                if (!awaitingTag) { sentences.push({ text: text.slice(start, i + 1), start, end: i + 1 }); start = i + 1; }
            }
            continue;
        }
        if (!inQuote && /[.!?]/.test(ch) && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
            sentences.push({ text: text.slice(start, i + 1), start, end: i + 1 });
            start = i + 1;
            awaitingTag = false;
        }
    }
    if (start < text.length && text.slice(start).trim()) sentences.push({ text: text.slice(start), start, end: text.length });
    return sentences;
}

/** Explicit `Name: "quote"` line, rule 0 — highest-confidence attribution, no heuristics involved. */
export function parseExplicitTag(sentenceText) {
    const match = sentenceText.match(/^\s*([A-Z][\w'’\- ]{0,30}):\s*["“](.+?)["”]?\s*$/);
    if (!match) return null;
    const name = sanitizeNameCandidate(match[1]);
    if (!name) return null;
    return { name, quote: match[2] };
}

/** Rule 1 — a speech verb adjacent to a proper noun in the SAME sentence: "Alex said" / "said Alex" / "Alex asked, ...". */
export function findSpeechVerbSubject(sentenceText) {
    const verbPattern = SPEECH_VERBS.join('|');
    const before = new RegExp(`(${PROPER_NOUN_RE.source})\\s+(?:${verbPattern})\\b`, 'i');
    const after = new RegExp(`\\b(?:${verbPattern})\\b,?\\s+(${PROPER_NOUN_RE.source})`, 'i');
    const beforeMatch = sentenceText.match(before);
    if (beforeMatch) return sanitizeNameCandidate(beforeMatch[1]);
    const afterMatch = sentenceText.match(after);
    if (afterMatch) return sanitizeNameCandidate(afterMatch[1]);
    return null;
}

/**
 * Rule 2/3 fallback — the leading proper noun of a sentence (its most likely
 * grammatical subject), pronoun included.
 *
 * `sentenceInitial: true` on a name match is a WARNING, not a rejection —
 * English capitalizes the first word of every sentence regardless of what
 * part of speech it is, so a lone sentence like "Looks back." or "Not now."
 * (an elliptical action-beat fragment, very common in present-tense RP prose)
 * capitalizes an ordinary word for the same reason a real name would be
 * capitalized there — the two are indistinguishable from THIS sentence
 * alone. The caller (`detectSpeakers`) is the one holding the growing
 * registry, so it decides whether a sentence-initial capital corroborates
 * an ALREADY-KNOWN name or must be treated as no-subject-found; this
 * function only reports the position, never guesses past it.
 */
export function findSentenceSubject(sentenceText) {
    const withoutQuotes = sentenceText.replace(/["“”][^"“”]*["“”]?/g, ' ');
    const pronounMatch = withoutQuotes.match(/\b(she|he|they)\b/i);
    const pronounIndex = pronounMatch ? withoutQuotes.indexOf(pronounMatch[0]) : Infinity;
    const leadingWhitespace = withoutQuotes.match(/^\s*/)[0].length;
    const wordCount = (withoutQuotes.match(/[a-zA-Z'’]+/g) ?? []).length;

    // Scan EVERY capitalized-word run, not just the first regex match — a
    // sentence-initial "Her"/"Their" (an object/possessive pronoun, filtered
    // by sanitizeNameCandidate) must not block a real name later in the same
    // sentence ("Her tail streams... as Lisawoo walks").
    const nameRe = new RegExp(PROPER_NOUN_RE.source, 'g');
    for (const match of withoutQuotes.matchAll(nameRe)) {
        if (match.index >= pronounIndex) break; // a name after the pronoun is not "the subject that comes first"
        const name = sanitizeNameCandidate(match[1]);
        if (name) return { kind: 'name', value: name, sentenceInitial: match.index === leadingWhitespace, wordCount };
    }
    if (pronounMatch) return { kind: 'pronoun', value: pronounMatch[1] };
    return null;
}

/** A name addressed INSIDE a quote ("Sasha, don't.") — excluded as speaker of THIS quote, promoted as a hint for the NEXT unattributed one. */
export function findVocativeAddressee(quoteText) {
    const leading = quoteText.match(/^\s*([A-Z][a-zA-Z'’]*)\s*,/);
    if (leading) return sanitizeNameCandidate(leading[1]);
    const trailing = quoteText.match(/,\s*([A-Z][a-zA-Z'’]*)\s*[.!?]?\s*$/);
    if (trailing) return sanitizeNameCandidate(trailing[1]);
    return null;
}

/**
 * Resolves a pronoun subject against the local stack of recently-seen named
 * subjects, most recent first — a naive centering/Hobbs-style walk, not full
 * coreference, but enough for a small live cast.
 */
function resolvePronounAgainstStack(pronoun, subjectStack, registry) {
    const wanted = genderFromPronoun(pronoun);
    if (!wanted) return null;
    for (let i = subjectStack.length - 1; i >= 0; i -= 1) {
        const id = subjectStack[i];
        const { gender } = computeEntityGender(registry.entities[id]);
        if (gender === wanted || gender === 'unknown' || gender === 'they') return id;
    }
    return null;
}

/**
 * Main entry point. Walks `text` sentence by sentence, tracks a local
 * "last named subject" stack (rebuilt from actions, not just speech tags —
 * "Alex crossed his arms." registers Alex as a subject even with no verb of
 * speech), and resolves each quote independently — so a paragraph with five
 * speakers never degrades into turn-alternation guessing.
 *
 * `defaultSpeakerName` (optional) — the ST message-card owner for the
 * message this text came from (`stChat.messages`'s own `name` field for a
 * non-user message). A message excerpted in isolation often names its
 * speaker nowhere in the text at all ("She looks at you...", never "Lisawoo
 * looks at you..." — the name was given many messages earlier in the
 * conversation) — without a fallback, every pronoun-only quote in such a
 * message would stay honestly `unknown` rather than wrongly guessed, but a
 * caller that DOES know the message's own character card can do better than
 * that. Seeded as the FIRST (least recent) entry of the subject stack, so
 * anything more specific detected in the text still wins over it.
 *
 * Returns `{ registry, segments }`; `registry` is the input registry with
 * any newly-discovered entities/gender-votes folded in (never mutated).
 */
export function detectSpeakers(text, registryIn = createEmptySpeakerRegistry(), { defaultSpeakerName } = {}) {
    let registry = registryIn;
    const segments = [];
    const subjectStack = []; // most recent last
    let pendingAddressee = null; // vocative hint for the NEXT unattributed quote

    function ensureEntity(name) {
        const result = registerSpeakerEntity(registry, name);
        registry = result.registry;
        return result.id;
    }

    if (defaultSpeakerName) subjectStack.push(ensureEntity(defaultSpeakerName));

    /**
     * A sentence-initial name candidate is trustworthy either because it's
     * already a KNOWN alias, or because the sentence around it has enough
     * words to be a real clause ("Alex crossed his arms.", "Maria stepped
     * forward.") rather than a bare 1-2-word elliptical action-beat fragment
     * ("Looks back.", "Pauses.") — a construction extremely common in
     * present-tense RP prose, where an ordinary verb is capitalized for the
     * exact same reason a real name would be, and the two are otherwise
     * indistinguishable from this one sentence alone. `MIN_WORDS` is a
     * heuristic threshold, not a grammar rule — a residual false positive
     * ("Tighter than yesterday." — 3 words, no real subject) is accepted as
     * a known, documented limitation of a no-dictionary approach; it self-
     * corrects the moment a real name is corroborated elsewhere.
     *
     * A non-sentence-initial candidate needs no such corroboration at all:
     * an ordinary English word is capitalized ONLY at a sentence's start, so
     * a capital anywhere else is already a reliable name signal on its own.
     *
     * `minWords` is deliberately CALLER-SUPPLIED, not one fixed constant:
     * a 2-word sentence immediately BEFORE a quote ("Lisawoo walks. \"Half a
     * day.\"") is a well-known literary attribution beat, and the adjacency
     * to the quote it's about to attribute is itself corroborating evidence
     * — worth the lower bar of 2. The SAME 2-word sentence found while just
     * mining narration for a future pronoun antecedent (no quote of its own
     * to attribute right now, lower stakes, easier to be wrong quietly)
     * needs the stricter bar of 3 — found live: "Direct ones." (2 words, no
     * adjacent quote) minted a bogus entity at the lower threshold.
     */
    function acceptNameCandidate(subject, minWords) {
        if (subject?.kind !== 'name') return null;
        if (!subject.sentenceInitial) return subject.value;
        if (resolveEntityByName(registry, subject.value)) return subject.value;
        return subject.wordCount >= minWords ? subject.value : null;
    }

    function applySubjectGenderSignal(id, sentenceText) {
        const pronounMatch = sentenceText.match(/\b(she|he|they|her|him|his|their)\b/i);
        if (pronounMatch) registry = applyGenderSignal(registry, id, genderFromPronoun(pronounMatch[1]));
        const titleMatch = sentenceText.match(/\b(Mr|Mrs|Ms|Miss|Sir|Lady|Lord)\.?\b/);
        if (titleMatch) registry = applyGenderSignal(registry, id, genderFromTitle(titleMatch[1]));
    }

    const sentences = splitIntoSentences(text);
    for (let i = 0; i < sentences.length; i += 1) {
        const sentence = sentences[i];
        const explicit = parseExplicitTag(sentence.text);
        if (explicit) {
            const id = ensureEntity(explicit.name);
            subjectStack.push(id);
            segments.push({ type: 'dialogue', text: explicit.quote, start: sentence.start, end: sentence.end, speakerId: id, confidence: 1, rule: 'explicitTag' });
            continue;
        }

        const quoteMatches = [...sentence.text.matchAll(/["“]([^"“”]+)["”]?/g)];
        if (quoteMatches.length === 0) {
            // Pure narration — still worth mining for a subject, so the NEXT
            // sentence's quote (if any) has something to resolve a pronoun against.
            // A short "Name verb." beat directly BEFORE a quote ("Lisawoo
            // walks. \"Half a day.\"") is a well-known literary attribution
            // pattern — the adjacency itself corroborates a 2-word subject,
            // same lower bar as `acceptedNonQuoteName` below; isolated
            // narration with no quote right after it (lower stakes, easier
            // to be wrong quietly — "Direct ones." minted a bogus entity
            // once, found live) keeps the stricter 3-word bar.
            const nextSentenceHasQuote = i + 1 < sentences.length && /["“]/.test(sentences[i + 1].text);
            const subject = findSentenceSubject(sentence.text);
            const acceptedName = acceptNameCandidate(subject, nextSentenceHasQuote ? 2 : 3);
            if (acceptedName) {
                const id = ensureEntity(acceptedName);
                applySubjectGenderSignal(id, sentence.text);
                subjectStack.push(id);
            } else if (subject?.kind === 'pronoun') {
                const id = resolvePronounAgainstStack(subject.value, subjectStack, registry);
                if (id) subjectStack.push(id);
            }
            segments.push({ type: 'narration', text: sentence.text, start: sentence.start, end: sentence.end });
            continue;
        }

        const verbSubjectName = findSpeechVerbSubject(sentence.text);
        let speakerId = null;
        let rule = null;

        if (verbSubjectName) {
            speakerId = ensureEntity(verbSubjectName);
            rule = 'speechVerb';
        } else {
            const nonQuoteSubject = findSentenceSubject(sentence.text.replace(/["“][^"“”]+["”]?/g, ''));
            const acceptedNonQuoteName = acceptNameCandidate(nonQuoteSubject, 2);
            if (acceptedNonQuoteName) {
                speakerId = ensureEntity(acceptedNonQuoteName);
                rule = 'adjacentAction';
            } else if (nonQuoteSubject?.kind === 'pronoun') {
                speakerId = resolvePronounAgainstStack(nonQuoteSubject.value, subjectStack, registry);
                rule = speakerId ? 'pronounResolution' : null;
            }
        }

        if (!speakerId && pendingAddressee) {
            const addresseeId = resolveEntityByName(registry, pendingAddressee);
            if (addresseeId) { speakerId = addresseeId; rule = 'vocativeResponse'; }
        }

        if (!speakerId && subjectStack.length > 0) {
            speakerId = subjectStack[subjectStack.length - 1];
            rule = 'nearestSubject';
        }

        if (speakerId) subjectStack.push(speakerId);

        // Quote text itself may also carry a speech-verb attribution
        // ("Enough," Sasha snapped.) that's already covered by verbSubjectName
        // above since it's in the same sentence.
        const quoteText = quoteMatches[0][1];
        const addressee = findVocativeAddressee(quoteText);
        pendingAddressee = addressee && addressee !== (speakerId && registry.entities[speakerId]?.canonicalName) ? addressee : null;

        segments.push({
            type: 'dialogue',
            text: quoteText,
            start: sentence.start,
            end: sentence.end,
            speakerId: speakerId ?? null,
            confidence: speakerId ? (rule === 'speechVerb' ? 0.95 : rule === 'adjacentAction' ? 0.85 : rule === 'pronounResolution' ? 0.7 : rule === 'vocativeResponse' ? 0.6 : 0.4) : 0,
            rule,
        });
    }

    return { registry, segments };
}
