// @ts-check
/**
 * Типы рантайма Модулей (RUNTIME.md). Файл НЕ содержит кода: только `@typedef` в JSDoc, чтобы типы жили в тех же `.js`, без `.ts` и без
 * сборки. Подключаются из других файлов так:
 *   `/** @typedef {import('./module-types.js').ModuleMeta} ModuleMeta *\/`
 * Проверка — `npm run typecheck` (tsc --noEmit только как линтер; в движок он не попадает).
 */

/**
 * @typedef {Object} Requirement  Зависимость Модуля: `module.tracker@^1.0`.
 * @property {string} id
 * @property {string} range
 */

/**
 * @typedef {Object} ModuleMeta  Разобранная шапка `@module`.
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} version
 * @property {string} engine
 * @property {Requirement[]} requires
 * @property {string[]} rights
 * @property {boolean} network
 * @property {string | null} folder
 * @property {string} factory
 */

/**
 * @typedef {{ ok: true, meta: ModuleMeta, errors: [] } | { ok: false, meta: null, errors: string[] }} HeaderResult
 */

/** @typedef {import('../shared/bus-types.js').TrustTier} TrustTier */
/** @typedef {import('../shared/bus-types.js').RightsConfig} RightsConfig */
/** @typedef {import('../shared/bus-types.js').Host} Host */

/**
 * @typedef {Object} ScanFinding
 * @property {string} rule
 * @property {'block' | 'unsafe'} severity
 * @property {string} message
 * @property {number} line
 */

/**
 * @typedef {Object} ScanResult
 * @property {'scanned-safe' | 'scanned-unsafe' | 'rejected'} tier
 * @property {ScanFinding[]} findings
 * @property {string[]} deniedContracts
 */

/**
 * @typedef {Object} AnalysisParts  Общее для обоих исходов разбора внешнего Модуля.
 * @property {ScanFinding[]} findings
 * @property {string[]} deniedContracts
 * @property {string[]} errors  Человеческие причины отказа (пусто при `ok: true`).
 */

/**
 * Итог разбора внешнего Модуля (`analyzeExternalModule`). При `ok: true` шапка и хэш точно есть, уровень — не `rejected`;
 * при `ok: false` шапка может быть (id занят, находки скана) или отсутствовать (плохая шапка, слишком большой файл).
 * @typedef {(AnalysisParts & { ok: true, meta: ModuleMeta, tier: 'scanned-safe' | 'scanned-unsafe', hash: string })
 *   | (AnalysisParts & { ok: false, meta: ModuleMeta | null, tier: 'rejected', hash: string | null })} Analysis
 */

/**
 * @typedef {Object} ModuleInstance  То, что возвращает фабрика Модуля.
 * @property {() => (void | Promise<void>)} load
 * @property {() => any} tree  Дерево интерфейса Модуля (его Final UI монтирует реестр).
 * @property {() => void} [stop]
 * @property {() => any} [hud]  Второе дерево — плавающее окно поверх страницы.
 * @property {(visible: boolean) => void} [setHudVisible]
 * @property {() => boolean} [isHudVisible]
 * @property {{ peek?: () => boolean }} [hudVisible]  Сигнал видимости окна (у Модулей нет единого канонического вида).
 * @property {() => any} [guideSettings]  Настройки, которые Модуль разрешил менять гиду (`{ specs, save }`).
 * @property {() => any} [guideTools]  Инструменты, которые Модуль дал гиду сверх настроек.
 */

/**
 * @typedef {Object} ModuleDefinition  Определение, которое Раннер отдаёт реестру.
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} [folder]
 * @property {string} version
 * @property {'builtin' | 'installed'} origin
 * @property {TrustTier} tier
 * @property {string | null} hash
 * @property {ScanFinding[]} findings
 * @property {RightsConfig} rights
 * @property {(host: Host) => Promise<ModuleInstance>} create  Загружает код и создаёт экземпляр Модуля для выданного ему хоста.
 */

/**
 * Final UI одного дерева: корень в DOM и «когда дерево отрисовано».
 * @typedef {Object} FinalUi
 * @property {() => Element} getRoot
 * @property {() => Promise<void>} settled
 */

