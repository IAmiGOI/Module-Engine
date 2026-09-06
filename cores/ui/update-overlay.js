import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Overlay, Banner } from '../../libraries/shared/widgets.js';

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

export function createUpdateOverlayCore(host, { mount } = {}) {
    const updating = signal(false);
    const failure = signal('');
    const retrying = signal(false);

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
    const bannerText = computed(() => (failure() && failure() !== BANNER_TEXT ? `${BANNER_TEXT} (${failure()})` : BANNER_TEXT));

    function tree() {
        return h('div', { class: 'stme-update-ui' },
            Overlay(updating, {
                title: 'ST Module Engine is updating…',
                description: 'A newer version was found. The page will reload automatically once it is applied.',
            }),
            computed(() => (failure() ? Banner(bannerText, { action: retry, busy: retrying }) : null)),
        );
    }

    const subscriptions = [
        // Обновление НАЧАЛОСЬ — перекрываем экран и убираем прошлую жалобу:
        // повторная попытка не должна идти под полосой от предыдущей.
        host.events.subscribe('selfUpdate.started', () => { failure.set(''); updating.set(true); }),
        // Применилось — перекрытие не снимаем: сразу за этим идёт перезагрузка
        // страницы, и мигание «всё пропало → всё вернулось» было бы враньём.
        host.events.subscribe('selfUpdate.applied', () => { updating.set(true); }),
        host.events.subscribe('selfUpdate.failed', payload => {
            updating.set(false);
            failure.set(String(payload?.reason ?? '').trim());
        }),
        // Обновляться нечего — это НЕ повод что-то показывать.
        host.events.subscribe('selfUpdate.upToDate', () => { updating.set(false); failure.set(''); }),
    ];

    return {
        tree,
        retry,
        updating: () => updating.peek(),
        failure: () => failure.peek(),
        open: () => mount(tree()),
        stop: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}

