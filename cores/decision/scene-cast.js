import { CAST_SYSTEM, CAST_TASK, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { isUserCharacter } from '../../libraries/core/decision-great-bank.js';
import { lastExchange } from './simulator.js';

/**
 * Каст первого хода: пока ростер пуст, один вызов модели резолвера отдельным коротким промптом, без контекста резолвера —
 * кто на странице прямо сейчас. Названные ложатся в ростер до симулятора и резолвера: важность в мире не ставит человека
 * в сцену (Шин в штабе Республики). Сбой — ростер остаётся пустым, ход идёт как шёл.
 */
const text = value => String(value ?? '').trim();
const DAY_CHARS = 240;

export function castCandidates(state) {
    return Object.values(state ?? {}).filter(character => text(character?.name) && !isUserCharacter(character));
}

export function candidateLine(character) {
    const aliases = (character.aliases ?? []).map(text).filter(Boolean);
    const day = text((character.decree?.[1] ?? []).map(text).filter(Boolean).join(' ')).replace(/^\[[^\]]*\]\s*/, '');
    const short = day.length > DAY_CHARS ? `${day.slice(0, DAY_CHARS).trimEnd()}…` : day;
    return `- ${character.name}${aliases.length ? ` (also ${aliases.join(', ')})` : ''}${short ? ` — their day: ${short}` : ''}`;
}

export function createSceneCast({ call, banks, store, publishEvent = () => {} }) {
    /** Ростер пуст — кастуем; иначе ничего. Возвращает список вошедших (пустой — каст не нужен или не удался). */
    async function castIfEmpty({ chat = [], workerId = '', signal = null } = {}) {
        if ((store?.roster?.().active ?? []).length || !banks?.great?.load) return [];
        const state = await banks.great.load().catch(() => ({}));
        const candidates = castCandidates(state);
        if (!candidates.length) return [];
        const user = Object.values(state).find(isUserCharacter)?.name || 'the user';
        const { page, message } = lastExchange(chat);
        if (!page) return [];
        const names = candidates.map(character => character.name);
        const tool = {
            name: 'cast', description: 'Who is there right now.',
            parameters: { type: 'object', required: ['present'], properties: { present: { type: 'array', description: `Everyone there right now, by name. Empty when nobody from the list is there.`, items: { type: 'string', enum: names } } } },
        };
        const answer = await call('model.generate', {
            purpose: 'cast', workerId, stream: false, returnMessage: true, maxTokens: 2000, temperature: 0.2, signal,
            tools: [tool], toolChoice: { type: 'function', function: { name: 'cast' } },
            messages: [
                { role: 'system', content: CAST_SYSTEM },
                { role: 'user', content: fillPrompt(CAST_TASK, { page, user, message: message || '(nothing yet)', people: candidates.map(candidateLine).join('\n') }) },
            ],
        });
        const callOf = (Array.isArray(answer?.toolCalls) ? answer.toolCalls : []).find(item => item?.name === 'cast') ?? answer?.toolCalls?.[0];
        let args = {};
        try { args = typeof callOf?.arguments === 'string' ? JSON.parse(callOf.arguments) : (callOf?.arguments ?? {}); } catch { args = {}; }
        const wanted = (Array.isArray(args.present) ? args.present : []).map(name => text(name).toLowerCase());
        const present = names.filter(name => wanted.includes(name.toLowerCase()));
        if (!present.length) return [];
        await store.saveRoster({ active: present });
        await banks.noteRosterAdded?.(present).catch(() => null);
        publishEvent('decision.cast', { present });
        return present;
    }
    return { castIfEmpty };
}
