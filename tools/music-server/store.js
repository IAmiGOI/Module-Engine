import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Каталог сервера: разделы, группы и треки в одном `catalog.json`, аудио — файлами `audio/<id>.<ext>`. Запись атомарная (временный файл → rename), изменения идут
 * по одному в очереди: две правки одновременно не затрут друг друга. Теги пишет владелец; вектор считается из тега при загрузке и правке (`embed`).
 *
 * Два режима раздела (выбирает владелец, пользователь ME о них не знает):
 *  - `tracks` — у каждого трека свой тег и вектор, подбор идёт по отдельным трекам;
 *  - `groups` — тег и вектор есть у ГРУППЫ («любовные сцены», «бой»…), у треков внутри тегов нет; подбор выбирает группу, а трек в ней — по очереди.
 */

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const randomId = () => crypto.randomBytes(5).toString('hex');
export const AUDIO_EXT = /^(mp3|ogg|oga|opus|m4a|aac|wav|flac|weba)$/i;
export const MODES = Object.freeze({ TRACKS: 'tracks', GROUPS: 'groups' });
const cleanMode = value => (value === MODES.GROUPS ? MODES.GROUPS : MODES.TRACKS);

export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

/** Накал музыки 1 (тихо) … 3 (напряжённо); пусто — не задан, на выбор не влияет. */
const cleanIntensity = value => (Number(value) >= 1 && Number(value) <= 3 ? Math.round(Number(value)) : null);
const MIN_EXAMPLE_LENGTH = 10, MAX_EXAMPLE_LENGTH = 2000, MAX_EXAMPLES_PER_CALL = 200;
const notFound = what => { throw new HttpError(404, `нет такого ${what}`); };
const needName = name => String(name ?? '').trim() || (() => { throw new HttpError(400, 'нужно название'); })();

