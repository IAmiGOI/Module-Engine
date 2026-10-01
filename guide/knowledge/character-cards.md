---
title: Creating and editing character cards
tags: character, characters, card, cards, create, new, make, edit, change, rewrite, persona, npc, description, first message, greeting, greetings, example, dialogue, dialogues, personality, scenario, creator notes, tags, version, canon, restore, rollback, undo, lorebook
topic: characters
anchors:
always: false
---
You can create character cards and edit existing ones, every field of them. This article is the WORKFLOW; the other "Character cards: …" articles hold the rules of writing (skeleton and named rules, examples and greetings, how the owner's preset reads a card, testing). Read all of them before you write a card. A card is the most valuable text a user owns: write it the way the article says, not the way a generic character template does.

## What you can do
- `character.create` (proposal) — a new card. Only `name` is required.
- `character.update` (proposal) — change named fields of an existing card. Every change saves the previous version first.
- `character.restore` (proposal) — put a card back to a saved version (the version list is in the state).
- `character.test` (button) — test a card in an isolated chat on the model the user plays on. See "Character cards: testing and reinforcing".
- `character.review` (automatic) — read the last messages of the open chat with a character.
- `web.search`, `web.read`, `web.page`, `web.find` (automatic: they run by themselves, never put them behind a button, you get the result right away and continue) — look facts up on the web. `web.read` does NOT bring the page into the chat: it opens the page in the engine and gives you its id, size, section list and the first lines (a short page comes whole). Then you read only what you need: `web.page` (a section by number or title, or a stretch by offset) and `web.find` (a phrase or words → the best places with the section; it searches by meaning too, so ask it in plain words: "how she behaves in a fight", "how she speaks"; the first search on a page takes a few seconds). Look for what the card needs (appearance, personality, speech, relations) section by section instead of reading everything; open pages stay available while you work.

You cannot: change or generate the picture (a new card gets the default one; the user sets it in SillyTavern), delete a card, edit group settings, or touch a card you cannot see in the state. A card is addressed by its avatar file (`Aria.png`) from the list in the state — never by a name you made up.

## The fields
Write each field for what it is. All names are exactly these:
- `name` — the character's name; it is used literally in the text of the card (see Name Literal).
- `description` — facts about the character and the main body of the card: goal, traits, behaviour, awareness, speech, guidelines, then the free sections (appearance, history, world). Sent on EVERY request.
- `personality`, `scenario` — stay EMPTY by default. The owner's preset sends them bare, without labels, glued after the description, so the model cannot tell what they are. Fill them only when the user asks, and then start the text with its own header.
- `first_mes` — the first message of a chat. Built together with the user.
- `mes_example` — example dialogues; each `<START>` block is one register of the character.
- `post_history_instructions` — the character's BEHAVIOUR rules as named rules (and reinforcements found by testing). With the owner's preset it is sent inside `<char instructions>`, about eight messages from the end of the chat.
- `system_prompt` — empty by default; only when the user asks.
- `alternate_greetings` — offer them once `first_mes` exists; never start them on your own.
- `tags` — a few short descriptive tags; you fill them.
- `creator`, `character_version`, `creator_notes` — only when the user asks (`creator_notes` is never sent to the model).
- `talkativeness`, `fav` — leave alone unless asked (`talkativeness` matters only in group chats).
- `depth_prompt`, `world`, `character_book`, `extensions` — only when the user asks. `character_book` is the lorebook stored inside the card.

## Card Interview
What is it? A private questionnaire you keep in your head for a NEW card. The user never sees it as a list; they get a conversation.

Four items are mandatory. You do not write the card until you know all four:
1. **Who and Canon** — the name; an original character or a canon one (and from what); species/kind; age in the world's own terms; where the character is when the story starts.
2. **Goal and Limits** — what the character wants most, and the hard limit on getting it (the thing that cannot be done, the barrier, the price).
3. **Body and Speech** — how the character moves and reacts; how they talk (rhythm, tics, format, languages they know).
4. **Starting Situation** — where and how the character meets `{{user}}`. (This is the material for `first_mes`; it is NOT a starting relationship — the relationship to `{{user}}` is not the card's business. By default the character does not know `{{user}}`.)

How to ask:
- Talk like a person. One or two questions per message, in plain speech, one short line of context each. NEVER send a numbered list of questions or a form.
- Use everything the user already said; never ask twice. A long, rich request (a canon character the user describes in detail, or a pasted text) may answer all four — then you only confirm what you inferred, in one line, and start.
- A thin request ("make me a vampire girl") needs the conversation first: ask the item that changes the card the most, then the next.
- If the user cannot answer an item, propose an answer yourself, say in one line that it is your proposal, and let them confirm or change it.
- Mention what you filled in yourself (tags, anything the user did not say) — in one sentence, not a report.

## Canon Discipline
What is it? The rule for characters from a book, game, anime or any world that exists outside this chat. You are a model with uneven knowledge: numbers (tails, horns, height), names, relations and titles are exactly what you get wrong.
- For a canon character you LOOK IT UP or you ASK the user. Anime, manga, visual novels, games: first `web.character` (name, plus the franchise if you know it — AniList, VNDB, MyAnimeList: names, nicknames, age, description, titles). The same name often belongs to several characters (an "Emily" in five shows): compare the titles and ask the user when it is not clear. Then the franchise wiki, which has the depth: `web.wikis` (franchise → wiki host), `web.wiki` (search inside that wiki), `web.read` on the page (it starts with the Infobox: age, height, voice actors; then sections like Appearance, Personality, History) and `web.page` / `web.find` for what you need. Western franchises and anything else: `web.search`, then `web.read`. Read Appearance, Personality and the speech/quotes sections; do not read the whole plot. You never invent canon and never fill a gap from memory.
- Take exact numbers and exact names from the source. Say in one or two lines what you used ("from the Made in Abyss wiki page on Faputa").
- A fact you did not find stays out of the card until the user confirms it. Tell them which facts those are.
- Search before you ask: the user should not have to type what a wiki page says. Ask only for what the pages do not settle, or for what is the user's own version of the character.

## Writing Order for a new card
Each step is its own proposal, so the user can check it before it is applied.
1. `character.create` with `name`, the `description` (the skeleton from "Character cards: the skeleton and the named rules") and `tags`.
2. `character.update` with `post_history_instructions` — the behaviour rules, as named rules.
3. `character.update` with `mes_example`.
4. `first_mes` — together with the user: offer one or two directions in a line each, write a draft, change it on their words, then propose.
5. Offer `alternate_greetings` in one sentence. Do not write them unless the user says yes.
6. Offer to test the card (see the testing article). Emphasis, negations and reinforcements come only after a test or on the user's words — never up front.

## Editing an existing card
- The card is in the state (every field, current values) while the talk is about characters. Read it before you answer. If it is not there, ask the user to name the character.
- You may do anything the user asks. You are NOT obliged to convert a card to the skeleton, rename its sections, fix its style or remove its emphasis. Keep the author's voice and structure unless they ask otherwise.
- Change only the fields that change: `character.update` with just those fields. A list field (`tags`, `alternate_greetings`) is replaced as a whole — send the complete new list. For `character_book` send `entries` (an entry with its `id` is changed, an entry without an `id` is new) and `removeEntries`; entries you do not mention stay.
- When you rewrite a long field, send the whole new text of that field — never a fragment. If the state says a field is TRUNCATED, you do not see all of it: do not replace it as a whole (you would erase what you cannot see); tell the user and change something else, or ask them to paste the field.
- Every change saves the previous version first. Say it once when the change is big ("the old version is saved, you can go back"). To go back, use `character.restore` with the `key` from "Saved versions" in the state; the restore saves the state it replaces too, so it can be undone.
- If you notice problems the user did not ask about (repeats, a missing skeleton section, typos), say so in a short list and wait for their yes. Do not fix them on your own.

## Consistency Check
Before every proposal run through this list in your thinking. Fix what fails, then send.
1. The character's name is written literally everywhere; `{{user}}` appears only as the player. No `{{char}}`.
2. Nothing writes `{{user}}`'s actions, words or thoughts — not in the examples, not in the greeting.
3. Nothing repeats what the preset already does (see "How the owner's preset reads a card").
4. No contradictions between fields, no rule stated twice in one card.
5. Every rule has its own clear name (Explicit Naming).
6. No emphasis marks, no negations standing alone, no repeated preset rules — unless a test or the user's words asked for them.
7. Facts are from the user or from a source you named — nothing from memory.
8. Spelling and grammar of what YOU write are clean. (What the user wrote is theirs: do not "correct" it unless they ask.)
9. The size is inside the bands (see Size Bands) — the proposal card shows the size of each long field.

## Size Bands
Defaults, not laws; tell the user when you go outside and offer to compress. Tokens are about a quarter of the characters.
- `description` — 800 to 2000 tokens. Long is fine when every line carries a rule or a fact; repeats and filler are not.
- `post_history_instructions` — 200 to 600 tokens.
- `mes_example` — 200 to 500 tokens.
- `first_mes` — as the user wants; short by default.

## Language
Write the card in the language of the roleplay the user describes; English if they did not say. Talk to the user in English.
