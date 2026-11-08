import { request } from '../../../libraries/shared/request.js';
import { toCourt, toBookVolume, toCharter, toSky, charterPatch } from '../../../libraries/core/pillars-sources.js';
import { workingLanes } from '../../../libraries/core/court-lanes.js';
import { pillarStates } from './pillar-states.js';

/**
 * Загрузчик данных меню «Пять столпов»: зовёт только существующие контракты (`decision.log`,
 * `decision.greatBank`, `decision.canonList`, …) и отдаёт их адаптерам `libraries/core/pillars-sources.js`.
 * Здесь нет ни DOM, ни рисования — этим занимается `screen.js`. Любой отказ контракта — пустая модель,
 * а не падение: меню обязано открыться и без игры.
 */
export function createPillarsSources({ host, call = null } = {}) {
    const invoke = call ?? ((contract, params) => request(host.own, contract, { params }));
    // `stCharacter.*` живут на Шине сервисов, всё `decision.*` — на Шине ядер.
    const service = (contract, params) => (host?.services ? request(host.services, contract, { params }) : invoke(contract, params));
    // любой сбой источника (даже синхронный) — пустое значение: один упавший контракт не гасит весь столп
    const value = async (contract, params, fallback = null, via = invoke) => {
        try {
            const result = await via(contract, params);
            return result?.ok ? result.value ?? fallback : fallback;
        } catch (error) {
            console.warn(`[ST Module Engine (Beta)] ${contract} failed for the five pillars:`, error);
            return fallback;
        }
    };
    const list = async (contract, params) => {
        const result = await value(contract, params, []);
        return Array.isArray(result) ? result : [];
    };
    const castOf = great => Object.values(great && typeof great === 'object' ? great : {})
        .map(character => ({ name: String(character?.name ?? '').trim(), main: character?.importance === 'main' }))
        .filter(person => person.name);

    async function entries() {
        return list('decision.log');
    }

    async function court() {
        // Ходы берутся из ленты (`turnsIn` внутри `toCourt`) — отдельного контракта у них нет.
        const [log, god, files, current, clock] = await Promise.all([
            entries(), value('decision.god', undefined, { questions: [] }), list('decision.files'),
            value('stCharacter.current', undefined, null, service), value('decision.clock', undefined, { minutes: 0 }),
        ]);
        const state = {
            entries: log,
            god,
            files,
            clock: { minutes: clock?.minutes ?? 0 },
            name: current?.name ?? '',
            place: '',
            // кто работает — по живым записям ленты (`running`), а не по именам воркеров: их называет пользователь
            working: workingLanes(log),
        };
        try { return toCourt(state); } catch (error) {
            console.warn('[ST Module Engine (Beta)] The Court model failed; showing the table without its records:', error);
            return toCourt({ name: state.name, clock: state.clock });
        }
    }

    async function bank() {
        const great = await value('decision.greatBank', undefined, {});
        return toBookVolume('bank', { great: great && typeof great === 'object' ? great : {} });
    }

    async function world() {
        const [creation, log] = await Promise.all([value('decision.creation', undefined, {}), entries()]);
        // Молитвы живут строками журнала (`kind: 'prayer'`), отдельного контракта у них нет.
        const prayers = log.flatMap(entry => (Array.isArray(entry?.rows) ? entry.rows : [])
            .filter(row => row?.kind === 'prayer')
            .map(row => ({ id: row.id, who: Number.isFinite(Number(entry?.turn)) ? `Turn ${entry.turn}` : 'a prayer', text: row?.text, status: row?.status })));
        return { volume: toBookVolume('world', { creation: creation ?? {}, prayers }), prayers };
    }

    async function charter() {
        const [settings, workers, files] = await Promise.all([value('decision.settings', undefined, {}), list('model.workers.get'), value('decision.files', undefined, null)]);
        return toCharter(settings ?? {}, { workers, files: Array.isArray(files) ? files.map(file => ({ id: file.path, name: file.path, text: file.text })) : null });
    }

    async function canon() {
        const [canons, current, great] = await Promise.all([list('decision.canonList'), value('stCharacter.current', undefined, null, service), value('decision.greatBank', undefined, {})]);
        const saved = canons.map(item => ({ ...item, cast: Array.isArray(item?.cast) ? item.cast : castOf(item?.great) }));
        // текущий мир — россыпь из его же людей: при печати она стягивается в созвездие
        return toSky({ canons: saved, current: { name: current?.name ?? '', meta: 'not yet bound', cast: castOf(great) }, key: current?.name ?? 'now' });
    }

    async function states() {
        const [courtModel, bankModel, canonModel, charterModel, worldModel] = await Promise.all([
            court().catch(() => null), bank().catch(() => null), canon().catch(() => null), charter().catch(() => null), world().catch(() => null),
        ]);
        return {
            states: pillarStates({ court: courtModel, bank: bankModel, canon: canonModel, charter: charterModel, world: { prayersInQueue: worldModel?.prayers ?? [] } }),
            models: { court: courtModel, bank: bankModel, canon: canonModel, charter: charterModel, world: worldModel },
        };
    }

    const actions = {
        answerGod: (id, answer) => invoke('decision.answerGod', { id, answer }),
        messageCounsellor: text => invoke('decision.message', { text }),
        saveCanon: name => invoke('decision.canonSave', { name }),
        applyCanon: id => invoke('decision.canonApply', { id }),
        // печать устава: пропуски → патчи настроек; движок сливает настройки неглубоко, поэтому роль уходит целиком
        sealCharter: async changes => {
            const [settings, workers] = await Promise.all([value('decision.settings', undefined, {}), list('model.workers.get')]);
            const { configure, game } = charterPatch(settings ?? {}, workers, changes);
            if (Object.keys(configure).length) { const answer = await invoke('decision.configure', { patch: configure }); if (answer?.ok === false) return answer; }
            if (Object.keys(game).length) { const answer = await invoke('decision.gameSettings.set', { patch: game }); if (answer?.ok === false) return answer; }
            return { ok: true };
        },
    };

    return { entries, court, bank, world, charter, canon, states, actions, call: invoke };
}
