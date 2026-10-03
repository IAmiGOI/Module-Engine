---
title: Prompt Manager presets: testing and reinforcing
tags: preset, presets, test, testing, probe, probes, forgets, forgetting, reinforce, reinforcement, emphasis, slip, regression, compare, copy, duplicate, preview, review
topic: presets
anchors:
always: false
---
A preset block is a claim about how the model will behave. You write it clean and named, then check it. Heavy wording (capitals, `!!`, repeats, "you are obligated") is the scar of a failed check, never the first draft.

## What you can check without spending the user's tokens
- `preset.preview` — the request as it would go: order, what each block costs, what was dropped, cache behaviour. It shows form problems at once (a block that is missing, empty, in the wrong place, a module row at the wrong depth).
- The engine's own check after a write (typos in what you touched, tags that do not pair, references to steps that do not exist, a repeated subheading, text for a module that is off, a per-turn row that breaks the cache).

## Testing behaviour
Behaviour needs the model. Use `character.test` with a character the user names: it runs a short series of turns in an isolated chat with the ACTIVE preset and that character, on the model the user plays on. It costs tokens (each probe is a full generation), so offer it as a button with the number of probes. To compare two versions of a preset, work on a copy (`preset.duplicate`), ask the user to make the copy active, and run the same probes on both; say clearly which preset was active in each run.
- One probe per idea you want to check, plus one plain situation. A probe is what the user would naturally write to make the model reach for the rule: a plan of several steps for a pace rule, a bare apology for a rule about independence, a question the character cannot know for a knowledge rule.
- Keep probes short, in the user's voice and language, and inside what the user wants from the roleplay.

## Reading the replies
Read each reply against the rule it tests, honestly:
- Say in a few lines what held and what slipped. Quote the slipped part and name the block.
- Decide whose slip it is. The same slip in a bare chat with no preset is the model's; a slip that appears only with this preset is a block that is unclear, missing, buried or fighting another block; a slip about one character is probably the card's.
- One sample is not proof: one clean reply does not prove a rule and one slip may be chance. If it is borderline, run that probe once more before changing the preset.

## Reinforcing
Use the lightest form that fixes the failure, then run the probe again:
1. Make the rule clearer and name it (the failure is often vagueness).
2. Move it nearer the end of the request, or into the group where its kind belongs.
3. Add the positive wording of what should happen; add the negation beside it only if the model keeps doing the thing.
4. Only then emphasis: capitals on the one exact fact, or a single `!!` pair on the single most important rule.
5. A repeat in a second block carries the SAME name and a lighter wording, and stands later in the request.
After the second round on one rule, stop stacking marks: the rule is probably fighting another block (look for the conflict: another block, the card's prompts, a module row) or the model simply cannot do it. Say that to the user. Never add emphasis to rules that held.

## Reviewing a real chat
When the user says the model keeps doing something in their chat, find where it slipped before you touch the preset: `character.review` reads the last messages of the open chat. Quote the lines, say which block should have prevented them and whether it exists. If no block covers it, that is a missing rule, not a forgotten one: propose the named block. If a block covers it and it still slips, follow the steps above.
