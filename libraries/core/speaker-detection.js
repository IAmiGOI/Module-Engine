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
 *
 * **Presence veto/departure (ROADMAP.md 5.41)** — a mention of a KNOWN cast
 * member doesn't always mean they're present: "Maria thinks of Alex often."
 * mentions Alex, but he isn't the one there. Ported (as an idea, not code —
 * MIT) from ryzendigo's `scene-director` PresenceEngine, which scores
 * arrival/action cues against a veto list of absence-context phrases; this
 * file only needs the veto half; see `hasPresenceVeto()`/
 * `findDepartureSubject()`.
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

/**
 * Absence-context phrases — a KNOWN cast member mentioned inside one of
 * these is being talked ABOUT, not established as present/speaking
 * ("Maria thinks of Alex often." must not make Alex a candidate for the
 * next unattributed quote). Ported from the scoring idea in ryzendigo's
 * `scene-director` PresenceEngine (MIT) — its own veto-word list also
 * covers `call`/`phone`/`text`/`message`, deliberately left OUT here: those
 * verbs are too often a real speech/arrival action in RP prose ("calls out
 * to her") to safely veto on word alone without the scoring machinery that
 * extension builds around them. Phrase-level (not single words) to avoid
 * "about" alone vetoing unrelated sentences.
 */
const PRESENCE_VETO_PHRASES = [
    'think of', 'thinks of', 'thought of', 'thinking of',
    'think about', 'thinks about', 'thought about', 'thinking about',
    'miss', 'misses', 'missed', 'missing',
    'remember', 'remembers', 'remembered',
    'wonder', 'wonders', 'wondered',
    'wish', 'wishes', 'wished',
    'promise', 'promises', 'promised',
];

/** Explicit departure — a stronger, unconditional veto (see `findDepartureSubject`): once left, a cast member drops out of the subject stack entirely, not just for the current sentence. */
const DEPARTURE_VERBS = [
    'leaves', 'leave', 'left', 'departs', 'depart', 'departed',
    'exits', 'exit', 'exited', 'walks out', 'walked out', 'walks away', 'walked away',
];

/** True if `sentenceText` contains an absence-context phrase — see `PRESENCE_VETO_PHRASES`. */
export function hasPresenceVeto(sentenceText) {
    return PRESENCE_VETO_PHRASES.some(phrase => new RegExp(`\\b${phrase.replace(' ', '\\s+')}\\b`, 'i').test(sentenceText));
}

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

/** Title abbreviations — the period after one of these must NOT end the sentence ("Dr. Okumura" is one name, not "Dr." + "Okumura"). Found live: this exact case broke `findKnownMention()`'s match on "Dr. Okumura", ROADMAP.md 5.42. */
const TITLE_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'st', 'capt', 'lt', 'sgt', 'col', 'gen', 'rev', 'jr', 'sr']);

/** True if the word immediately before `periodIndex` (the `.` itself, not counted) is a known title abbreviation. */
function endsWithTitleAbbreviation(text, periodIndex) {
    const wordMatch = text.slice(0, periodIndex).match(/([A-Za-z]+)$/);
    return Boolean(wordMatch && TITLE_ABBREVIATIONS.has(wordMatch[1].toLowerCase()));
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
 *
 * A run of 2+ dots, or the single Unicode ellipsis character `…`, counts as
 * ONE terminal mark (`…`/`...` both close a sentence exactly once) — found
 * live: the single-character `…` wasn't recognized at all, silently fusing
 * every ellipsis-separated narrative beat in a paragraph into one giant
 * "sentence", which (among other things) fed `findSentenceSubject()` a
 * blob wide enough to smuggle unrelated narration into a later quote's
 * paint range. ROADMAP.md 5.42.
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
        // `…` (single-char ellipsis) added to the terminal-mark class — a run
        // like "..." only ever fires HERE anyway, at its last character:
        // every earlier dot in the run is followed by another dot, not
        // whitespace, so the existing `(i === length-1 || /\s/.test(next))`
        // check below already skips them without any extra run-detection.
        if (!inQuote && /[.!?…]/.test(ch) && (i === text.length - 1 || /\s/.test(text[i + 1])) && !(ch === '.' && endsWithTitleAbbreviation(text, i))) {
            sentences.push({ text: text.slice(start, i + 1), start, end: i + 1 });
            start = i + 1;
            awaitingTag = false;
        }
    }
    if (start < text.length && text.slice(start).trim()) sentences.push({ text: text.slice(start), start, end: text.length });
    return sentences;
}

