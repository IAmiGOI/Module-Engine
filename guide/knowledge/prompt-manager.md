---
title: Prompt Manager
tags: prompt manager, preset, prompt, order, cot, chain of thought, regex, rules, cache, prefix cache, tokens, trim, overrides, sampler, temperature, streaming, plugins
anchors: 
---
The **Prompt Manager (PM)** builds the request that goes to the model instead of SillyTavern's own prompt manager. It works with Chat Completion and single chats; in group chats and Text Completion it steps aside and the ordinary ST prompt is used. It opens with the **Prompt Manager button of ST** (the native window is hidden while PM is on).

## First start
All your ST Chat Completion presets are copied into PM automatically (the ST files are never changed). The preset selected in ST becomes the active one. Import and export work with ST files too — passwords and keys are removed on export.

## Tabs
- **Order** — the prompts of the preset as a tree: drag to reorder, tick to send or not, groups can wrap their content in tags (`<info> … </info>` — and stay silent when empty). Click a row to edit it: name, role, text, position (in order, or N messages from the end of the chat), trim priority, and **"Send only when…"** — a plain-words condition builder (keywords in the last messages, message length, tracker value, variable, chance, every N-th message, cooldown). Modules (memory graph, Notebook, Summary…) appear as **module** rows: put them wherever you want; the button returns one to the place the module suggested.
- **Preview** — what would be sent for the current chat, tokens per block, what was trimmed, warnings about random or unknown macros.
- **Log & cache** — the last requests and how much of the start of each request is the same as in the previous one. Providers cache only that shared start, so anything that changes early (a memory block above long stable rules) costs you the cache. The tab names the block that changed and tells which stable blocks stand after it.
- **CoT** — Guided CoT: hidden thinking steps before the answer. Each step is a separate request sent as a user message after the whole prompt; steps see the previous answers and reasoning; a different model can be chosen per step. The result is added to the final prompt and stored under the message as a collapsed block (it never goes into later history). A failed step is retried once, a second failure cancels the generation. Off by default.
- **Text rules** — replace or remove a phrase, cut everything between two marks, or use regex; choose roles and how far from the end. They change only what is sent, never your saved chat. You can import ST regex scripts.
- **Settings** — sampler and other generation values of the preset, trimming headroom, overrides per model, character or chat (off by default), plugins, versions with rollback.

## Good to know
- **Character prompts.** The character card's own system prompt, post-history instructions and depth prompt are applied the way SillyTavern's manager applies them: the card's system prompt fills the preset's `main` block, the post-history text fills `jailbreak` (a block set to forbid overrides is left alone; `{{original}}` inserts the block's own text), and the depth prompt is injected at the depth and role the card names. Turn "Prefer Char. Prompt/Jailbreak" off in SillyTavern to ignore them.
- **Trimming** cuts the oldest history first and cuts a little extra at once, so the start of the history does not move every turn (that would break the provider cache).
- **Random macros** break the cache; "Freeze random" (Settings) keeps one value per chat.
- **Streaming** from the preset is applied by switching ST's own setting for the generation and switching it back afterwards.
- If PM ever fails while assembling, the original ST request is sent — PM never blocks a generation (except after a second failed CoT step).
