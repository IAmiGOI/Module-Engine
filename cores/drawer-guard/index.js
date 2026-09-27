import { request } from '../../libraries/shared/request.js';

/**
 * Тонкая обёртка над `services/st-drawer-guard.js`: решает КОГДА держать защиту включённой — всегда, с загрузки страницы и до конца
 * сессии, никакого переключателя пользователю не нужно (это не настройка Модуля — это то, что чинит саму механику самой ST). Логика
 * «свой ли это клик» и работа с `.pinnedOpen` — целиком в Сервисе; здесь только факт «уже установлено ли», чтобы `install()` не ставил
 * второй слушатель при повторном вызове.
 */
export function createDrawerGuardCore(host) {
    const call = (contract, params = {}) => request(host.services, contract, { params });
    let installed = false;

    async function install() {
        if (installed) return true;
        const result = await call('stDrawerGuard.install');
        installed = result.ok && result.value === true;
        return installed;
    }

    async function uninstall() {
        if (!installed) return true;
        const result = await call('stDrawerGuard.uninstall');
        if (result.ok && result.value === true) installed = false;
        return !installed;
    }

    return { install, uninstall };
}
