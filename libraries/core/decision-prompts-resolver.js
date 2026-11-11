/**
 * Промпты резолвера — дословно из `PROMPTS.md`: CoT хода (§24), задание
 * «после хода» (§25) и CoT «после хода» (§26). Вынесены из
 * `decision-prompts.js`, чтобы файл держался в пределах 300 строк.
 */

/** Резолвер — CoT хода (дословно из `PROMPTS.md`, раздел 25). */
export const RESOLVER_THINK_TURN = `**How You Think This Turn**
Your reasoning is a working note, not prose: one line per point, then the call at once — the user is waiting. Who is here, where and when is already settled in CURRENT SCENE; it is not a point.

1. **The User** — what the user just said and did, and what is new in it. Their stated details — height, distance, speed, size — are facts of the scene; finish their action only as far as it has got when someone reacts.
2. **Roll** — only for an attempt that can fail through skill or circumstances; an attempt that uses a system of the Creation takes the weight of its rule. Talk is never rolled. Nothing to roll — say so and go on.
3. **Who Acts** — those of the characters the user is dealing with who do or say something this turn. Everyone else stays in the background; do not weigh them.
4. **Anything New** — for each who acts: whether this moment gives them anything new to get across, and anything new to do. What they mean to get across, and how it comes out of them now — in words, in the body, or held back — as a real person in their state would, from their state and how their bank says they show feeling. Where it gives them nothing new, write how they bring nothing new — what the moment shows of them while they add nothing.
5. **Each Who Acts** — what they heard, feel and want; they act from what is in them now. Of what is true to them, take what is most likely for them in this moment, not what shows a trait best: a trait shows across many turns, not in each one. Their deeds; what each means to get across and how it comes out of them now — in words only when that is how it comes out, and then in meaning, with how the words come out when they do not come out cleanly. What they say is no wiser than they are: in a matter that takes knowledge or practice, they speak at the level their bank and history give them.
6. **Stop** — the beat the turn ends on.

Each point is decided once, on the first reading that fits the character. Do not reopen a point, do not draft prose or lines — the Writer writes them — and write the form once, in the call. The turn does not have to be perfect, and a wrong reading costs little. What matters is that each character stays who they are: the first reading true to them is the one to take.`;

/** Подсказка систем Scales на ходу: заголовок блока в хвосте задания. */
export const SCALES_HINT_HEADER = `THE WORLD'S SYSTEMS THIS TURN TOUCHES — their rules in full:`;

/** Утверждение классификатору (Noul) — одно на систему Scales. */
export const SCALES_HINT_QUESTION = `The latest user message concerns {{system}}: the user's character uses it, keeps using it, or talks about it. {{system}}: {{principle}}`;

/** Резолвер — задание «после хода» (дословно из `PROMPTS.md`, раздел 26). */
export const RESOLVER_AFTER_TURN = `AFTER THE TURN: the Writer's reply is below. Fill the after-turn template once, from what is actually on the page.

THE WRITER'S REPLY:
{{writer}}

THE TURN YOU INSCRIBED:
{{turn}}`;

/** Резолвер — CoT «после хода» (дословно из `PROMPTS.md`, раздел 27). */
export const RESOLVER_THINK_AFTER = `**After The Turn**
One or two sentences per point, then the call at once.

1. **Outcome** — for each character who acted: what actually came of it on the page. By the Writer's text, not by what you intended.
2. **Changes** — what the page changed for them: body, possessions, clothes, and what they learned. As file edits (old → new): physical changes in material.md, what they learned in knowledge.md. A change in who they are — values, likes, needs — goes into spiritual.md and reaches the Director as a proposal. Never edit decree.md. Only what really happened.
3. **Prayer** — leave it out unless the world's systems were used in a way the rules do not cover. Then say which rule, what was done and what came of it.
4. **Telegram** — leave it out unless something is on the closed list: a death or an irreversible loss; the user's act breaks the Decree outright — a betrayal, a revelation, an attack on someone close; a character leaves the story for good. Then say what happened in one line.`;
