import { buildWriterContext } from '../../libraries/core/decision-context.js';
import { computeWriterPayload } from '../../libraries/core/decision-body.js';
import { assembleSectionFor } from './prompt-sections.js';
import { createWriterProxy } from './writer-proxy.js';

/**
 * Тело запроса прозаика. Если у прозаика выбрано подключение ME, запрос
 * уходит туда целиком (writer-proxy) и ST получает готовый Response. Если
 * подключения нет — прежний путь: подменяем тело запроса ST, адрес и ключ
 * остаются ST.
 */
export function createWriterRewrite({ host, call, getSettings, getWorkers, store, getPending, banks = null }) {
    const writerProxy = createWriterProxy({ host, getSettings, getWorkers });
    return async function rewrite(input = {}) {
        const payload = input.payload ?? input;
        const pending = getPending();
        if (!pending || !payload) return payload;
        const settings = getSettings();
        const summaries = (await call('summary.list')) ?? [];
        const writerId = String(settings.writer?.workerId ?? '').trim();
        const worker = writerId ? getWorkers().find(item => item.id === writerId) : null;
        const model = worker && worker.id !== 'st-main' ? String(worker.model ?? '') : '';
        const writerBlock = (await assembleSectionFor({ sectionId: 'writer', settings, chat: pending.chat, call, model })).messages;
        const bankText = banks ? banks.contextFor({ names: store.roster().active, all: false }).text : '';
        const examples = banks ? banks.examplesForCards() : '';
        const context = buildWriterContext({ notes: store.notes(), summaries, chat: pending.chat, decision: pending.push ?? pending.decision, writerBlock, banksText: bankText, examples });
        if (writerId && writerId !== 'st-main') {
            const own = await writerProxy.respond({ payload, messages: context.messages, signal: input.signal });
            if (own) return own;
        }
        return computeWriterPayload(payload, context, { writer: settings.writer, model }) ?? payload;
    };
}
