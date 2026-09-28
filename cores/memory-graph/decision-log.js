/**
 * Журнал решений графа памяти — MEMORY_GRAPH_FIX_PLAN.md, Этап 6 (наблюдаемость). До этого этапа калибровать числа
 * гейта (Этап 4, `gateWindow`/`thresholdK`) и размещения (Этап 3, `placementMinSimilarity`/`placementMinMargin`)
 * можно было только вслепую — ни разработчик, ни пользователь не видел, ПОЧЕМУ конкретный ход не дал ноды: гейт не
 * сработал, модель отказалась, ответ не распарсился, или узел ушёл в накопитель вместо региона. Кольцевой буфер —
 * последние `limit` записей, старые молча вытесняются (тот же принцип, что у любого журнала отладки: полная
 * история с начала сессии никому не нужна, важен только недавний хвост).
 */

/** Добавляет `entry` в конец `log`, не мутируя исходный массив; лишнее сверх `limit` срезается со СТАРОГО конца (новая запись сохраняется всегда). */
export function appendDecision(log, entry, limit = 100) {
    const next = [...(log ?? []), entry];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Одна строка по-английски для панели (`cores/ui/memory-graph-panel.js`'s секция «Why») — формат зафиксирован
 * собственными примерами плана:
 * `#142 · gate 0.31 > 0.27 · model: node "Kira's heritage" · placed 3:1 (similarity 0.86, margin 0.04)`
 * `#143 · gate 0.12 ≤ 0.27 · model not called`
 *
 * Пара "gate X op Y" — сигнал, который РЕШИЛ исход: если сработал сигнал новизны (`noveltyDistance`), а тема сама
 * по себе не изменилась, показывается именно он (иначе показ topic-пары при факте, что сработала novelty, был бы
 * необъяснимым "0.12 ≤ 0.27" рядом с реально созданной нодой); во всех остальных случаях (тема сработала, либо не
 * сработало ничего) — topic-пара, как основной/первый сигнал в `entry.gate`.
 */
export function summarizeDecision(entry) {
    const { clock, gate, extractor, error, node, placement, capacity } = entry;

    const topicFired = gate.topicDistance > gate.topicThreshold;
    const noveltyFired = gate.noveltyDistance > gate.noveltyThreshold;
    const showNovelty = !topicFired && noveltyFired;
    const distance = showNovelty ? gate.noveltyDistance : gate.topicDistance;
    const threshold = showNovelty ? gate.noveltyThreshold : gate.topicThreshold;
    const cmp = distance > threshold ? '>' : '≤';
    let line = `#${clock} · gate ${distance.toFixed(2)} ${cmp} ${threshold.toFixed(2)}`;
    if (gate.forced) line += ' (forced)';

    if (extractor === 'not-called') line += ' · model not called';
    else if (extractor === 'skip') line += ' · model: skip';
    else if (extractor === 'empty') line += ' · model: empty reply';
    else if (extractor === 'error') line += ` · model: error (${error})`;
    else if (extractor === 'node') line += ` · model: node "${node.label}"`;

    if (placement) {
        if (placement.status === 'staged') {
            line += ' · staged';
        } else {
            const regionLabel = `${placement.region.sector}:${placement.region.ring}`;
            line += placement.similarity !== undefined
                ? ` · placed ${regionLabel} (similarity ${placement.similarity.toFixed(2)}, margin ${placement.margin.toFixed(2)})`
                : ` · placed ${regionLabel} (${placement.reason})`;
        }
    }

    if (capacity && (capacity.evicted.length || capacity.queuedMerge || capacity.queuedReconsolidation)) {
        const bits = [];
        if (capacity.evicted.length) bits.push(`evicted ${capacity.evicted.length}`);
        if (capacity.queuedMerge) bits.push('queued merge');
        if (capacity.queuedReconsolidation) bits.push('queued reconsolidation');
        line += ` · ${bits.join(', ')}`;
    }

    return line;
}
