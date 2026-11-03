import { assessAction, DIFFICULTY_ANCHORS, EXPERIENCE_ANCHORS, lexicalSimilarity } from '../../libraries/core/decision-probability.js';

/** Оценка действия: слова директора проецируются на шкалы, движок бросает кость. */
export function createAssessHandler({ state, similarityScores, getSettings }) {
    return async args => {
        state.assessmentCounter += 1;
        const id = `asm_${state.runId}_${state.assessmentCounter}`;
        const [difficultyScores, experienceScores] = await Promise.all([
            similarityScores(args.difficulty, DIFFICULTY_ANCHORS),
            similarityScores(args.experience, EXPERIENCE_ANCHORS),
        ]);
        const similarity = (text, anchorPhrase) => difficultyScores?.get(anchorPhrase)
            ?? experienceScores?.get(anchorPhrase)
            ?? lexicalSimilarity(text, anchorPhrase);
        const settings = getSettings();
        const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + state.assessmentCounter : undefined;
        const result = assessAction({
            character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience, seed, similarity,
        });
        state.assessments.set(id, { ...result, id });
        return { ok: true, id, ...result };
    };
}
