/**
 * Промпты резолвера — дословно из `PROMPTS.md`: CoT хода (§24), задание
 * «после хода» (§25) и CoT «после хода» (§26). Вынесены из
 * `decision-prompts.js`, чтобы файл держался в пределах 300 строк.
 */

/** Резолвер — CoT хода (дословно из `PROMPTS.md`, раздел 25). */
export const RESOLVER_THINK_TURN = `**How You Think This Turn**
Your reasoning is a working note, not prose. One or two sentences per point, then the call at once — the user is waiting.

1. **The User** — what the user attempted, and its stated details: height, distance, speed, size. They are facts of the scene; resolve from them, make nothing smaller, and finish the action only as far as it has got when someone reacts.
2. **Roster** — who is in the scene now and who enters or leaves this turn. Only those who can affect the scene are in it; watchers and pursuers live in their plans.
3. **Each Character** — for every active character, in this order:
   - **Feels** — the feeling now and its cause, from their bank and what just happened.
   - **The Decree wants** — what their Decree wants from them in this moment: its goal for today and its rules of resolving.
   - **Conflict** — none, minor or strong, and what pulls where. A strong conflict means they act against themselves.
   - **Does and says** — what they do and what they say, in meaning only; what they expect and are already guarding against.
4. **Rolls** — what can fail and needs assess. An attempt that uses a system of the Creation takes the weight of its rule. Talk is never rolled. An obstacle counts only if the scene already established it; never invent one to make a roll harder.
5. **Stop** — where the turn ends: the first point where the user would naturally react.

Decide, do not deliberate. When two readings are plausible, take the one that fits the character and the map best and move on. Do not draft prose or lines of speech — the Writer writes them. Do not build the form twice: write it once, in the call.`;

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
