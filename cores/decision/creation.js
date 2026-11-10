import { ruleCard } from '../../libraries/core/decision-rule-weight.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import {
    applySections, normalizeCreation, renderCreation, findSection, allSections, isComplete, missingSections,
} from '../../libraries/core/decision-creation.js';
import { normalizeScaleSystem, findScaleSystem, appendDiscovery } from '../../libraries/core/decision-scales.js';
import { discoveriesBlock } from '../../libraries/core/decision-god.js';

/**
 * Creation в памяти чата (позже — часть Canon, фаза 6) и его снимок для
 * резолвера. Creation целиком стоит в стабильной части контекста резолвера и
 * кешируется; снимок обновляется только на переключении окна, а открытия
 * между снимками идут коротким блоком у задания.
 */

const CREATION_KEY = 'creation';
const SNAPSHOT_KEY = 'creationSnapshot';

export function createCreationStore({ call, store = null, publishEvent = () => {}, now = () => Date.now() }) {
    let creation = normalizeCreation(null);
    let snapshot = null;
    let loaded = false;

    async function load() {
        if (loaded) return creation;
        loaded = true;
        try {
            creation = normalizeCreation(await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: CREATION_KEY, fallback: null }));
            const saved = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: SNAPSHOT_KEY, fallback: null });
            snapshot = saved && typeof saved === 'object' && typeof saved.text === 'string' ? saved : null;
        } catch {
            creation = normalizeCreation(null);
            snapshot = null;
        }
        return creation;
    }

    function reset() {
        loaded = false;
        creation = normalizeCreation(null);
        snapshot = null;
    }

    async function save(next) {
        creation = normalizeCreation(next);
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: CREATION_KEY, value: creation });
        return creation;
    }

    function state() {
        return normalizeCreation(creation);
    }

    const isEmpty = () => !allSections(creation).some(section => String(section.text ?? '').trim()) && !(creation.scales ?? []).length;
    /** Начат, но не закончен: у него есть хоть что-то написанное — достройка на следующем открытии. */
    const started = () => !isEmpty();
    const complete = () => isComplete(creation);
    const missing = () => missingSections(creation);

    /** `creation_write`: несколько разделов одним вызовом; повтор раздела заменяет текст. */
    async function writeSections({ sections = [], at = '', by = 'god', comment = '' } = {}) {
        const applied = applySections(creation, sections, { at, by, comment });
        await save(applied.state);
        publishEvent('decision.creation.written', {
            sections: applied.written, at, complete: complete(),
            missing: missing(),
        });
        return { ok: true, at, sections: applied.written, complete: complete(), missing: missing() };
    }

    /**
     * `scale_write`: система структурно. Повтор системы заменяет её правила и
     * сохраняет открытия — прецеденты не стираются.
     */
    async function writeScale({ system = '', principle = '', payment = '', rules = [] } = {}) {
        const fresh = normalizeScaleSystem({ system, principle, payment, rules });
        if (!fresh) return { ok: false, error: 'A system of weight needs a name and its rules.' };
        const existing = findScaleSystem(creation.scales, fresh.name);
        const next = existing
            ? { ...fresh, id: existing.id, discoveries: existing.discoveries }
            : fresh;
        const scales = existing
            ? creation.scales.map(item => (item.id === existing.id ? next : item))
            : [...creation.scales, next];
        await save({ ...creation, scales });
        publishEvent('decision.creation.written', { scales: next.name, rules: next.rules.length, at: creation.snapshots?.at ?? '', complete: complete() });
        return { ok: true, system: next.name, rules: next.rules.length, replaced: Boolean(existing) };
    }

    /** Открытие из Молитвы: прецедент дописывается; система не найдена — создаётся честная. */
    async function writeDiscovery({ system = '', rule = '', text = '', at = '' } = {}) {
        const body = String(text ?? '').trim();
        if (!body) return { ok: false, error: 'A Discovery needs what was done and what came of it.' };
        const seq = (Number(creation.snapshots?.seq) || 0) + 1;
        const applied = appendDiscovery(creation.scales, { system, rule, text: body, at, seq });
        await save({ ...creation, scales: applied.systems, snapshots: { ...creation.snapshots, seq } });
        publishEvent('decision.creation.discovery', { system: applied.system, at, text: body });
        return { ok: true, system: applied.system, at, seq };
    }

    /** Стабильная часть контекста резолвера: снимок Creation. Нет снимка — снимается один раз. */
    async function resolverText() {
        await load();
        if (!creation.scales?.length && isEmpty()) return '';
        const text = renderCreation(creation);
        if (!snapshot) {
            snapshot = { at: String(creation.snapshots?.at ?? ''), seq: Number(creation.snapshots?.seq) || 0, text };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: SNAPSHOT_KEY, value: snapshot }).catch(() => {});
        }
        return snapshot.text ?? text;
    }

    /** Переключение окна — единственная точка, где снимок Creation обновляется. */
    async function refreshSnapshot() {
        await load();
        snapshot = {
            at: String(creation.snapshots?.at ?? ''),
            seq: Number(creation.snapshots?.seq) || 0,
            text: renderCreation(creation),
        };
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: SNAPSHOT_KEY, value: snapshot }).catch(() => {});
        return snapshot;
    }

    /** Открытия, которых резолвер не видел: короткий блок у задания. */
    function discoveries() {
        // Правила, которых нет в снимке резолвера (Бог дописал по ходу игры), — целиком: иначе резолвер видел только
        // строку открытия и толковал правило, не читая его Needs, Yields и Limit.
        const seen = String(snapshot?.text ?? '');
        const fresh = seen ? (creation.scales ?? []).flatMap(system => (system.rules ?? []).filter(rule => rule?.name && !seen.includes(rule.name)).map(rule => ruleCard(system, rule))) : [];
        return [discoveriesBlock(creation, Number(snapshot?.seq) || 0), fresh.length ? `NEW RULES (written since the world was last read; they are the law of the world):\n\n${fresh.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
    }

    return {
        load, reset, save, state, resolverText, refreshSnapshot, discoveries,
        writeSections, writeScale, writeDiscovery,
        isEmpty, started, complete, missing,
        sections: () => allSections(creation).map(section => ({ ...section })),
        section: title => findSection(creation, title),
        text: () => renderCreation(creation),
        now,
    };
}
