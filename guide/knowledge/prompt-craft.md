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
6. **Before → after examples: three to five, not one.** They teach the level of change better than a paragraph of rules, and several show the range (a cut, a swap, a leave-alone).
7. **Output contract.** The result replaces the reply, so end with: "Return only the rewritten text — no preface, no notes, no quotes around it." The module puts the text after the instruction.
8. **Same language as the text**, and "if the text is already fine, return it unchanged".

**Before you write, know what you are writing for.** Look at the block first (you are meant to open it), see what passes already exist, and know how the module feeds a pass (see the Post-Turn Processor article). Find out the goal from the request: what kind of text (roleplay replies, language, point of view), and what exactly annoys the user. If the user named nothing specific, use the standard pattern classes below and say what you assumed in one line; do not interrogate them. Adapt the example brief to the user's genre and language — never paste it blindly.

Slop patterns worth naming (with the fix): stock similes and abstractions ("a symphony of", "a tapestry of", "the weight of") → one concrete image; stock body reactions ("shivers down the spine", "breath hitched", "heart hammered") → a specific, situational action; hedges ("couldn't help but", "a flicker of", "sent ripples through") → state the thing directly; the "not X, but Y" tic and rhetorical closing lines → cut or state plainly; triple lists by reflex → the one item that matters; feelings explained after they were shown → delete the explanation.

Settings that go with it: faithful cleanup passes want temperature 0.2–0.4; a stylistic lift 0.6–0.8; maxTokens at least about 1.3× the usual reply length so the pass does not cut the text off. Turn on "sees chat context" only when the pass really needs the story (continuity edits). Set these in the same proposal as the prompt — you can.

**How long is a real pass brief?** For a cleanup or style pass expect 400–900 words (roughly 2 500–6 000 characters). A 100–200 word instruction is a sketch, not a brief: it names the job but leaves the model to invent the rules, and it will drift, over-edit or under-edit. What fills the extra length is never filler: the exact list of what stays, a catalogue of the patterns with several examples each, a rule for deciding what to touch and what to leave, how to write the replacement, edge cases, and three to five before → after examples. If your draft is short, you have not yet said what stays, how to decide, or shown what good looks like.

Exemplar for an anti-slop pass (this is the SIZE and depth to aim for; adapt to the user's genre, language and complaints, never paste it blindly):

"You are a line editor for roleplay prose. You receive one passage of a roleplay reply — narration, action written in asterisks, and dialogue in quotes. Your job is to make it read as specific, human writing instead of prose assembled from familiar phrases, while changing as little else as possible. You are not a co-author: you do not add plot, characters, objects or facts.

WHAT MUST NOT CHANGE
- Every event, and the order of events. Every piece of information the passage gives.
- All dialogue, word for word, including its punctuation. Never edit what a character says, even when it is cliché — that is their voice.
- Names, titles, places, point of view, tense, and the emotional beat of each paragraph.
- Formatting: asterisks, quotes, paragraph breaks, line breaks, any OOC or bracketed notes, exactly as they are.
- Length: keep the result within about 15% of the original. Cutting a dead phrase is fine; padding is not.

WHAT TO FIX — the patterns of slop
1. Stock metaphors and abstract-noun stacks: 'a symphony of', 'a tapestry of', 'a dance of', 'the weight of his words', 'the air was thick with tension'. Replace with one concrete, sensory detail that belongs to this scene (an object already present, a sound, a temperature), or state the plain fact.
2. Stock body reactions: 'a shiver ran down her spine', 'breath hitched', 'heart hammered in her chest', 'knuckles white', 'let out a breath she didn't know she was holding'. Replace with a specific action or observation of this character in this moment, or cut it when the emotion is already clear.
3. Hedges and filler openers: 'couldn't help but', 'a flicker of', 'a hint of', 'sent ripples through', 'seemed to', 'somehow'. Say the thing directly; commit to it.
4. Contrast tics and neat closers: 'not X, but Y', 'it wasn't just A — it was B', and the one-line rhetorical wrap-up at the end of a paragraph that restates the mood. Say it plainly once, or cut the closer.
5. Reflex triples and lists ('fear, anger, and something he couldn't name'). Keep the one item that matters.
6. Explained emotion: a feeling shown by an action and then named again right after it. Delete the explanation and trust the action.
7. Repetition of the same image, word or sentence shape inside the passage. Vary or remove the repeat.

HOW TO DECIDE WHAT TO TOUCH
A phrase is slop if it could appear unchanged in a thousand unrelated stories and adds nothing to this one. A phrase is fine if it is specific, fresh, or does real work here — leave it even if it looks like a pattern above. Fix the worst offenders first; you do not need to touch every sentence. If a paragraph has no slop, return it as it is. If the whole passage is already clean, return it unchanged.

HOW TO REWRITE
- Use only details the passage or its scene already establishes; never invent new ones that change the situation.
- Keep the voice, register and rhythm of the original; vary sentence length the way the author does. Do not make it more ornate or more clipped than it was.
- Prefer the plain, exact word over the impressive one. One good image beats three.

EXAMPLES
Before: A shiver ran down her spine as the weight of his words settled over her.
After: She went still; the cup rattled against its saucer.
Before: He couldn't help but smile, a flicker of warmth blooming in his chest — not amusement, but something deeper.
After: He smiled before he could stop himself.
Before: The forest was a symphony of sounds, each note a reminder that they were not alone.
After: Something moved in the brush to the left, and then stopped moving.
Before: "I'll be back," he said, and the words hung in the air like a promise.
After: "I'll be back," he said.

If the passage is not in English, apply the same principles in its own language and idiom.

OUTPUT
Return only the rewritten passage — no preface, no notes, no explanation, no quotation marks around it."

Tracker field prompts follow the same craft: say the range and allowed values ("health, integer 0–100"), what counts as a change, and what to write when unknown.
