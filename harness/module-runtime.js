// @ts-check
import { request } from '../libraries/shared/request.js';
import { createRunnerCore, STME_PATHS } from '../cores/runner/index.js';
import { createModuleInstaller } from '../cores/runner/installer.js';

/** @typedef {import('../libraries/core/module-types.js').RunnerEntry} RunnerEntry */
/** @typedef {import('../libraries/core/module-types.js').RunnerCore} RunnerCore */
/** @typedef {import('../libraries/core/module-types.js').InstallerCore} InstallerCore */
/** @typedef {import('../libraries/shared/bus-types.js').Engine} Engine */
/** @typedef {import('../libraries/shared/bus-types.js').Host} Host */

/**
 * @typedef {Object} ModuleRuntime
 * @property {RunnerCore} runner
 * @property {InstallerCore} installer
 * @property {Promise<unknown>} ready  Когда определения готовы (реестр ждёт его в `restore()`).
 * @property {() => Promise<unknown>} rediscover  Пересобрать состав после установки/удаления.
 */

/**
 * Версия движка для проверки `engine:` в шапках Модулей (RUNTIME.md). Совпадает с версией в manifest.json (без хвоста «Beta»).
 */
export const ENGINE_VERSION = '0.2.1';

/**
 * Встроенные Модули — только ГДЕ они лежат. Всё остальное (id, название, права, зависимости) живёт в шапке самого файла и читается
 * Раннером ([cores/runner/index.js](../cores/runner/index.js)) как текст. Списка путей не избежать: у браузера нет «прочитать папку»,
 * а динамический `import()` нужен литералом, чтобы сборщик/ST его вообще нашёл.
 *
 * Права встроенных намеренно `community` с явным списком контрактов, а не `official`: Модуль, который едет вместе с движком, всё равно
 * обязан ходить тем же путём, что и чужой, — иначе Гейт на этом пути никогда бы не проверялся.
 *
 * @type {RunnerEntry[]}
 */
export const BUILTIN_MODULES = [
    { origin: 'builtin', path: 'modules/tracker/index.js', load: () => import('../modules/tracker/index.js') },
    { origin: 'builtin', path: 'modules/time/index.js', load: () => import('../modules/time/index.js') },
    { origin: 'builtin', path: 'modules/tools/notebook.js', load: () => import('../modules/tools/notebook.js') },
    { origin: 'builtin', path: 'modules/tools/secrets.js', load: () => import('../modules/tools/secrets.js') },
    { origin: 'builtin', path: 'modules/postprocess/index.js', load: () => import('../modules/postprocess/index.js') },
    { origin: 'builtin', path: 'modules/music/index.js', load: () => import('../modules/music/index.js') },
    { origin: 'builtin', path: 'modules/scene-painter/index.js', load: () => import('../modules/scene-painter/index.js') },
    { origin: 'builtin', path: 'modules/speaker-colors/index.js', load: () => import('../modules/speaker-colors/index.js') },
    { origin: 'builtin', path: 'modules/map/index.js', load: () => import('../modules/map/index.js') },
];

/**
 * Текст встроенного Модуля — ради шапки. В браузере это fetch того же файла; в Node (тесты) — файловая система.
 * @param {string} path  Путь от корня движка.
 * @returns {Promise<string>}
 */
async function readBuiltinSource(path) {
    const url = new URL(`../${path}`, import.meta.url);
    if (url.protocol === 'file:') {
        // Имя модуля — через переменную: в браузере эта ветка не выполняется, а типы Node проекту не нужны.
        const nodeFs = 'node:fs/promises';
        return (await import(nodeFs)).readFile(url, 'utf8');
    }
    const response = await globalThis.fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return response.text();
}

