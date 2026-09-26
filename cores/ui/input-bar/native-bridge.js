/**
 * Мост к родной панели набора ST. Своя пилюля (`pill.js`) — только вид: текст, отправка и остановка идут через РОДНЫЕ элементы
 * (`#send_textarea`, `#send_but`, `#mes_stop`), поэтому слэш-команды, черновики, вложения и всё, что ST делает при отправке, работают как раньше.
 * Родная панель при включённой пилюле спрятана CSS'ом (`display: none`), но остаётся в документе.
 *
 * Всё браузерное приходит инъекцией (`document`, `MutationObserverCtor`) — мост целиком проверяется на подставном DOM.
 */
export function createNativeBridge({ document: doc = globalThis.document, MutationObserverCtor = globalThis.MutationObserver } = {}) {
    const byId = id => doc.getElementById?.(id) ?? null;
    const win = () => doc.defaultView ?? globalThis;
    const textarea = () => byId('send_textarea');

    /** Родная панель на месте — без неё пилюле не к чему подключаться, и включаться нельзя. */
    const available = () => Boolean(textarea() && byId('send_but'));

    const readText = () => textarea()?.value ?? '';

    /** Записывает текст в родное поле и сообщает ST событием `input` — так же, как набрал бы человек (черновик, счётчики, кнопки). */
    function writeText(value) {
        const el = textarea();
        if (!el || el.value === value) return;
        el.value = value;
        const EventCtor = win().Event ?? globalThis.Event;
        el.dispatchEvent(new EventCtor('input', { bubbles: true }));
    }

    /** «Закрыть чат» — родной пункт меню ST (`#option_close_chat`; в разметке ST два таких `id`, срабатывает любой — обработчик висит на обоих). */
    const closeChat = () => { byId('option_close_chat')?.click(); };
    const send = () => { byId('send_but')?.click(); };
    const stop = () => { byId('mes_stop')?.click(); };

    /** Идёт ли генерация — по родной кнопке «Стоп»: ST показывает её (`display: flex`) на время ответа и прячет после. */
    function isGenerating() {
        const el = byId('mes_stop');
        if (!el) return false;
        return win().getComputedStyle(el).display !== 'none';
    }

    /** `handler(generating)` — при каждой смене состояния (не на каждую мутацию). Возвращает отписку. */
    function watchGenerating(handler) {
        const right = byId('rightSendForm');
        if (!right || typeof MutationObserverCtor !== 'function') return () => {};
        let last = isGenerating();
        const observer = new MutationObserverCtor(() => {
            const now = isGenerating();
            if (now === last) return;
            last = now;
            handler(now);
        });
        observer.observe(right, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
        return () => observer.disconnect();
    }

    /** `handler()` — когда родное поле изменили не мы (ST очистил после отправки, восстановил черновик чата, слэш-команда). */
    function watchNativeText(handler) {
        const el = textarea();
        if (!el) return () => {};
        el.addEventListener('input', handler);
        return () => el.removeEventListener('input', handler);
    }

    /** Две родные кнопки слева (меню и расширения): сами узлы переезжают в левый док (у ST на них висят попапы и обработчики), потом возвращаются. */
    function takeLeftButtons() {
        const nodes = ['options_button', 'extensionsMenuButton'].map(byId).filter(Boolean);
        const parent = byId('leftSendForm');
        return {
            nodes,
            restore: () => { if (parent) for (const node of nodes) parent.append(node); },
        };
    }

    return { available, readText, writeText, send, stop, closeChat, isGenerating, watchGenerating, watchNativeText, takeLeftButtons };
}
