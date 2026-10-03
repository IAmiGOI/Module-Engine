import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Overlay, Banner, Button } from '../../libraries/shared/widgets.js';

/**
 * Ядро экрана обновления — то, что видит пользователь, пока движок обновляет
 * сам себя, и то, что он видит, если обновиться не вышло.
 *
 * Ровно две поверхности, обе взяты у Alpha, потому что там они были правильные:
 *
 *  1. **Перекрытие всего экрана** с ожиданием: «нашлась новая версия,
 *     страница перезагрузится сама». Именно ВСЕГО экрана, а не своей панели —
 *     у Alpha это записано как отдельно поставленная задача: пока код меняется
 *     под ногами, работать с ним нельзя.
 *  2. **Полоса вверху страницы** с кнопкой «Retry», если обновление нашлось,
 *     но не применилось. Вне разметки расширения: свёрнутая панель не должна
 *     прятать сообщение о том, что движок остался на старой версии.
 *
 * Чего у Alpha не было, а здесь есть:
 *
 *  - **Никакого DOM.** Там обе поверхности собирались строками `innerHTML`
 *    прямо в `index.js`. Здесь это дерево из общих виджетов (`Overlay`,
 *    `Banner`), и рисует его Ядро финального UI — как и всё остальное.
 *  - **Связи с самообновлением нет.** Ядро самообновления ОБЪЯВЛЯЕТ ход
 *    (`selfUpdate.started`/`applied`/`failed`), это Ядро слушает. Оно не
 *    знает ни про git, ни про GitHub, а самообновление не знает про экран —
 *    у Alpha `attemptCoreUpdate()` сам создавал и удалял свои узлы, то есть
 *    ход обновления и его показ были одним куском кода.
 *  - **Молчание — состояние по умолчанию.** Ни свежая версия, ни не-git
 *    установка, ни отсутствие сети не рисуют ничего: это то же обещание, что
 *    у Ядра самообновления, только теперь его можно проверить с этой стороны.
 *
 * **Почему Ядро, а не Модуль** — по критерию из ARCHITECTURE.md: Модуль
 * подключает пользователь. Сообщение «движок обновляется» не может зависеть
 * от того, включил ли кто-то нужный Модуль.
 */

const BANNER_TEXT = 'ST Module Engine couldn\'t update itself — it is still running the previous version.';
/** Закрытый крестиком баннер не возвращается до перезагрузки вкладки ЗАНОВО-попытки — иначе сообщение из окна остывания всплывало бы после каждой перезагрузки. */
const DISMISSED_KEY = 'stme.beta.updateBannerDismissed';

export function createUpdateOverlayCore(host, { mount } = {}) {
    const updating = signal(false);
    const failure = signal('');
    const retrying = signal(false);
    const dismissed = signal(false);
    /** Известная причина (например, переписанная история) — с готовым решением; `null` для обычной ошибки. */
    const known = signal(null);
    const copied = signal(false);

    // Сессия может быть недоступна (тесты, узлы) — тогда крестик действует до перезагрузки, и только.
    request(host.services, 'session.get', { params: { key: DISMISSED_KEY, fallback: '' }, timeoutMs: 1000 })
        .then(result => { if (result.ok && result.value === '1') dismissed.set(true); })
        .catch(() => {});

    function dismiss() {
        dismissed.set(true);
        request(host.services, 'session.set', { params: { key: DISMISSED_KEY, value: '1' } }).catch(() => {});
    }

    async function copyFix() {
        const command = known.peek()?.fix;
        if (!command) return false;
        try {
            await globalThis.navigator?.clipboard?.writeText(command);
            copied.set(true);
            setTimeout(() => copied.set(false), 2000);
            return true;
        } catch {
            return false;
        }
    }

    async function retry() {
        if (retrying.peek()) return false;
        retrying.set(true);
        try {
            // `force`: пауза между попытками существует против цикла
            // «обновились → перезагрузка → обновились», а не против человека,
            // который нажал кнопку осознанно.
            const result = await request(host.own, 'selfUpdate.run', { params: { force: true } });
            return Boolean(result.ok);
        } finally {
            retrying.set(false);
        }
    }

    /**
     * Текст полосы включает причину, если она есть. «Не обновилось» без
     * причины — ровно то, из-за чего сломанное самообновление невозможно было
     * отличить от нечего-обновлять.
     */
    const bannerText = computed(() => {
        if (known()) return `${BANNER_TEXT} ${known().message}`;
        return failure() && failure() !== BANNER_TEXT ? `${BANNER_TEXT} (${failure()})` : BANNER_TEXT;
    });

    /** Готовая команда и кнопка «Copy» — только для известной причины. */
    const bannerDetail = computed(() => (known()?.fix
        ? h('span', { class: 'stme-banner-fix' },
            h('code', { class: 'stme-banner-code' }, known().fix),
            Button(copied() ? 'Copied' : 'Copy', copyFix))
        : null));

    function tree() {
        return h('div', { class: 'stme-update-ui' },
            Overlay(updating, {
                title: 'ST Module Engine is updating…',
                description: 'A newer version was found. The page will reload automatically once it is applied.',
            }),
            computed(() => (failure() && !dismissed() ? Banner(bannerText, { action: retry, busy: retrying, detail: bannerDetail, onDismiss: dismiss }) : null)),
        );
    }

    const subscriptions = [
        // Обновление НАЧАЛОСЬ — перекрываем экран и убираем прошлую жалобу:
        // повторная попытка не должна идти под полосой от предыдущей.
        host.events.subscribe('selfUpdate.started', () => { failure.set(''); known.set(null); dismissed.set(false); request(host.services, 'session.set', { params: { key: DISMISSED_KEY, value: '' } }).catch(() => {}); updating.set(true); }),
        // Применилось — перекрытие не снимаем: сразу за этим идёт перезагрузка
        // страницы, и мигание «всё пропало → всё вернулось» было бы враньём.
        host.events.subscribe('selfUpdate.applied', () => { updating.set(true); }),
        host.events.subscribe('selfUpdate.failed', payload => {
            updating.set(false);
            known.set(payload?.kind && payload?.fix ? { message: String(payload.message ?? ''), fix: String(payload.fix) } : null);
            failure.set(String(payload?.reason ?? '').trim() || (payload?.kind ? String(payload.kind) : ''));
        }),
        // Обновляться нечего — это НЕ повод что-то показывать.
        host.events.subscribe('selfUpdate.upToDate', () => { updating.set(false); failure.set(''); known.set(null); }),
    ];

    return {
        tree,
        retry,
        dismiss,
        dismissed: () => dismissed.peek(),
        known: () => known.peek(),
        updating: () => updating.peek(),
        failure: () => failure.peek(),
        open: () => mount(tree()),
        stop: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}

