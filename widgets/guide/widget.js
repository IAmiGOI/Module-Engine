/**
 * Виджет гида на рабочем столе: аватар, последняя реплика и прогресс чек-листа первого запуска; клик — открыть её чат (Ядро гида, cores/guide).
 * Как и все виджеты, ничего не импортирует: данные берёт контрактом `guide.status`, открывает `guide.open`, обновляется по событию `guide.changed`.
 */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export default {
    id: 'guide',
    title: 'Guide',
    description: 'Your guide to Module Engine: her last words, the first-start checklist, and one click to chat.',
    size: { w: 280, h: 150 },
    rights: ['guide.status', 'guide.open'],
    create(host) {
        let status = null;
        let unsubscribe = null;
        const refresh = async () => {
            const result = await host.request('guide.status');
            if (result?.ok) { status = result.value; host.invalidate(); }
        };
        const open = () => { void host.request('guide.open'); };
        return {
            html() {
                const name = status?.name ?? 'Guide';
                const line = status?.busy ? 'Thinking…' : (status?.lastLine || 'Hi! Click to talk to me.');
                const list = status?.checklist ?? [];
                const done = list.filter(item => item.done).length;
                const { rowsTop, rowH } = host.layout;
                return `<div class="hb"><div class="wg-title" style="left:14px;top:12px;right:56px">${escapeHtml(name)}</div>`
                    + `<div class="wg-text" style="left:64px;top:${rowsTop + 2}px;right:12px;height:${rowH - 4}px;overflow:hidden">${escapeHtml(line)}</div>`
                    + (list.length ? `<div class="wg-muted" style="left:14px;top:${rowsTop + rowH + 8}px;right:12px">First start: ${done} of ${list.length} done</div>` : '')
                    + '</div>';
            },
            rows() {
                return [{ id: 'guide', image: status?.avatar || undefined, imageFallback: (status?.name ?? 'G').slice(0, 1), click: 'open', actions: [] }];
            },
            actions: [{ id: 'open', icon: 'fa-comments', title: 'Open the chat' }],
            onAction(id) { if (id === 'open') open(); },
            async start() {
                unsubscribe = host.subscribe?.('guide.changed', () => { void refresh(); });
                await refresh();
            },
            stop() { unsubscribe?.(); unsubscribe = null; },
        };
    },
};
