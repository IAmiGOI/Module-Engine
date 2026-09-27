---
title: Post-Turn Processor
tags: postprocess, post-processing, rewrite, polish, passes, style, fix reply, edit reply
anchors: module:module.postprocess
---
The Post-Turn Processor rewrites each fresh reply through a chain of independent model passes (for example: fix grammar, remove clichés, enforce a style) and replaces the reply with the final result. Each pass is its own prompt and model. Module id: module.postprocess.

## How it really works (know this before you build or advise)
- A pass receives ONLY the text produced by the previous step (the first one gets the fresh reply). The user's message and the rest of the chat are not sent unless the pass has "Include recent chat context" on.
- The pass **Instruction is sent as the system prompt**, the text to rewrite arrives as the user message. The engine itself appends "Return ONLY the rewritten text — no explanation, no markdown code fences, no commentary" to every instruction, so the output contract is already enforced — still say it in your own words if it matters.
- The result **replaces the reply** in the chat (an annotation marks it as processed; a reroll is processed again). A pass that returns something shorter, longer or different changes the story for good — so "what must stay unchanged" belongs in every instruction.
- Nothing runs unless the module is **Enabled**, at least one pass is on with a non-empty instruction, and **Auto-run after each reply** is ON (the state below tells you which) — otherwise only "Process last reply now" works. When you add passes for someone, check auto-run and offer to turn it on.
- A pass with no model connection chosen is spread over any available connection; pin a connection only when the user asks or one clearly fits (for example a cheap fast model for cleanup) — do not pin one at random.
- Reasoning models spend the token limit on thinking: for rewrite passes set reasoningMode to disabled, or the answer gets cut off. Set maxTokens to at least 2× the usual reply length (roleplay replies are commonly 300–1200 tokens, so 2000–4000 is safe).

## Fields on screen
- **Passes** — the chain of rewrite steps, run in order right after each reply; pass 2 sees pass 1's output. Each pass has its own **Instruction** (what to do with the text) and its own **Model connection**. ↑ / ↓ reorder passes, **Remove** deletes one.
- **Include recent chat context** — off by default: a pass then sees only the text it rewrites. On, it also gets the last few chat messages, useful for consistency edits.
- **Messages of context** — how many recent messages that context contains (only shown when the toggle is on).
- **Auto-run after each reply** — process every fresh reply by itself. Off means only by hand.
- **Process last reply now** — runs the chain on the latest reply once; safe to press twice, an already processed reply is skipped.
- **Enabled** — the whole module on or off. **Save** stores the chain.

You can add, change, reorder and delete passes for the user yourself (they appear as cards). Pass ideas: a cleanup pass (remove AI slop and clichés while keeping events, dialogue and length), a stylistic pass (concrete sensory detail, varied rhythm), a continuity pass (with chat context on). Write them as full briefs following "Writing strong prompts" — never as one-liners like "Fix grammar" — and set temperature and max tokens in the same card. Each pass sees the result of the one before it, so order matters. A pass may use its own model connection — only ones that exist.