/**
 * Explicit `Name: "quote"` line — the tag's name is matched against the
 * cast like everything else; an unrecognized name here is left
 * unattributed, not auto-added (see file doc comment).
 *
 * `quoteStart`/`quoteEnd` — the QUOTE's own character offsets within
 * `sentenceText`, `d`-flag (`hasIndices`) group positions, not a guess:
 * `splitIntoSentences()` fuses the "Name:" prefix (and everything before it
 * back to the previous sentence boundary — narration included, when a
 * paragraph never hits real terminal punctuation) into the SAME unit as the
 * quote, so `sentenceText` itself is almost always wider than the quote.
 * The caller MUST use these, not the whole sentence span, when deciding
 * what to paint — using the sentence span was a real bug (found live on a
 * beta tester's transcript, ROADMAP.md 5.42): unrelated narration sitting
 * in front of a "Name:" tag got colored along with the quote it precedes.
 */
export function parseExplicitTag(sentenceText, cast) {
    const match = sentenceText.match(/^\s*([\w'’.\- ]{1,30}):\s*["“](.+?)["”]?\s*$/d);
    if (!match) return null;
    const id = resolveEntityByName(cast, match[1].trim());
    const [quoteStart, quoteEnd] = match.indices[2];
    return { id, rawName: match[1].trim(), quote: match[2], quoteStart, quoteEnd };
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
 * A KNOWN cast member adjacent to an explicit departure verb in THIS
 * sentence ("Alex leaves." / "Alex walks out of the room.") — the caller
 * removes them from the subject stack entirely once this fires, so a LATER
 * pronoun or `nearestSubject` fallback can't attribute a quote to someone
 * who has already left the scene. Same word-order pattern as
 * `findSpeechVerbSubject` (name-then-verb is the overwhelmingly common
 * order for this construction, so only that direction is checked).
 */
export function findDepartureSubject(sentenceText, cast) {
    const verbPattern = DEPARTURE_VERBS.join('|');
    for (const { id, alias } of listAliasEntries(cast)) {
        if (new RegExp(`\\b${escapeRegExp(alias)}\\b\\s+(?:${verbPattern})\\b`, 'i').test(sentenceText)) return id;
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
        // Departure sweep — runs BEFORE anything else uses the stack this
        // sentence: once someone's explicitly written as leaving, they can no
        // longer be the implicit subject of a later pronoun/nearestSubject
        // fallback, in THIS sentence or any that follow.
        const departedId = findDepartureSubject(sentence.text, cast);
        if (departedId) {
            for (let i = subjectStack.length - 1; i >= 0; i -= 1) if (subjectStack[i] === departedId) subjectStack.splice(i, 1);
            if (pendingAddressee === departedId) pendingAddressee = null;
        }

        const explicit = parseExplicitTag(sentence.text, cast);
        if (explicit) {
            if (explicit.id) subjectStack.push(explicit.id);
            // Paint range is the QUOTE ITSELF (`quoteStart`/`quoteEnd`, offset
            // into `sentence.text` by `parseExplicitTag()`), never the whole
            // fused sentence span — see that function's doc comment.
            segments.push({
                type: 'dialogue', text: explicit.quote,
                start: sentence.start + explicit.quoteStart, end: sentence.start + explicit.quoteEnd,
                speakerId: explicit.id, confidence: explicit.id ? 1 : 0, rule: 'explicitTag',
            });
            continue;
        }

        const quoteMatches = [...sentence.text.matchAll(/["“]([^"“”]+)["”]?/g)];
        if (quoteMatches.length === 0) {
            // Pure narration — still worth mining for a subject, so the NEXT
            // sentence's quote (if any) has something to resolve a pronoun against.
            const subject = findSentenceSubject(sentence.text, cast);
            if (subject?.kind === 'name' && subject.id !== departedId && !hasPresenceVeto(sentence.text)) {
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
            if (nonQuoteSubject?.kind === 'name' && nonQuoteSubject.id !== departedId && !hasPresenceVeto(sentence.text)) {
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

        // Paint range is the QUOTE ITSELF, never the whole `sentence` span —
        // `sentence.text` can carry fused-in narration/tag prefix ahead of it
        // (see splitIntoSentences()'s doc comment on the comma/colon merges;
        // same bug class as parseExplicitTag()'s `quoteStart`/`quoteEnd`,
        // found live, ROADMAP.md 5.42). `quoteMatch.index` is the position of
        // the WHOLE match (opening quote mark included), so `+ 1` skips past
        // that one character to the inner text `findVocativeAddressee()`/the
        // returned `text` field already operate on.
        const quoteMatch = quoteMatches[0];
        const quoteText = quoteMatch[1];
        const quoteStart = sentence.start + quoteMatch.index + 1;
        const addressee = findVocativeAddressee(quoteText, cast);
        pendingAddressee = addressee && addressee !== speakerId ? addressee : null;

        segments.push({
            type: 'dialogue',
            text: quoteText,
            start: quoteStart,
            end: quoteStart + quoteText.length,
            speakerId: speakerId ?? null,
            confidence: speakerId ? (rule === 'speechVerb' ? 0.95 : rule === 'adjacentAction' ? 0.85 : rule === 'pronounResolution' ? 0.7 : rule === 'vocativeResponse' ? 0.6 : 0.4) : 0,
            rule,
        });
    }

    return { segments };
}
