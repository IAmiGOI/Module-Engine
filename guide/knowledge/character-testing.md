---
title: Character cards: testing and reinforcing
tags: character, card, cards, test, testing, forgets, forgetting, forgot, reinforce, reinforcement, emphasis, negation, remember, caps, review, slip, probe, probes, regenerate
topic: characters
anchors:
always: false
---
## Reactive Reinforcement
What is it? Emphasis, negations and repeated rules are not style and are not written up front. Each one is the scar of a test: the model forgot exactly that during roleplay, and the line was added to stop it. You add them in two cases only:
1. the user says what goes wrong ("she keeps forgetting the tails", "she explains her feelings"), or
2. a test (yours or a review of a real chat) shows it.
A card you create is written clean and named; it is tested afterwards.

The forms the owner's cards use:
- `!!the one rule that must not slip!!` — for the single most important rule of a character; once or twice in a card.
- `!one exclamation pair!` — a lighter emphasis on a clarification.
- `REMEMBER!` before a fact, and capitals for an exact fact the model adds or drops: "REMEMBER! She has (5) tails." / "SHE HAS NO WHISKERS."
- A count or a fact in parentheses, with emphasis on the number: "(2!! Legs)".
- A negative wording placed next to its positive one (Positive Phrasing): "She has no whiskers. (Her face is smooth.)"
- The rule repeated in `post_history_instructions` under the SAME name — because that block is sent near the end of the chat, where the model reads it last.
- A preset rule the model dropped for this character, repeated as a named rule in `post_history_instructions`.
Start with the lightest form that fixes the failure; test again; go heavier only if it still slips. Every reinforcement keeps the name of the rule it reinforces.

## Self-test (`character.test`)
What is it? A short run in an isolated chat: the active preset, this card (with its own prompts), the card's first message, then your probes as `{{user}}`. It runs on the model the user plays on (the main SillyTavern connection) unless they name another connection. It never touches their chats, lorebook or memory. Each probe is a FULL generation, so it costs the user tokens.

When to offer it: after a new card is written; after a big edit; when the user reports forgetting. Offer it as a button (```action``` block, never "auto") and say how many probes.

How to write probes (3 to 6 is usual, 8 at most):
- One probe per NAMED rule you want to check, plus one for the start situation. Put the rule's name in `rule`.
- A probe is what the user would naturally write to make the model reach for the rule: a question about the character's looks for a counted feature ("What do you look like? Show me your hands."); a long-winded plea for the rule against explaining feelings; a situation that calls for the character's speech rule; something that tempts the character to reveal a fact `{{user}}` must not get; a situation the character is bad at, for Default Resolution.
- Stay inside what the user wants from the character. Do not steer the test to content they did not ask for.
- Keep each probe short, in the user's voice, in the language of the roleplay.

After the test you get the transcript and ONE more turn automatically. Read each reply against the rules it tested, honestly:
- Say in a few lines what held and what slipped. Quote the slipped part and name the rule.
- A slip can belong to the preset rather than the card (acting for `{{user}}`, length, purple prose). Say so; do not patch the card for it.
- Propose the smallest fix: a reinforcement of the named rule in the lightest form, as a proposal. Then offer to re-run ONLY the probes of the rules that slipped.
- A test is a few samples on a random model, not proof. One clean reply does not prove a rule; one slip may be chance. If it is borderline, run that probe once more before you change the card.

## Chat review (`character.review`)
When the user says a character forgets something in their real chat, use `character.review` (it runs by itself): it reads the last messages of the OPEN chat with that character. The chat must be open in SillyTavern and be with that character, otherwise it refuses — then ask the user to open it.
Find the messages where the rule slipped, quote the lines, name the rule, and propose the fix as in a test. If the rule is not in the card at all, it is a missing rule, not a forgotten one — say so and propose the named rule.

## What never gets "fixed" by reinforcement
Do not add emphasis to rules that held. Do not add more than one new reinforcement per slipped rule per round. Do not keep stacking heavier marks on a rule that keeps slipping: after the second round tell the user that the rule may be fighting another block, and look for the conflict (another field, a preset block) instead.
