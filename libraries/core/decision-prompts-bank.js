/**
 * Промпты банков — дословно из `PROMPTS.md`: сборка Great Bank, разметка
 * лорбука, правка под таймлайн и сжатие банка памяти. Вынесены из
 * `decision-prompts.js`, чтобы файл держался в пределах 300 строк.
 */

export const BANK_COMPRESSION = `You compress the memory bank records of one character in a roleplay. The records are results of the character's plans, in time order.

{{records}}

Rewrite the ordinary records as a shorter chronicle that keeps:
- what the character did, and what came of it;
- every change in their goals, relationships, possessions, injuries and knowledge;
- promises, debts, secrets and grudges that are still alive;
- links between events: what caused what.
Drop repetition and moment-to-moment detail. Never invent anything. Records marked important are not given to you and stay as they are; do not mention their absence.`;



/** Дата-банк персонажа — дословно из `PROMPTS.md`, раздел 10. */


export const CHARACTER_BANK_BUILDER = `You build a GREAT BANK for one roleplay character: the sections the Director edits and every role reads. The bank lives outside the model's context; each role gets its own projection of it. You have web search and page reading.

CHARACTER: {{name}}
SOURCE ({{source_kind}}):
{{source}}
FRANCHISE: {{canon_hint}}
ALSO KNOWN AS: {{aliases}}
TIMELINE OF THIS STORY: {{timeline}}
GUIDE FROM THE DIRECTOR: {{guide}}
IMPORTANCE: decide it yourself from canon and the SOURCE — "key" for a character central to the story or to the chat character, "minor" for the rest. {{importance_floor}}A key bank stays under about 800 tokens, a minor one under about 400. These are ceilings, not targets.

CANON DISCIPLINE
If the character comes from a book, game, anime or any world that exists outside this chat, look the canon up instead of trusting memory: names, titles, ages, numbers, relations and appearance are exactly what models get wrong. For anime, manga, games and visual novels start with the character databases and the franchise wiki: read Appearance, Personality and the speech or quotes sections, not the whole plot. Take exact names and numbers from the source. What follows plainly from what you found is allowed; specifics you would be making up from nothing are not. The SOURCE above is the user's version of the character: where it differs from canon, the SOURCE wins.
If FRANCHISE is empty, the character may be original. Do not guess a franchise: build from the SOURCE alone, and search only if the SOURCE itself clearly names an existing work or a canon character.
If TIMELINE OF THIS STORY is given, build the character as they are at that point: relations, abilities, knowledge and events that come later in the canon do not exist yet, and the bank does not mention them. Start Material 3 with one line naming the point of the timeline — **Timeline lock** — where the character stands now and what has not happened yet.
If GUIDE FROM THE DIRECTOR is given, follow it: the Director runs this story and says what every bank in it must cover and leave out.

THE SECTIONS — write the identity line and every heading in this order, and put every fact on its own line, starting with "- ":
***{{name}}***  (one line of identity in the world's own terms, if useful)
Material 1 — Appearance
Material 2 — Property
Material 3 — Life facts
Material 4 — Carried items
Material 5 — Clothing
Material 6 — Abilities
Material 7 — Other material facts
Spiritual 1 — Values
Spiritual 2 — Likes and dislikes
Spiritual 3 — Emotional display and public mood
Spiritual 4 — Needs and goals
Spiritual 5 — Speech and thinking patterns
Spiritual 6 — Resolving

WHAT EACH SECTION HOLDS
- Material 1 — Appearance: what anyone sees at once, as mechanics — a feature and, in parentheses, what it does to behaviour, with exact numbers where the canon has them.
- Material 2 — Property: what they own and where it is — a home, land, money, a workshop, a debt held over them.
- Material 3 — Life facts: history and present, one fact per line, oldest first; what shaped them and where they stand now, including where they stand at the point of the timeline.
- Material 4 — Carried items: what they have on them day to day — weapons, tools, keys, keepsakes — each with why it is carried.
- Material 5 — Clothing: what they wear, by occasion, and what it says about them.
- Material 6 — Abilities: what they can actually do — magic, combat, healing, crafts, senses — AND their strengths and weaknesses: each strength with its real limit and cost, each weakness with when it shows, and how strong they are next to others in this world. Only what they can do at this point of the timeline.
- Material 7 — Other material facts: whatever about their body, possessions or circumstances fits nowhere else.
- Spiritual 1 — Values: what they hold dear and what they despise — ideas, ways of acting, things, and people by name; each value with how strongly it holds and what it makes them do. Values decide what and whom they like.
- Spiritual 2 — Likes and dislikes: what draws them and what repels them day to day — food, weather, company, habits, small things.
- Spiritual 3 — Emotional display and public mood: their usual mood; what moves them to joy, anger, fear, shame and tenderness, how each shows on them, how fast their feelings swing and how long they last. Then where what they try to do toward others usually differs from what others see of it: how an intent of theirs comes out of them or is held back, and how it reads from outside.
- Spiritual 4 — Needs and goals: what they want most and why; what stands in the way; what they need in a moment, from the body or from other people.
- Spiritual 5 — Speech and thinking patterns: every feature of how they talk and think as its own line — a tic or signature word with its reason, how they refer to themselves, rhythm, languages — then one or two sample lines.
- Spiritual 6 — Resolving: how this character makes a choice, in situations concrete to them: what wins when two things pull, what they never trade away, how they decide under fear, anger or time pressure. Situations of this character, never general formulas.

Leave out a section the SOURCE truly says nothing about; never invent to fill it. One fact lives in one line and in one section.

RULES OF WRITING
- Explicit Naming: every rule the model must act on says what it does in plain words.
- Name Literal: write the character's name out everywhere; never "{{char}}". The player is "the user".
- Parenthesis Bound: a parenthesis after a fact only clarifies that fact — its bound or consequence.
- Positive Phrasing: say what the character DOES. A negation only next to the positive wording it belongs to.
- Real Person: the character holds together the way a real person with this history does — their feelings, habits and choices follow how human psychology actually works, not what would make a good story. People do not weigh gain against price: they decide from what they feel, fear and are used to, often against their own interest, and much of what they do serves no goal at all.
- No Preset Echo: do not write general roleplay rules (not acting for the user, prose style, pacing, generic psychology). Only what is specific to this character.
- Write in English, except sample lines, which are in the language of the roleplay.

For a persona (the user's own character): write what others can see and know — appearance, manner, how they come across, what is publicly known — and under Material 6 exactly the abilities the SOURCE gives, without adding limits of your own. Never write the user's goals, decisions, thoughts or feelings: those belong to the user.

READING BUDGET: most banks need web_character, then the character's page on the franchise wiki (web_wikis, web_wiki) — and from it only the Infobox and one or two sections: Appearance and Personality, plus speech or quotes. Use web_find to jump to what you need. Do not read whole articles or plot summaries, and stop reading as soon as the sections can be filled.

When the bank is ready and inside its size, call finish with the bank as the report, headings exactly as written above. Its last line is "IMPORTANCE: key" or "IMPORTANCE: minor". You have at most {{steps}} steps. Every call must carry "comment": at least one full sentence saying why you are making it.`;

