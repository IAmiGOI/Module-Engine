/**
 * Читатели состояния для инструментов директора: место по карте, последняя
 * отметка RP Time и близость слов через e5-small. Ошибка любого источника —
 * честная пустота, а не исключение.
 */

export function createPlaceReader(call) {
    return async function resolvePlace() {
        try {
            const position = await call('map.position.get');
            if (!position?.nodeId) return '';
            const nodes = await call('map.nodes.list');
            const path = await call('map.nodes.containmentPath', { id: position.nodeId });
            const byId = new Map((Array.isArray(nodes) ? nodes : []).map(node => [node.id, node]));
            return (Array.isArray(path) ? path : []).map(id => byId.get(id)?.name ?? id).join(' → ');
        } catch { return ''; }
    };
}

export function createTimeReader(call) {
    return async function lastTimeMark() {
        try {
            const marks = await call('chatHistory.annotations', { namespace: 'module.time' });
            const ids = Object.keys(marks ?? {}).sort((a, b) => Number(a) - Number(b));
            return String(marks?.[ids.at(-1)] ?? '');
        } catch { return ''; }
    };
}

