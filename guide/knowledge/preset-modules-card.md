---
title: Prompt Manager presets: modules, macros and the character card
tags: preset, presets, module, modules, macro, macros, card, character, character card, main prompt, post history, jailbreak, system prompt, depth prompt, marker, markers, notebook, secrets, rp time, summary, memory, lorebook, world info, info
topic: presets
anchors:
always: false
---
A preset does not stand alone: the card, the lorebook and the modules all put text into the same request. Know where each lands before you write a block that depends on one.

## Markers: where the material lands
Markers are blocks the assembler fills in: the character description, personality, scenario, the persona, world info before and after the character, the chat examples and the chat history. You can move them and switch them off, never remove them; a request without the chat history marker is not a chat. The text around a marker (a group's tags, a line before the examples) tells the model what the material is.

## The card's own prompts
The card's system prompt, post-history instructions and depth prompt are applied the way SillyTavern applies them: the system prompt fills the preset's main block, the post-history text fills the post-history block, a block set to forbid overrides is left alone, `{{original}}` in the card's text inserts the block's own text, and the depth prompt is injected at the depth and role the card names. So:
- Leave those blocks in the preset even when they are empty: empty is how the card's text gets in, and removing one throws the card's rules away.
- Do not repeat in the preset what a card says about one character; the preset is for what every character should follow.
- When a card's rule fights a preset block, the model sees both. Say which one should win and change THAT one, not both.

## Modules and what the text may assume
Some text asks the model to use a module: write to a notebook, call a secrets tool, read the date from time macros. That text only works while the module is on. The state lists the modules and whether they are on; before you write or keep such a line, check, and if a module is off say so rather than write dead instructions. Likewise the row of a module only sends something when the module has content for it.

## Macros
Macros like `{{user}}`, `{{char}}` and the module macros (the time macros of RP Time) are replaced in the text that is sent. Use them instead of real names. Unknown macros stay as plain text and the preview warns about them. Random macros change every request and break the cache unless "Freeze random" is on in the Settings tab.

## Lorebook and memory
World info lands through the two world info markers; their format is set by the preset's templates. Summaries and the memory graph come as module rows. A preset block that talks about "what the character remembers" should say where that memory comes from (the rows above) rather than describe a memory it cannot see.

## What the preset should assume about a card
Cards written in this engine give the preset the raw material its procedures read: a core goal, concrete behaviour, awareness, named speech rules. Write preset blocks that read those things and do not require a particular layout; a user's own cards may be written another way. See the article about how the preset reads a card for what the owner's cards provide.
