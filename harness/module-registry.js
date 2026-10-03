// @ts-check
import { request } from '../libraries/shared/request.js';

/** @typedef {import('../libraries/core/module-types.js').RegistryOptions} RegistryOptions */
/** @typedef {import('../libraries/core/module-types.js').ModuleRegistry} ModuleRegistry */
/** @typedef {import('../libraries/core/module-types.js').ModuleInstance} ModuleInstance */
/** @typedef {import('../libraries/core/module-types.js').FinalUi} FinalUi */
/** @typedef {import('../libraries/core/module-types.js').PreviewResult} PreviewResult */

/** Где реестр помнит, что было включено. Неймспейс Раннера, а не Модуля: это состояние ЗАПУСКА, а не настройка кого-то из них. */
const RUNNER_NAMESPACE = 'core.runner';
const ENABLED_KEY = 'enabledModules';

/**
 * Реестр живых Модулей: включает и выключает их, помнит состав, держит установку/удаление. Определения ему даёт Раннер.
 *
 * @param {RegistryOptions} options
 * @returns {ModuleRegistry}
 */
export function createModuleRegistry({ engine, uiModules, panelSettled, panelRoot, storageHost, onChanged = () => {}, definitions, ready = Promise.resolve(), problems = () => [], installer = null, rediscover = async () => {} }) {
    /** @type {Map<string, { instance: ModuleInstance, finalUi: FinalUi, hudUi?: FinalUi }>} */
    const live = new Map();
    /** @type {Map<string, string>} id -> текст последней неудачной попытки включить */
    const lastErrors = new Map();
    // Локальная ссылка на состав: тестам (и только им) можно подсунуть свой
    // список лёгких Модулей вместо настоящих определений Раннера — реестру нужен
    // интерфейс Модуля (`create`/`load`/`tree`), не его начинка.
    const DEFS = definitions ?? [];

    /**
     * Кладёт корни включённых Модулей в выделенные им слоты. Отдельным шагом и
     * идемпотентно, потому что слот появляется только ПОСЛЕ того, как панель
     * перерисовалась, а перерисовывается она от смены состава — то есть от
     * того же вызова, что сюда и привёл. Пытаться угадать порядок хуже, чем
     * один раз честно дождаться и доложить корни на место.
     */
    async function attach() {
        await panelSettled();
        // Ищем ВНУТРИ корня панели, а не по всему документу. Корень попадает
        // на страницу позже — его вешает тот, кто собрал движок, — и поиск по
        // `document` во время восстановления состава не находил ничего:
        // Модули включались, слоты рисовались, а деревья оставались снаружи.
        const root = panelRoot?.() ?? document;
        for (const [id, entry] of live) {
            const slot = root.querySelector(`.stme-module-slot[data-module="${id}"]`);
            if (slot && !slot.contains(entry.finalUi.getRoot())) slot.append(entry.finalUi.getRoot());
        }
    }

    /**
     * Список включённых — в Ядро сохранения, тем же способом, что и всё
     * остальное персистентное (см. persisted-list.js). Отдельного «Ядра
     * состояния» для этого не нужно: `storage.settings` и есть Ядро
     * сохранения, ему просто никто не рассказывал про состав Модулей.
     *
     * Пишем СПИСОК ЦЕЛИКОМ после каждой смены, а не по одному ключу на Модуль:
     * иначе удалённый из сборки Модуль оставлял бы за собой вечный `false`.
     */
    function remember() {
        return request(storageHost.own, 'storage.settings.set', {
            params: { namespace: RUNNER_NAMESPACE, key: ENABLED_KEY, value: [...live.keys()] },
        });
    }

    /**
     * Восстановление состава при запуске. Зовётся ОДИН раз и явно — тем, кто
     * собирает движок, и строго после панели: Модулю нужен слот, а слот
     * появляется только когда панель отрисована.
     *
     * Незнакомый id молча пропускается: сборка могла измениться между
     * запусками, и падать из-за Модуля, которого больше нет, — худшее из
     * возможных поведений при старте.
     */
    async function restore() {
        // Состав Модулей приходит от Раннера асинхронно (шапки читаются как текст) — без этого `DEFS` ещё пуст.
        await ready;
        const result = await request(storageHost.own, 'storage.settings.get', {
            params: { namespace: RUNNER_NAMESPACE, key: ENABLED_KEY, fallback: [] },
        });
        /** @type {string[]} */
        const stored = result.ok && Array.isArray(result.value) ? result.value : [];
        const wanted = stored.filter(id => DEFS.some(item => item.id === id));
        for (const id of wanted) {
            try { await enable(id, { remember: false }); }
            catch (error) { console.warn(`[ST Module Engine (Beta)] Could not bring back module "${id}":`, error); }
        }
        return wanted;
    }

    /**
     * @param {string} id
     * @param {{ remember?: boolean }} [options]  `remember: false` — не перезаписывать сохранённый состав (так делает восстановление).
     * @returns {Promise<boolean>}
     */
    async function enable(id, { remember: shouldRemember = true } = {}) {
        if (live.has(id)) return true;
        const definition = DEFS.find(item => item.id === id);
        if (!definition) throw new Error(`module "${id}" is not installed.`);

        // Карантин (нарушил права) действует и на включение: «не включится обратно в рамках установки».
        if (engine.rights?.isQuarantined?.(definition.id)) throw new Error(`module "${id}" is quarantined.`);

        const moduleHost = engine.registerCaller(definition.id, 'modules', definition.rights);
        /** @type {ModuleInstance | null} */
        let instance = null;
        /** @type {FinalUi | null} */
        let finalUi = null;
        try {
            instance = await definition.create(moduleHost);
            await instance.load();
            finalUi = uiModules.enable(definition.id, instance.tree());
            await finalUi.settled();
        } catch (error) {
            // Сбой при включении не оставляет половину Модуля: подписки и дерево снимаются, остальные Модули не затронуты.
            try { instance?.stop?.(); } catch { /* уже сломан — важнее доложить исходную ошибку */ }
            if (finalUi) uiModules.disable(definition.id);
            lastErrors.set(id, error instanceof Error ? error.message : String(error));
            throw error;
        }
        lastErrors.delete(id);
        /** @type {{ instance: ModuleInstance, finalUi: FinalUi, hudUi?: FinalUi }} */
        const entry = { instance, finalUi };
        live.set(id, entry);

        // Модуль вправе иметь ВТОРОЕ дерево — плавающее окно поверх страницы
        // (у трекера это состояние из шины). Оно не в панели, поэтому и
        // монтируется своим Final UI прямо в body.
        if (typeof instance.hud === 'function') {
            const hudUi = uiModules.enable(`${definition.id}:hud`, instance.hud());
            await hudUi.settled();
            document.body.append(hudUi.getRoot());
            entry.hudUi = hudUi;
        }

        onChanged();   // панель узнаёт о новом составе и рисует слот
        await attach(); // и только теперь в этот слот кладётся дерево Модуля
        // Восстановление состава НЕ перезаписывает то, что само же читает.
        if (shouldRemember) await remember();
        return true;
    }

    /**
     * @param {string} id
     * @returns {Promise<boolean>}  `false` — такого включённого Модуля не было.
     */
    async function disable(id) {
        const entry = live.get(id);
        if (!entry) return false;
        entry.instance.stop?.();
        entry.hudUi?.getRoot()?.remove();
        uiModules.disable(`${id}:hud`);
        uiModules.disable(id);
        live.delete(id);
        onChanged();
        await remember();
        return true;
    }

    /**
     * Попросить Модуль показать/спрятать его HUD-окно. GENERIC-канал для
     * точек входа мимо панели (например, кнопки в лаунчере-доке): вызывающий
     * знает только id Модуля и НЕ знает, есть ли у того hud-дерево вообще —
     * вернётся false, и кнопка не сделает вид, что что-то открыла. Никакого
     * хардкода «открыть именно Music» ни в доке, ни здесь.
     *
     * ТУМБЛЕР (решено с пользователем: «с музыкой и графом сделай также,
     * чтобы закрывались»): если HUD уже виден — прячем, а не переоткрываем.
     * Модуль отчитывается о видимости сам (`hudVisible`-сигнал или
     * `isHudVisible()` — у Модулей нет единого канонического вида), поэтому
     * здесь два защитных способа спросить; нет ни того, ни другого —
     * считаем скрытым и просто показываем.
     *
     * @param {string} id
     * @returns {boolean}  `false` — Модуль выключен или не умеет показывать HUD.
     */
    function requestHud(id) {
        const entry = live.get(id);
        if (!entry) return false;
        const instance = entry.instance;
        if (typeof instance?.setHudVisible !== 'function') return false;
        const visibleNow = typeof instance.isHudVisible === 'function'
            ? Boolean(instance.isHudVisible())
            : Boolean(instance.hudVisible?.peek?.());
        instance.setHudVisible(!visibleNow);
        return true;
    }

    /**
     * Подвести живой состав к ЖЕЛАЕМОМУ списку — включить недостающих,
     * выключить лишних, одним вызовом. Потребитель — импорт пресета
     * (карточка Preset панели движка): снапшот бэкапа восстанавливает
     * `core.runner.enabledModules` внутри extensionSettings, но это лишь
     * ЗАПИСЬ — живые экземпляры она сама не строит и не снимает. Ровно
     * тот же разрез, что у `restore()` при старте: настройка — данные,
     * состав — работа реестра.
     *
     * Незнакомые id из целевого списка молча пропускаются (сборка могла
     * измениться — та же дисциплина, что в `restore()`); восстанавливать
     * смысл не имеет: сохранение ИСТИННОГО состава делает сам
     * enable/disable через remember(), и он совпадёт с целевым минус
     * пропущенные.
     *
     * @param {string[]} [wantedIds]
     * @returns {Promise<{ enabled: string[] }>}
     */
    async function reconcile(wantedIds = []) {
        const wanted = (wantedIds ?? []).filter(id => DEFS.some(item => item.id === id));
        const currentlyEnabled = [...live.keys()];
        for (const id of wanted) {
            if (!live.has(id)) {
                try { await enable(id); }
                catch (error) { console.warn(`[ST Module Engine (Beta)] Could not bring in module "${id}" during preset import:`, error); }
            }
        }
        for (const id of currentlyEnabled) {
            if (!wanted.includes(id)) await disable(id);
        }
        return { enabled: [...live.keys()] };
    }

    /**
     * Установить Модуль, показанный `installer.preview()`: сохранить, пересобрать состав и (если он уже был включён) подменить живой
     * экземпляр на новую версию. Само ВКЛЮЧЕНИЕ остаётся отдельным решением пользователя.
     *
     * @param {PreviewResult} previewResult
     */
    async function installModule(previewResult) {
        if (!installer) throw new Error('no installer is wired.');
        const record = await installer.install(previewResult);
        const wasLive = live.has(record.id);
        if (wasLive) await disable(record.id);
        await rediscover();
        onChanged();
        if (wasLive && DEFS.some(item => item.id === record.id)) await enable(record.id);
        return record;
    }

    /** @param {string} id */
    async function uninstallModule(id) {
        if (!installer) throw new Error('no installer is wired.');
        if (live.has(id)) await disable(id);
        const removed = await installer.uninstall(id);
        await rediscover();
        onChanged();
        return removed;
    }

    /**
     * Снять карантин — только явным решением пользователя; потом состав пересобирается, и Модуль снова можно включить.
     * @param {string} id
     */
    async function releaseQuarantine(id) {
        if (!installer) throw new Error('no installer is wired.');
        const released = await installer.releaseQuarantine(id);
        if (released) { engine.rights.unquarantine(id); await rediscover(); onChanged(); }
        return released;
    }

    return {
        installModule, uninstallModule, releaseQuarantine,
        installer,
        list: () => DEFS.map(({ id, title, description, folder, version, origin, tier }) => ({ id, title, description, folder, version, origin, tier, error: lastErrors.get(id) ?? null })),
        /** Источники, которые Раннер не смог превратить в Модуль, — с причиной (плохая шапка, отказ скана, нет зависимости). */
        problems,
        enabled: () => [...live.keys()],
        instance: id => live.get(id)?.instance,
        /** Настройки, которые Модуль разрешил менять гиду (`guideSettings()` → `{ specs, save }`); `null` — Модуль выключен или ничего не объявил. */
        guideSettings: id => live.get(id)?.instance?.guideSettings?.() ?? null,
        /** Инструменты, которые Модуль дал гиду сверх настроек (`guideTools()`: чтение состояния для промпта и операции над его данными); `null` — выключен или не объявил. */
        guideTools: id => live.get(id)?.instance?.guideTools?.() ?? null,
        requestHud,
        enable,
        disable,
        restore,
        reconcile,
    };
}
