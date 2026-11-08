import { applyEdit } from '../../libraries/core/text-diff.js';
import { renderPart, parsePart, editsForPart } from '../../libraries/core/court-bank-files.js';

/**
 * Файловый слой движка (часть 21): всё, что меняют модели, — виртуальные файлы,
 * те же, что пользователь видит во вкладке «Files». `view` — список и текст,
 * `edit` — правки `old → new` (несколько, в нескольких файлах), `create` — новый
 * файл. Без отказов: путь, имя и строка ищутся мягко, не найденное дописывается.
 * Свои файлы подключают поставщики (`addProvider`) — так встанет Creation Бога.
 */
const PARTS = Object.freeze({ material: 'material', spiritual: 'spiritual', decree: 'decree', card: 'card' });
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

export function createFileLayer({ banks = null } = {}) {
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

    async function list() {
        const files = [];
        for (const character of Object.values(await characters())) {
            if (!character?.name) continue;
            for (const part of ['material', 'spiritual', 'decree']) files.push(`Characters/${character.name}/${part}.md`);
        }
        for (const provider of providers) files.push(...(await provider.list()));
        return files;
    }

    async function read(path) {
        for (const provider of providers) if (provider.owns(path)) return provider.read(path);
        const target = parseCharacterPath(path);
        const character = target ? await findCharacter(target.name) : null;
        if (!character) return { ok: false, error: `There is no file "${path}". Call view without a path to list the files.` };
        const text = target.part === 'card' ? String(character.fallbackText ?? '') : renderPart(character, target.part);
        return { ok: true, path: `Characters/${character.name}/${target.part}.md`, text };
    }

    async function write(path, before, after, { comment = '', by = 'director' } = {}) {
        for (const provider of providers) if (provider.owns(path)) return provider.write(path, after, { comment, by });
        const target = parseCharacterPath(path);
        if (!target || target.part === 'card') return { ok: false, error: `"${path}" cannot be written.` };
        const character = await findCharacter(target.name);
        const name = character?.name ?? clean(target.name);
        if (target.part === 'decree') return great().writeDecree({ character: name, sections: parsePart(after, 'decree'), comment, by });
        return great().edit({ comment, edits: editsForPart(name, target.part, before, after) }, { by });
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
        const results = [];
        for (const [path, list] of byPath) {
            const current = await read(path);
            const target = parseCharacterPath(path);
            const before = current.ok ? current.text : (target ? renderPart({}, target.part) : '');
            let after = before;
            const how = [];
            for (const one of list) { const applied = applyEdit(after, one); after = applied.text; how.push(applied.how); }
            const written = after === before ? { ok: true, unchanged: true } : await write(current.path ?? path, before, after, { comment, by });
            results.push({ path: current.path ?? path, ok: written.ok !== false, applied: how, ...(written.error ? { error: written.error } : {}), ...(written.unchanged ? { unchanged: true } : {}) });
        }
        return { ok: true, files: results };
    }

    async function create({ path = '', text = '', comment = '' } = {}, { by = 'director' } = {}) {
        for (const provider of providers) if (provider.owns(path)) return provider.create ? provider.create(path, text, { comment, by }) : provider.write(path, text, { comment, by });
        const target = parseCharacterPath(path);
        if (!target) return { ok: false, error: `"${path}" is not a place for a file. Character files are Characters/<Name>/material.md, spiritual.md or decree.md.` };
        const current = await read(path);
        const before = current.ok ? current.text : renderPart({}, target.part);
        return write(path, before, String(text ?? ''), { comment, by });
    }

    function addProvider(provider) { providers.push(provider); }

    return { list, read, edit, create, addProvider };
}
