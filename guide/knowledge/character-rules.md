---
title: Character cards: the skeleton and the named rules
tags: character, card, cards, skeleton, rules, rule, named, naming, description, core goal, personality, traits, behaviour, awareness, speech, guidelines, appearance, tic, parentheses, positive, negation, knowledge
topic: characters
anchors:
always: false
---
These are the rules of writing a card. They come from the owner's own cards and from testing them in real roleplay, so follow them exactly and do not fall back on a generic character template (no "Name / Age / Gender / Personality: kind, brave" sheets, no lists of adjectives).

## Explicit Naming
What is it? Every rule, mechanic or trait the model must act on gets its OWN clear name, written as a header line. Any explicit term lets the model hold on to its context much harder than an instruction it must interpret. Never write "that rule above" or "as said before": the name is the handle.

How to apply:
- A named rule is a header line in bold, then its lines: `**Culture void**` then what it means for this character. Use the same header style in `description` and in `post_history_instructions`.
- A good name says what the rule DOES, in one to four words, in the character's own terms: `Senses - key`, `Fluid Body Movement`, `Culture void`, `Floating point of attention`, `Body-Bias`, `Sosu`. A bad name is vague (`Rule 1`, `Extra`, `Important`, `Notes`).
- Names are free per character, but when the concept is the same as one the preset already names, use the preset's term (Global goal, Needs, Self-Awareness, Explanation Veto, Personality preservation, Attention points, Body-framework — see "How the owner's preset reads a card").
- The name is the handle for repeats: when a rule is reinforced later (in `post_history_instructions`, after a test), the reinforcement carries the SAME name.
- Each name is used once per card for one rule. Two rules never share a name; one rule never has two names.

## The Skeleton
What is it? The fixed beginning of `description`. The sections always exist, in this order. A card may ADD sections, never drop one. Everything after Guidelines is free.

The first line is the header: `***Name***`, and under it, if useful, one line of identity in the world's own terms (for example "Approximate age: 150 years by 6th level time").

1. **Core goal** — what the character wants most, stated once in a line; then the hard limit on getting it, in the same lines (what cannot be done, the barrier, the price). The preset reads this as the character's Global goal, so write it as a goal, not as a backstory.
2. **Core Personality traits** — the stable traits. Each trait comes with its CONSEQUENCE (Trait → Consequence, below). Not a list of adjectives.
3. **Behaviour** — what the character concretely DOES in situations: what comes first, what they touch, sniff, avoid, claim, protect; habits learned from how they grew up; abilities (and what they cost or need). This is the section the model acts from.
4. **Awareness** — what the character knows and believes about themselves and the world: do they find their own behaviour strange? what do they take for granted? what are they sure of and wrong about? The preset reads this as Self-Awareness.
5. **Speech** — how the character talks. Every feature of the speech is a NAMED rule (see Named Speech Features), followed by one or two sample lines.
6. **Guidelines** — rules for the NARRATOR about this character (how the character is to be shown), for example "show what happens, not the reasoning behind it".

After Guidelines come free sections, named by you for what they hold: `**Appearance**`, `**Birth**`, `**Backstory**`, `**World**` and so on — only what this character needs. They describe the character's story and surroundings.

Shape of a finished description (shape only — the content is invented):
```
***Mira***
Approximate age: 34 years

**Core goal**
Mira wants to bring the last caravan through the Salt Pass before the first snow.
BUT the pass can only be crossed at dawn, and she has never once seen the dawn from the other side.

**Core Personality traits**
Mira counts everything: people, water, days.
Counting leads to her choices and to the way she measures strangers. Not to speeches.
…
**Behaviour**
Mira checks the wind before she looks at a person's face.
…
**Awareness**
Mira does not think of herself as cold. She thinks of herself as careful.

**Speech**
**Number habit**
Mira puts a number into every second sentence: "Three days, maybe four."
**Dry short answers**
She answers in one sentence and waits for the next question.
"Two wells left. Drink slowly."

**Guidelines**
Show what Mira does; do not explain why she does it.

**Appearance**
…
```

## Name Literal
What is it? The character's own name is written out everywhere in the card: in `description`, in `post_history_instructions`, in the examples. `{{user}}` is used only for the player; there is no `{{char}}` in the text of a card.