/**
 * @typedef {Object} UiModules  Ядро UI Модулей: даёт каждому дереву свой независимый Final UI.
 * @property {(id: string, tree: any) => FinalUi} enable
 * @property {(id: string) => void} disable
 */

/**
 * Определение в том виде, в каком его принимает реестр: тесты подсовывают лёгкие заглушки без версии и происхождения.
 * @typedef {Pick<ModuleDefinition, 'id' | 'title' | 'description' | 'rights' | 'create'> & Partial<Pick<ModuleDefinition, 'folder' | 'version' | 'origin' | 'tier'>>} RegistryDefinition
 */

/**
 * @typedef {Object} RegistryOptions
 * @property {import('../shared/bus-types.js').Engine} engine
 * @property {UiModules} uiModules
 * @property {() => Promise<void>} panelSettled  Когда панель отрисована (слоты Модулей появляются только после этого).
 * @property {() => ParentNode | null} [panelRoot]  Корень панели; `null` — искать по всему документу.
 * @property {Host} storageHost  Хост Ядра с правом на `storage.settings`: от его имени реестр помнит состав.
 * @property {() => void} [onChanged]
 * @property {RegistryDefinition[]} [definitions]  Живой массив Раннера (или заглушки в тестах).
 * @property {Promise<unknown>} [ready]  Когда определения готовы: `restore()` ждёт его.
 * @property {() => RunnerProblem[]} [problems]
 * @property {InstallerCore | null} [installer]
 * @property {() => Promise<unknown>} [rediscover]  Пересобрать состав после установки/удаления.
 */

/**
 * @typedef {Object} RegistryListItem
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} [folder]
 * @property {string} [version]
 * @property {string} [origin]
 * @property {string} [tier]
 * @property {string | null} error  Причина последней неудачной попытки включить.
 */

/**
 * @typedef {Object} ModuleRegistry
 * @property {() => RegistryListItem[]} list
 * @property {() => string[]} enabled
 * @property {(id: string) => ModuleInstance | undefined} instance
 * @property {(id: string, options?: { remember?: boolean }) => Promise<boolean>} enable
 * @property {(id: string) => Promise<boolean>} disable
 * @property {() => Promise<string[]>} restore
 * @property {(wantedIds?: string[]) => Promise<{ enabled: string[] }>} reconcile
 * @property {(id: string) => boolean} requestHud
 * @property {(id: string) => any} guideSettings
 * @property {(id: string) => any} guideTools
 * @property {() => RunnerProblem[]} problems
 * @property {InstallerCore | null} installer
 * @property {(previewResult: PreviewResult) => Promise<InstalledInfo>} installModule
 * @property {(id: string) => Promise<boolean>} uninstallModule
 * @property {(id: string) => Promise<boolean>} releaseQuarantine
 */

/**
 * @typedef {Object} RunnerEntry  Источник Модуля для Раннера.
 * @property {'builtin' | 'installed'} origin
 * @property {string} path
 * @property {string} [source]  Исходник (у установленных — из хранилища).
 * @property {() => Promise<any>} [load]  Для встроенных — обычный `import()`.
 */

/**
 * @typedef {Object} RunnerOptions  Настройки Ядра Раннера.
 * @property {string} engineVersion  Версия движка для проверки `engine:` в шапках.
 * @property {(path: string) => Promise<string>} readSource  Текст встроенного Модуля (ради шапки).
 * @property {(path: string) => string | null | undefined} [resolveStme]  `stme:<путь>` → адрес модуля движка.
 * @property {(source: string) => Promise<any>} [importBlob]  Загрузить проверенный текст как ES-модуль.
 * @property {(id: string, hash: string) => boolean} [isQuarantined]
 * @property {Map<string, string>} [available]  Не-Модули (Ядра), которые можно требовать: id → версия.
 */

/**
 * @typedef {Object} RunnerCore
 * @property {(entries: RunnerEntry[]) => Promise<{ definitions: ModuleDefinition[], problems: RunnerProblem[] }>} discover
 * @property {ModuleDefinition[]} definitions  Живой массив: `discover` заполняет его на месте.
 * @property {() => RunnerProblem[]} problems
 * @property {(id: string) => { id: string, version: string, origin: string, tier: TrustTier, hash: string | null } | null} info
 */

