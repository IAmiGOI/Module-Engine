---
title: Prompt Manager presets: order, placement and cache
tags: preset, presets, order, placement, depth, position, cache, prefix cache, tokens, trim, trimming, group, inject, module, rp time, notebook, summary, memory graph, volatile, stable, divider, condition, preview, log, headroom
topic: presets
anchors:
always: false
---
## THE CACHE LAW (highest priority for every placement you make)
**What the provider cache is.** Providers keep the START of a request and reuse it when the next request begins with exactly the same text. The reuse stops at the FIRST character that differs, and everything after that point is paid for again at full price and full delay. The chat history is the biggest part of any request, so one changing block standing before it makes the provider re-read the whole history on every reply.

**The law.** Everything that can differ from one request to the next stands AFTER the chat history, or inside the chat at a small depth (depth 0 is after the last message). Only text that is the same in every request may stand before the history.
- What differs between requests: module rows whose content changes (RP Time, Notebook, Secrets, the Memory graph and Plot core); any block with a condition (it appears and disappears); any block with a random macro; anything the user edits often; a block that quotes the last message or the current scene.
- **The only exception is the Summaries row: it MUST stand before the chat history** (it replaces the start of the chat, so the history that follows is the part after the summary). It changes rarely, only when a new summary is written, and that restart is accepted. Never move it after the history, and never use it as an excuse to put anything else there.
- Frame, rules and the character's material are the same in every request: they can stand before the history and stay cached. Rules you want as the last word go after the history and are re-sent every turn; that is a conscious trade, never a cache accident.

**How you use it.**
1. Before you place, move, add, switch on or put a condition on ANY block or module row, ask: can this text differ between two requests? Where does it stand relative to Chat History? If it can differ and stands before the history, stop: put it after the history or at a small depth, and tell the user why in one line ("it changes every turn, so I put it after the history to keep the cache").
2. If the user asks for a placement that breaks the law, do it only when they insist, after saying in one sentence what it costs (the whole history is re-read on every reply). Offer the cache-safe alternative first.
3. After a change that touches order, read `preset.preview` and the cache lines. Name the block that breaks the cache and how many stable tokens stand after it.
4. When you read an existing preset, check every module row and every conditional block against the law, and tell the user what you find in a short list. Do not move things without their yes, unless you are making the change they asked for.
5. The engine checks this after every write and puts a `[fix]` line in your plan: a module row that changes and stands before the history, a conditional block or a random macro before the history, and a Summaries row that stands after the history. Treat that line as an order, not a hint. If the owner placed something on purpose, leave it and say that you saw it.

The order of blocks is part of what a preset says. It decides what the model reads last, what the provider can cache, and what is cut first when the request is too long.

## What the order does
- **Reading order.** The model weighs the end of the request most. Rules and checklists that must be the last word stand after the chat history; the frame, the character's material and the chat examples stand before it.
- **Provider cache.** Providers cache only the START of the request that is identical to the previous one. The first change breaks the cache for everything after it. So: stable text first, anything that changes each turn as late as possible. Blocks that stay the same all chat long (frame, rules) are cheap near the top and lose the cache when they stand after something volatile.
- **A deliberate trade.** Putting rules after the history gives them the last word at the price of re-sending them every turn. That is usually right for behaviour rules; say the trade when it matters, do not "fix" it.
- **Trimming** cuts the oldest chat history first, a little extra at once, and respects each block's trim priority (100 means never trimmed). The cut stays where it is every turn (the Preview calls it a "stable cut") so the cache keeps working; it is released by itself when the budget grows by a quarter or more, and the user can release it with Settings → Reset trimming. If a chat lost its start after a wrong Max response / Max context, that is the cause and the cure. Max response must stay clearly below Max context: otherwise there is no budget and trimming is switched off.

## Position of one block
- *In order*: where it stands in the list.
- *Inside the chat, N messages from the end*: depth N. Depth 0 is after the last message; larger numbers are earlier. Blocks at the same depth go by their `order` number (smaller first); at equal order, assistant, then user, then system, so system text lies nearest the end.
- A GROUP can sit at a depth as a whole: its tags and everything inside go as one message.

## Rows of modules
Modules (Summary, Notebook, Secrets, RP Time, Memory graph) appear as module rows in the order. Each module says where its row starts; the user, and you through `placeModule`, can move it.
- Content that changes as the chat goes on (the time, the notebook, secrets, the memory graph and the plot core) belongs at a small depth in the chat, normally 0, never "at the start of the history" or before it: there it restarts the cache before the whole chat. The engine flags this after a write.
- Summaries are the one exception: the Summaries row stands before the history, always.
- A module that is off publishes no row; a row that is empty sends nothing. The preview says which.

## Conditions and regions
A block or group with a condition appears and disappears; the request changes from that place on and the cache restarts there. A conditional block never stands before the chat history (the cache law): after the history it is fine. A region of dividers is one condition for everything inside, so the whole region stands after the history too. Divider strips make a region with one condition for everything between them. Jev (a small classifier) answers a yes/no question about the recent chat; if it does not answer in time, the block is sent.

## What to do with the Preview
`preset.preview` shows tokens per block and what was trimmed or left out and why, and the Log tells how much of the start of each request matched the previous one and which block broke it. Read it when you change order, add a volatile block, or when the user says the model forgets things or the bill is high. Offer to move the culprit to the end instead of rewriting good rules.

## Context budget: the sweet spot and the ceiling
This is the owner's experience of roleplay, an idea to plan with, not a law of the models.
- **Sweet spot: about 35 000 tokens** for the whole request: the preset, the card, the lorebook, summaries and memory, the chat history, with room left for the reply. At this size replies keep their quality and the cost stays sane. It is the size the owner's own preset is set to (context 35 000, reply up to 4 000).
- **Ceiling without losses: about 50 000 to 60 000 tokens IN TOTAL**, counting everything that goes out (history, preset, lorebook, card, memory, module rows), not just the history. Past that the model starts to lose details of what stands in the middle of the request, and replies get worse while the bill grows.
- The context size setting of the preset (`openai_max_context`) is what the Prompt Manager trims to: it cuts the oldest history first. A bigger number does not make the model remember more, it only lets more through.

How you use it:
1. Know the total before you add anything: `preset.preview` shows it and the tokens of each block. When you add text, say what it costs in tokens, and the new total.
2. Plan for the sweet spot. If a preset, card and lorebook together already take a large share of 35 000, tell the user that the chat history is what gets squeezed.
3. Keep the context size at about 35 000 unless the user asks for more. If they want more, say it can go up to roughly 50 000 to 60 000 in total and that above that quality drops; do not set a number past 60 000.
4. When the total is above the sweet spot, say so in one line and what it buys and costs; it is the user's decision. Offer to trim the blocks that repeat or that say little before you offer to cut useful ones.

## Sampler and settings
The generation settings (temperature, top-p/top-k, penalties, context size, reply length, reasoning effort, streaming) belong to the preset; change them with `params` in `preset.update` and say what each does in a few words. Per-model, per-character and per-chat overrides exist (`preset.override`) and are OFF until the user switches them on in the Settings tab: say so after setting one. Do not change a setting because it "usually" helps; change it for what the user says is wrong, and say which way you moved it.