## Trait → Consequence
What is it? A trait alone tells the model nothing it can act on. A trait is written together with what it leads to, and — in the same line or the next — what it does NOT lead to.
- Weak: "Mira is observant."
- Strong: "Mira notices small changes in a place before she notices the people in it. Noticing leads to her choices and to what she asks; not to long descriptions of what she saw."
The consequence is the thing the model can reproduce. Write it in positive terms; see Positive Phrasing.

## Parenthesis Bound
What is it? A parenthesis after a rule is a clarification of THAT rule: its bound, its consequence, or a correction of how it is easily misread. Keep it short and put it directly after the rule it belongs to.
- "She touches everything. (Very active, moves fast. Without asking.)"
- "She puts a lot of emotion into her speech. (She is not talkative all the time.)"
- "She dislikes being observed. (No fear, mostly disgust.)"
- "{{user}} does not know the goggles were a gift. ({{user}} learns it only when she says it.)"
A parenthesis never carries a separate new rule — that gets its own name.

## Positive Phrasing
What is it? Rules say what the character DOES. A negative wording ("never", "does not", "no X") is allowed only next to the positive wording it belongs to, or not at all. Negations are a repair tool: they are added after a test showed the model doing the wrong thing, not written up front.
- Good: "Mira answers in one sentence. (She does not fill silences.)"
- Not good: "Mira never talks much. Never gives speeches. Never explains herself."

## No Preset Echo
What is it? The preset already owns the general rules of roleplay. The card does not repeat them. A card repeats a preset rule only where a test showed the model dropping it for this character — and then as a named rule in `post_history_instructions`.

The preset already owns (do not write these into a card):
- acting for `{{user}}` (never writes their actions, words, thoughts); second person and present tense; the length and pacing of replies; one meaningful user action per reply;
- prose quality: no stock phrases, no echoing the user's words, no "not X but Y";
- general psychology: personality preservation, feelings are shown not explained (Explanation Veto), characters can lie, refuse and hurt `{{user}}`, `{{user}}` has no plot armour;
- how Needs, Goals and Decisions are derived, attention points, what each character knows, secrets, time.
The card supplies the character-specific RAW MATERIAL those procedures read.

## Named Speech Features
What is it? Every feature of how the character talks that the examples show is ALSO written as a named rule in **Speech**. The examples illustrate; they do not carry the rule alone. Look at your examples and name what they do:
- **The tic or signature word**, with the in-world reason: "Sosu — she puts it into sentences because she thinks it makes her sound like a princess", plus two sample lines.
- **How they refer to themselves**: in the third person by name, "I", "we", a title.
- **Rhythm**: "speaks in waves — calm and short, then a burst, then short again".
- **Format of stress and sound**: "stressed words in CAPS", stretched vowels in wordless sounds.
- **A grammar clarification** when the oddity is NOT grammar: "speaks with normal grammar and may know hard words; it is the volume and the rhythm that are strange".
- **A rarity guard** in a parenthesis when the trait must not be overdone.
- **Languages** the character knows.
- Whether the first reaction is instinctive or deliberate.

## Free Story Sections
What is it? Everything after Guidelines. Write what the character's story and body need, as named sections. Two habits from the owner's cards:
- **Appearance as mechanics.** An anatomy feature is followed, in parentheses, by what it does to behaviour: "Claws act as fingers. (Picking up small objects is hard; clenching makes them meet in the middle.)" Numbers are exact, in the world's terms. The model is told where fur is and where skin is, what the eyes do ("always moving").
- **Knowledge Gating.** What `{{user}}` does not know is marked where the fact stands, in a parenthesis: "({{user}} does not know this until she says it)". The preset's Secrets tool handles secrets during play; the card only says which facts `{{user}}` does not have.
Lore that matters only sometimes belongs in a lorebook entry, not in the always-sent description — but only when the user wants a lorebook (`character_book` is on request).

## What the model forgets — and what you do about it
You do not guess which rules a model will forget. You write the card clean and named, then test it (see "Character cards: testing and reinforcing"). Reinforcement — emphasis marks, a count in parentheses, a repeated rule — is the result of a test or of the user saying "she keeps forgetting X". Until then, none.
