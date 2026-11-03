import { h } from './tree.js';

/** Строки проверок писателя и формы — только рисование, данные приходят событиями. */
function checkOdds(probabilities) {
    return Object.entries(probabilities ?? {})
        .filter(([id]) => id === 'user_agency' || id === 'past_resolution')
        .map(([id, value]) => `${id} ${Math.round(Number(value) * 100)}%`)
        .join(' · ');
}

export function writerCheckNode(row) {
    if (row.skipped) return h('div', { class: 'stme-dw-warning' }, `Writer check skipped: ${row.error || 'no classifier answer'}`);
    if (row.phase === 'rewrite') return h('div', { class: 'stme-dw-warning' }, `Rewrite attempt ${row.attempt}: ${row.quote || 'no quote'}${row.reasons ? ` — ${row.reasons}` : ''}`);
    const head = `Writer check: ${checkOdds(row.probabilities) || '—'}`;
    const tail = row.exhausted ? ' — delivered after the rewrite limit' : (row.aborted ? ` — discarded, attempt ${row.attempt}` : ' — accepted');
    return h('div', { class: `stme-dw-check${row.aborted || row.exhausted ? ' stme-dw-warning' : ''}` }, `${head}${tail}${row.quote ? ` · ${row.quote}` : ''}`);
}

export function formCheckNode(row) {
    if (row.skipped) return h('div', { class: 'stme-dw-warning' }, 'Form check skipped: the classifier did not answer.');
    const head = row.name ? `Form check — ${row.name}: ${Number.isFinite(Number(row.chance)) ? `${Math.round(Number(row.chance) * 100)}%` : '—'}` : 'Form check';
    const tail = row.refused ? ' — returned to the director' : (row.warnings?.length ? ' — accepted with a note' : ' — accepted');
    return h('div', { class: `stme-dw-check${row.refused ? ' stme-dw-warning' : ''}` }, `${head}${tail}${row.quote ? ` · ${row.quote}` : ''}`);
}
