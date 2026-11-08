/**
 * Что роль пишет прямо сейчас: прогресс аргументов вызова из потока модели
 * (`model.generate.toolProgress`) → `decision.cycle.writing` для окна The Court.
 * Пока модель пишет раздел в 15 тысяч знаков, лента показывает файл и строки,
 * а не молчит до конца вызова. Мысли этого не касаются — их ведёт capture.js.
 */
export function watchToolProgress(host, prefix, { publishEvent }) {
    const runId = String(prefix ?? '').replace(/:$/, '');
    return host.events.subscribe('model.generate.toolProgress', payload => {
        if (!String(payload?.requestId ?? '').startsWith(prefix)) return;
        const calls = (Array.isArray(payload.calls) ? payload.calls : []).map(call => ({
            name: String(call?.name ?? ''), path: String(call?.path ?? ''), lines: Number(call?.lines) || 0, chars: Number(call?.chars) || 0,
        })).filter(call => call.name);
        if (calls.length) publishEvent('decision.cycle.writing', { runId, calls });
    });
}
