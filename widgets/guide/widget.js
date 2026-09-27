/**
 * Виджет гида на рабочем столе: портрет 3×4 слева, справа имя, её последняя реплика и полоса прогресса чек-листа первого запуска; клик по портрету или по кнопке — открыть её чат
 * (Ядро гида, cores/guide). Как и все виджеты, ничего не импортирует: данные берёт контрактом `guide.status`, открывает `guide.open`, обновляется по событию `guide.changed`.
 */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const WIDTH = 350;
const HEIGHT = 172;
const PAD = 12;
const PORTRAIT_H = HEIGHT - 2 * PAD;
const TEXT_X = PAD + Math.round(PORTRAIT_H * 3 / 4) + 16;   // правее портрета 3×4
const LINE_H = 20;
const LINES = 3;
const SEGMENT_GAP = 5;

/** Полоса чек-листа из сегментов: `[{ left, width, done }]` — чистая раскладка, чтобы её можно было проверить без DOM. */
export function segmentLayout(total, done, { left = TEXT_X, right = WIDTH - PAD, gap = SEGMENT_GAP } = {}) {
    if (!total) return [];
    const width = (right - left - gap * (total - 1)) / total;
    return Array.from({ length: total }, (_, index) => ({ left: Math.round(left + index * (width + gap)), width: Math.floor(width), done: index < done }));
}

export default {
    id: 'guide',
    title: 'Guide',
    description: 'Your guide to Module Engine: her portrait, her last words, the first-start progress, and one click to chat.',
    size: { w: WIDTH, h: HEIGHT },
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
                const line = status?.busy ? 'Thinking…' : (status?.lastLine || 'Hi! Click me to talk.');
                const list = status?.checklist ?? [];
                const done = list.filter(item => item.done).length;
                const barTop = HEIGHT - PAD - 6;
                const segments = segmentLayout(list.length, done).map(segment => {
                    const box = `left:${segment.left}px;top:${barTop}px;width:${segment.width}px;height:6px`;
                    return `<div class="${segment.done ? 'wg-fill' : 'wg-track'}" style="${box}"></div>`;
                }).join('');
                const progress = list.length ? (done === list.length ? 'First start — all done' : `First start — ${done} of ${list.length} done`) : '';
                return `<div class="hb"><div class="wg-title" style="left:${TEXT_X}px;top:${PAD + 1}px;right:84px;font-size:16px;line-height:22px">${escapeHtml(name)}</div>`
                    + `<div class="wg-lead" style="left:${TEXT_X}px;top:${PAD + 32}px;right:${PAD + 2}px;height:${LINES * LINE_H}px;white-space:normal;overflow:hidden">${escapeHtml(line)}</div>`
                    + (list.length ? `<div class="wg-muted" style="left:${TEXT_X}px;top:${barTop - 22}px;right:${PAD}px">${escapeHtml(progress)}</div>${segments}` : '')
                    + '</div>';
            },
            rows() {
                return [{ id: 'guide', portrait: true, image: status?.avatar || undefined, imageFallback: (status?.name ?? 'G').slice(0, 1), click: 'open', actions: [] }];
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
