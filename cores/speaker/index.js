import { request } from '../../libraries/shared/request.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import {
    createEmptySpeakerRegistry, detectSpeakers, computeEntityGender, resolveEntityByName,
} from '../../libraries/core/speaker-detection.js';

const CHAT_NAMESPACE = 'core.speaker';
const CHAT_REGISTRY_KEY = 'registry';
const PRESETS_NAMESPACE = 'core.speaker';
const PRESETS_KEY = 'presets';

function slugifyPresetName(name) {
    return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

/** The shape a preset/registry entity is exposed as OUTSIDE this Core — resolved gender, no internal vote counters. */
function toPublicEntity(id, entity) {
    return {
        id,
        name: entity.canonicalName,
        aliases: entity.aliases,
        gender: computeEntityGender(entity).gender,
        genderConfidence: computeEntityGender(entity).confidence,
        color: entity.color ?? null,
    };
}

/**
 * Ядро определения говорящего (CORES.md) — по чату персистентный реестр
 * говорящих (regisrty из [libraries/core/speaker-detection.js](../../libraries/core/speaker-detection.js))
 * + переиспользуемые именованные пресеты состава, зеркалящие
 * `model.presets.get/set` у Ядра внутренних моделей (тот же
 * `createPersistedList` через `storage.settings`, то же имя события
 * `<домен>.presets.changed`).
 *
 * **Зачем отдельное Ядро, не часть одного Модуля.** Формально движок
 * работает и без единого говорящего, распознанного этим Ядром — не проходит
 * буквальный критерий CORES.md «без Ядра движок не работает». Но это ровно
 * тот же прецедент, что уже принят для Ядра трекинга: переиспользуемая
 * ИНФРАСТРУКТУРА (реестр+резолвинг+персистентность), которую способен
 * подключить БОЛЬШЕ ОДНОГО потребителя — сейчас только Модуль покраски
 * текста, но контракт публичный, а не спрятанный внутри одного Модуля,
 * ровно затем, чтобы будущий Модуль (например, TTS-озвучка по голосам)
 * получил тот же реестр бесплатно, без копирования логики.
 *
 * **Что здесь НЕ живёт.** Ни DOM, ни выбор цвета из темы ST, ни собственно
 * покраска — то ЧТО подсвечивать и КАКИМ цветом решает Модуль поверх этого
 * Ядра (`color` здесь — плоское поле, которое Модуль пишет через
 * `speaker.setColor`; Ядро само никогда не придумывает цвет). Разделение то
 * же, что уже проведено между Ядром трекинга (значения+публикация) и
 * специализированным Модулем «RP Time» (что и как показывать).
 *
 * **Реестр — ПЕР ЧАТ**, персонаж «Sasha» в одном чате может получить другой
 * цвет/пол, чем «Sasha» в другом — та же дисциплина, что у натрекан­ных
 * значений Ядра трекинга (`storage.chatMemory`, перечитывается на
 * `st.chatChanged`). **Пресеты — ГЛОБАЛЬНЫЕ**, именованные, через
 * `storage.settings`: пользователь может сохранить состав говорящих текущего
 * чата под именем и применить его в другом чате — так же, как сэмплер-пресет
 * не привязан к конкретному воркеру.
 */
export function createSpeakerCore(host, { publish } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let registry = createEmptySpeakerRegistry();
    let customPresets = [];

    const presetsPersisted = createPersistedList(host, {
        namespace: PRESETS_NAMESPACE, key: PRESETS_KEY,
        apply: list => { customPresets = list ?? []; },
    });

    /** Persists the CURRENT chat's registry — mirrors Ядро трекинга's `saveChatValues()`; silently stays in-memory if `storage.chatMemory` isn't wired (narrow tests). */
    async function saveRegistry() {
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: CHAT_NAMESPACE, key: CHAT_REGISTRY_KEY, value: registry } });
    }

    /** Reloads the registry for whichever chat is CURRENT — called once at startup and again on every `st.chatChanged`, same discipline as tracked values. */
    async function loadRegistryForCurrentChat() {
        const result = await request(host.own, 'storage.chatMemory.get', {
            params: { namespace: CHAT_NAMESPACE, key: CHAT_REGISTRY_KEY, fallback: null },
        });
        registry = result.ok && result.value ? result.value : createEmptySpeakerRegistry();
    }

    function listEntities() {
        return Object.entries(registry.entities).map(([id, entity]) => toPublicEntity(id, entity));
    }

    /**
     * Runs detection over `text`, folding any newly-discovered speaker into
     * the CURRENT chat's registry and persisting it — the only write path
     * into the registry driven by real prose, as opposed to a manual
     * `speaker.setColor`/`speaker.applyPreset` edit.
     *
     * `defaultSpeakerName` — optional, forwarded as-is to
     * `detectSpeakers()`'s own fallback (see its doc comment): the ST
     * message-card owner, for a caller that has it, so a message with no
     * named speaker anywhere in ITS OWN text still resolves its pronoun-only
     * quotes instead of staying `unknown`.
     */
    async function resolve({ text, mesid, defaultSpeakerName } = {}) {
        const before = new Set(Object.keys(registry.entities));
        const { registry: nextRegistry, segments } = detectSpeakers(String(text ?? ''), registry, { defaultSpeakerName });
        registry = nextRegistry;
        const discovered = Object.keys(registry.entities).filter(id => !before.has(id));
        if (discovered.length > 0) {
            await saveRegistry();
            publishEvent('speaker.registryChanged', { mesid, discoveredIds: discovered });
        }
        return {
            mesid,
            segments: segments.map(segment => ({
                ...segment,
                speaker: segment.speakerId ? toPublicEntity(segment.speakerId, registry.entities[segment.speakerId]) : null,
            })),
        };
    }

    /** Manual color assignment — the ONLY place `color` is ever written, whether the caller is a user pick or the Module's own auto-palette. */
    async function setColor({ id, color } = {}) {
        if (!registry.entities[id]) throw new Error(`speaker.setColor: unknown speaker id "${id}".`);
        registry = { ...registry, entities: { ...registry.entities, [id]: { ...registry.entities[id], color: color ?? null } } };
        await saveRegistry();
        publishEvent('speaker.registryChanged', { discoveredIds: [] });
        return toPublicEntity(id, registry.entities[id]);
    }

    /** Renames the canonical display name of an already-known speaker (e.g. detector guessed "Sasha" from a nickname, user corrects the display form) without losing accumulated gender votes/aliases. */
    async function rename({ id, name } = {}) {
        if (!registry.entities[id]) throw new Error(`speaker.rename: unknown speaker id "${id}".`);
        const trimmed = String(name ?? '').trim();
        if (!trimmed) throw new Error('speaker.rename: "name" is required.');
        registry = { ...registry, entities: { ...registry.entities, [id]: { ...registry.entities[id], canonicalName: trimmed } } };
        await saveRegistry();
        publishEvent('speaker.registryChanged', { discoveredIds: [] });
        return toPublicEntity(id, registry.entities[id]);
    }

    /**
     * Saves the CURRENT chat's registry as a reusable named preset — same
     * name updates the same preset (deterministic slug id), never plants a
     * duplicate, same convention as `buildCustomPreset()` for sampler
     * presets.
     */
    async function savePreset({ name } = {}) {
        const trimmed = String(name ?? '').trim();
        if (!trimmed) throw new Error('speaker.presets.save: "name" is required.');
        const id = slugifyPresetName(trimmed);
        const preset = { id, name: trimmed, entities: listEntities().map(entity => ({ name: entity.name, aliases: entity.aliases, color: entity.color })) };
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
     * Applies a saved preset INTO the current chat's registry — entities are
     * matched by name/alias against what's already known (so an entity the
     * detector already discovered this chat keeps its id and gender votes),
     * new ones from the preset are added fresh with the preset's color as a
     * starting value.
     */
    async function applyPreset({ id } = {}) {
        const preset = customPresets.find(item => item.id === id);
        if (!preset) throw new Error(`speaker.presets.apply: unknown preset "${id}".`);
        let next = registry;
        for (const presetEntity of preset.entities) {
            const existingId = resolveEntityByName(next, presetEntity.name);
            if (existingId) {
                next = { ...next, entities: { ...next.entities, [existingId]: { ...next.entities[existingId], color: presetEntity.color ?? next.entities[existingId].color } } };
            } else {
                const entity = {
                    canonicalName: presetEntity.name,
                    aliases: presetEntity.aliases?.length ? presetEntity.aliases : [presetEntity.name],
                    genderVotes: { M: 0, F: 0 },
                    theyVotes: 0,
                    role: 'npc',
                    color: presetEntity.color ?? null,
                };
                next = { nextId: next.nextId + 1, entities: { ...next.entities, [`speaker${next.nextId}`]: entity } };
            }
        }
        registry = next;
        await saveRegistry();
        publishEvent('speaker.registryChanged', { discoveredIds: [] });
        return listEntities();
    }

    const chatChangedUnsubscribe = host.events.subscribe('st.chatChanged', () => { void loadRegistryForCurrentChat(); });

    const unregisters = [
        host.own.register('speaker.resolve', params => resolve(params)),
        host.own.register('speaker.registry.get', () => listEntities()),
        host.own.register('speaker.setColor', params => setColor(params)),
        host.own.register('speaker.rename', params => rename(params)),
        host.own.register('speaker.presets.get', () => customPresets),
        host.own.register('speaker.presets.save', params => savePreset(params)),
        host.own.register('speaker.presets.delete', params => deletePreset(params)),
        host.own.register('speaker.presets.apply', params => applyPreset(params)),
    ];

    return {
        /** Explicit startup hook — mirrors `restoreTrackers()`: called ONCE by whoever assembles the engine, after storage is wired, never from inside this factory. */
        async restore() {
            await presetsPersisted.restore();
            await loadRegistryForCurrentChat();
        },
        unregister: () => {
            for (const unregister of unregisters) unregister();
            chatChangedUnsubscribe();
        },
    };
}
