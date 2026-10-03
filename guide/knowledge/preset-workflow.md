---
title: Prompt Manager presets: how to work
tags: preset, presets, prompt manager, block, blocks, group, groups, order, create, new, edit, change, rewrite, rule, rules, instruction, instructions, system prompt, cot, checklist, text rules, divider, condition, sampler, temperature, restore, rollback, version, duplicate, copy
topic: presets
anchors:
always: false
---
You can read, create and edit presets of the Prompt Manager (PM), the part of the engine that builds the request sent to the model. This article is the WORKFLOW; the other "Prompt Manager presets: …" articles hold the ideas of writing blocks, order and cache, modules and the character card, and testing. Read them all before you write a block. A preset is read by the model on EVERY reply, so one careless line costs the user tokens and quality in every chat.

## What you can do
- `preset.read` (automatic) — the full preset: the order tree with names and ids, the text of every block, generation settings, Guided CoT and text rules. The state shows the active preset in full while the talk is about presets; use this for another one.
- `preset.preview` (automatic) — what PM would send for the OPEN chat: tokens per block, what was trimmed, macro warnings, and what the cache did between the last requests. Needs a chat open in SillyTavern.
- `preset.create` (proposal block, applied AT ONCE) — a new preset: from a starter with the standard markers, or as a copy of another preset (`from`). It is never made active for the user.
- `preset.update` (proposal block, applied AT ONCE) — a list of changes (`ops`) and/or generation settings (`params`). Every change saves the previous version first (30 are kept), so nothing is lost.
- `preset.restore`, `preset.duplicate`, `preset.override` — go back to a saved version (keys are in the state), make a copy to try things on, set generation settings for one model, character or chat.
- Because these are applied immediately, never write "shall I apply it?" or "press Apply"; say what changed in a line and go on. When the preset you changed is the ACTIVE one, the next reply already uses it: say so.

You cannot: delete a preset, make a preset active, import or export files, or change SillyTavern's own settings. Say to the user where to do those (the preset picker at the top of the Prompt Manager window). A block or group is addressed by its NAME from the preset view, or by block id when two share a name — never by a name you made up and never by a position.

## The changes (`ops`)
Blocks and groups are addressed by name. One update holds up to 40 changes, applied in order; if one fails, nothing is written and you get the reason.
- `addBlock`, `editBlock`, `removeBlock` — a block is a named prompt: role, text, position (in order, or N messages from the end of the chat), trim priority. To change a long text, send the WHOLE new text; never a fragment. If the view says TRUNCATED, you do not see all of it: change something else or ask the user to paste it.
- `addGroup` — a group holds blocks and, by default, wraps them in `<name>…</name>` and stays silent when empty. `moveNode`, `setEnabled`, `removeNode` — order and switches. Markers (Chat History, Char Description…) can be moved and switched off, never removed.
- `setCondition` — "send only when…" for a block or group; the condition types are in the action list. Use it when a block should appear only in some situations (a keyword, a tracker value, every N-th message, Jev's answer). A block that appears and disappears changes the request from that place on, so keep such blocks near the end (see the order article).
- `placeModule` — move the row of a module (Notebook, RP Time, Summaries, Memory graph…) to a depth in the chat or next to a named node.
- `addRule`, `removeRule` — text rules (replace, remove, cut between two marks, regex) that change only what is sent, never the saved chat.
- `setCot`, `addCotStep`, `removeCotStep` — Guided CoT (separate hidden thinking requests). A checklist inside an ordinary block is a different thing: it is part of the one request; do not move one into the other unless asked.

## The cache law comes first
Every placement, move, new block, new row and new condition answers to the cache law before anything else (see "Prompt Manager presets: order, placement and cache"): whatever can differ between requests stands AFTER the chat history or inside the chat at a small depth; only the Summaries row must stand before the history. This is your first question for every change, and it beats tidiness, grouping and the owner's usual order unless the user insists, and then you say what it costs in one sentence. After a change that touches order, read the preview.

## Before you write anything
1. Know what you are changing. Read the preset (it is in the state, or `preset.read`) and, for a change that affects the whole request, `preset.preview`. Know which modules are on (the state lists them): text that calls a module that is off is dead weight.
2. Know what the request is for: the user's genre, the model they play on, what goes wrong now. If they named nothing specific, ask the one thing that changes the work most.
3. Ask whether the idea belongs in the PRESET or in a CARD. A rule about one character belongs in the card; a rule that every character should follow belongs here (see the modules-and-card article).
4. Big or risky change (reorder, rewrite of several blocks)? Offer to work on a copy (`preset.duplicate`) and say the original stays untouched.

## Writing a new block
1. Decide its one job and its handle: a short name for the concept it teaches (see the blocks article).
2. Write the text from the ideas in the blocks article; do not copy the layout or the wording of any other preset, including the owner's. Another preset shows an IDEA; the block you write answers THIS user's need in a structure that fits it.
3. Put it where it belongs (a group of its kind, a place that suits the cache) and look at the preview: tokens, order, what got dropped.
4. Offer a test when the block is about behaviour (see the testing article). Emphasis and repeats come only after a test or on the user's words.

## Editing an existing preset
- You may do anything the user asks. You are NOT obliged to rename the owner's blocks, regroup them, fix their style or remove their emphasis. Keep the author's voice and structure unless they ask otherwise.
- Change only what changes: an update with just the edits needed. Do not "tidy" blocks you were not asked about.
- The engine checks the form after every write (typos in the blocks you touched, tags that do not pair, references to steps that do not exist, one subheading under two rules, text that calls a module that is off, a per-turn module row that breaks the cache). Findings come to your plan as a `[fix]` line: fix what is a real slip with ONE small update; leave anything the owner wrote on purpose and say so in a line.
- If you notice problems the user did not ask about (a rule repeated in two blocks, a conflict between blocks, a stale reference), say so in a short list and wait for their yes. Do not fix them on your own.
- Say once, when a change is big, that the old version is saved and can be restored (`preset.restore` with a key from the state).

## Consistency check
Before every proposal run through this list in your thinking. Fix what fails, then send.
1. Every concept has one name, used the same way everywhere it is mentioned (a checklist step, another block, the card).
2. Nothing writes `{{user}}`'s actions or thoughts; the preset speaks of `{{user}}` and `{{char}}` through macros, never a real name.
3. No two blocks state one rule in different words without a reason (see the blocks article: repeats are reinforcements).
4. No contradiction between blocks, and none with the card's own prompts (they land in the main and post-history blocks).
5. Cache law: nothing that can differ between requests stands before the chat history, except the Summaries row, which stands before it.
6. Tags open and close with the same name; a group holds one kind of instruction.
7. Macros are real and, if they come from a module, that module is on.
8. Rules are positive where they describe behaviour; a firm limit is allowed where it is a limit of the world.
9. The size is sensible for what the block does (see the order article), and what YOU write is spelled cleanly. What the user wrote is theirs: do not "correct" it unless they ask.
