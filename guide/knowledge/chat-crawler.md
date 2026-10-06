---
title: Reading chats
tags: chat, chats, history, conversation, roleplay, read, reading, search, find, review, earlier, before, remember, forgot, forgets, summary, what happened, when did, quote, scene, messages, message, swipe, continuity, story so far
anchors:
always: false
---
You can read the user's chats without pulling them into this conversation. A chat can be thousands of messages; you open it as a page in the engine and then read only what you need, exactly like a web page or a lorebook. Everything here only READS: you never change a chat.

## The four actions (all automatic: they run by themselves, never behind a button)
- `chat.list` — the saved chats of a character: file name, message count, date of the last message, the last line, and which one is open now. Params: `{"name": "Aria"}` or `{"avatar": "Aria.png"}`; without them, the character open in SillyTavern.
- `chat.open` — opens a chat and gives you its page id, the number of messages, who speaks, the first and last lines. Without params it is the chat open in SillyTavern right now (a group chat too); with `{"name", "file"}` it is a saved chat of that character (take the file from `chat.list`). A short chat comes whole.
- `chat.read` — messages by number: `{"id": "p5", "last": 10}` for the latest, or `{"id": "p5", "from": 40, "to": 55}`. Messages come whole and in order; the result says from which number to continue. A single huge message is cut and the result tells you where to read the rest (`web.page` with the offset).
- `chat.find` — look for something by the words AND by the meaning ("when did she lie to me" finds the message that does not contain the word "lie"). It answers with message numbers, who wrote them and a bit of text around the place. The first meaning search in a long chat takes a few seconds and the index is extended on the next searches (the answer says when it covers only part of the chat so far).

Message numbers (`#12`) are the same as in SillyTavern: the number of the message in that chat counted from 0. A message marked `[hidden]` is not sent to the model (it was folded by a summary or hidden by the user); `[user]` is the player, `[char]` a character.

## How to work
1. Do not read blindly. Say what you want to know, then `chat.find` for it, then `chat.read` the surroundings of the best places (a few messages before and after). Read the whole chat in order only when the task is the story itself, and then in pieces.
2. The open chat is the usual start. If the user talks about another chat or an old one, `chat.list` first and ask which when it is not clear.
3. Quote briefly and give the message number so the user can find the place (`#41`). Never invent what a message says: if you did not read it, say so and read it.
4. Opening a chat never touches it. A chat you opened stays in memory for the next questions (a few at a time; the oldest is dropped), so read again with the same id instead of opening again.

## What it is for
- **A rule slipped.** The user says the character keeps forgetting or breaking something. Find the messages where it happened (`chat.find` with the rule in plain words, or the last stretch with `chat.read`), quote them, name the card's rule or the preset's block that should have held it, and propose the smallest fix. If nothing in the card or preset covers it, it is a missing rule, not a forgotten one.
- **Continuity.** What was promised, who knows what, when something happened, how a relationship moved: find the scenes and read them before you answer.
- **Summaries and memory.** To judge whether a summary or the memory graph lost something, find the original scene and compare.
- **Writing for the story.** A first message, a scenario or a lorebook entry that continues an existing story should come from what the chat actually says.

Only read what the task needs, and do not repeat a user's private chat text beyond what the task asks for.
