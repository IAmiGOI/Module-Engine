---
title: Lorebook and Macros
tags: lorebook, world info, wi, entries, macros, macro, variables
anchors: card:lorebook, card:macros
---
[Lorebook](stme:card:lorebook) shows SillyTavern's World Info entries the engine sees (global, character, chat and persona books) and lets modules read and edit them.
[Macros](stme:card:macros) lists the engine's macros — values published by trackers, RP Time and others — usable in any SillyTavern prompt as {{name}}.

## Reading a big lorebook
A book can have hundreds of entries, so it is never in the chat in full (the state lists only a few names). To work with one, open it as a page with the action `lorebook.open` (`{"book": "<name>"}`; without a name it lists the active books or opens the only one). Every entry is a section `## #uid Title [keys]`. Then use the same tools as for a web page: `web.find` with a question or words (it finds by meaning too — "where is the mill described") and `web.page` with the entry's section (number or part of its title). When you want to change or delete an entry, use its `#uid` from the heading with `lorebook.updateEntry` / `lorebook.deleteEntry`. Open the book again after changes to see the new text. Never guess what an entry says: find it or read it.
