import { applyKnowledge, normalizeKnowledge, renderKnowledge, knowledgeKey } from '../../libraries/core/decision-knowledge.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

const KNOWLEDGE_KEY = 'knowledge';

/**
 * Знания персонажей в памяти чата: инструмент директора и текст секции для контекстов. Читает память чата при
 * каждом обращении — так смена чата не оставляет чужих знаний.
 */
export function createKnowledge({ call, store = null, banks = null, now = () => Date.now(), rid = Math.random }) {
    async function load() {
        try { return normalizeKnowledge(await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: KNOWLEDGE_KEY, fallback: {} })); }
        catch { return {}; }
    }

    function isUser(name) {
        const persona = (typeof banks?.records === 'function' ? banks.records() : []).find(record => record.sourceKind === 'persona');
        return Boolean(persona) && knowledgeKey(persona.name) === knowledgeKey(name);
    }

    async function characterKnowledge(args = {}) {
        if (isUser(args.character)) {
            return { ok: false, error: "The user's character has no knowledge record: for the user keep only items and physical state, in a character note." };
        }
        const minutes = typeof store?.clock === 'function' ? store.clock()?.minutes ?? null : null;
        const result = applyKnowledge(await load(), args, { minutes, at: now(), rid });
        if (!result.ok) return result;
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: KNOWLEDGE_KEY, value: result.state });
        return { ok: true, id: result.item.id, status: result.item.status };
    }

    async function textFor(names = null) {
        return renderKnowledge(await load(), { names });
    }

    return { handlers: { character_knowledge: characterKnowledge }, textFor, load };
}
