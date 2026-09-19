import { request } from '../../libraries/shared/request.js';
import { wireBootScreen } from '../../harness/boot-screen.js';

/**
 * Ядро запуска — порядок того, что происходит при загрузке страницы: проверка обновления → (если страница не перезагружается) фоны из
 * репозитория и синхронизация устройств → закрытие экрана загрузки. Раньше эта последовательность была вплетена в `init()` в
 * `index.js`: вызовы Ядер напрямую по ссылкам, в обход Гейтов и без единого теста; теперь всё идёт контрактами по шине Ядер:
 * `selfUpdate.run`, `backgrounds.sync`, `sync.planLoad`, `sync.start`, `sync.runOnLoad`.
 *
 * Сам экран загрузки создаётся ДО движка (`harness/boot-start.js` — он обязан встать раньше остального графа модулей), поэтому сюда он
 * приходит готовым объектом (`screen`); Ядро только связывает его со стадиями (`wireBootScreen`) и закрывает по итогу.
 *
 * Сбои молчаливы для интерфейса и громки для консоли: ни один шаг не имеет права оставить экран загрузки висеть.
 */

export function createStartupCore(host, { screen = null, wireBoot = wireBootScreen, log = console } = {}) {
    const call = (contract, params = {}) => request(host.own, contract, { params });
    let began = false;

    /** Держать ли экран загрузки ради синхронизации: решается ДО хода самообновления, по одним настройкам. */
    async function planSync() {
        const plan = await call('sync.planLoad');
        return plan.ok && plan.value === true;
    }

    async function begin() {
        if (began) return { outcome: 'already' };
        began = true;
        const holdForSync = await planSync();
        // Подписка ДО `selfUpdate.run`: иначе событие `selfUpdate.checking` уйдёт раньше подписчика.
        wireBoot(screen, host.events, { holdForSync });

        const update = await call('selfUpdate.run');
        if (!update.ok) {
            log.warn?.('[ST Module Engine (Beta)] Self-update skipped:', update.error?.message);
            screen?.finish?.({ afterMs: 0 });
            return { outcome: 'update-failed' };
        }
        const outcome = update.value?.outcome ?? 'no result';
        // Итог печатается ВСЕГДА: без строчки в консоли отличить работающее самообновление от сломанного было нечем.
        log.info?.('[ST Module Engine (Beta)] Self-update:', outcome, update.value?.reason ?? update.value?.error ?? '');
        // Обновилось — страница сейчас перезагрузится, всё остальное пройдёт после перезагрузки.
        if (outcome === 'updated') return { outcome };

        // Фоны из репозитория — не блокируя интерфейс и не дожидаясь.
        call('backgrounds.sync').then(result => { if (!result.ok) log.warn?.('[ST Module Engine (Beta)] Backgrounds sync skipped:', result.error?.message); });

        // Синхронизация устройств: если включена, проход идёт при загрузке (экран держится, но ограниченно — см. boot-screen.js).
        const started = await call('sync.start');
        if (!started.ok) log.warn?.('[ST Module Engine (Beta)] Sync skipped:', started.error?.message);
        else if (holdForSync) {
            const pass = await call('sync.runOnLoad');
            if (!pass.ok) log.warn?.('[ST Module Engine (Beta)] Sync skipped:', pass.error?.message);
        }
        if (holdForSync) screen?.finish?.({ afterMs: 300 });
        return { outcome, holdForSync };
    }

    const unregister = host.own.register('startup.begin', () => begin());
    return { begin, unregister };
}
