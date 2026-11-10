import { applyEdit } from '../../libraries/core/text-diff.js';
import { renderPart, renderPsyche, parsePart, editsForPart } from '../../libraries/core/court-bank-files.js';
import { knowledgeKey } from '../../libraries/core/decision-knowledge.js';
import { isUserCharacter, USER_CHARACTER_NOTE } from '../../libraries/core/decision-great-bank.js';

/**
 * Файловый слой движка (часть 21): всё, что меняют модели, — виртуальные файлы,
 * те же, что пользователь видит во вкладке «Files». `view` — список и текст,
 * `edit` — правки `old → new` (несколько, в нескольких файлах), `create` — новый
 * файл. Без отказов: путь, имя и строка ищутся мягко, не найденное дописывается.
 * Свои файлы подключают поставщики (`addProvider`) — так встанет Creation Бога.
 */
const PARTS = Object.freeze({ material: 'material', spiritual: 'spiritual', decree: 'decree', psyche: 'psyche', knowledge: 'knowledge', card: 'card' });
const lineBodies = value => String(value ?? '').split('\n').map(line => line.replace(/^\s*[-*]\s+/, '').trim()).filter(line => line && !line.startsWith('#'));
const clean = value => String(value ?? '').trim();

export function parseCharacterPath(path) {
    const parts = clean(path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').split('/').filter(Boolean);
    if (!parts.length) return null;
    const head = parts[0].toLowerCase();
    const rest = head === 'characters' || head === 'character' ? parts.slice(1) : parts;
    if (rest.length < 2) return null;
    const part = PARTS[rest.at(-1).toLowerCase()] ?? null;
    return part ? { name: rest.slice(0, -1).join('/'), part } : null;
}

export function createFileLayer({ banks = null, knowledge = null, beforeWrite = null } = {}) {
    const providers = [];
    const great = () => banks?.great ?? null;

    async function characters() {
        const g = great();
        if (!g) return {};
        await g.sync?.();
        return (await g.load?.()) ?? {};
    }

    async function findCharacter(name) {
        const state = await characters();
        const key = clean(name).toLowerCase();
        const all = Object.values(state);
        return all.find(item => clean(item.name).toLowerCase() === key)
            ?? all.find(item => (item.aliases ?? []).some(alias => clean(alias).toLowerCase() === key))
            ?? all.find(item => clean(item.name).toLowerCase().includes(key) || key.includes(clean(item.name).toLowerCase()))
            ?? null;
    }

    async function knowledgeItems(name) {
        const state = knowledge?.load ? await knowledge.load() : {};
        return (state?.[knowledgeKey(name)]?.items ?? []).filter(item => item.status === 'known');
    }

    async function knowledgeText(name) {
        const items = await knowledgeItems(name);
        return items.length ? items.map(item => `- ${item.fact}`).join('\n') : '';
    }

    /** knowledge.md: новая строка — знание, убранная — забыто, заменённая — пересмотрено (старое остаётся «used to believe»). */
    async function writeKnowledge(name, before, after, comment) {
        const tool = knowledge?.handlers?.character_knowledge;
        if (!tool) return { ok: false, error: 'Knowledge is not available here.' };
        const items = await knowledgeItems(name);
        const was = lineBodies(before);
        const now = lineBodies(after);
        const removed = was.filter(line => !now.includes(line));
        const added = now.filter(line => !was.includes(line));
        const idOf = fact => items.find(item => item.fact === fact)?.id;
        while (removed.length && added.length) {
            const id = idOf(removed.shift());
            const fact = added.shift();
            await tool(id ? { op: 'revise', character: name, id, fact, comment } : { op: 'add', character: name, fact, source: 'saw', comment });
        }
        for (const fact of added) await tool({ op: 'add', character: name, fact, source: 'saw', comment });
        for (const line of removed) { const id = idOf(line); if (id) await tool({ op: 'forget', character: name, id, comment }); }
        return { ok: true };
    }

    async function list() {
        const files = [];
        for (const character of Object.values(await characters())) {
            if (!character?.name) continue;
            // psyche.md появляется в списке, когда Психолог его написал: до этого файла нет.
            const parts = ['material', 'spiritual', 'decree', ...(Array.isArray(character.psyche) && character.psyche.length ? ['psyche'] : []), ...(knowledge ? ['knowledge'] : [])];
            for (const part of parts) files.push(`Characters/${character.name}/${part}.md`);
        }
        for (const provider of providers) files.push(...(await provider.list()));
        return files;
    }

    async function read(path) {
        for (const provider of providers) if (provider.owns(path)) return provider.read(path);
        const target = parseCharacterPath(path);
        const character = target ? await findCharacter(target.name) : null;
        if (!character) return { ok: false, error: `There is no file "${path}". Call view without a path to list the files.` };
        const text = target.part === 'card' ? String(character.fallbackText ?? '')
            : target.part === 'knowledge' ? await knowledgeText(character.name)
                : target.part === 'psyche' ? renderPsyche(character)
                    : renderPart(character, target.part);
        return { ok: true, path: `Characters/${character.name}/${target.part}.md`, text };
    }

    async function write(path, before, after, { comment = '', by = 'director' } = {}) {
        for (const provider of providers) if (provider.owns(path)) return provider.write(path, after, { comment, by, before });
        const target = parseCharacterPath(path);
        if (!target || target.part === 'card') return { ok: false, error: `"${path}" cannot be written.` };
        const character = await findCharacter(target.name);
        const name = character?.name ?? clean(target.name);
        // psyche.md — файл Психолога: читать можно, править нельзя (как Указ персонажа пользователя).
        if (target.part === 'psyche') return { ok: false, error: `${name}'s psyche.md is written by the Psychologist and cannot be changed here.` };
        if (target.part === 'knowledge') return writeKnowledge(name, before, after, comment);
        // Указ пишет только Director: правка резолвера не отклоняется, а остаётся без записи с пояснением.
        if (target.part === 'decree' && by === 'resolver') return { ok: true, unchanged: true, note: 'Only the Director writes the Decree — tell it in the outcome instead.' };
        if (target.part === 'decree' && isUserCharacter(character)) return { ok: false, error: `${name} ${USER_CHARACTER_NOTE}` };
        if (target.part === 'decree') return great().writeDecree({ character: name, sections: parsePart(after, 'decree'), comment, by });
        const result = await great().edit({ comment, edits: editsForPart(name, target.part, before, after) }, { by });
        // material.md и spiritual.md готовы — Психолог пишет psyche.md, не дожидаясь следующего хода.
        if (target.part === 'material' || target.part === 'spiritual') {
            if (typeof banks?.ensurePsyche === 'function') banks.ensurePsyche().catch(() => {});
        }
        return result;
    }

    /** Правки по файлам: каждая — к тексту, каким он стал после предыдущих правок того же файла. */
    async function edit({ edits = [], comment = '' } = {}, { by = 'director' } = {}) {
        const byPath = new Map();
        for (const item of Array.isArray(edits) ? edits : []) {
            const path = clean(item?.path ?? item?.file);
            if (!path) continue;
            if (!byPath.has(path)) byPath.set(path, []);
            byPath.get(path).push({ old: String(item?.old ?? ''), new: String(item?.new ?? '') });
        }
        // Сначала весь предлагаемый текст, потом запись: возражение Психолога не применяет вызов целиком.
        const planned = [];
        for (const [path, list] of byPath) {
            const current = await read(path);
            const target = parseCharacterPath(path);
            const before = current.ok ? current.text : (target && target.part !== 'knowledge' && target.part !== 'psyche' ? renderPart({}, target.part) : '');
            let after = before;
            const how = [];
            for (const one of list) { const applied = applyEdit(after, one); after = applied.text; how.push(applied.how); }
            planned.push({ path: current.path ?? path, target, before, after, how, unchanged: after === before });
        }
        if (typeof beforeWrite === 'function') {
            for (const item of planned) {
                if (item.unchanged || !item.target) continue;
                // Имя из пути может быть псевдонимом: проверяем по тому, кем персонаж записан в банке.
                const canonical = parseCharacterPath(item.path) ?? item.target;
                const refusal = await beforeWrite({ path: item.path, target: canonical, before: item.before, after: item.after, comment, by });
                if (refusal?.ok === false) return { ok: false, error: refusal.error, ...(refusal.speaker ? { speaker: refusal.speaker } : {}), refused: item.path };
            }
        }
        const results = [];
        for (const item of planned) {
            const written = item.unchanged ? { ok: true, unchanged: true } : await write(item.path, item.before, item.after, { comment, by });
            results.push({ path: item.path, ok: written.ok !== false, applied: item.how, ...(written.error ? { error: written.error } : {}), ...(written.unchanged ? { unchanged: true } : {}), ...(written.note ? { note: written.note } : {}) });
        }
        return { ok: true, files: results };
    }

    async function create({ path = '', text = '', comment = '' } = {}, { by = 'director' } = {}) {
        for (const provider of providers) if (provider.owns(path)) return provider.create ? provider.create(path, text, { comment, by }) : provider.write(path, String(text ?? ''), { comment, by });
        const target = parseCharacterPath(path);
        if (!target) return { ok: false, error: `"${path}" is not a place for a file. Character files are Characters/<Name>/material.md, spiritual.md or decree.md.` };
        const current = await read(path);
        const before = current.ok ? current.text : (target.part === 'psyche' ? '' : renderPart({}, target.part));
        const after = String(text ?? '');
        if (typeof beforeWrite === 'function' && after !== before) {
            const canonical = (current.ok ? parseCharacterPath(current.path) : null) ?? target;
            const refusal = await beforeWrite({ path: current.path ?? path, target: canonical, before, after, comment, by });
            if (refusal?.ok === false) return { ok: false, error: refusal.error, ...(refusal.speaker ? { speaker: refusal.speaker } : {}), refused: current.path ?? path };
        }
        return write(path, before, after, { comment, by });
    }

    function addProvider(provider) { providers.push(provider); }

    return { list, read, write, edit, create, addProvider };
}
