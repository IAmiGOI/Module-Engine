import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { estimateAlignment, ALIGN_DEFAULTS } from './alignment.js';
import { cleanSceneText, guessNames, normalizeNames } from './scene-text.js';

/**
 * Каталог сервера: пул треков, назначения «трек → раздел/группа», разделы и группы в одном `catalog.json`, аудио — файлами `audio/<id>.<ext>`. Запись атомарная (временный файл → rename), изменения идут
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
const MAX_FEEDBACK = 300, ROUND_VECTOR = 10000;
const MIN_EXAMPLE_LENGTH = 10, MAX_EXAMPLE_LENGTH = 2000, MAX_EXAMPLES_PER_CALL = 200;
const notFound = what => { throw new HttpError(404, `нет такого ${what}`); };
const needName = name => String(name ?? '').trim() || (() => { throw new HttpError(400, 'нужно название'); })();

export async function openStore({ dir, embed, embedQuery = embed }) {
    const file = path.join(dir, 'catalog.json');
    const audioDir = path.join(dir, 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    let data = { sections: [], groups: [], tracks: [], assignments: [], examples: [], patterns: [], feedback: [] };
    try { data = { ...data, ...JSON.parse(await fs.readFile(file, 'utf8')) }; } catch { /* первый запуск */ }

    let queue = Promise.resolve();
    /** Изменения идут по одному; ошибка одного не ломает очередь. */
    const exclusive = job => { const run = queue.then(job); queue = run.catch(() => {}); return run; };
    async function save() {
        await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
        await fs.rename(`${file}.tmp`, file);
    }


    /**
     * Старая схема: трек сам принадлежал одному разделу и одной группе (и нёс тег). Новая: треки лежат в общем ПУЛЕ (файл и название один раз), а раздел/группа/тег живут
     * в НАЗНАЧЕНИИ «трек → раздел/группа». Один трек можно положить в несколько групп и разделов. Старый каталог переезжает один раз и без потерь: каждый трек становится
     * записью пула и одним назначением с тем же разделом, группой и тегом; копия файла до переезда — `catalog.json.pre-pool`.
     */
    async function migrateToPool() {
        const legacy = data.tracks.filter(item => item.section !== undefined);
        if (!legacy.length) return;
        await fs.copyFile(file, `${file}.pre-pool`, fsConstants.COPYFILE_EXCL).catch(() => {});
        for (const item of legacy) {
            data.assignments.push({ id: randomId(), track: item.id, section: item.section, group: item.group ?? null, description: item.description ?? '', vector: item.vector ?? null, negative: item.negative ?? '', negVector: item.negVector ?? null, intensity: item.intensity ?? null, createdAt: item.createdAt ?? Date.now() });
            for (const key of ['section', 'group', 'description', 'vector', 'negative', 'negVector', 'intensity']) delete item[key];
        }
        await save();
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

    const assignment = id => data.assignments.find(item => item.id === id);
    /** Назначение вместе с треком: `id` — трек, `assignment` — само назначение; раздел, группа и теги — из назначения. */
    const rowOf = item => { const found = track(item.track); return found ? { ...item, id: item.track, assignment: item.id, ext: found.ext, title: found.title } : null; };
    const rows = () => data.assignments.map(rowOf).filter(Boolean);
    const rowsIn = sectionId => rows().filter(item => item.section === sectionId);

    /** Играющие треки раздела: в `tracks` — с вектором назначения; в `groups` — из группы, у которой есть вектор. Остальные молчат. */
    const playable = id => rowsIn(id).filter(item => (modeOf(id) === MODES.GROUPS ? Array.isArray(group(item.group)?.vector) : Array.isArray(item.vector)));

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
            if (!found) throw new HttpError(400, 'такого трека нет в пуле');
            return found.id;
        }
        throw new HttpError(400, 'шаг — это группа или трек');
    }

    /** Какие имена вычёркивать из эталонных сцен раздела: названные владельцем + повторяющиеся заглавные слова по всем сценам (эталоны своих участников не помнят). */
    const sceneNames = (sectionId, extraTexts = [], given = []) => normalizeNames([...given, ...guessNames([...data.examples.filter(item => item.section === sectionId).map(item => item.text), ...extraTexts])]);
    const usedByPattern = (kind, id) => data.patterns.some(node => node.kind === kind && node.ref === id);

    await migrateToPool();

    return {
        audioPath,
        track,

        /** Публичный каталог: только разделы, где есть хотя бы один играющий трек. Названий и текста тегов здесь нет. */
        publicSections: () => data.sections.map(item => ({ id: item.id, name: item.name, tracks: new Set(playable(item.id).map(row => row.id)).size })).filter(item => item.tracks > 0),   // разные треки: один и тот же в двух группах — один
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
        /** Отдаётся ли аудио трека чужим: его играет хоть одно назначение (в групповом разделе у группы есть тег), либо он — шаг паттерна (сам или его группа). */
        isPlayable: id => {
            const found = track(id);
            if (!found) return false;
            if (usedByPattern('track', id)) return true;
            return data.assignments.some(item => item.track === id && (playable(item.section).some(row => row.assignment === item.id) || (item.group && usedByPattern('group', item.group))));
        },
        /** Треки для шагов паттернов раздела: все треки пула (шаг-трек может быть любым) и их группы в этом разделе (для шагов-групп). Тег у трека не нужен: шаг сам решает, когда он играет. */
        patternTracks: id => {
            const inGroups = rowsIn(id).filter(item => item.group).map(item => ({ id: item.id, ext: item.ext, group: item.group }));
            return [...inGroups, ...data.tracks.map(item => ({ id: item.id, ext: item.ext, group: null }))];
        },
        hasSection: id => Boolean(section(id)),

        /** Всё для консоли владельца (с тегами, без векторов). */
        /** Словарь эталонных сцен группы раздела: вектор считается как у сцены (`query:`), чтобы сравнивать прозу с прозой. */
        addExamples: ({ sectionId, groupId, texts, names = [] }) => exclusive(async () => {
            needSection(sectionId);
            if (modeOf(sectionId) !== MODES.GROUPS) throw new HttpError(400, 'эталонные сцены бывают только в разделе «по группам»');
            if (!checkGroup(sectionId, groupId)) throw new HttpError(400, 'выберите группу');
            const clean = [...new Set((Array.isArray(texts) ? texts : []).map(text => String(text ?? '').trim()).filter(text => text.length >= MIN_EXAMPLE_LENGTH))].slice(0, MAX_EXAMPLES_PER_CALL).map(text => text.slice(0, MAX_EXAMPLE_LENGTH));
            if (!clean.length) throw new HttpError(400, `нужен хотя бы один текст сцены (от ${MIN_EXAMPLE_LENGTH} знаков)`);
            const known = new Set(data.examples.filter(item => item.group === groupId).map(item => item.text));
            // Вектор считается от ОЧИЩЕННОГО текста (без имён героев и разметки) — так же, как ME чистит сцену: иначе сцена и словарь окажутся в разных «регистрах».
            const hidden = sceneNames(sectionId, clean, names);
            let added = 0;
            for (const text of clean) {
                if (known.has(text)) continue;
                data.examples.push({ id: randomId(), section: sectionId, group: groupId, text, vector: await embedQuery(cleanSceneText(text, { names: hidden }) || text), cleaned: true, createdAt: Date.now() });
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

        /**
         * Цепочка шагов за один раз (мастер «новый паттерн»): `steps` по порядку, каждый следующий — продолжение предыдущего, под `parent` (или новый корень). Либо
         * создаётся всё, либо ничего: ссылки проверяются до записи. Тег (`description`) — у любого шага, обычно у первого.
         */
        addPatternChain: ({ sectionId, parent = null, steps }) => exclusive(async () => {
            needSection(sectionId);
            const list = Array.isArray(steps) ? steps : [];
            if (!list.length) throw new HttpError(400, 'нужен хотя бы один шаг');
            if (list.length > 40) throw new HttpError(400, 'слишком длинная цепочка');
            if (parent) { const up = patternNode(parent); if (!up || up.section !== sectionId) throw new HttpError(400, 'такого родителя нет в этом разделе'); }
            const refs = list.map(step => checkStep(sectionId, step?.kind, step?.ref));
            const created = [];
            let above = parent || null;
            for (const [index, step] of list.entries()) {
                const text = String(step.description ?? '').trim();
                const node = { id: randomId(), section: sectionId, parent: above, kind: step.kind, ref: refs[index], name: String(step.name ?? '').trim(), description: text, vector: text ? await embed(text) : null, negative: '', negVector: null, order: data.patterns.filter(item => item.section === sectionId && item.parent === above).length };
                if (step.negative) await reembed(node, 'negative', 'negVector', step.negative);
                data.patterns.push(node);
                created.push(node);
                above = node.id;
            }
            await save();
            return { created: created.map(node => node.id) };
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



        /** Пересчёт вектора у старых эталонов по очищенному тексту (имена и разметка убраны). Порциями (`limit`), чтобы запрос не висел: вызывать, пока `remaining` > 0. */
        recleanExamples: ({ sectionId, limit = 40, names = [] }) => exclusive(async () => {
            needSection(sectionId);
            const hidden = sceneNames(sectionId, [], names);
            const pending = data.examples.filter(item => item.section === sectionId && !item.cleaned);
            for (const item of pending.slice(0, Math.max(1, Math.min(200, Number(limit) || 40)))) {
                item.vector = await embedQuery(cleanSceneText(item.text, { names: hidden }) || item.text);
                item.cleaned = true;
            }
            if (pending.length) await save();
            return { remaining: Math.max(0, pending.length - Math.max(1, Math.min(200, Number(limit) || 40))), names: hidden };
        }),

        /** Выравнивание регистров сцена↔теги раздела (см. alignment.js); `null` — выключено или мало эталонов. Считается на лету: это среднее по сотням векторов. */
        alignmentFor: id => {
            const found = section(id);
            if (!found) return null;
            const grouped = modeOf(id) === MODES.GROUPS;
            const tagVectors = grouped ? data.groups.filter(item => item.section === id).map(item => item.vector) : rowsIn(id).map(item => item.vector);
            return estimateAlignment({ sceneVectors: data.examples.filter(item => item.section === id).map(item => item.vector), tagVectors, strength: Number.isFinite(found.alignStrength) ? found.alignStrength : ALIGN_DEFAULTS.strength });
        },
        /** Сила выравнивания раздела (0 — выключено, 1 — полное; до 2). */
        setAlignStrength: (id, strength) => exclusive(async () => {
            const found = needSection(id);
            const value = Number(strength);
            if (!Number.isFinite(value) || value < 0 || value > 2) throw new HttpError(400, 'сила выравнивания — число от 0 до 2');
            found.alignStrength = Math.round(value * 100) / 100;
            await save();
            return found;
        }),


        /**
         * Отметки из ME («верно» / «неверно» у играющего трека): очередь на проверку владельцем, НЕ словарь. ME шлёт вектор сцены, на которой начал играть трек, и сам трек; в
         * очередь это попадает по ключу чтения (он не секрет), поэтому ничего сразу не обучается: эталоном отметка становится, только когда владелец разберёт её в консоли.
         * Очередь ограничена (старые вытесняются), повтор той же отметки той же сцены не копится.
         */
        addFeedback: ({ sectionId, vector, trackId, mark, dim }) => exclusive(async () => {
            needSection(sectionId);
            if (mark !== 'good' && mark !== 'bad') throw new HttpError(400, 'отметка — «верно» или «неверно»');
            if (!Array.isArray(vector) || vector.length !== dim || !vector.every(Number.isFinite)) throw new HttpError(400, 'нужен вектор сцены');
            const played = rowsIn(sectionId).find(item => item.id === String(trackId ?? '')) ?? (track(String(trackId ?? '')) && data.patterns.some(node => node.section === sectionId && node.kind === 'track' && node.ref === String(trackId ?? '')) ? { id: String(trackId), group: null } : null);
            if (!played) throw new HttpError(400, 'такого трека нет в этом разделе');
            const same = data.feedback.find(item => item.track === played.id && item.vector.every((x, i) => Math.abs(x - vector[i]) < 1e-6));
            if (same) { same.mark = mark; same.at = Date.now(); await save(); return { queued: data.feedback.length, updated: true }; }
            data.feedback.push({ id: randomId(), section: sectionId, track: played.id, group: played.group ?? null, mark, vector: vector.map(x => Math.round(x * ROUND_VECTOR) / ROUND_VECTOR), at: Date.now() });
            if (data.feedback.length > MAX_FEEDBACK) data.feedback.splice(0, data.feedback.length - MAX_FEEDBACK);
            await save();
            return { queued: data.feedback.length, updated: false };
        }),
        /** Разбор отметки: сцена становится эталоном группы `group` (для «верно» по умолчанию — группа сыгравшего трека), отметка уходит из очереди. */
        resolveFeedback: (id, { group: groupId } = {}) => exclusive(async () => {
            const item = data.feedback.find(entry => entry.id === id) ?? notFound('отметки');
            if (modeOf(item.section) !== MODES.GROUPS) throw new HttpError(400, 'эталонные сцены бывают только в разделе «по группам» — отметку можно только отклонить');
            const target = checkGroup(item.section, groupId || item.group);
            if (!target) throw new HttpError(400, 'выберите группу');
            data.examples.push({ id: randomId(), section: item.section, group: target, text: '(сцена из ME, текст не передаётся)', vector: item.vector, cleaned: true, source: 'feedback', createdAt: Date.now() });
            data.feedback = data.feedback.filter(entry => entry.id !== id);
            await save();
            return { group: target };
        }),
        dismissFeedback: id => exclusive(async () => {
            data.feedback.find(entry => entry.id === id) ?? notFound('отметки');
            data.feedback = data.feedback.filter(entry => entry.id !== id);
            await save();
        }),

        adminCatalog: () => ({
            feedback: data.feedback.map(({ vector, ...rest }) => ({ ...rest, trackTitle: track(rest.track)?.title ?? '(трек удалён)', groupName: group(rest.group)?.name ?? null })),
            patterns: data.patterns.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
            examples: data.examples.map(({ vector, ...rest }) => rest),
            sections: data.sections.map(item => ({ ...item, mode: cleanMode(item.mode) })),
            groups: data.groups.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
            tracks: data.tracks.map(item => ({ ...item, assigned: data.assignments.filter(entry => entry.track === item.id).length })),
            assignments: data.assignments.map(({ vector, negVector, ...rest }) => ({ ...rest, tagged: Array.isArray(vector) })),
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
            if (data.assignments.some(item => item.section === id)) throw new HttpError(409, 'в разделе есть назначенные треки — сначала уберите их из раздела');
            data.sections = data.sections.filter(item => item.id !== id);
            data.patterns = data.patterns.filter(item => item.section !== id);
            data.assignments = data.assignments.filter(item => item.section !== id);
            data.feedback = data.feedback.filter(item => item.section !== id);
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
            if (data.assignments.some(item => item.group === id)) throw new HttpError(409, 'в группе есть треки — сначала уберите их из группы');
            if (usedByPattern('group', id)) throw new HttpError(409, 'группа используется в паттерне — сначала уберите её оттуда');
            data.groups = data.groups.filter(item => item.id !== id);
            data.examples = data.examples.filter(item => item.group !== id);   // эталоны уходят вместе с группой
            await save();
        }),

        /** Новый трек В ПУЛ: байты уже лежат во временном файле `tmpFile`. Раздел и группа назначаются отдельно (`addAssignment`): без назначения трек молчит. */
        addTrack: ({ title, ext, tmpFile }) => exclusive(async () => {
            if (!AUDIO_EXT.test(ext)) throw new HttpError(400, 'нужен аудиофайл: mp3, ogg, m4a, flac, wav…');
            const item = { id: randomId(), ext: ext.toLowerCase(), title: String(title ?? '').trim() || 'Без названия', createdAt: Date.now() };
            await fs.rename(tmpFile, audioPath(item));
            data.tracks.push(item);
            await save();
            return item;
        }),

        /** Правка трека пула: пока только название (всё остальное — в назначениях). */
        updateTrack: (id, patch) => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
            await save();
            return item;
        }),

        /**
         * Назначение «трек → раздел/группа». В разделе «по группам» нужна группа этого раздела (тег — у группы), в разделе «по трекам» группы нет, а тег (`description`,
         * `negative`, `intensity`) принадлежит назначению: один трек может быть в нескольких разделах с разными тегами. Повторное назначение той же пары ничего не меняет.
         */
        addAssignment: ({ trackId, sectionId, groupId = null, description = '', negative = '', intensity }) => exclusive(async () => {
            track(trackId) ?? notFound('трека');
            needSection(sectionId);
            const grouped = modeOf(sectionId) === MODES.GROUPS;
            const target = grouped ? checkGroup(sectionId, groupId) : null;
            if (grouped && !target) throw new HttpError(400, 'в разделе «по группам» выберите группу');
            const same = data.assignments.find(item => item.track === trackId && item.section === sectionId && (item.group ?? null) === target);
            if (same) return { ...rowOf(same), existing: true };
            const item = { id: randomId(), track: trackId, section: sectionId, group: target, description: '', vector: null, negative: '', negVector: null, intensity: grouped ? null : cleanIntensity(intensity), createdAt: Date.now() };
            if (!grouped) { await reembed(item, 'description', 'vector', description); if (negative) await reembed(item, 'negative', 'negVector', negative); }
            data.assignments.push(item);
            await save();
            return rowOf(item);
        }),

        /** Много треков сразу в одну группу/раздел; уже назначенные пропускаются. */
        addAssignments: ({ trackIds, sectionId, groupId = null }) => exclusive(async () => {
            needSection(sectionId);
            const grouped = modeOf(sectionId) === MODES.GROUPS;
            const target = grouped ? checkGroup(sectionId, groupId) : null;
            if (grouped && !target) throw new HttpError(400, 'в разделе «по группам» выберите группу');
            const ids = [...new Set(Array.isArray(trackIds) ? trackIds.map(String) : [])];
            if (!ids.length || ids.length > 500) throw new HttpError(400, 'нужно от 1 до 500 треков');
            if (ids.some(id => !track(id))) throw new HttpError(400, 'среди выбранных есть несуществующий трек');
            let added = 0;
            for (const id of ids) {
                if (data.assignments.some(item => item.track === id && item.section === sectionId && (item.group ?? null) === target)) continue;
                data.assignments.push({ id: randomId(), track: id, section: sectionId, group: target, description: '', vector: null, negative: '', negVector: null, intensity: null, createdAt: Date.now() });
                added += 1;
            }
            if (added) await save();
            return { added, skipped: ids.length - added };
        }),

        /** Правка назначения: перенос в другую группу своего раздела (`group`) и, в разделе «по трекам», теги и накал. */
        updateAssignment: (id, patch) => exclusive(async () => {
            const item = assignment(id) ?? notFound('назначения');
            const grouped = modeOf(item.section) === MODES.GROUPS;
            if (patch.group !== undefined) {
                if (!grouped) throw new HttpError(400, 'группы есть только в разделе «по группам»');
                const target = checkGroup(item.section, patch.group);
                if (!target) throw new HttpError(400, 'выберите группу');
                if (data.assignments.some(other => other !== item && other.track === item.track && other.section === item.section && other.group === target)) throw new HttpError(409, 'этот трек уже в той группе');
                item.group = target;
            }
            if (!grouped) {
                if (patch.intensity !== undefined) item.intensity = cleanIntensity(patch.intensity);
                if (patch.description !== undefined) await reembed(item, 'description', 'vector', patch.description);
                if (patch.negative !== undefined) await reembed(item, 'negative', 'negVector', patch.negative);
            }
            await save();
            return rowOf(item);
        }),

        /** Убрать трек из раздела/группы: трек остаётся в пуле. */
        deleteAssignment: id => exclusive(async () => {
            assignment(id) ?? notFound('назначения');
            data.assignments = data.assignments.filter(item => item.id !== id);
            await save();
        }),

        deleteTrack: id => exclusive(async () => {
            const item = track(id) ?? notFound('трека');
            if (usedByPattern('track', id)) throw new HttpError(409, 'трек используется в паттерне — сначала уберите его оттуда');
            data.tracks = data.tracks.filter(other => other.id !== id);
            data.assignments = data.assignments.filter(entry => entry.track !== id);
            data.feedback = data.feedback.filter(entry => entry.track !== id);
            await save();
            await fs.rm(audioPath(item), { force: true });
        }),
    };
}
