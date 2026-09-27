---
title: Writing strong prompts (passes, trackers, painter)
tags: prompt, prompts, instruction, instructions, pass, passes, rewrite, rewriting, slop, cliche, cliches, style, write, wording, temperature
anchors: module:module.postprocess, module:module.tracker, module:module.scenePainter
always: false
---
When you write a prompt for the user (a Post-Turn pass, a tracker field, a painter instruction), write it as a working brief, not a one-liner. **A prompt must be precise — it does not have to be short.** Length is fine, even good, when every sentence does work: a constraint, a target, an example, a format rule. Never cut needed detail to look tidy, and never pad with filler, repetition or pleading ("very important!", "please be careful"). Test each sentence: if removing it would change what the model does, keep it; if not, drop it. Weak prompts are vague, only forbid things and say nothing about the result. What makes one strong:

1. **One job per pass.** Cleanup and stylistic lift are two passes, not one. Order: fix structure and cliches first, style after (each pass sees the previous result).
2. **Say who and what for.** One line of role and goal: "You are a line editor for roleplay prose. The reader wants scenes that feel specific and alive."
3. **Say what stays.** The model will drift unless told what is fixed: events and their order, dialogue word for word, names, point of view and tense, formatting (asterisks, paragraphs), and length within about ±15%.
4. **Name the target, not only the ban.** "Replace X with concrete detail" beats "don't use X". Describe the good version: a specific object, sound, gesture, number instead of an abstraction.
5. **Classes of problems, not a giant word list.** A long ban list makes the model fixate on those words. Name the patterns and give 2–3 examples each; leave phrases alone when they fit the moment.
6. **One tiny before → after example.** It teaches the level of change better than a paragraph of rules.
7. **Output contract.** The result replaces the reply, so end with: "Return only the rewritten text — no preface, no notes, no quotes around it." The module puts the text after the instruction.
8. **Same language as the text**, and "if the text is already fine, return it unchanged".

**Before you write, know what you are writing for.** Look at the block first (you are meant to open it), see what passes already exist, and know how the module feeds a pass (see the Post-Turn Processor article). Find out the goal from the request: what kind of text (roleplay replies, language, point of view), and what exactly annoys the user. If the user named nothing specific, use the standard pattern classes below and say what you assumed in one line; do not interrogate them. Adapt the example brief to the user's genre and language — never paste it blindly.

Slop patterns worth naming (with the fix): stock similes and abstractions ("a symphony of", "a tapestry of", "the weight of") → one concrete image; stock body reactions ("shivers down the spine", "breath hitched", "heart hammered") → a specific, situational action; hedges ("couldn't help but", "a flicker of", "sent ripples through") → state the thing directly; the "not X, but Y" tic and rhetorical closing lines → cut or state plainly; triple lists by reflex → the one item that matters; feelings explained after they were shown → delete the explanation.

Settings that go with it: faithful cleanup passes want temperature 0.2–0.4; a stylistic lift 0.6–0.8; maxTokens at least about 1.3× the usual reply length so the pass does not cut the text off. Turn on "sees chat context" only when the pass really needs the story (continuity edits). Set these in the same proposal as the prompt — you can.

Example brief for an anti-slop pass (adapt, do not paste blindly):
"You are a line editor for roleplay prose. Rewrite the text so it reads as specific and human. Keep: every event and its order, all dialogue word for word, names, point of view, tense, paragraphing and formatting; keep the length within 15%. Change only what is slop: (1) stock metaphors and abstractions such as 'a symphony of', 'the weight of' — replace with one concrete image; (2) stock body reactions such as 'shivers down the spine', 'breath hitched' — replace with a specific action that fits the scene; (3) hedges such as 'couldn't help but', 'a flicker of' — state it directly; (4) 'not X, but Y' constructions and neat rhetorical closing lines — say it plainly or cut. If a phrase works in context, leave it. Example: 'A shiver ran down her spine as the weight of his words settled.' → 'She went still; the cup rattled against its saucer.' Return only the rewritten text, with no preface or notes."

Tracker field prompts follow the same craft: say the range and allowed values ("health, integer 0–100"), what counts as a change, and what to write when unknown.
