import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { request } from '../../../libraries/shared/request.js';
import { Toggle, Card } from '../../../libraries/shared/widgets.js';
import { DEFAULT_SIDE_MARGIN } from '../../../libraries/shared/chat-viewport-overlay-math.js';
import { createChatViewportOverlay } from '../chat-viewport-overlay/overlay.js';
import { resolveChatViewportEnabled } from '../../../libraries/shared/chat-viewport-math.js';

/** Карточка «Chat Viewport»: тумблер, отступы, сохранение состояния. */
export function createChatViewportCard(deps) {
    const { chatViewport, inputBar, home, host, callService, callServiceOrThrow, notify, collapse, isMobile } = deps;

    // --- Chat Viewport (план `chat-viewport`) — единственная реальная точка
    // включения. Раньше `chatViewport.attach()` вызывался ТОЛЬКО из
    // демо-кнопки харнесса — в настоящей панели движка не было НИЧЕГО, что
    // бы его включало, поэтому в реальном UI подавление `#chat` не могло
    // сработать в принципе (владелец поймал это конкретно: "чат не
    // подавляется" → "переключатель забыл внести в UI"). Живёт в экране
    // НАСТРОЕК (см. `settingsTree()` ниже), не в основной вкладке — тот же
    // раздел, что даёт доступ к "Engine"/"Preset"/"Updates".
    const chatViewportEnabled = signal(false);

    const chatViewportBusy = signal(false);

    // owner (уточнено ПОСЛЕ первой версии — та по умолчанию совпадала с
    // шириной #chat, то есть с настоящей ST-настройкой `chat_width`
    // (--sheldWidth, обычно 50vw), а НЕ со страницей): "Сделать ВО ВСЮ
    // ширину страницы [по умолчанию]. Отступ чисто небольшой дефолтно,
    // чтобы было читаемо. Далее — можно сузить до любой ширины, не меньше
    // ДЕФОЛТНОЙ для ST" — значит: по умолчанию оверлей должен занимать всю
    // СТРАНИЦУ (не #chat), с небольшим фиксированным отступом для
    // читаемости, а сужать можно вплоть до ПОЛОВИНЫ страницы (ST-дефолт
    // `chat_width: 50` из `power-user.js`) — не до текущей настройки
    // владельца (которая может отличаться), а именно до захардкоженного
    // ST-дефолта. `DEFAULT_SIDE_MARGIN`/`MIN_WIDTH_FRACTION` — см.
    // `libraries/shared/chat-viewport-overlay-math.js`.
    // px, симметрично с обеих сторон (одна ручка сужает сразу оба края,
    // держа контент по центру; независимые отступы слева/справа —
    // усложнение, не запрошенное явно, не делаем, пока owner не попросит
    // именно это).
    const chatViewportSideMargin = signal(DEFAULT_SIDE_MARGIN);

    // Весь DOM оверлея — `cores/ui/chat-viewport-overlay/`; панель только просит включить/выключить и показывает исход.
    const chatViewportOverlay = chatViewport
        ? createChatViewportOverlay({
            host, chatViewport, callService, callServiceOrThrow,
            sideMargin: chatViewportSideMargin,
            onMarginCommit: () => saveChatViewportState(),
        })
        : null;

    async function enableChatViewport() {
        if (!chatViewportOverlay || chatViewportOverlay.isActive()) return;
        chatViewportBusy.set(true);
        try {
            // Своя панель набора и боковая панель (верхняя полоса ST в левом углу) — ДО оверлея: он снимает размеры уже с ними
            // (верхней полосы над чатом больше нет, снизу — пилюля). Не вышло с оверлеем — возвращаем родное.
            await inputBar?.enable();
            const result = await chatViewportOverlay.enable();
            if (result.ok) await home?.enable();   // главный экран из блоков — вместо стартового экрана ST
            if (!result.ok) {
                await inputBar?.disable();
                chatViewportEnabled.set(false);
                await notify('error', 'Chat Viewport: this browser has no WebGL — staying on the native chat.');
            }
        } catch (error) {
            await inputBar?.disable();
            chatViewportEnabled.set(false);
            await notify('error', `Chat Viewport failed to start: ${error.message}`);
        } finally {
            chatViewportBusy.set(false);
        }
    }

    async function disableChatViewport() {
        if (!chatViewportOverlay?.isActive()) return;
        chatViewportBusy.set(true);
        try {
            await home?.disable();
            await inputBar?.disable();
            await chatViewportOverlay.disable();
        } finally {
            chatViewportBusy.set(false);
        }
    }

    function chatViewportCard() {
        return Card('Chat Viewport (experimental)', { ...collapse.bind('card:chatViewport') },
            h('p', { class: 'stme-summary-help' }, 'Renders the chat history through our own WebGL-backed viewport instead of SillyTavern\'s native chat. On by default on phones (SillyTavern\'s native chat layout breaks there), off by default on a computer — this is early and only approximates real SillyTavern layout (see ROADMAP).'),
            Toggle('Enabled', chatViewportEnabled, {
                onChange: async value => { await (value ? enableChatViewport() : disableChatViewport()); await saveChatViewportState(); },
                hint: computed(() => (chatViewportBusy() ? 'Starting…' : '')),
            }),
            // Ползунок ширины нарочно НЕ здесь — owner: "нужно ТЯНУТЬ
            // физически. Не ползунком где-то там". Заужение — ручки по краям
            // самого канваса в чате (см. `leftHandle`/`rightHandle` в
            // `enableChatViewport()`), а не отдельный контрол в настройках.
        );
    }

    /** Включён ли Chat Viewport и ширина заужения — переживают перезагрузку страницы. */
    function saveChatViewportState() {
        return request(host.own, 'storage.settings.set', {
            params: { namespace: 'core.ui.panel', key: 'chatViewport', value: { enabled: chatViewportEnabled.peek(), sideMargin: chatViewportSideMargin.peek() } },
        });
    }

    async function restoreChatViewportState() {
        const result = await request(host.own, 'storage.settings.get', { params: { namespace: 'core.ui.panel', key: 'chatViewport', fallback: {} } });
        const saved = (result.ok ? result.value : null) ?? {};
        if (Number.isFinite(saved.sideMargin)) chatViewportSideMargin.set(saved.sideMargin);
        // Явный выбор пользователя важнее всего; если его не было — на телефоне включаем (см. `resolveChatViewportEnabled`).
        // Неудавшийся запуск выбор НЕ записывает, поэтому на следующей загрузке телефон попробует снова.
        if (resolveChatViewportEnabled(saved, { mobile: isMobile() })) {
            chatViewportEnabled.set(true);
            // ST к этому моменту может ещё не дорисовать чат — включаем с небольшой задержкой.
            setTimeout(() => { enableChatViewport(); }, 1500);
        }
    }

    return { chatViewportCard, restoreChatViewportState };
}
