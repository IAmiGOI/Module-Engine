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

const notFound = what => { throw new HttpError(404, `нет такого ${what}`); };
const needName = name => String(name ?? '').trim() || (() => { throw new HttpError(400, 'нужно название'); })();

export async function openStore({ dir, embed }) {
    const file = path.join(dir, 'catalog.json');
    const audioDir = path.join(dir, 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    let data = { sections: [], groups: [], tracks: [] };
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

    function embedIfChanged(item, description) {
        const text = String(description).trim();
        return text !== item.description || !item.vector ? (text ? embed(text) : Promise.resolve(null)) : Promise.resolve(item.vector);
    }

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
        pickItems: id => playable(id).map(item => ({ id: item.id, ext: item.ext, group: item.group ?? null, vector: modeOf(id) === MODES.GROUPS ? group(item.group).vector : item.vector })),
        hasSection: id => Boolean(section(id)),

        /** Всё для консоли владельца (с тегами, без векторов). */
        adminCatalog: () => ({
            sections: data.sections.map(item => ({ ...item, mode: cleanMode(item.mode) })),
            groups: data.groups.map(({ vector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
            tracks: data.tracks.map(({ vector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
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

        /** Непустой раздел не удаляется: случайно потерять десятки размеченных треков слишком дорого. Пустые группы уходят вместе с ним. */
        deleteSection: id => exclusive(async () => {
            needSection(id);
            if (data.tracks.some(item => item.section === id)) throw new HttpError(409, 'в разделе есть треки — сначала перенесите или удалите их');
            data.sections = data.sections.filter(item => item.id !== id);
            data.groups = data.groups.filter(item => item.section !== id);
            await save();
        }),

        addGroup: ({ sectionId, name, description }) => exclusive(async () => {
            if (modeOf(needSection(sectionId).id) !== MODES.GROUPS) throw new HttpError(400, 'группы бывают только в разделе «по группам»');
            const text = String(description ?? '').trim();
            const item = { id: randomId(), section: sectionId, name: needName(name), description: text, vector: text ? await embed(text) : null };
            data.groups.push(item);
            await save();
            return item;
        }),

        /** Правка группы: переименование и/или новый тег (вектор пересчитывается — это сразу меняет, когда играют её треки). */
        updateGroup: (id, patch) => exclusive(async () => {
            const item = group(id) ?? notFound('группы');
            if (patch.name !== undefined) item.name = needName(patch.name);
            if (patch.description !== undefined) {
                item.vector = await embedIfChanged(item, patch.description);
                item.description = String(patch.description).trim();
            }
            await save();
            return item;
        }),

        deleteGroup: id => exclusive(async () => {
            group(id) ?? notFound('группы');
            if (data.tracks.some(item => item.group === id)) throw new HttpError(409, 'в группе есть треки — сначала перенесите их');
            data.groups = data.groups.filter(item => item.id !== id);
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
                item.section = needSection(patch.section).id;
                item.group = null;   // группа осталась в старом разделе
            }
            if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
            if (patch.group !== undefined) item.group = modeOf(item.section) === MODES.GROUPS ? checkGroup(item.section, patch.group) : null;
            if (patch.description !== undefined && modeOf(item.section) !== MODES.GROUPS) {
                item.vector = await embedIfChanged(item, patch.description);
                item.description = String(patch.description).trim();
            }
            await save();
            return item;
        }),

        deleteTrack: id => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            data.tracks = data.tracks.filter(other => other.id !== id);
            await save();
            await fs.rm(audioPath(item), { force: true });
        }),
    };
}
