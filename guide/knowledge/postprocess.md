---
title: Post-Turn Processor
tags: postprocess, post-processing, rewrite, polish, passes, style, fix reply, edit reply
anchors: module:module.postprocess
---
The Post-Turn Processor rewrites each fresh reply through a chain of independent model passes (for example: fix grammar, remove clichés, enforce a style) and replaces the reply with the final result. Each pass is its own prompt and model. Module id: module.postprocess.

## Fields on screen
- **Passes** — the chain of rewrite steps, run in order right after each reply; pass 2 sees pass 1's output. Each pass has its own **Instruction** (what to do with the text) and its own **Model connection**. ↑ / ↓ reorder passes, **Remove** deletes one.
- **Include recent chat context** — off by default: a pass then sees only the text it rewrites. On, it also gets the last few chat messages, useful for consistency edits.
- **Messages of context** — how many recent messages that context contains (only shown when the toggle is on).
- **Auto-run after each reply** — process every fresh reply by itself. Off means only by hand.
- **Process last reply now** — runs the chain on the latest reply once; safe to press twice, an already processed reply is skipped.
- **Enabled** — the whole module on or off. **Save** stores the chain.