/**
 * `stme:<путь>` → адрес модуля движка либо `null`, если такого пути нет. Ищет ТОЛЬКО собственные ключи: `stme:constructor` или
 * `stme:toString` не должны «находиться» через прототип объекта и превращаться в странный адрес.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function resolveStme(path) {
    if (!Object.hasOwn(STME_PATHS, path)) return null;
    return new URL(`../${STME_PATHS[/** @type {keyof typeof STME_PATHS} */ (path)]}`, import.meta.url).href;
}

/**
 * Раннер со встроенными Модулями; `ready` — когда определения готовы (реестр ждёт его в `restore()`).
 *
 * @param {{ engine?: Engine, entries?: RunnerEntry[] }} [options]
 * @returns {{ runner: RunnerCore, ready: Promise<unknown> }}
 */
export function createBuiltinRunner({ engine, entries = BUILTIN_MODULES } = {}) {
    const runner = createRunnerCore({
        engineVersion: ENGINE_VERSION,
        readSource: readBuiltinSource,
        resolveStme,
        isQuarantined: id => Boolean(engine?.rights?.isQuarantined?.(id)),
    });
    const ready = runner.discover(entries);
    return { runner, ready };
}

const RUNNER_NAMESPACE_KEY = 'core.runner';
/** Резерв на случай, если вызвали до первой сборки: id встроенных известны заранее. */
const BUILTIN_IDS_FALLBACK = ['module.tracker', 'module.time', 'module.notebook', 'module.secrets', 'module.postprocess', 'module.music', 'module.scenePainter', 'module.speakerColors', 'module.map'];

/**
 * Полный рантайм: Раннер + установщик внешних Модулей. Список установленных и карантин лежат в `storage.settings` под неймспейсом
 * Раннера; сеть для скачивания идёт через сетевую Шину от ОТДЕЛЬНОГО Ядра с `networkAccess` — самим Модулям сеть для этого не нужна.
 * Нарушение прав внешним Модулем (карантин) сохраняется сразу и действует и после перезапуска.
 *
 * @param {{ engine: Engine, storageHost: Host, entries?: RunnerEntry[], importBlob?: (source: string) => Promise<any> }} options
 *   `importBlob` — подмена загрузки проверенного текста (в Node нет `blob:`-импортов; тесты используют `data:`).
 * @returns {ModuleRuntime}
 */
export function createModuleRuntime({ engine, storageHost, entries = BUILTIN_MODULES, importBlob }) {
    const networkHost = engine.registerCaller('core.runner.installer', 'cores', { tier: 'official', networkAccess: true });
    /** @type {import('../libraries/core/module-types.js').InstallerStore} */
    const store = {
        read: async (key, fallback) => {
            const result = await request(storageHost.own, 'storage.settings.get', { params: { namespace: RUNNER_NAMESPACE_KEY, key, fallback } });
            return result.ok ? result.value ?? fallback : fallback;
        },
        write: (key, value) => request(storageHost.own, 'storage.settings.set', { params: { namespace: RUNNER_NAMESPACE_KEY, key, value } }),
    };

    /** @type {import('../libraries/core/module-types.js').InstallerOptions['fetchText']} */
    const fetchText = async url => {
        const result = await request(/** @type {import('../libraries/shared/bus-types.js').GateAccessor} */ (networkHost.network), 'http.request', { params: { url, method: 'GET' }, timeoutMs: 20000 });
        return result.ok ? { ok: Boolean(result.value?.ok), status: result.value?.status, text: result.value?.text ?? '' } : { ok: false, status: 0, text: '' };
    };

    /** @type {RunnerCore | null} */
    let runner = null;
    const installer = createModuleInstaller({
        fetchText, store, resolveStme,
        reservedIds: () => (runner?.definitions ?? []).filter(item => item.origin === 'builtin').map(item => item.id).concat(BUILTIN_IDS_FALLBACK),
    });
    const createdRunner = createRunnerCore({
        engineVersion: ENGINE_VERSION,
        readSource: readBuiltinSource,
        ...(importBlob ? { importBlob } : {}),
        resolveStme,
        isQuarantined: id => installer.isQuarantined(id) || Boolean(engine.rights.isQuarantined(id)),
    });
    runner = createdRunner;
    engine.rights.onViolation(violation => { void installer.recordQuarantine(violation); });

    const rediscover = () => createdRunner.discover([...entries, ...installer.sources()]);
    const ready = installer.load().then(rediscover);
    return { runner: createdRunner, installer, ready, rediscover };
}
