import { FORM_KNOWLEDGE_QUESTION, FORM_KNOWLEDGE_REFUSAL, fillPrompt } from './decision-prompts.js';

/**
 * Проверка формы директора на знания — чистые функции: срез сцены,
 * утверждение на каждого персонажа, цитата из формы и текст отказа.
 * Тексты — `PROMPTS.md`, раздел 14.
 */

const text = value => String(value ?? '').trim();

export const knowledgeId = name => `knowledge_conflict:${text(name)}`;

export function formKnowledgeState({ scene = '', characters = [] } = {}) {
    return {
        scene: text(scene),
        characters: (Array.isArray(characters) ? characters : []).map(character => ({
            name: text(character.name),
            bank: text(character.bank),
            knowledge: text(character.knowledge),
            decision: text(character.decision),
            action: text(character.action),
            speech: text(character.speech),
        })),
    };
}

export function formKnowledgeQuestions(characters) {
    return Object.fromEntries((Array.isArray(characters) ? characters : [])
        .map(character => text(character?.name))
        .filter(Boolean)
        .map(name => [knowledgeId(name), fillPrompt(FORM_KNOWLEDGE_QUESTION, { name })]));
}

/** Цитата для отказа — действие, иначе реплика, иначе решение. */
export function characterQuote(character) {
    return text(character?.action) || text(character?.speech) || text(character?.decision);
}

export function knowledgeRefusal({ name, quote = '' } = {}) {
    return fillPrompt(FORM_KNOWLEDGE_REFUSAL, { name: text(name), quote: text(quote) });
}

/** Персонажи выше порога, в порядке формы; ответы без числа пропускаются. */
export function knowledgeViolations(answers, characters, threshold) {
    const limit = Number(threshold) || 0.85;
    return (Array.isArray(characters) ? characters : [])
        .map(character => ({ character, name: text(character?.name), chance: Number(answers?.[knowledgeId(character?.name)]) }))
        .filter(item => item.name && Number.isFinite(item.chance) && item.chance >= limit);
}
