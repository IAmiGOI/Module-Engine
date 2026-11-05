/**
 * Правила настроек игры — дословно из PROMPTS.md §22. Отдельным файлом,
 * чтобы decision-prompts.js не рос дальше: потребители берут их оттуда же
 * через ре-экспорт.
 */
/** Заголовок блока настроек игры (PROMPTS.md §22). */
export const STORY_SETTINGS_HEADER = 'STORY SETTINGS:';

/**
 * Строки правил настроек игры — дословно из PROMPTS.md §22. В контекст
 * попадает только строка выбранного значения; смена значения меняет блок.
 */
export const STORY_SETTINGS_RULES = Object.freeze({
    difficulty: Object.freeze({
        easy: "Rolls go in the attempt's favour: when it is close, it works.",
        normal: 'Every attempt stands on its own odds.',
        hard: 'Rolls go against the attempt: carelessness fails.',
        brutal: 'The world does not forgive a mistake; doubtful attempts go badly.',
    }),
    power: Object.freeze({
        grounded: "The user's character can do only what this world makes plausible: every ability has its natural reach, cost and limit.",
        'as-described': "Take the user's character's abilities as stated, at full strength: add no limit, cost or doubt the user did not give, and never write one into the brief, a note or a plan. A stated ability covers its natural uses: rate experience by that ability, not by whether this exact use has been seen before.",
    }),
    consequences: Object.freeze({
        safe: 'The user\'s character and the characters who matter do not die or lose a limb. A failure costs time, standing or a relationship.',
        wounds: 'Wounds are real and last. Death comes only from a choice that leads to it.',
        lethal: 'Anyone can die, the user\'s character included, when the scene leads there.',
    }),
    pacing: Object.freeze({
        'slow-burn': 'Let quiet turns stay quiet. A new complication comes only when the world must answer.',
        balanced: 'Move one thing forward each turn; add a complication when the world has a reason.',
        eventful: 'Something new presses on the scene every turn or two.',
    }),
    initiative: Object.freeze({
        reactive: "Characters act when the user's action gives them a reason; otherwise they wait.",
        living: "Characters pursue their own plans whether or not the user is watching.",
        relentless: 'Characters push their plans every turn and the world moves on its own.',
    }),
    canon: Object.freeze({
        strict: 'Characters and the world hold to their canon; the card and the lorebook win over it.',
        flavoured: "Keep the canon's flavour; this story may fill what canon leaves open.",
        free: 'Treat the canon as material, not a rule; this story may change it.',
    }),
    romance: Object.freeze({
        slow: 'Romance builds over many turns; characters do not warm to the user quickly.',
        natural: 'Romance grows at the pace the characters and the story allow.',
        fast: 'Characters warm to the user quickly and romance moves fast.',
        off: 'No romantic lines: attraction stays in the background and never becomes a thread.',
    }),
    tone: Object.freeze({
        light: 'Keep the world warm: allow humour and kindness, and spare the user its worst.',
        balanced: 'Weigh warmth and cruelty as the characters and the story demand.',
        dark: 'The world is harsh: cruelty, loss and grim detail belong in it.',
    }),
    hooks: Object.freeze({
        natural: 'End the turn at the first point where the user would naturally react.',
        cliffhangers: 'End each turn on a hook that pulls the user back into the story.',
    }),
    replyLength: Object.freeze({
        short: 'Keep each reply short: a few sentences.',
        medium: 'Write replies of moderate length: two or three paragraphs.',
        long: 'Write long replies with room for detail and atmosphere.',
    }),
    pov: Object.freeze({
        second: 'Write in the second person, addressing the user as "you".',
        third: 'Write in the third person: the user\'s character is "they" or their name.',
        first: 'The user\'s character tells the story in the first person; everyone else is seen from outside.',
    }),
    prose: Object.freeze({
        plain: 'Use plain, direct prose: clear sentences, little ornament.',
        vivid: 'Write vivid prose: concrete sensory detail and living gestures.',
        literary: 'Write literary prose: rhythm, imagery and precise, uncommon words.',
    }),
    dialogue: Object.freeze({
        less: 'Keep dialogue sparse: description carries most of the reply.',
        balanced: 'Balance dialogue and description.',
        more: 'Give dialogue more room than description.',
    }),
    innerThoughts: Object.freeze({
        hidden: 'Never show the inner thoughts of other characters; show them through behaviour and speech.',
        shown: 'You may show the inner thoughts of other characters, in moderation.',
    }),
});
