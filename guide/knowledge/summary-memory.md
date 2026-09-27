---
title: Chat Summary and memory
tags: summary, summaries, memory, long chat, context, fold, hide, memory graph, graph
anchors: card:summary, card:memoryGraph
---
[Chat Summary](stme:card:summary) folds old messages into summaries in levels, hiding the originals from the prompt (never deleting them) so long chats fit the context. A protected window of recent messages is never folded; an optional verify pass checks each summary.
The memory graph ([Memory graph](stme:card:memoryGraph)) builds a graph of people, places and facts from the chat, shown in its own window.

## Fields on screen
The Chat Summary card:
- **Protected window** — how many of the newest messages never get folded into a summary.
- **Worker** — which connection writes the summaries ("Default" = any working one).
- **Level 1 / 2 / 3 batch size** — level 1 folds this many of the OLDEST raw messages into one summary (it starts once there are at least protected window + batch messages); level 2 folds this many level-1 summaries into one; level 3 does the same with level 2. Bigger batches = fewer, coarser summaries.
- **Verify worker** — the connection that checks each summary ("Same as fold worker" by default).
