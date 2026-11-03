import { characterQuote, formKnowledgeQuestions, formKnowledgeState, knowledgeRefusal, knowledgeViolations } from '../../libraries/core/decision-form-check.js';

/**
 * Проверка формы директора классификатором: один запрос со всеми
 * персонажами и общим срезом сцены. Возвращённый конфликт — текст раздела
 * 14; повторный конфликт по тому же имени принимается с пометкой.
 */
export function createFormChecker({ call, getSettings, banks = null, knowledge = null }) {
    function settings() {
        return getSettings()?.classifier ?? {};
    }

    async function characterData(characters) {
        return Promise.all(characters.map(async character => {
            const name = String(character?.name ?? '').trim();
            const bank = banks?.recordsFor ? banks.recordsFor([name]).map(record => record.text).filter(Boolean).join('\n\n') : '';
            const knowledgeText = knowledge?.textFor ? await knowledge.textFor([name]).catch(() => '') : '';
            return { ...character, bank, knowledge: knowledgeText };
        }));
    }

    /**
     * @returns {{ ok: true, warnings: string[], probabilities?: object }
     *          | { ok: false, name: string, chance: number, quote: string, refusal: string, probabilities: object }}
     */
    async function check({ form, sceneText = '', returned = new Set(), signal = null } = {}) {
        const userName = String(banks?.persona?.()?.name ?? '').trim().toLowerCase();
        const characters = (Array.isArray(form?.characters) ? form.characters : [])
            .filter(character => String(character?.name ?? '').trim() && character?.idle !== true)
            .filter(character => !userName || String(character.name).trim().toLowerCase() !== userName);
        if (!characters.length) return { ok: true, warnings: [] };
        const rich = await characterData(characters);
        const state = formKnowledgeState({ scene: sceneText, characters: rich });
        const questions = formKnowledgeQuestions(rich);
        const config = settings();
        const connectionId = String(config.connectionId ?? '').trim();
        let result;
        try {
            result = await call('classifier.decide', {
                calls: [{ state, questions, ...(connectionId ? { connectionId } : {}) }],
                ...(signal ? { signal } : {}),
            });
        } catch (error) {
            return { ok: true, warnings: [`The form was not checked by the classifier: ${error?.message ?? error}`], skipped: true };
        }
        const answers = result?.answers ?? {};
        if (!Object.keys(answers).length) {
            return { ok: true, warnings: [`The form was not checked by the classifier: ${result?.error || 'no answer'}`], skipped: true };
        }
        const threshold = Number(config.threshold) || 0.85;
        const violations = knowledgeViolations(answers, rich, threshold);
        for (const item of violations) {
            if (!returned.has(item.name)) {
                return {
                    ok: false, name: item.name, chance: item.chance, quote: characterQuote(item.character),
                    refusal: knowledgeRefusal({ name: item.name, quote: characterQuote(item.character) }), probabilities: answers,
                };
            }
        }
        const warnings = violations.map(item => `The form was accepted with a knowledge conflict for ${item.name} (${Math.round(item.chance * 100)}%): the same character was already returned once this turn.`);
        return { ok: true, warnings, probabilities: answers, warningsOnly: violations.length > 0 };
    }

    return { check };
}
