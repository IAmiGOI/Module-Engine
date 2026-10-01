import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Каталог сервера: разделы и треки в одном `catalog.json`, аудио — файлами `audio/<id>.<ext>`. Запись атомарная (временный файл → rename), изменения идут
 * по одному в очереди: две правки одновременно не затрут друг друга. Теги (`description`) пишет владелец; вектор считается из них при загрузке и правке (`embed`).
 */

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const randomId = () => crypto.randomBytes(5).toString('hex');
export const AUDIO_EXT = /^(mp3|ogg|oga|opus|m4a|aac|wav|flac|weba)$/i;

export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const notFound = what => { throw new HttpError(404, `нет такого ${what}`); };

export async function openStore({ dir, embed }) {
    const file = path.join(dir, 'catalog.json');
    const audioDir = path.join(dir, 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    let data = { sections: [], tracks: [] };
    try { data = { ...data, ...JSON.parse(await fs.readFile(file, 'utf8')) }; } catch { /* первый запуск */ }

    let queue = Promise.resolve();
    /** Изменения идут по одному; ошибка одного не ломает очередь. */
    const exclusive = job => { const run = queue.then(job); queue = run.catch(() => {}); return run; };
    async function save() {
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
        await fs.rename(`${file}.tmp`, file);
    }

    const section = id => data.sections.find(item => item.id === id);
    const track = id => data.tracks.find(item => item.id === id);
    const needSection = id => section(id) ?? notFound('раздела');
    const audioPath = item => path.join(audioDir, `${item.id}.${item.ext}`);
    const publicTracks = id => data.tracks.filter(item => item.section === id && Array.isArray(item.vector));

    return {
        audioPath,
        track,

        /** Публичный каталог: только разделы, где есть хотя бы один размеченный трек. Текста тегов здесь нет. */
        publicSections: () => data.sections.map(item => ({ id: item.id, name: item.name, tracks: publicTracks(item.id).length })).filter(item => item.tracks > 0),
        publicSection: id => {
            const found = section(id);
            return found ? { name: found.name, tracks: publicTracks(id).map(item => ({ id: item.id, ext: item.ext, v: item.vector })) } : null;
        },

        /** Всё для консоли владельца (с тегами, без векторов). */
        adminCatalog: () => ({ sections: data.sections, tracks: data.tracks.map(({ vector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })) }),

        addSection: name => exclusive(async () => {
            const clean = String(name ?? '').trim();
            if (!clean) throw new HttpError(400, 'у раздела должно быть название');
            let id = slug(clean) || `s-${randomId()}`;
            while (section(id)) id = `${slug(clean) || 's'}-${randomId().slice(0, 4)}`;
            data.sections.push({ id, name: clean });
            await save();
            return { id, name: clean };
        }),

        renameSection: (id, name) => exclusive(async () => {
            const found = needSection(id);
            const clean = String(name ?? '').trim();
            if (!clean) throw new HttpError(400, 'у раздела должно быть название');
            found.name = clean;
            await save();
            return found;
        }),

        /** Непустой раздел не удаляется: случайно потерять десятки размеченных треков слишком дорого. */
        deleteSection: id => exclusive(async () => {
            needSection(id);
            if (data.tracks.some(item => item.section === id)) throw new HttpError(409, 'в разделе есть треки — сначала перенесите или удалите их');
            data.sections = data.sections.filter(item => item.id !== id);
            await save();
        }),

        /** Новый трек: байты уже лежат во временном файле `tmpFile`. Без тега трек молчит (вектора нет), пока владелец его не напишет. */
        addTrack: ({ sectionId, title, description, ext, tmpFile }) => exclusive(async () => {
            needSection(sectionId);
            if (!AUDIO_EXT.test(ext)) throw new HttpError(400, 'нужен аудиофайл: mp3, ogg, m4a, flac, wav…');
            const item = { id: randomId(), section: sectionId, ext: ext.toLowerCase(), title: String(title ?? '').trim() || 'Без названия', description: String(description ?? '').trim(), vector: null, createdAt: Date.now() };
            if (item.description) item.vector = await embed(item.description);
            await fs.rename(tmpFile, audioPath(item));
            data.tracks.push(item);
            await save();
            return item;
        }),

        updateTrack: (id, patch) => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            if (patch.section !== undefined) item.section = needSection(patch.section).id;
            if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
            if (patch.description !== undefined) {
                const description = String(patch.description).trim();
                if (description !== item.description || !item.vector) item.vector = description ? await embed(description) : null;
                item.description = description;
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
