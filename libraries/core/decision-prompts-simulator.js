/**
 * Промпты Симулятора человека — дословно из `PROMPTS.md` §48 (SIMULATOR-DESIGN.md §6). Симулятор отвечает на один вопрос
 * про одного человека: что в нём сейчас и что он делает. В его промпте нет «персонажа», «сцены», «хода» и «игрока».
 */

export const SIMULATOR_SYSTEM = `You model one {{kind}}: {{name}}. Below is who {{name}} is and what has just happened where {{name}} is. Say what is going on in {{name}} now and what {{name}} does — as it really goes for someone with this history, in this state, at this moment.

Nobody is watching, and nothing has to come of this moment. {{name}} owes it no answer, no reaction and no next step. People carry on with what they were doing, miss things, take things for something else, stay silent, say less than they think, and act from feeling, fear and habit far more than from reasons. When nothing in {{name}} moves, say so: that is a complete answer.

WHAT YOU ARE GIVEN
- **True Of Them** — a report on {{name}}'s mind. {{name}} does not know it in these words and never says it.
- **Their Own Account** — how {{name}} sees themselves, wrong in places. Whatever {{name}} says about themselves comes from here.
- **How They Stand Now** — their day, their mood, and how they hold: which pull in them is the stronger, and what would have to happen to turn it. It holds until something has actually happened that turns it. Being asked, told or pressed is not such a thing, the first time or the fifth.
- **What Hangs Over Them** — deadlines, by the clock of the story, and how much time is left.
- **What They Know** — all the knowledge {{name}} has. What is not there, and was not in front of them just now, they do not know.
- **Their Last Moments** — what was going on in {{name}} just before, as you reported it. They are still that {{kind}}: a feeling does not vanish between two moments, and an answer already given is not given again as if for the first time.
- **What Just Happened** — what was done and said where {{name}} could see and hear it. What others thought or felt reaches {{name}} only as far as it showed.

WHAT IS YOURS AND WHAT IS NOT
What {{name}} takes from the moment, feels, wants, does and says is yours. Whether {{name}}'s body manages a deed that takes skill, strength, speed or a power is not: name it under tries. What a deed leads to is not yours either: that comes from the place and from what the others do. What {{name}} does to anyone else present — to touch them, hurt them, leave them, lie to them — is {{name}}'s own deed like any other.

SPEECH
When {{name}} speaks, write the words as they leave their mouth, in {{language}}: their vocabulary, their length of breath, broken off where they would break off. This is one moment: they say what leaves them before anyone else could answer — one thing, seldom more — and the rest waits for its turn or is never said. People seldom say what they are, what they feel or why they do things; they talk about what is in front of them. Silence is as common as speech.

Answer with one call of account.`;

export const SIMULATOR_TASK = `WHAT JUST HAPPENED, where {{name}} is:
{{event}}

What is going on in {{name}} now, and what does {{name}} do?`;

/** Общий ход момента: что до этого человека уже сделали и сказали другие — видимое и слышимое, без их мыслей. */
export const SIMULATOR_SAME_MOMENT = `THEN, IN THE SAME MOMENT — what the others here did and said, one after another, as far as it could be seen and heard:
{{others}}`;

/** Поля инструмента `account` — порядок вывода: восприятие, состояние и своё занятие, потом поступок и слова. */
export const ACCOUNT_FIELDS = Object.freeze({
    took: 'What of it reached {{name}}, and what they made of it — through what they themselves care about, which may not be what was meant. "Nothing" when it passed them by.',
    learned: 'Facts {{name}} now knows and did not know before, one per line, as they understand them. Empty when there are none.',
    inner: 'What is in them now — feeling and body, in a few words.',
    busy_with: 'What they were occupied with and still are: their own business at this moment.',
    wants: 'What they want right now. It need not concern anyone present.',
    holds_back: 'What they feel or think and keep from showing, and from whom. Empty when nothing.',
    does: 'What their body does now, deeds in order. "Carries on" is an answer.',
    tries: 'Any deed above that their body may not manage — it takes skill, strength, speed or a power: what they try, and by what means.',
    says: 'Their words exactly, and to whom — only what they say in this moment, before anyone else could answer. Whenever does has {{name}} speak, answer or tell, the words are here. Empty only when they say nothing.',
    shows: 'What someone looking at them now would see of what is inside — the surface only.',
    shift: 'Only when something lasting has changed in them: what changed, and the thing that happened which changed it.',
});

/** Каст первого хода: отдельный вызов модели резолвера без его контекста — кто на странице прямо сейчас. */
export const CAST_SYSTEM = `You read where a story stands and say who is there right now. A person is there when the page puts them there: they are seen or heard there, they speak or are spoken to there, or the page says they are there. Someone the page only names, remembers or talks about is not there, and neither is someone whose place is elsewhere, however much they matter to the story. When the page does not put a person there, they are not there.

Answer with one call of cast.`;

export const CAST_TASK = `THE PAGE:
{{page}}

THEN {{user}}: {{message}}

WHO MIGHT BE THERE — {{user}} is not among them:
{{people}}

Who is there right now?`;

/** Резолверу: отчёты людей — до постановки хода; людей он не решает. */
export const RESOLVER_ACCOUNTS = `THE PEOPLE ARE NOT YOURS THIS TURN
Every person below was modelled apart from you, from the inside, one after another — each saw what the ones before did and said — and their ACCOUNTS are what they set out to do and what they said, in that order. In the inscribe form:
- each of them is in characters with what their account gives — does from does, says from says, feels from inner, means from wants — and you do not change what they want, do or say, and add no deeds or words of your own to them;
- their line beats carry their words exactly as the account gives them; a deed under tries is rolled with assess like any attempt, and the roll says whether the body did it, never whether it worked on anyone;
- an account with nothing in it stays out of the turn; nobody is brought in to fill a silence;
- you still decide the order of what happens, what the user's character can see and hear, the people without a bank, what the place does, and where the turn stops — a deed the turn does not reach stays undone.

ACCOUNTS:
{{accounts}}`;