export async function openStore({ dir, embed, embedQuery = embed }) {
    const file = path.join(dir, 'catalog.json');
    const audioDir = path.join(dir, 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    let data = { sections: [], groups: [], tracks: [], examples: [], patterns: [] };
    try { data = { ...data, ...JSON.parse(await fs.readFile(file, 'utf8')) }; } catch { /* первый запуск */ }

    let queue = Promise.resolve();
    /** Изменения идут по одному; ошибка одного не ломает очередь. */
    const exclusive = job => { const run = queue.then(job); queue = run.catch(() => {}); return run; };
    async function save() {
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
        await fs.rename(`${file}.tmp`, file);
    }

    const section = id => data.sections.find(item => item.id === id);
    const group = id => data.groups.find(item => item.id === id);
    const track = id => data.tracks.find(item => item.id === id);
    const needSection = id => section(id) ?? notFound('раздела');
    const audioPath = item => path.join(audioDir, `${item.id}.${item.ext}`);
    const modeOf = id => cleanMode(section(id)?.mode);

    /** Группа должна лежать в разделе режима `groups`; пустое значение — «без группы». */
    function checkGroup(sectionId, groupId) {
        if (!groupId) return null;
        const found = group(groupId);
        if (!found || found.section !== sectionId) throw new HttpError(400, 'такой группы нет в этом разделе');
        return found.id;
    }

    /** Играющие треки раздела: в `tracks` — с вектором; в `groups` — из группы, у которой есть вектор. Остальные молчат. */
    const playable = id => data.tracks.filter(item => item.section === id && (modeOf(id) === MODES.GROUPS ? Array.isArray(group(item.group)?.vector) : Array.isArray(item.vector)));

    /** Новый вектор для текстового поля (`description` → `vector`, `negative` → `negVector`); не пересчитывается, если текст не менялся. */
    async function reembed(item, textField, vectorField, value) {
        const text = String(value ?? '').trim();
        if (text !== (item[textField] ?? '') || (text && !item[vectorField])) item[vectorField] = text ? await embed(text) : null;
        item[textField] = text;
    }

    /** Трек для выбора: в групповом разделе и вектор, и «когда НЕ включать» — группы. */
    const itemFor = (id, item) => {
        const owner = modeOf(id) === MODES.GROUPS ? group(item.group) : item;
        return { id: item.id, ext: item.ext, group: item.group ?? null, vector: owner.vector, negVector: owner.negVector ?? null, statement: owner.description, intensity: owner.intensity ?? null };
    };


    /** Узлы паттернов раздела (дерево: `parent` — id родителя или `null` у корня). Шаг — группа или конкретный трек, играет по порядку веток. */
    const patternNodes = sectionId => data.patterns.filter(item => item.section === sectionId);
    const patternNode = id => data.patterns.find(item => item.id === id);
    const subtreeIds = id => {
        const ids = new Set([id]);
        for (let grew = true; grew;) {
            grew = false;
            for (const node of data.patterns) if (node.parent && ids.has(node.parent) && !ids.has(node.id)) { ids.add(node.id); grew = true; }
        }
        return ids;
    };
    /** Шаг ссылается на существующую группу (в групповом разделе) или трек этого же раздела. */
    function checkStep(sectionId, kind, ref) {
        if (kind === 'group') {
            if (modeOf(sectionId) !== MODES.GROUPS) throw new HttpError(400, 'шаг-группа бывает только в разделе «по группам»');
            return checkGroup(sectionId, ref) ?? (() => { throw new HttpError(400, 'выберите группу'); })();
        }
        if (kind === 'track') {
            const found = track(ref);
            if (!found || found.section !== sectionId) throw new HttpError(400, 'такого трека нет в этом разделе');
            return found.id;
        }
        throw new HttpError(400, 'шаг — это группа или трек');
    }
    const usedByPattern = (kind, id) => data.patterns.some(node => node.kind === kind && node.ref === id);

    return {
        audioPath,
        track,

        /** Публичный каталог: только разделы, где есть хотя бы один играющий трек. Названий и текста тегов здесь нет. */
        publicSections: () => data.sections.map(item => ({ id: item.id, name: item.name, tracks: playable(item.id).length })).filter(item => item.tracks > 0),
        publicSection: id => {
            const found = section(id);
            if (!found) return null;
            const tracks = playable(id);
            if (modeOf(id) !== MODES.GROUPS) return { name: found.name, mode: MODES.TRACKS, tracks: tracks.map(item => ({ id: item.id, ext: item.ext, v: item.vector })) };
            const used = new Set(tracks.map(item => item.group));
            return {
                name: found.name, mode: MODES.GROUPS,
                groups: data.groups.filter(item => item.section === id && used.has(item.id)).map(item => ({ id: item.id, v: item.vector })),
                tracks: tracks.map(item => ({ id: item.id, ext: item.ext, g: item.group })),
            };
        },

        /** Играющие треки раздела для выбора на сервере: `{ id, ext, vector, group }` (в групповом разделе вектор — группы). */
        pickItems: id => playable(id).map(item => itemFor(id, item)),
        /** Для проверки подбора в консоли: то же, что `pickItems`, плюс названия (их видит только владелец). */
        previewItems: id => playable(id).map(item => ({ ...itemFor(id, item), title: item.title, groupName: group(item.group)?.name ?? null })),
        /** Играет ли трек (и значит, отдаётся ли его аудио чужим): в групповом разделе — если у его группы есть тег. */
        isPlayable: id => { const item = track(id); return Boolean(item) && (playable(item.section).includes(item) || usedByPattern('track', item.id) || (item.group && usedByPattern('group', item.group))); },
        /** Все треки раздела для шагов паттернов (тег у трека не обязателен: шаг сам решает, когда он играет). */
        sectionTracks: id => data.tracks.filter(item => item.section === id).map(item => ({ id: item.id, ext: item.ext, group: item.group ?? null })),
        hasSection: id => Boolean(section(id)),

        /** Всё для консоли владельца (с тегами, без векторов). */
        /** Словарь эталонных сцен группы раздела: вектор считается как у сцены (`query:`), чтобы сравнивать прозу с прозой. */
        addExamples: ({ sectionId, groupId, texts }) => exclusive(async () => {
            needSection(sectionId);
            if (modeOf(sectionId) !== MODES.GROUPS) throw new HttpError(400, 'эталонные сцены бывают только в разделе «по группам»');
            if (!checkGroup(sectionId, groupId)) throw new HttpError(400, 'выберите группу');
            const clean = [...new Set((Array.isArray(texts) ? texts : []).map(text => String(text ?? '').trim()).filter(text => text.length >= MIN_EXAMPLE_LENGTH))].slice(0, MAX_EXAMPLES_PER_CALL).map(text => text.slice(0, MAX_EXAMPLE_LENGTH));
            if (!clean.length) throw new HttpError(400, `нужен хотя бы один текст сцены (от ${MIN_EXAMPLE_LENGTH} знаков)`);
            const known = new Set(data.examples.filter(item => item.group === groupId).map(item => item.text));
            let added = 0;
            for (const text of clean) {
                if (known.has(text)) continue;
                data.examples.push({ id: randomId(), section: sectionId, group: groupId, text, vector: await embedQuery(text), createdAt: Date.now() });
                added += 1;
            }
            await save();
            return { added, skipped: clean.length - added };
        }),

        deleteExample: id => exclusive(async () => {
            if (!data.examples.some(item => item.id === id)) notFound('эталона');
            data.examples = data.examples.filter(item => item.id !== id);
            await save();
        }),

        /** Эталонные сцены раздела для выбора: группа → векторы. Наружу (публичные ответы) не уходят никогда. */
        prototypesFor: id => {
            const map = new Map();
            for (const item of data.examples) if (item.section === id) { const list = map.get(item.group) ?? []; list.push(item.vector); map.set(item.group, list); }
            return map;
        },


        /**
         * Паттерны: порядок проигрыша групп/треков. Это дерево — общее начало, дальше любые ветки и под-ветки на любую глубину. У узла может быть свой тег
         * («когда уместно», «когда НЕ уместно»): по нему выбирается вход в паттерн и ветка на развилке. Вектор считается как у тега группы.
         */
        patternNodes: id => patternNodes(id).map(node => ({ ...node })),
        addPatternNode: ({ sectionId, parent = null, kind, ref, name, description, negative }) => exclusive(async () => {
            needSection(sectionId);
            if (parent) { const up = patternNode(parent); if (!up || up.section !== sectionId) throw new HttpError(400, 'такого родителя нет в этом разделе'); }
            const text = String(description ?? '').trim();
            const node = { id: randomId(), section: sectionId, parent: parent || null, kind, ref: checkStep(sectionId, kind, ref), name: String(name ?? '').trim(), description: text, vector: text ? await embed(text) : null, negative: '', negVector: null, order: data.patterns.filter(item => item.section === sectionId && item.parent === (parent || null)).length };
            if (negative) await reembed(node, 'negative', 'negVector', negative);
            data.patterns.push(node);
            await save();
            return node;
        }),
        /** Правка узла: имя, теги, шаг (`kind` + `ref`), перенос под другого родителя (`parent`: id или `null` — в корень; в свою же ветку нельзя). */
        updatePatternNode: (id, patch) => exclusive(async () => {
            const node = patternNode(id) ?? notFound('шага паттерна');
            if (patch.name !== undefined) node.name = String(patch.name ?? '').trim();
            if (patch.description !== undefined) await reembed(node, 'description', 'vector', patch.description);
            if (patch.negative !== undefined) await reembed(node, 'negative', 'negVector', patch.negative);
            if (patch.kind !== undefined || patch.ref !== undefined) {
                const kind = patch.kind ?? node.kind;
                node.ref = checkStep(node.section, kind, patch.ref ?? node.ref);
                node.kind = kind;
            }
            if (patch.parent !== undefined) {
                const parent = patch.parent || null;
                if (parent) {
                    const up = patternNode(parent);
                    if (!up || up.section !== node.section) throw new HttpError(400, 'такого родителя нет в этом разделе');
                    if (subtreeIds(id).has(parent)) throw new HttpError(400, 'нельзя перенести шаг в собственную ветку');
                }
                node.parent = parent;
            }
            if (Number.isFinite(patch.order)) node.order = patch.order;
            await save();
            return node;
        }),
        /** Удаляется шаг вместе со всей веткой под ним. */
        deletePatternNode: id => exclusive(async () => {
            patternNode(id) ?? notFound('шага паттерна');
            const gone = subtreeIds(id);
            data.patterns = data.patterns.filter(node => !gone.has(node.id));
            await save();
            return { removed: gone.size };
        }),

        adminCatalog: () => ({
            patterns: data.patterns.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
            examples: data.examples.map(({ vector, ...rest }) => rest),
            sections: data.sections.map(item => ({ ...item, mode: cleanMode(item.mode) })),
            groups: data.groups.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
            tracks: data.tracks.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
        }),

        addSection: (name, mode) => exclusive(async () => {
            const clean = needName(name);
            let id = slug(clean) || `s-${randomId()}`;
            while (section(id)) id = `${slug(clean) || 's'}-${randomId().slice(0, 4)}`;
            const created = { id, name: clean, mode: cleanMode(mode) };
            data.sections.push(created);
            await save();
            return created;
        }),

        renameSection: (id, name) => exclusive(async () => {
            const found = needSection(id);
            found.name = needName(name);
            await save();
            return found;
        }),

        /**
         * Граф переходов раздела (рисует владелец на холсте): `nodes` — положения групп и пометка «резкая» (в неё можно прыгнуть откуда угодно), `edges` — пары групп,
         * между которыми музыка переходит свободно. Чужие id, петли и повторы отбрасываются; пустой граф стирается.
         */
        setGraph: (id, graph) => exclusive(async () => {
            const found = needSection(id);
            const ids = new Set(data.groups.filter(item => item.section === id).map(item => item.id));
            const coord = value => (Number.isFinite(value) ? Math.max(0, Math.min(1000, value)) : 0);
            const nodes = {};
            for (const [key, node] of Object.entries(graph?.nodes ?? {})) if (ids.has(key)) nodes[key] = { x: coord(node?.x), y: coord(node?.y), sharp: node?.sharp === true };
            const seen = new Set(), edges = [];
            for (const pair of Array.isArray(graph?.edges) ? graph.edges : []) {
                const [a, b] = Array.isArray(pair) ? pair.map(String) : [];
                if (!ids.has(a) || !ids.has(b) || a === b) continue;
                const key = [a, b].sort().join('|');
                if (!seen.has(key)) { seen.add(key); edges.push([a, b]); }
            }
            if (edges.length || Object.values(nodes).some(node => node.sharp)) found.graph = { nodes, edges }; else delete found.graph;
            await save();
            return found;
        }),

        /** Для подбора: `{ edges: Set('a|b' по возрастанию), sharp: Set, linked: Set }`; `null` — графа нет. */
        graphOf: id => {
            const graph = section(id)?.graph;
            if (!graph) return null;
            const edges = new Set(graph.edges.map(([a, b]) => [a, b].sort().join('|')));
            const linked = new Set(graph.edges.flat());
            const sharp = new Set(Object.entries(graph.nodes).filter(([, node]) => node.sharp).map(([key]) => key));
            return { edges, sharp, linked };
        },

        /** Непустой раздел не удаляется: случайно потерять десятки размеченных треков слишком дорого. Пустые группы уходят вместе с ним. */
        deleteSection: id => exclusive(async () => {
            needSection(id);
            if (data.tracks.some(item => item.section === id)) throw new HttpError(409, 'в разделе есть треки — сначала перенесите или удалите их');
            data.sections = data.sections.filter(item => item.id !== id);
            data.patterns = data.patterns.filter(item => item.section !== id);
            data.groups = data.groups.filter(item => item.section !== id);
            data.examples = data.examples.filter(item => item.section !== id);
            await save();
        }),

        addGroup: ({ sectionId, name, description, negative }) => exclusive(async () => {
            if (modeOf(needSection(sectionId).id) !== MODES.GROUPS) throw new HttpError(400, 'группы бывают только в разделе «по группам»');
            const text = String(description ?? '').trim();
            const item = { id: randomId(), section: sectionId, name: needName(name), description: text, vector: text ? await embed(text) : null, negative: '', negVector: null };
            if (negative) await reembed(item, 'negative', 'negVector', negative);
            data.groups.push(item);
            await save();
            return item;
        }),

        /** Правка группы: переименование и/или новый тег (вектор пересчитывается — это сразу меняет, когда играют её треки). */
        updateGroup: (id, patch) => exclusive(async () => {
            const item = group(id) ?? notFound('группы');
            if (patch.name !== undefined) item.name = needName(patch.name);
            if (patch.description !== undefined) await reembed(item, 'description', 'vector', patch.description);
            if (patch.negative !== undefined) await reembed(item, 'negative', 'negVector', patch.negative);
            if (patch.intensity !== undefined) item.intensity = cleanIntensity(patch.intensity);
            await save();
            return item;
        }),

        deleteGroup: id => exclusive(async () => {
            group(id) ?? notFound('группы');
            if (data.tracks.some(item => item.group === id)) throw new HttpError(409, 'в группе есть треки — сначала перенесите их');
            if (usedByPattern('group', id)) throw new HttpError(409, 'группа используется в паттерне — сначала уберите её оттуда');
            data.groups = data.groups.filter(item => item.id !== id);
            data.examples = data.examples.filter(item => item.group !== id);   // эталоны уходят вместе с группой
            await save();
        }),

        /** Новый трек: байты уже лежат во временном файле `tmpFile`. Без тега (режим `tracks`) или без группы (режим `groups`) трек молчит. */
        addTrack: ({ sectionId, groupId, title, description, ext, tmpFile }) => exclusive(async () => {
            needSection(sectionId);
            if (!AUDIO_EXT.test(ext)) throw new HttpError(400, 'нужен аудиофайл: mp3, ogg, m4a, flac, wav…');
            const grouped = modeOf(sectionId) === MODES.GROUPS;
            const text = grouped ? '' : String(description ?? '').trim();   // у трека в группе собственного тега нет
            const item = { id: randomId(), section: sectionId, group: grouped ? checkGroup(sectionId, groupId) : null, ext: ext.toLowerCase(), title: String(title ?? '').trim() || 'Без названия', description: text, vector: text ? await embed(text) : null, createdAt: Date.now() };
            await fs.rename(tmpFile, audioPath(item));
            data.tracks.push(item);
            await save();
            return item;
        }),

        updateTrack: (id, patch) => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            if (patch.section !== undefined && patch.section !== item.section) {
                if (usedByPattern('track', id)) throw new HttpError(409, 'трек используется в паттерне — сначала уберите его оттуда');
                item.section = needSection(patch.section).id;
                item.group = null;   // группа осталась в старом разделе
            }
            if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
            if (patch.group !== undefined) item.group = modeOf(item.section) === MODES.GROUPS ? checkGroup(item.section, patch.group) : null;
            if (patch.intensity !== undefined && modeOf(item.section) !== MODES.GROUPS) item.intensity = cleanIntensity(patch.intensity);
            if (modeOf(item.section) !== MODES.GROUPS) {
                if (patch.description !== undefined) await reembed(item, 'description', 'vector', patch.description);
                if (patch.negative !== undefined) await reembed(item, 'negative', 'negVector', patch.negative);
            }
            await save();
            return item;
        }),

        deleteTrack: id => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            if (usedByPattern('track', id)) throw new HttpError(409, 'трек используется в паттерне — сначала уберите его оттуда');
            data.tracks = data.tracks.filter(other => other.id !== id);
            await save();
            await fs.rm(audioPath(item), { force: true });
        }),
    };
}
