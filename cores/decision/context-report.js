import { estimateTokens } from '../../libraries/core/token-estimate.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Заполнение контекстного окна резолвера (как индикатор у кодинговых моделей):
 * на каждом ходу настоящий контекст раскладывается по разделам с токенами.
 * Текст разделов — только в памяти страницы (иначе файл чата раздувался бы
 * на весь контекст каждый ход); в чат пишутся подписи и токены, чтобы
 * колесико показывало заполнение и после перезагрузки.
 */
export const RESOLVER_CONTEXT_LIMIT = 300000;

export function createContextReport({ call, publishEvent = () => {}, now = () => Date.now() }) {
    let last = null;

    function record(built, { turn = null, limit = RESOLVER_CONTEXT_LIMIT } = {}) {
        const sections = (Array.isArray(built?.sections) ? built.sections : []).map(section => ({ ...section, tokens: estimateTokens(section.text) }));
        if (!sections.length) return null;
        const total = sections.reduce((sum, section) => sum + section.tokens, 0);
        last = { at: now(), turn, limit, total, sections };
        const summary = { ...last, sections: sections.map(({ text: _text, ...rest }) => rest) };
        publishEvent('decision.context.report', summary);
        Promise.resolve(call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'contextReport', value: summary })).catch(() => {});
        return last;
    }

    async function get() {
        if (last) return last;
        try {
            const stored = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'contextReport', fallback: null });
            return stored && typeof stored === 'object' ? stored : null;
        } catch { return null; }
    }

    return { record, get, reset: () => { last = null; } };
}
