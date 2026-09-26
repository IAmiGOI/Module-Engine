import { request } from '../../../libraries/shared/request.js';

/** Вызовы Сервисов/Ядер для Ядра Chat Viewport: `serviceOrThrow` / `serviceOrNull` (шина services) и `coreOrNull` (шина cores через `host.own`). */
export function installCalls(ctx) {
    const { host } = ctx;

    async function serviceOrThrow(contract, params) {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    async function serviceOrNull(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    /**
     * `ui.messageFooter.*` — НАЙДЕНО ЖИВЬЁМ, дважды подряд. Во-первых, эти
     * контракты зарегистрированы `message-footer.js` на шине 'cores' (тем
     * же `host.own.register`), а не 'services' — вызов через `serviceOrNull`
     * (который ходит в `host.services`) молча проваливался («ok: false» →
     * `null`, контракта там просто нет). Во-вторых, `host.cores` для
     * САМОГО этого Ядра (оно и есть Ядро, домашняя шина уже 'cores') не
     * существует вовсе — `engine.js`'s `registerCaller()` заводит по
     * гейтовому accessor'у ТОЛЬКО на ДРУГИЕ домены (`gates['cores'] =
     * {services, modules, network}`), а Ядро↔Ядро НЕ пересекает границу
     * домена — оба сидят на ОДНОЙ И ТОЙ ЖЕ шине 'cores', обмен идёт через
     * `host.own` (её же используют регистрации ЭТОГО САМОГО Ядра чуть выше)
     * без всякого Гейта. `modules/time/index.js`'s `call()` зовёт те же
     * контракты через `host.cores` НЕ случайно — Модуль↔Ядро ДЕЙСТВИТЕЛЬНО
     * пересекает домен, гейт там есть; у Ядра-вызывающего этой же цели
     * нужен другой accessor.
     */
    async function coreOrNull(contract, params) {
        const result = await request(host.own, contract, { params });
        return result.ok ? result.value : null;
    }
    Object.assign(ctx, { serviceOrThrow, serviceOrNull, coreOrNull });
}
