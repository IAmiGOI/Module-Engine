---
title: How the owner's preset reads a card
tags: character, card, cards, preset, amigo, polished, prompt manager, cot, checklist, needs, goals, body-framework, default resolution, info, char instructions, depth, post-history, system prompt, tokens, order
topic: characters
anchors:
always: false
---
Cards in this engine are written for the owner's preset ("Polished Version - Module Engine - AmiGO Preset") through the engine's Prompt Manager. Everything below was checked against the preset file and against how SillyTavern 1.18 and the Prompt Manager assemble the request. You cannot see which preset the user has active right now; if you have reason to think it is a different one, say what you assume and ask.

## Where each field lands
- `description` — inside the `<info>` block, with `personality`, `scenario` and the persona, BEFORE the chat history. The preset sends `personality` and `scenario` bare (no "Personality:" label), so text placed there is an unlabeled paragraph after the description. That is why the card keeps everything in `description` with its own headers.
- `mes_example` — inside `<chat examples>`, introduced by "This is not what happened before. Just examples of {{char}}'s speech."
- `system_prompt` — replaces the preset's empty `main` prompt and is sent inside `<char instructions>` at depth 8, about eight messages from the end.
- `post_history_instructions` — replaces the preset's empty `jailbreak` prompt and is sent in the same `<char instructions>` group at depth 8. It is NOT the last thing in the request: the preset's own blocks (need and goal guidelines, logic, narration, the CoT checklist) come after the chat history, closer to the end. A rule in `post_history_instructions` must be strong by itself, and must not fight those blocks.
- `depth_prompt` — injected into the chat at the depth and role the card names.
- `first_mes` — the first message of the chat, inside the history. `creator_notes` — never sent.
(The Prompt Manager applies the card's `system_prompt`, `post_history_instructions` and `depth_prompt` the same way SillyTavern's own manager does, including the `{{original}}` macro, and honours the "Prefer Char. Prompt/Jailbreak" settings.)

## What the preset's procedures read from the card
Before each reply the preset's checklist makes the model go through steps that read the card. Write the card so these steps find their material:
- **Body-framework** — "the main speech and body patterns of the character and how they use them". It reads **Behaviour**, **Speech** and the named rules of `post_history_instructions`. Concrete mechanics feed it; adjectives do not.
- **Knowledge** — what each character knows and does not know; the Secrets tool is called when knowledge is unbalanced. It reads **Awareness** and the Knowledge Gating marks ("{{user}} does not know … until …").
- **Goals and Needs** — the model derives Global Needs once and current ones per scene, writing them to the Notebook, from "the character's description and everything from sidecar retrieval". It reads **Core goal** (the Global goal) and the Behaviour lines that show what the character wants. Universal needs are already in the preset (Independence, all Biological needs): state a need only when it is specific to this character or when the character is an unusual kind of being.
- **Decision** — what the character would do in the next five minutes on their own, from their goals. The relationship level toward `{{user}}` is judged from play; it is not written in the card.
- **Action / Default Resolution** — the model picks the character's "established behavioural default" for a situation, and when a task is something the character is explicitly bad at, the failing outcome is the default. It reads **Core Personality traits** and Behaviour. So write plainly what the character is bad at, cannot do, or always does — as consequences of traits.
- **Prose** — length, pacing, prose quality, user agency: the preset's; nothing from the card.

## Terms of the preset worth reusing
When the concept is the same, name the card's rule with the preset's term: Global goal (card: Core goal), Needs (Biological, Emotional, Instinctual), Goals (Global, Interaction-related, Current), Self-Awareness (card: Awareness), Decisions, Personality preservation, Explanation Veto, Attention points, Body-framework, Knowledge, Default Resolution. The model meets the same word in the preset and in the card and connects them.

## What stays out of a card
Everything the preset owns (see "No Preset Echo" in "Character cards: the skeleton and the named rules"), any instruction about length, tense or point of view, and any "the reply must …" format wrapper.

## Token budget
The preset's context is about 35 000 tokens with up to 4 000 for the reply; blocks of the preset itself take thousands. A card of around 3 000 tokens in all (description, post-history, examples) is normal for the owner's cards. The proposal card shows the size of each long field.
