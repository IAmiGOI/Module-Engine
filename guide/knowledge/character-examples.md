---
title: Character cards: example dialogues and greetings
tags: character, card, cards, examples, example, dialogue, dialogues, mes_example, start, register, first message, first_mes, greeting, greetings, alternate, swipe, sounds
topic: characters
anchors:
always: false
---
## Example dialogues (`mes_example`)
What is it? Samples of HOW the character speaks and acts, not scenes that happened. The owner's preset wraps them with the line "This is not what happened before. Just examples of the character's speech." So an example is a register sample, never a plot event the model might take for history.

Rules:
- **One Register Per Block.** The text is a series of `<START>` blocks. Every block shows ONE register of the character — a different state, not a different topic. Cover the range of the character: calm and quiet; peak emotion; the shortest possible line; the longest action beat; a reaction to something unexpected. A block that repeats the register of another block is cut.
- **Wordless Counts.** Body beats and characteristic sounds with no words are examples too, and each is its own block when the character really behaves that way: a block of only movement (`*She circles the nest in a tight restless loop, tails dragging low.*`), a block of only a sound (`"Shaaaann."`), a one-line block (`"Faputa is Faputa."`). If the character has a sound, stretched vowel or gesture, it appears here and is named in Speech (Named Speech Features).
- **Character Lines Only.** Every line starts with `{{char}}:` — the one place where that macro is written in a card, because SillyTavern's example format needs it. There is NEVER a `{{user}}` line in an example: the user's side is not written, and the character's narration may speak to the user only as "you" in the present tense (`*The impact jars the weapon in your grip.*`), which is how the preset writes `{{user}}` everywhere.
- **Format as in the chat.** Actions in `*asterisks*`, speech in double quotes, one `<START>` per block, blank line between blocks.
- **Speech rules shown, not described.** The examples must show every named speech rule of the card (tic, self-reference, CAPS, rhythm, sounds) at least once.
- **No plot facts.** Do not put events in examples that would contradict the first message or the start situation. A situation may appear as an illustration of a register, but the example is a sample of voice.
- Six to ten blocks fit the band (about 200–500 tokens). More is repeats.
Write the examples after `description` and `post_history_instructions`, so they show the rules that are already named.

Shape (shape only — the content is invented):
```
<START>
{{char}}: "Two wells left." *She does not look up from the map.* "Drink slowly."

<START>
{{char}}: "Three days, maybe four." *Her thumb taps the rope twice, counting.*

<START>
{{char}}: *She walks the line of carts without a word, touching each wheel rim as she passes. At yours she stops and waits.*
```

## First message (`first_mes`)
What is it? The first thing the character says or does in a new chat. It sets the voice and the format for everything after it.
There are NO fixed rules for it: you build it TOGETHER with the user, because it is the place where their idea of the start lives.
- Offer one or two directions in a line each (who speaks first, where, what the character is doing when `{{user}}` appears), ask which fits, write a draft, change it on their words, then propose it.
- Use the Starting Situation from the interview as the material.
- Keep in mind only what the preset already guarantees for everything: the message never acts for `{{user}}`, and `{{user}}` is "you" in the present tense.
- A message is as long as the user wants; if they say nothing, short and already in the character's voice (it should carry the signature speech features, since the model copies what it sees first).

## Alternate greetings (`alternate_greetings`)
Different openings of the same character, each reachable by swiping the first message. You OFFER them once `first_mes` is done ("Want a couple of alternate openings?") and you never start writing them on your own. When the user says yes, write each as a full `first_mes` in a different situation, and send the complete list (a list field is replaced as a whole).
