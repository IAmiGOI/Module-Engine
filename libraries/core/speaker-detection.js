/**
 * Speaker detection — pure matching against a FIXED, user-entered cast list
 * (`{ id -> { name, aliases, gender, color } }`), never open-ended guessing.
 * No LLM, no ST, no DOM — a pure Библиотека per LIBRARIES.md's "Library
 * before Core" rule; [cores/speaker/index.js](../../cores/speaker/index.js)
 * is the only real consumer, adding per-chat persistence and contracts on
 * top of what's here.
 *
 * **This file does NOT invent characters.** An earlier version tried to
 * guess "is this capitalized word a name" from prose alone (proper-noun
 * regex + a stoplist of common verbs/adverbs) — found live, on a real
 * transcript the project owner pasted, to mint a garbage cast entry for
 * every ordinary capitalized word that happened to open a sentence
 * ("Looks back.", "Holds your hand...", "Not gentle."). The owner's own
 * framing, verbatim: "Idет персонаж. У него имя. И у него/неё пол. По этому
 * ты определяешь, кто говорит" — a character comes with a name and a
 * gender, known up front, entered by the user; detection's only job is to
 * match prose against THAT list, never to discover new names on its own.
 * See ROADMAP.md 5.39/5.40 for the full history of both versions.
 *
 * English prose only (no Russian verb-gender agreement to lean on). Because
 * a single paragraph can carry several unattributed speakers, attribution
 * here is resolved PER SENTENCE, never by alternating turns between two
 * speakers — that heuristic breaks the moment a third speaker joins
 * mid-paragraph.
 */

const SPEECH_VERBS = [
    'say', 'says', 'said', 'ask', 'asks', 'asked', 'reply', 'replies', 'replied',
    'whisper', 'whispers', 'whispered', 'murmur', 'murmurs', 'murmured',
    'mutter', 'mutters', 'muttered', 'snap', 'snaps', 'snapped', 'call', 'calls', 'called',
    'answer', 'answers', 'answered', 'shout', 'shouts', 'shouted', 'yell', 'yells', 'yelled',
    'breathe', 'breathes', 'breathed', 'sigh', 'sighs', 'sighed', 'growl', 'growls', 'growled',
    'whimper', 'whimpers', 'whimpered', 'add', 'adds', 'added', 'continue', 'continues', 'continued',
    'shrug', 'shrugs', 'shrugged', 'protest', 'protests', 'protested',
];

function genderFromPronoun(word) {
    const w = word.toLowerCase();
    if (['she', 'her', 'hers'].includes(w)) return 'F';
    if (['he', 'him', 'his'].includes(w)) return 'M';
    if (['they', 'them', 'their', 'theirs'].includes(w)) return 'they';
    return null;
}

/** Defensive default — an empty, user-editable cast. Nothing in this file ever adds to it on its own. */
export function createEmptySpeakerCast() {
    return { nextId: 1, entities: {} };
}

function normalizeAlias(name) {
    return String(name ?? '').trim().toLowerCase();
}

/** `resolveX` — always returns a valid entity id or null, never throws; matches by exact alias, case-insensitive. */
export function resolveEntityByName(cast, name) {
    const alias = normalizeAlias(name);
    if (!alias) return null;
    for (const [id, entity] of Object.entries(cast.entities)) {
        if (entity.aliases.some(a => normalizeAlias(a) === alias)) return id;
    }
    return null;
}

/**
 * `applyX` — the ONLY way a name is ever added to the cast, and it is
 * always a direct, explicit user action (a Модуль's "Add character" form),
 * never something this file's own `detectSpeakers()` calls internally.
 * Mutates a SHALLOW COPY (never the original) and returns `{ cast, id }`;
 * refuses a name already covered by an existing alias (case-insensitive)
 * rather than creating a duplicate — the caller should treat that as "use
 * the existing id" or "reject as a duplicate name", not silently merge.
 */
export function addCastMember(cast, { name, gender = 'unknown', aliases, color = null } = {}) {
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName) throw new Error('addCastMember: "name" is required.');
    if (resolveEntityByName(cast, trimmedName)) throw new Error(`addCastMember: "${trimmedName}" is already in the cast.`);

    const id = `speaker${cast.nextId}`;
    const entity = {
        canonicalName: trimmedName,
        aliases: aliases?.length ? [...new Set([trimmedName, ...aliases])] : [trimmedName],
        gender,
        color,
    };
    return { id, cast: { nextId: cast.nextId + 1, entities: { ...cast.entities, [id]: entity } } };
}

