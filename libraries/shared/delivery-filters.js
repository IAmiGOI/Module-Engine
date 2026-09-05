/**
 * Фильтры доставки — «каждый N-й», debounce, throttle, dedupe — вокруг
 * произвольного обработчика. Ровно та обвязка, которую в Alpha каждый
 * модуль писал руками у себя (Tracker's `turnCounters`/`pollTimers`,
 * Notebook's собственный анти-дребезг, и т.д.). В Beta она живёт здесь, а
 * применяет её Ядро событий — чтобы в самом Ядре/Модуле не было НИ ОДНОЙ
 * строчки этой логики (ARCHITECTURE.md, приоритеты №1 «простота написания
 * модуля» и №3 «динамические соединения регулируются на уровне ядра, без
 * участия модулей»).
 *
 * Порядок применения фиксирован и осмыслен: `dedupe` → `every` →
 * `throttleMs` → `debounceMs`. Сначала выбрасываем повторы (они не должны
 * тратить счётчик `every`), потом считаем каждый N-й, потом режем частоту,
 * и только в конце — откладываем до тишины.
 *
 * `cancel()` обязателен при отписке: незакрытый debounce-таймер иначе
 * доставит событие уже отписанному обработчику (та же болезнь «утёкшего
 * слушателя», которую Alpha ловила у себя в module-engine).
 */
function safeKey(payload) {
    try { return JSON.stringify(payload); }
    catch { return String(payload); }
}

export function applyDeliveryFilters(handler, { every, debounceMs, throttleMs, dedupe } = {}) {
    let count = 0;
    let lastDeliveredAt = 0;
    let timer = null;
    let lastKey;
    let hasLastKey = false;

    function deliver(payload) {
        if (dedupe) {
            const key = safeKey(payload);
            if (hasLastKey && key === lastKey) return;
            lastKey = key;
            hasLastKey = true;
        }
        if (every > 1) {
            count += 1;
            if (count % every !== 0) return;
        }
        if (throttleMs) {
            const now = Date.now();
            if (lastDeliveredAt && now - lastDeliveredAt < throttleMs) return;
            lastDeliveredAt = now;
        }
        if (debounceMs) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; handler(payload); }, debounceMs);
            return;
        }
        handler(payload);
    }

    return { deliver, cancel: () => { if (timer) { clearTimeout(timer); timer = null; } } };
}
