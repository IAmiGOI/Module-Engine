import { request } from '../../libraries/shared/request.js';
import { normalizeProbes, buildTestChat, describeTestResult, describeChatExcerpt, CHAT_EXCERPT_MAX_MESSAGES } from '../../libraries/core/character-test.js';

/**
 * Проверка карточки: серия ходов в изолированном чате (запрос собирает Prompt Manager тем же путём, что настоящую отправку, но с текстом ЭТОЙ карточки) и разбор
 * настоящего открытого чата. Идёт на модели, на которой человек играет (основное подключение ST) либо на выбранном воркере: забывчивость зависит от модели,
 * поэтому проверять на чужой бессмысленно. Каждая проба — полная генерация, то есть токены человека; пределы — в libraries/core/character-test.js.
 */
export function createCardTestRunner(host, { readCard }) {
    const callOwn = (contract, params) => request(host.own, contract, { params });
    const callService = (contract, params) => request(host.services, contract, { params });

    async function requireValue(result, what) {
        if (!result.ok) throw new Error(`characterCard: ${what}: ${result.error.message}`);
        return result.value;
    }

    async function generateReply(messages, { workerId, maxTokens }) {
        if (workerId) return String(await requireValue(await callOwn('model.generate', { workerId, messages, maxTokens, stream: false }), 'the model did not answer') ?? '');
        const answer = await requireValue(await callService('stGeneration.direct', { messages, maxTokens }), 'the main connection did not answer');
        if (!answer?.ok) throw new Error(`characterCard: the main connection did not answer: ${answer?.error ?? 'no reply'}`);
        return String(answer.text ?? '');
    }

    async function runTest(params = {}) {
        const made = normalizeProbes(params.probes);
        if (!made.ok) throw new Error(`characterCard: ${made.error}`);
        const { fields } = await readCard(params);
        const userName = (await requireValue(await callService('stPromptData.read', {}), 'SillyTavern data is not available'))?.user ?? 'User';
        const maxTokens = Math.min(Math.max(Number(params.maxTokens) || 1200, 200), 4000);
        const turns = [];
        let presetName = '';
        for (const probe of made.value) {
            const turn = { ...probe };
            turns.push(turn);
            const assembled = await requireValue(await callOwn('promptManager.assembleForCard', { card: fields, chat: buildTestChat(fields, userName, turns) }), 'the request could not be built');
            if (assembled.skipped) throw new Error(`characterCard: Prompt Manager cannot build the request (${assembled.skipped}).`);
            presetName = assembled.presetName;
            turn.reply = await generateReply(assembled.messages, { workerId: params.workerId, maxTokens });
        }
        const modelLabel = params.workerId ? `the model connection “${params.workerId}”` : 'the main SillyTavern connection (the model you play on)';
        return { name: fields.name, text: describeTestResult({ name: fields.name, modelLabel, presetName, results: turns }), results: turns };
    }

    async function readChatExcerpt(params = {}) {
        const { avatar, fields } = await readCard(params);
        const open = await requireValue(await callService('stCharacter.current'), 'the open character is not available');
        if (open?.avatar !== avatar) throw new Error(`characterCard: the open chat is not with ${fields.name} — open a chat with this character first.`);
        const messages = await requireValue(await callOwn('chatHistory.messages', { limit: Math.min(Math.max(Number(params.last) || CHAT_EXCERPT_MAX_MESSAGES, 2), CHAT_EXCERPT_MAX_MESSAGES) }), 'the chat could not be read');
        return { name: fields.name, text: describeChatExcerpt({ name: fields.name, messages }) };
    }

    return { runTest, readChatExcerpt };
}