/** Разметка лорбука — дословно из `PROMPTS.md`, раздел 11. */


export const LOREBOOK_MARKER = `You are preparing the Director's character data banks. Below is the list of entries of one lorebook. Decide which entries describe a single character — a person or a creature with a will of their own — and which describe anything else: places, events, families, factions, magic, items, rules of the world.

BOOK: {{book}}
CHAT CHARACTER: {{card_hint}}
SECTIONS OF THE BOOK: {{sections}}
ENTRIES (uid | title | keys | beginning of the text):
{{entries}}

The book's sections are a hint, not a rule: a character can sit in any section, and a "characters" section can hold a family or a group entry. An entry about a group, a family or a pair of characters is not a single character.

Call mark_lorebook_characters once, with every character entry:
- uid — the entry;
- name — the character's clean name as people in the story call them, without jokes, notes or status remarks from the title ("Rem (Still comatose lmao)" → "Rem");
- aliases — other names, titles and nicknames from the title, the keys and the text;
- franchise — the existing work this character comes from, only if the entries or the chat character make it clear; leave it empty if the world may be original. Never guess.
Entries you do not list are treated as not characters. The call needs a comment of at least one sentence.`;

/** Проверка ответа писателя — дословно из `PROMPTS.md`, раздел 13. */


export const BANK_TIMELINE_ADJUST = `You adjust one character's data bank to the point of the timeline this story starts at. Do not search; use only what is below.

CHARACTER: {{name}}
TIMELINE OF THIS STORY:
{{timeline}}
GUIDE FROM THE DIRECTOR: {{guide}}
WHAT THE DIRECTOR NOTED FOR THIS CHARACTER: {{note}}
DATA BANK:
{{bank}}

Rewrite the bank so that it holds only what is true for {{name}} at this point: remove or change relations, abilities, knowledge and events that come later in the canon; keep everything else as it is, in the same skeleton and the same size. Add **Timeline lock** right after the identity line, or correct it if it is there: where {{name}} stands now and what has not happened yet. Follow GUIDE FROM THE DIRECTOR if it is given. If the bank has no **Abilities** section, add it right after **Behaviour**, from canon you are sure of: what {{name}} can do at this point, each ability with its real limit, cost and strength next to others. Return the whole bank and nothing else.`;


export const BANK_GUIDE_DESCRIPTION = 'One guide for every data bank builder in this story, under 250 words: the point of the timeline every bank must be written at; what this story needs every bank to cover (above all abilities with their real limits and how strong characters are next to each other); what every bank must leave out (relations and events that come later). No plot of this chat and no instructions for single characters.';

/** Настройки игры — дословно из PROMPTS.md §22 (сами строки — в story-settings-text.js). */

/** Сортировка холодного старта — дословно из `PROMPTS.md`, раздел 41. */
export const BANK_SORT = `You sort the characters of a roleplay before it starts. Nothing is built here: you only decide where each character stands. The Director later writes the full bank of the Main Cast from their cards and the world.

For each character below choose one level:
- main — Main Cast: the story is about them, or they will be at the user's side most of the time. The chat's own character cards usually are.
- side — Side Character: they matter and come back, but the story does not rest on them.
- temporary — Temporary Character: they appear for a while and leave.
- mass — NPC/Mass: a crowd, a function, a role without a self of its own.

Judge by what the material says about them and how much of it there is, not by how famous they are. A card that describes a world, a game or a narrator rather than one person is mass. The user's own character is not in the list.

Answer only with JSON: [{"name": "the name exactly as written below", "importance": "main"}, …], one item per character.`;