/** Pure removal — removing an unknown id is a harmless no-op, same discipline as namespaced-store.js. */
export function removeCastMember(cast, id) {
    if (!cast.entities[id]) return cast;
    const entities = { ...cast.entities };
    delete entities[id];
    return { ...cast, entities };
}

/** Pure partial update (name/gender/aliases/color) — unknown id is a no-op, never throws. */
export function updateCastMember(cast, id, patch) {
    if (!cast.entities[id]) return cast;
    return { ...cast, entities: { ...cast.entities, [id]: { ...cast.entities[id], ...patch } } };
}

/** Every `{ id, alias }` pair in the cast, longest alias first — so a multi-word alias ("Lady Selanawoo") matches before a shorter one that happens to be its substring ("Selanawoo"). */
function listAliasEntries(cast) {
    return Object.entries(cast.entities)
        .flatMap(([id, entity]) => entity.aliases.map(alias => ({ id, alias })))
        .sort((a, b) => b.alias.length - a.alias.length);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ONE primitive every rule below builds on: does `sentenceText` mention
 * any KNOWN cast member, and where. Whole-word match, case-insensitive
 * (prose sometimes writes a name in a different case than the cast entry).
 * Returns the EARLIEST match in the sentence, or null — never a guess about
 * an unrecognized word, by construction: it can only ever return an id that
 * is already in `cast`.
 */
export function findKnownMention(sentenceText, cast) {
    let best = null;
    for (const { id, alias } of listAliasEntries(cast)) {
        const match = sentenceText.match(new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i'));
        if (match && (!best || match.index < best.index)) best = { id, index: match.index, length: match[0].length };
    }
    return best;
}

/**
 * Splits raw text into sentence-ish spans, one attribution unit each.
 *
 * A quote's own closing punctuation decides what happens next — the same
 * signal a human reader uses: a COMMA before the closing quote mark
 * (`"Enough," Sasha snapped.`) means the clause that follows is a dialogue
 * TAG describing this same quote, so it stays in the same unit. A period/
 * `!`/`?` before the closing quote (`"No." Maria stepped forward.`) means
 * the quote is grammatically complete on its own — what follows is an
 * unrelated new sentence.
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

/** Explicit `Name: "quote"` line — the tag's name is matched against the cast like everything else; an unrecognized name here is left unattributed, not auto-added (see file doc comment). */
export function parseExplicitTag(sentenceText, cast) {
    const match = sentenceText.match(/^\s*([\w'’\- ]{1,30}):\s*["“](.+?)["”]?\s*$/);
    if (!match) return null;
    const id = resolveEntityByName(cast, match[1].trim());
    return { id, rawName: match[1].trim(), quote: match[2] };
}

/** Rule 1 — a speech verb adjacent to a KNOWN cast member's name in the SAME sentence: "Alex said" / "said Alex" / "Alex asked, ...". */
export function findSpeechVerbSubject(sentenceText, cast) {
    const verbPattern = SPEECH_VERBS.join('|');
    for (const { id, alias } of listAliasEntries(cast)) {
        const esc = escapeRegExp(alias);
        if (new RegExp(`\\b${esc}\\b\\s+(?:${verbPattern})\\b`, 'i').test(sentenceText)) return id;
        if (new RegExp(`\\b(?:${verbPattern})\\b,?\\s+${esc}\\b`, 'i').test(sentenceText)) return id;
    }
    return null;
}

/**
 * Rule 2/3 fallback — the earliest KNOWN cast mention in a sentence (its
 * most likely grammatical subject), or a bare pronoun if no known mention
 * comes before it.
 */
export function findSentenceSubject(sentenceText, cast) {
    const withoutQuotes = sentenceText.replace(/["“”][^"“”]*["“”]?/g, ' ');
    const mention = findKnownMention(withoutQuotes, cast);
    const pronounMatch = withoutQuotes.match(/\b(she|he|they)\b/i);
    const pronounIndex = pronounMatch ? withoutQuotes.indexOf(pronounMatch[0]) : Infinity;

    if (mention && mention.index < pronounIndex) return { kind: 'name', id: mention.id };
    if (pronounMatch) return { kind: 'pronoun', value: pronounMatch[1] };
    return null;
}

/** A KNOWN cast member addressed INSIDE a quote ("Sasha, don't.") — excluded as speaker of THIS quote, promoted as a hint for the NEXT unattributed one. */
export function findVocativeAddressee(quoteText, cast) {
    const leading = quoteText.match(/^\s*([\w'’]+)\s*,/);
    if (leading) { const id = resolveEntityByName(cast, leading[1]); if (id) return id; }
    const trailing = quoteText.match(/,\s*([\w'’]+)\s*[.!?]?\s*$/);
    if (trailing) { const id = resolveEntityByName(cast, trailing[1]); if (id) return id; }
    return null;
}

/**
 * Resolves a pronoun subject against the local stack of recently-mentioned
 * KNOWN cast members, most recent first — a naive centering/Hobbs-style
 * walk, not full coreference, but enough for a small live cast. Matches on
 * the cast member's OWN declared `gender` field (set by the user), never an
 * inferred one.
 */
function resolvePronounAgainstStack(pronoun, subjectStack, cast) {
    const wanted = genderFromPronoun(pronoun);
    if (!wanted) return null;
    for (let i = subjectStack.length - 1; i >= 0; i -= 1) {
        const id = subjectStack[i];
        const gender = cast.entities[id]?.gender;
        if (gender === wanted || gender === 'unknown' || gender === 'they' || !gender) return id;
    }
    return null;
}

/**
 * Main entry point. Walks `text` sentence by sentence, tracks a local
 * "last mentioned known subject" stack, and resolves each quote
 * independently — so a paragraph with several speakers never degrades into
 * turn-alternation guessing. `cast` is read-only: this function returns
 * only `{ segments }`, never a modified cast — see file doc comment for why
 * a name is NEVER minted here.
 *
 * `defaultSpeakerName` (optional) — a resolution HINT, not a creation
 * request: if it happens to already match a cast member, it seeds the
 * subject stack (useful when a message never names its own speaker in its
 * own text — "She looks at you...", never "Lisawoo looks at you..."). If it
 * does NOT match anyone in the cast, it is silently ignored — it never adds
 * a new cast member.
 */
export function detectSpeakers(text, cast = createEmptySpeakerCast(), { defaultSpeakerName } = {}) {
    const segments = [];
    const subjectStack = []; // most recent last, known cast ids only
    let pendingAddressee = null; // vocative hint (a known cast id) for the NEXT unattributed quote

    const defaultId = defaultSpeakerName ? resolveEntityByName(cast, defaultSpeakerName) : null;
    if (defaultId) subjectStack.push(defaultId);

    const sentences = splitIntoSentences(text);
    for (const sentence of sentences) {
        const explicit = parseExplicitTag(sentence.text, cast);
        if (explicit) {
            if (explicit.id) subjectStack.push(explicit.id);
            segments.push({
                type: 'dialogue', text: explicit.quote, start: sentence.start, end: sentence.end,
                speakerId: explicit.id, confidence: explicit.id ? 1 : 0, rule: 'explicitTag',
            });
            continue;
        }

        const quoteMatches = [...sentence.text.matchAll(/["“]([^"“”]+)["”]?/g)];
        if (quoteMatches.length === 0) {
            // Pure narration — still worth mining for a subject, so the NEXT
            // sentence's quote (if any) has something to resolve a pronoun against.
            const subject = findSentenceSubject(sentence.text, cast);
            if (subject?.kind === 'name') {
                subjectStack.push(subject.id);
            } else if (subject?.kind === 'pronoun') {
                const id = resolvePronounAgainstStack(subject.value, subjectStack, cast);
                if (id) subjectStack.push(id);
            }
            segments.push({ type: 'narration', text: sentence.text, start: sentence.start, end: sentence.end });
            continue;
        }

        const verbSubjectId = findSpeechVerbSubject(sentence.text, cast);
        let speakerId = null;
        let rule = null;

        if (verbSubjectId) {
            speakerId = verbSubjectId;
            rule = 'speechVerb';
        } else {
            const nonQuoteSubject = findSentenceSubject(sentence.text.replace(/["“][^"“”]+["”]?/g, ''), cast);
            if (nonQuoteSubject?.kind === 'name') {
                speakerId = nonQuoteSubject.id;
                rule = 'adjacentAction';
            } else if (nonQuoteSubject?.kind === 'pronoun') {
                speakerId = resolvePronounAgainstStack(nonQuoteSubject.value, subjectStack, cast);
                rule = speakerId ? 'pronounResolution' : null;
            }
        }

        if (!speakerId && pendingAddressee) { speakerId = pendingAddressee; rule = 'vocativeResponse'; }

        if (!speakerId && subjectStack.length > 0) {
            speakerId = subjectStack[subjectStack.length - 1];
            rule = 'nearestSubject';
        }

        if (speakerId) subjectStack.push(speakerId);

        const quoteText = quoteMatches[0][1];
        const addressee = findVocativeAddressee(quoteText, cast);
        pendingAddressee = addressee && addressee !== speakerId ? addressee : null;

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

    return { segments };
}