/**
 * Установленный Модуль в хранилище (исходник лежит рядом — запуск не зависит от сети).
 * @typedef {Object} InstalledModule
 * @property {string} id
 * @property {string} title
 * @property {string} version
 * @property {string} url  Откуда скачан (прямой адрес `index.js`).
 * @property {'verified' | 'thirdParty'} kind
 * @property {string} hash  SHA-256 исходника.
 * @property {string} source
 * @property {number} installedAt
 */

/** @typedef {Omit<InstalledModule, 'source'>} InstalledInfo  То, что показывается и возвращается наружу: без исходника. */

/**
 * @typedef {Object} QuarantineRecord
 * @property {string} id
 * @property {string | null} hash  Хэш установленной копии на момент нарушения.
 * @property {string} contract  Контракт, за которым он полез.
 * @property {number} at
 */

/**
 * @typedef {Object} Catalog
 * @property {CatalogEntry[]} verified
 * @property {CatalogEntry[]} thirdParty
 * @property {string[]} errors  Каждая половина каталога падает отдельно.
 */

/**
 * Хранилище установщика (`storage.settings` под неймспейсом Раннера).
 * @typedef {Object} InstallerStore
 * @property {<T>(key: string, fallback: T) => Promise<T>} read
 * @property {(key: string, value: unknown) => Promise<unknown>} write
 */

/**
 * @typedef {Object} InstallerOptions
 * @property {(url: string) => Promise<{ ok: boolean, status?: number, text: string }>} fetchText  Сеть — инъекцией.
 * @property {InstallerStore} store
 * @property {() => string[]} [reservedIds]  id встроенных Модулей, которые занять нельзя.
 * @property {((path: string) => string | null | undefined) | null} [resolveStme]
 * @property {() => number} [now]
 */

/**
 * Предпросмотр: разбор Модуля ДО установки — то, что видит пользователь перед согласием.
 * @typedef {import('./module-types.js').Analysis & {
 *   entry: CatalogEntry | null,
 *   source: string | null,
 *   requestedRights: string[],
 *   requestsNetwork: boolean,
 *   replaces: string | null }} PreviewResult
 */

/**
 * @typedef {Object} InstallerCore
 * @property {() => Promise<string>} getCatalogRepository
 * @property {(value: string) => Promise<unknown>} setCatalogRepository
 * @property {() => Promise<{ installed: InstalledInfo[], quarantined: QuarantineRecord[] }>} load
 * @property {() => InstalledInfo[]} list
 * @property {() => RunnerEntry[]} sources
 * @property {(repository: string | RepoRef) => Promise<Catalog>} fetchCatalog
 * @property {(entryOrLink: CatalogEntry | string) => Promise<PreviewResult>} preview
 * @property {(previewResult: PreviewResult) => Promise<InstalledInfo>} install
 * @property {(id: string) => Promise<boolean>} uninstall
 * @property {(id: string | undefined) => boolean} isQuarantined
 * @property {(violation: { callerId: string, contract: string }) => Promise<void>} recordQuarantine
 * @property {(id: string) => Promise<boolean>} releaseQuarantine
 * @property {() => QuarantineRecord[]} quarantineList
 */

/**
 * @typedef {Object} RunnerProblem
 * @property {string | null} id
 * @property {string} path
 * @property {string} origin
 * @property {'invalid' | 'rejected' | 'blocked' | 'quarantined'} state
 * @property {string} reason
 * @property {ScanFinding[]} findings
 */

/**
 * @typedef {Object} ModuleLink  Ссылка на файл Модуля в GitHub.
 * @property {string} owner
 * @property {string} repo
 * @property {string} ref  Ветка/тег/`HEAD`.
 * @property {string} path  Путь к ФАЙЛУ Модуля (не к папке).
 */

/**
 * @typedef {Object} RepoRef  Репозиторий каталога; `ref` по умолчанию `HEAD`.
 * @property {string} owner
 * @property {string} repo
 * @property {string} [ref]
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {'verified' | 'thirdParty'} kind
 * @property {string} name
 * @property {string} url  Прямой адрес `index.js`.
 * @property {ModuleLink} link
 */

export {};
