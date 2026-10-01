import { estimateTokens } from './guide-knowledge.js';

/**
 * Сжатие длинной истории гида — тот же принцип, что у Ядра саммари: свежее окно остаётся дословно, всё, что старше, сворачивается в одну выжимку,
 * которая идёт в системный промпт; сами сообщения в чате остаются как были. Чистые функции: решение «что сворачивать», подсказка для модели и границы текста.
 */

export const DIGEST_MAX_CHARS = 14000;
export const DIGEST_MAX_TOKENS = 3500;

/** Сообщения после отметки `upTo` (id последнего свёрнутого); отметки нет в списке — свёрнутое уже выпало из чата, остаётся всё. */
export function cutAfterDigest(history, upTo) {
    if (!upTo) return history;
    const at = history.findIndex(message => message.id === upTo);
    return at < 0 ? history : history.slice(at + 1);
}

/**
 * Сколько самых старых ходов свернуть. История не больше `limitTokens` — не сворачиваем ничего; иначе сворачиваем старейшие, пока остаток не станет меньше
 * `keepTokens` (свежее окно остаётся дословно, как «защищённое окно» саммари) — но минимум два последних хода всегда остаются.
 * `turns` — `[{ content }]`, старые первыми.
 */
export function planHistoryFold(turns, { limitTokens, keepTokens }) {
    const costs = turns.map(turn => estimateTokens(turn.content));
    let total = costs.reduce((sum, cost) => sum + cost, 0);
    if (total <= limitTokens) return 0;
    let count = 0;
    while (count < turns.length - 2 && total > keepTokens) { total -= costs[count]; count += 1; }
    return count;
}

/** Подсказка модели: прежняя выжимка плюс свёрнутые ходы → новая выжимка. Что важно сохранить — для работы над карточкой персонажа. */
export function buildDigestPrompt(previous, turns) {
    const transcript = turns.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n\n');
    return [
        'You keep the memory of a long working conversation between a user and an assistant who helps with SillyTavern and writes character cards. Update the running summary below with the new part of the conversation.',
        'Keep, in plain compact notes: what the user asked for and every decision they made (wording they insisted on included); facts established (canon details found online, with the page they came from); the current state of the card or settings being worked on (what is written, what is still open); rules and preferences the user stated; results of actions that still matter.',
        'Drop greetings, repeated attempts and anything that was superseded. Do not copy long pieces verbatim, except short phrases the user dictated. Write the summary only, no preface, under 1500 words.',
        '',
        '## Summary so far',
        previous || '(nothing yet)',
        '',
        '## New part of the conversation',
        transcript,
    ].join('\n');
}

/** Выжимка в системный промпт: пустая — без блока. */
export function digestBlock(digest) {
    const text = String(digest ?? '').trim();
    return text ? `## Earlier in this conversation (summary of what was folded out of the history)\n${text}` : '';
}

export const clampDigest = text => String(text ?? '').trim().slice(0, DIGEST_MAX_CHARS);
