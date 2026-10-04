---
title: Prompt Manager presets: writing blocks
tags: preset, presets, block, blocks, write, writing, wording, rule, rules, concept, name, naming, procedure, guidelines, psychology, needs, goals, decisions, prose, style, tags, group, repeat, repetition, positive, negation, checklist, cot, slop, bias, agency
topic: presets
anchors:
always: false
---
These are the ideas of writing the blocks of a preset. They come from the owner's own presets and from testing them in real roleplay. They are IDEAS, not a template: never reproduce the owner's blocks, headings, wording or group layout, and never fill in a fixed skeleton. Understand the idea, then write a block that answers what THIS user needs, in a structure that suits that block. A block that merely echoes another preset is a bad block.

## A block has one job
Say in one line what the block makes the model do differently. A block that does three things (pace, length and point of view in one) cannot be named, cannot be tested and cannot be reinforced; split it. If you cannot say its job, you are not ready to write it.

## Give a concept a handle
The model holds on to a named thing far harder than to an instruction it must interpret. When a block introduces a way of thinking (how needs turn into goals, how attention narrows, how a character protects their own personality), give the concept a short, plain name and use exactly that name every time it is mentioned: in the block, in a checklist question, in the card's own text. A name is used for one concept and a concept has one name. When you rename one, change every place that mentions it.

## Teach a procedure, not a mood
A block that says "characters are independent" does little. A block that says what the model should look at, what it should decide from it and what it should do next gives behaviour: what to read (the card, the chat, what is already written down), what to decide, where to put the result. Prefer steps the model can actually carry out with what it has in the request. If a step needs a module's tool (a notebook, a secret), that module must be on.

## The preset owns the general mechanics; the card owns the raw material
The preset says HOW a character's wants become choices, how attention works, what a character may know. The card says WHO this character is. A preset block that describes one character is in the wrong place; a card that repeats a mechanic the preset already runs is also in the wrong place (see the card articles). Write the preset block so it can read whatever a card gives it.

## Say what happens
Rules that describe behaviour and prose are written as what DOES happen: "remains still", not "does not move". Negations are a repair tool: they are added after a test shows the model doing the wrong thing, next to the positive wording they belong to. A firm limit is a different thing: a rule of the world (nobody is protected by the plot, time passes in full) may be absolute, because it is a boundary, not a behaviour. Keep those few and clear.

## Stay inside what the model can follow
- Rules the model can check against its own last reply (do not repeat the user's words, vary the opening) work better than abstract standards ("be original").
- A good rule often carries a short example of the bad and the good version. One pair is enough; a list of banned phrases makes the model fixate on them: name the pattern and give two or three samples.
- Say who the model is writing for and from where (whose eyes, which tense, which person) once, in the frame, and let the other blocks use it without restating it.

## A block's text decides where it can stand
Before you write, know whether the block's text stays the same in every request. A block that quotes the scene, uses a random macro or appears only under a condition cannot stand before the chat history without breaking the cache (see the order article). Write such text so that it can live after the history; keep what must stand before it (the frame, the stable rules) free of anything that changes.

## Structure carries meaning
Group tags (`<logic>`, `<narration>`, `<info>`) tell the model what KIND of text follows: the character's material, the world's rules, how to write, how to think before writing. Keep one kind per group; keep the material the card and chat give apart from instructions; open and close tags with the same name. Names of groups and tags are plain words in one style across the preset.

## Repetition is a decision
A rule stated in two places is a reinforcement and should be one on purpose: the same name, the lighter wording in the second place, the second place nearer the end of the request, where the model reads last. The reasons are real (a rule that slipped in tests). Two blocks that silently say one thing in different words only double the tokens and the weight. Before you add a rule, search the preset for it; before you repeat one, know why. Emphasis (capitals, `!!`, "you are obligated") is a scar of a failure, never a first draft; use the lightest form that fixes the failure and try again before going heavier.

## Checklists the model walks before it writes
A self-check list is a list of questions in the order a decision is made: what is known, what each character wants, what they would do alone, what the user is trying, what stands in the way, then how to write it. Good ones: each question answerable in a sentence, limits on how long the answer may be, steps that use the same names as the blocks they depend on, no step that refers to another by number unless the numbering is kept in step (a reference to a step that is gone is worse than none). Do not let a checklist duplicate the blocks: it asks the questions, the blocks hold the rules.

## Size
There are no fixed sizes. A block is as long as its procedure needs and not longer; if a block repeats another or fills the space with reassurance, cut it. Remember the whole request: the preset's own blocks and the card together should leave the model room for the chat. The sweet spot for the whole request is about 35 000 tokens and the ceiling without losses about 50 000 to 60 000 in total (see the order article): use `preset.preview` and say the token cost of what you add and the new total.

## Language
Write blocks in the language the user plays in; English if they did not say. Keep spelling and grammar of what you write clean. The owner's own text may contain slips or odd phrasing: that is theirs, and you change it only when asked.
