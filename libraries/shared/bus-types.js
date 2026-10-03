// @ts-check
/**
 * Типы Шин, Гейтов и хоста — общий словарь для всего движка. Файл без кода: только `@typedef` в JSDoc (никакого `.ts`, никакой сборки).
 * Подключение из другого файла:
 *   `/** @typedef {import('../shared/bus-types.js').Envelope} Envelope *\/`
 * Проверка — `npm run typecheck`.
 */

/**
 * @template [T=any]
 * @typedef {{ ok: true, value: T } | { ok: false, error: { message: string, code?: string } }} Envelope
 *   Единый конверт ответа (CONVENTIONS.md §4): через границу Шины никогда не бросается исключение.
 */

/** @typedef {() => void} Unsubscribe */

/**
 * @typedef {Object} EveryCondition
 * @property {string} [event]
 * @property {number} [count]  Каждое N-е событие.
 * @property {number} [ms]  Или по таймеру.
 */

/**
 * Условие доставки (contract-bus.js): когда Шина отдаёт ответ заказчику.
 * @typedef {Object} WhenCondition
 * @property {string} [event]
 * @property {number | EveryCondition} [every]
 * @property {number} [debounceMs]
 * @property {number} [throttleMs]
 * @property {boolean} [dedupe]
 * @property {boolean} [once]
 */

/**
 * @typedef {Object} SubscribeOptions
 * @property {any} [params]
 * @property {WhenCondition} [when]
 * @property {string} [callerId]  Проставляет Гейт/домашняя Шина; подделать из params нельзя.
 * @property {string} [priority]
 */

/**
 * @template [T=any]
 * @typedef {(result: Envelope<T>) => void} DeliveryCallback
 */

/**
 * Что поставщик получает вторым аргументом: личность спрашивающего.
 * @typedef {Object} HandlerMeta
 * @property {string} [callerId]
 * @property {string} [priority]
 */

/** @typedef {(params: any, meta: HandlerMeta) => any} ContractHandler */

/**
 * @typedef {Object} RegisterOptions
 * @property {() => number} [loadMetric]  Заявленная загрузка поставщика: Директор выбирает наименее загруженного.
 */

/**
 * @typedef {Object} Subscribable  То, через что заказчик просит контракт (Шина или Гейт).
 * @property {(contract: string, options: SubscribeOptions | undefined, callback: DeliveryCallback) => Unsubscribe} subscribe
 */

/**
 * @typedef {Object} ContractBus  Шина целиком (то, что создаёт `createContractBus`).
 * @property {(contract: string, handler: ContractHandler, options?: RegisterOptions) => Unsubscribe} register
 * @property {(contract: string, options: SubscribeOptions | undefined, callback: DeliveryCallback) => Unsubscribe} subscribe
 * @property {() => Array<{ contract: string, suppliers: number }>} contracts
 */

/**
 * @typedef {Object} EventBus
 * @property {(eventName: string, payload?: any) => void} emit
 * @property {(eventName: string, callback: (payload: any) => void) => Unsubscribe} subscribe
 */

/**
 * Гейт между доменами: заказчик просит через него, поставщик регистрируется как на обычной Шине.
 * @typedef {Object} GateAccessor
 * @property {(contract: string, options: SubscribeOptions | undefined, callback: DeliveryCallback) => Unsubscribe} subscribe
 * @property {(contract: string, handler: ContractHandler, options?: RegisterOptions) => Unsubscribe} register
 */

/**
 * Домашняя Шина вызывающего: без Гейта (ничего не пересекает границу домена), но с его личностью.
 * @typedef {Object} OwnAccessor
 * @property {(contract: string, options: SubscribeOptions | undefined, callback: DeliveryCallback) => Unsubscribe} subscribe
 * @property {(contract: string, handler: ContractHandler, options?: RegisterOptions) => Unsubscribe} register
 * @property {() => Array<{ contract: string, suppliers: number }>} contracts
 */

/**
 * «Хост» — всё, чем вызывающий (Ядро или Модуль) достаёт до остального движка. Какие Гейты есть, зависит от домашнего домена:
 * Модуль видит `services`/`cores`/`network`, Ядро — `services`/`modules`/`network`.
 * @typedef {Object} Host
 * @property {EventBus} events
 * @property {OwnAccessor} own
 * @property {GateAccessor} [services]
 * @property {GateAccessor} [cores]
 * @property {GateAccessor} [modules]
 * @property {GateAccessor} [network]
 */

/** @typedef {'official' | 'community' | 'scanned-safe' | 'scanned-unsafe'} TrustTier */

/**
 * Что движок знает о вызывающем при `registerCaller` (ARCHITECTURE.md, «Система прав»). Вызывающий не знает и не может подделать
 * свои права: их держит только Ядро прав. `community` читает `allowedContracts`, `scanned-*` — `deniedContracts`.
 * @typedef {Object} RightsConfig
 * @property {TrustTier} tier
 * @property {string[]} [allowedContracts]
 * @property {string[]} [deniedContracts]
 * @property {boolean} [networkAccess]  Отдельное бинарное право, не следует из уровня доверия.
 * @property {boolean} [quarantineOnViolation]  Любое нарушение прав — карантин (внешние Модули).
 */

/** @typedef {{ allowed: true } | { allowed: false, reason: string }} AccessDecision */

/**
 * @typedef {Object} ViolationEvent
 * @property {string} callerId
 * @property {string} contract
 */

/**
 * @typedef {Object} RightsCore
 * @property {(callerId: string, config: RightsConfig) => void} register
 * @property {(callerId: string | undefined) => boolean} isQuarantined
 * @property {(callerId: string) => void} quarantine
 * @property {(callerId: string | undefined, contract: string) => AccessDecision} checkAccess  Неизвестный (`undefined`) вызывающий — отказ.
 * @property {(callerId: string | undefined) => boolean} hasNetworkAccess
 * @property {(listener: (violation: ViolationEvent) => void) => () => void} onViolation
 * @property {(callerId: string) => void} unquarantine
 */

/** @typedef {'modules' | 'cores' | 'services' | 'network'} Domain  Домены Шин. */
/** @typedef {Domain} HomeDomain  Где живёт вызывающий: Модуль и Ядро — на своих Шинах, но регистрироваться вправе и Сервис (у него нет Гейтов наружу). */

/**
 * Собранный движок (`createEngine`).
 * @typedef {Object} Engine
 * @property {EventBus} events
 * @property {Record<Domain, ContractBus>} buses
 * @property {RightsCore} rights
 * @property {(callerId: string, homeDomain: HomeDomain, rightsConfig: RightsConfig) => Host} registerCaller
 * @property {(callerId: string, contract: string, params?: any, options?: { priority?: string }) => Promise<Envelope>} resolveAs
 */

export {};
