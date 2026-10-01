---
title: Lorebook: building a world, entry by entry
tags: lorebook, world info, wi, world, worldbuilding, setting, lore, entries, entry, always active, constant, keys, locations, factions, characters, categories, stages, create a lorebook, build a world
topic: lorebook
anchors:
always: false
---
These are the rules for writing a world into a lorebook. They are the owner's first draft and will be refined; follow them exactly and do not fall back on a generic "world bible" template. (How to find and read entries in a big book is in "Lorebook and Macros".)

## Format
Every entry is written in Markdown: a short `#` or `**bold**` header line with the name, then short lines or lists. Plain facts, no flourishes. The text must be complete and usable on its own, because the model sees only the entries whose keys fired.

## Gradual, but as detailed as possible
Describe the world as DETAILED as the sources allow, but GRADUALLY: never the whole world in one go. Work in stages; each stage is one batch of entries (`lorebook.addEntries`, up to 20 at a time), then say in a line what is written and what comes next. The user steers between stages ("more about the factions", "skip locations"). Facts come from the user or a source you name (a wiki page you read, the canon), never from memory.

## Stage 1 — the key facts (2 to 10 entries, always active)
The first 2 to 10 entries are the KEY facts and events of the world: what the setting is, the event or state of things that defines it, the rules everything depends on (how magic works, the main conflict, the era). They are written with `"always": true`, so keep them short and dense: they are sent on every request, so each is as short as its fact allows (the size ceilings are in "Size" below).

## Stage 2 and on — by categories
After the key facts, write by category. The default categories, in this order:
1. **Characters**
2. **Locations**
3. **Factions**
4. **Extra facts** (items, customs, history, anything that does not fit above)

These entries are NOT always active: each has trigger keys (the name, its common aliases and titles; up to 8, `keys`). One entry holds one subject. Use one clear title per entry (the name of the subject). The user may add or drop categories; follow them.

## A character entry is a micro-card
Every character entry is built as a small card, not a paragraph of story. The same ideas as the full card, in a few lines each (sizes in "Size" below):
- the name in a header (the name is written literally, never "she" without a name);
- **Role / goal** — who they are in this world and what they want;
- **Traits** — each with its consequence (what it leads to);
- **Behaviour** — what they concretely do;
- **Speech** — one or two lines, only when it matters;
- **Knowledge gate** in a parenthesis where the user does not know something yet.
Keep to what a short entry needs; a minor character may have only the first three lines. A character who also has a full card is not repeated here in other words (one fact lives in one place).

## Size
These are CEILINGS, not targets: an entry says what it must and stops. Tokens are about a quarter of the characters. Count each entry before you send it; if it is over its ceiling, cut it (split a big subject into two entries before you cut facts).

| Entry | Recommended | Ceiling |
|---|---|---|
| Key character (an important one) | about 500 | 800 to 1000 |
| Weak (minor) character | about 300 | about 500 |
| Important fact | about 1000 | — |
| Place | about 300 | — |
| Event | about 300 | — |
| The most important entries of the world (the key facts of stage 1) | as short as the fact allows | 2500 at most |

Nothing goes over 2500 tokens, whatever it is. Always-active entries are sent on every request: keep them to the minimum that carries the fact.

## Locations, factions, extra facts
- A **location** entry: what it is, where it sits relative to others, what is there, who is there, what it is used for.
- A **faction** entry: what it wants, who leads it, what it holds, who it is against or allied with.
- An **extra fact** entry: the fact itself and what it changes in play.
Write facts, not atmosphere; the model adds the atmosphere itself.

## Working order for a new world
1. Ask only what the sources do not settle (which part of the world, which era, how much the user wants); search before you ask.
2. Make the book if there is none (`lorebook.createBook`, attach it to the character when the world belongs to one).
3. Stage 1: the key entries, always active.
4. Stage 2 and on: one category at a time, in batches; after each batch, one line of what is written and what is next.
5. When the user asks to look at the book or change an entry, open it (`lorebook.open`) and use `#uid` to change or delete.

## Phrasing
Say what IS and what is DONE; a negation is allowed only next to the positive wording it belongs to. Do not repeat the preset's general roleplay rules. Spelling and grammar are clean; write the entries in the language of the roleplay (English if none was named).
