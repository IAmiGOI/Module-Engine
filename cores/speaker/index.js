import { request } from '../../libraries/shared/request.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import {
    createEmptySpeakerCast, addCastMember, removeCastMember, updateCastMember, detectSpeakers,
} from '../../libraries/core/speaker-detection.js';

const CHAT_NAMESPACE = 'core.speaker';
const CHAT_CAST_KEY = 'cast';
const PRESETS_NAMESPACE = 'core.speaker';
const PRESETS_KEY = 'presets';

function slugifyPresetName(name) {
    return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

/** The shape a cast entity is exposed as OUTSIDE this Core — flat, no internal bookkeeping. */
function toPublicEntity(id, entity) {
    return { id, name: entity.canonicalName, aliases: entity.aliases, gender: entity.gender, color: entity.color ?? null };
}

/**
 * Ядро определения говорящего (CORES.md) — по чату персистентный СОСТАВ
 * (cast), который ВВОДИТ ПОЛЬЗОВАТЕЛЬ (имя + пол, [libraries/core/speaker-detection.js](../../libraries/core/speaker-detection.js)),
 * + переиспользуемые именованные пресеты состава, зеркалящие
 * `model.presets.get/set` у Ядра внутренних моделей.
 *
 * **Поправка к первой версии (тот же день).** Первая версия сама
 * "открывала" говорящих из прозы (proper-noun эвристики) и накапливала пол
 * голосованием по местоимениям — на реальном транскрипте владельца это
 * заводило отдельную запись пресета на КАЖДОЕ капитализированное слово
 * ("Looks", "Holds", "Not"...). Прямая формулировка владельца: **"Идёт
 * персонаж. У него имя. И у него/неё пол. По этому ты определяешь, кто
 * говорит"** — состав известен ЗАРАНЕЕ, вводится пользователем через
 * `speaker.cast.add`, и `speaker.resolve` только СОПОСТАВЛЯЕТ текст с этим
 * составом. Ни один контракт этого Ядра больше не создаёт запись состава
 * сам — `resolve()` теперь принимает cast как read-only вход и никогда не
 * возвращает изменённый cast. См. ROADMAP.md 5.40.
 *
 * **Зачем отдельное Ядро, не часть одного Модуля.** Формально движок
 * работает и без единого настроенного состава — не проходит буквальный
 * критерий CORES.md «без Ядра движок не работает». Но тот же прецедент, что
 * уже принят для Ядра трекинга: переиспользуемая ИНФРАСТРУКТУРА
 * (состав+резолвинг+персистентность), которую способен подключить БОЛЬШЕ
 * ОДНОГО потребителя — сейчас только Модуль покраски текста.
 *
 * **Состав — ПЕР ЧАТ** (`storage.chatMemory`, перечитывается на
 * `st.chatChanged`) — разные истории обычно разные действующие лица.
 * **Пресеты — ГЛОБАЛЬНЫЕ**, именованные, через `storage.settings`:
 * пользователь настраивает состав один раз (например, для серии связанных
 * чатов) и применяет его в другом чате одной кнопкой.
 */
export function createSpeakerCore(host, { publish } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let cast = createEmptySpeakerCast();
    let customPresets = [];

    const presetsPersisted = createPersistedList(host, {
        namespace: PRESETS_NAMESPACE, key: PRESETS_KEY,
        apply: list => { customPresets = list ?? []; },
    });

    /** Persists the CURRENT chat's cast — mirrors Ядро трекинга's `saveChatValues()`; silently stays in-memory if `storage.chatMemory` isn't wired (narrow tests). */
    async function saveCast() {
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: CHAT_NAMESPACE, key: CHAT_CAST_KEY, value: cast } });
    }

    /** Reloads the cast for whichever chat is CURRENT — called once at startup and again on every `st.chatChanged`, same discipline as tracked values. */
    async function loadCastForCurrentChat() {
        const result = await request(host.own, 'storage.chatMemory.get', {
            params: { namespace: CHAT_NAMESPACE, key: CHAT_CAST_KEY, fallback: null },
        });
        cast = result.ok && result.value ? result.value : createEmptySpeakerCast();
    }

    function listCast() {
        return Object.entries(cast.entities).map(([id, entity]) => toPublicEntity(id, entity));
    }

    /** The ONLY way a character enters the cast — a direct, explicit user action (the Модуль's "Add character" form), never something `resolve()` does on its own. */
    async function addCharacter({ name, gender, aliases, color } = {}) {
        const result = addCastMember(cast, { name, gender, aliases, color });
        cast = result.cast;
        await saveCast();
        publishEvent('speaker.castChanged', {});
        return toPublicEntity(result.id, cast.entities[result.id]);
    }

    async function removeCharacter({ id } = {}) {
        cast = removeCastMember(cast, id);
        await saveCast();
        publishEvent('speaker.castChanged', {});
        return true;
    }

    /** Generic partial edit (name/gender/aliases/color) — one contract, not a separate rename/setColor pair; unknown id is a no-op (matches `updateCastMember`'s own contract). */
    async function updateCharacter({ id, ...patch } = {}) {
        if (!cast.entities[id]) throw new Error(`speaker.cast.update: unknown speaker id "${id}".`);
        cast = updateCastMember(cast, id, patch);
        await saveCast();
        publishEvent('speaker.castChanged', {});
        return toPublicEntity(id, cast.entities[id]);
    }

    /**
     * Runs detection over `text` against the CURRENT chat's cast — read-only,
     * never adds/changes a cast member. `defaultSpeakerName` is forwarded
     * as-is to `detectSpeakers()`'s own fallback (see its doc comment): a
     * resolution HINT only, ignored entirely if it doesn't already match
     * someone in the cast.
     */
    async function resolve({ text, mesid, defaultSpeakerName } = {}) {
        const { segments } = detectSpeakers(String(text ?? ''), cast, { defaultSpeakerName });
        return {
            mesid,
            segments: segments.map(segment => ({
                ...segment,
                speaker: segment.speakerId ? toPublicEntity(segment.speakerId, cast.entities[segment.speakerId]) : null,
            })),
        };
    }

    /** Saves the CURRENT chat's cast as a reusable named preset — same name updates the same preset (deterministic slug id), never plants a duplicate. */
    async function savePreset({ name } = {}) {
        const trimmed = String(name ?? '').trim();
        if (!trimmed) throw new Error('speaker.presets.save: "name" is required.');
        const id = slugifyPresetName(trimmed);
        const preset = { id, name: trimmed, entities: listCast().map(entity => ({ name: entity.name, gender: entity.gender, aliases: entity.aliases, color: entity.color })) };
        const next = [...customPresets.filter(item => item.id !== id), preset];
        await presetsPersisted.save(next);
        publishEvent('speaker.presets.changed', { count: next.length });
        return preset;
    }

    async function deletePreset({ id } = {}) {
        const next = customPresets.filter(item => item.id !== id);
        await presetsPersisted.save(next);
        publishEvent('speaker.presets.changed', { count: next.length });
        return true;
    }

    /**
     * Applies a saved preset INTO the current chat's cast — entities already
     * present (matched by name/alias) get their gender/color updated from
     * the preset, ones not yet in this chat's cast are added fresh. Still a
     * direct, explicit user action (clicking "Apply"), not automatic
     * discovery — consistent with `addCharacter()` above.
     */
    async function applyPreset({ id } = {}) {
        const preset = customPresets.find(item => item.id === id);
        if (!preset) throw new Error(`speaker.presets.apply: unknown preset "${id}".`);
        for (const presetEntity of preset.entities) {
            const existingId = Object.keys(cast.entities).find(entityId => cast.entities[entityId].aliases.some(alias => alias.toLowerCase() === presetEntity.name.toLowerCase()));
            if (existingId) {
                cast = updateCastMember(cast, existingId, { gender: presetEntity.gender, color: presetEntity.color });
            } else {
                cast = addCastMember(cast, { name: presetEntity.name, gender: presetEntity.gender, aliases: presetEntity.aliases, color: presetEntity.color }).cast;
            }
        }
        await saveCast();
        publishEvent('speaker.castChanged', {});
        return listCast();
    }

    /**
     * Красит РЕПЛИКИ в готовом HTML сообщения и возвращает новый HTML — для Chat Viewport, который рисует текст из HTML сам
     * (родного `.mes_text` у старых сообщений в DOM может не быть вовсе, там красить нечего). Работает на отсоединённом узле:
     * та же цепочка «текст узла → определение говорящего → `dom.paintTextRuns`», что у Модуля для родной ленты, но с цветами,
     * которые УЖЕ заданы у персонажей состава (автоцвет новым персонажам назначает Модуль при покраске родной ленты).
     * Без состава/цветов/реплик возвращает исходный HTML без изменений.
     */
    async function paintHtml({ html, mesid, defaultSpeakerName } = {}) {
        const source = String(html ?? '');
        const colorById = new Map(listCast().filter(entity => entity.color).map(entity => [entity.id, entity.color]));
        if (!source || colorById.size === 0) return source;
        const services = (contract, params) => request(host.services, contract, { params });
        const created = await services('dom.createElement', { tag: 'div' });
        if (!created.ok || !created.value) return source;
        const node = created.value;
        await services('dom.setInnerHtml', { el: node, html: source });
        const text = (await services('dom.textContent', { node })).value ?? '';
        if (!String(text).trim()) return source;
        const resolved = await resolve({ text, mesid, defaultSpeakerName });
        const runs = [];
        for (const segment of resolved.segments) {
            if (segment.type !== 'dialogue' || !segment.speaker || segment.confidence <= 0) continue;
            const color = colorById.get(segment.speaker.id);
            if (color) runs.push({ start: segment.start, end: segment.end, color });
        }
        if (!runs.length) return source;
        await services('dom.paintTextRuns', { container: node, runs });
        const painted = await services('dom.getInnerHtml', { node });
        return painted.ok && typeof painted.value === 'string' ? painted.value : source;
    }

    const chatChangedUnsubscribe = host.events.subscribe('st.chatChanged', () => { void loadCastForCurrentChat(); });

    const unregisters = [
        host.own.register('speaker.resolve', params => resolve(params)),
        host.own.register('speaker.paintHtml', params => paintHtml(params)),
        host.own.register('speaker.cast.list', () => listCast()),
        host.own.register('speaker.cast.add', params => addCharacter(params)),
        host.own.register('speaker.cast.remove', params => removeCharacter(params)),
        host.own.register('speaker.cast.update', params => updateCharacter(params)),
        host.own.register('speaker.presets.get', () => customPresets),
        host.own.register('speaker.presets.save', params => savePreset(params)),
        host.own.register('speaker.presets.delete', params => deletePreset(params)),
        host.own.register('speaker.presets.apply', params => applyPreset(params)),
    ];

    return {
        /** Explicit startup hook — mirrors `restoreTrackers()`: called ONCE by whoever assembles the engine, after storage is wired, never from inside this factory. */
        async restore() {
            await presetsPersisted.restore();
            await loadCastForCurrentChat();
        },
        unregister: () => {
            for (const unregister of unregisters) unregister();
            chatChangedUnsubscribe();
        },
    };
}
