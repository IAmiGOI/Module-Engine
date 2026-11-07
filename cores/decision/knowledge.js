import { applyKnowledge, normalizeKnowledge, renderKnowledge, knowledgeKey } from '../../libraries/core/decision-knowledge.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

const KNOWLEDGE_KEY = 'knowledge';

/**
 * Знания персонажей: инструмент директора и текст секции для контекстов.
 *
 * Знания привязаны к записи персонажа в Great Bank (`knowledge` — отдельный
 * блок записи, форма та же, что и была у системы). Пока Great Bank в чате не
 * собран — читается старое хранилище чата: чат не теряет знания при переходе.
 */
export function createKnowledge({ call, store = null, banks = null, now = () => Date.now(), rid = Math.random }) {
    const great = () => (banks?.great && typeof banks.great.setKnowledge === 'function' ? banks.great : null);

    /** Старое хранилище — запасной путь для чатов, где Great Bank ещё не собран. */
    async function legacy() {
        try { return normalizeKnowledge(await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: KNOWLEDGE_KEY, fallback: {} })); }
        catch { return {}; }
    }

    /** Все знания чата одной формой: имя → { name, items }. */
    async function load() {
        const source = great();
        if (!source) return legacy();
        const state = await source.load();
        const out = {};
        for (const character of Object.values(state ?? {})) {
            const items = Array.isArray(character?.knowledge?.items) ? character.knowledge.items : [];
            if (!character?.name || !items.length) continue;
            out[knowledgeKey(character.name)] = { name: character.name, items: items.map(item => ({ ...item })) };
        }
        return out;
    }

    function isUser(name) {
        const persona = (typeof banks?.records === 'function' ? banks.records() : []).find(record => record.sourceKind === 'persona');
        return Boolean(persona) && knowledgeKey(persona.name) === knowledgeKey(name);
    }

    async function characterKnowledge(args = {}) {
        if (isUser(args.character)) {
            return { ok: false, error: "The user's character has no knowledge record: for the user keep only items and physical state, in a character note." };
        }
        const source = great();
        if (!source) return legacyKnowledge(args);
        // Имя приводится к записи персонажа: знания живут при персонаже, а не отдельной картой по всему чату.
        const name = await source.resolveName(args.character);
        const current = (await load())[knowledgeKey(name)] ?? { name, items: [] };
        const minutes = typeof store?.clock === 'function' ? store.clock()?.minutes ?? null : null;
        const result = applyKnowledge({ [knowledgeKey(name)]: current }, args, { minutes, at: now(), rid });
        if (!result.ok) return result;
        await source.setKnowledge(name, result.state[knowledgeKey(name)].items);
        return { ok: true, id: result.item.id, status: result.item.status };
    }

    /** Старый путь: пока записи персонажа нет, знания пишутся в хранилище чата. */
    async function legacyKnowledge(args) {
        const result = applyKnowledge(await legacy(), args, { minutes: typeof store?.clock === 'function' ? store.clock()?.minutes ?? null : null, at: now(), rid });
        if (!result.ok) return result;
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: KNOWLEDGE_KEY, value: result.state });
        return { ok: true, id: result.item.id, status: result.item.status };
    }

    async function textFor(names = null) {
        const state = await load();
        const fallback = great() ? await legacy() : {};
        return renderKnowledge({ ...fallback, ...state }, { names });
    }

    return { handlers: { character_knowledge: characterKnowledge }, textFor, load };
}
