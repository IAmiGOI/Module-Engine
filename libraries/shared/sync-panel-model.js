/**
 * Модель карточки «Sync» — чистые функции «состояние Ядра → человеческие строки». Интерфейс ничего не форматирует сам: строит
 * дерево из этих значений, поэтому формулировки проверяются тестами, а не глазами.
 */

export function formatAgo(now, then) {
    if (!then) return 'never';
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Итог одной стороны прохода одной строкой: «2 sent, 1 received, 1 removed». Пусто, если ничего не менялось. */
export function describeCounts(counts = {}, { sent = 'sent', received = 'received' } = {}) {
    const parts = [];
    if (counts.pushed) parts.push(`${counts.pushed} ${sent}`);
    if (counts.pulled) parts.push(`${counts.pulled} ${received}`);
    const removed = (counts.deletedLocal ?? 0) + (counts.deletedRemote ?? 0);
    if (removed) parts.push(`${removed} removed`);
    if (counts.conflicts) parts.push(`${plural(counts.conflicts, 'conflict')} kept as a copy`);
    if (counts.deferred) parts.push(`${counts.deferred} postponed (open chat)`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    return parts.length ? parts.join(', ') : 'everything up to date';
}

/** Итог последнего прохода → строки для показа и тон (`ok` / `warn` / `error` / `muted`). */
export function describeLastRun(last, now) {
    if (!last) return { tone: 'muted', lines: ['Not synced yet in this session.'] };
    if (last.outcome === 'busy') return { tone: 'muted', lines: ['A sync is already running.'] };
    const lines = [];
    let tone = 'ok';
    for (const peer of last.peers ?? []) {
        if (peer.outcome === 'offline') { lines.push('The device went offline.'); tone = 'warn'; continue; }
        if (peer.outcome === 'requested') { lines.push(`Asked ${peer.pair ?? 'the other device'} to sync.`); continue; }
        if (peer.outcome === 'failed') { lines.push(`${peer.error ?? 'Sync with the device failed.'}`); tone = 'error'; continue; }
        lines.push(`${peer.pair ?? 'Device'}: ${describeCounts(peer.counts)}`);
        for (const message of peer.errors ?? []) lines.push(`⚠ ${message}`);
        if (peer.counts?.failed || peer.ok === false) tone = tone === 'error' ? 'error' : 'warn';
    }
    if (last.github) {
        const github = last.github;
        if (github.outcome === 'unconfigured') lines.push('GitHub: not configured.');
        else if (github.outcome === 'failed') { lines.push(`GitHub: ${github.errors?.[0] ?? 'failed'}`); tone = 'error'; }
        else {
            lines.push(`GitHub: ${describeCounts(github.counts, { sent: 'uploaded', received: 'downloaded' })}`);
            for (const message of github.errors ?? []) lines.push(`⚠ ${message}`);
            if (github.counts?.failed || github.ok === false) tone = tone === 'error' ? 'error' : 'warn';
        }
    }
    if (last.cloud) {
        const cloud = last.cloud;
        const name = cloud.provider === 'google' ? 'Google Drive' : 'Dropbox';
        if (cloud.outcome === 'unconfigured') lines.push('Cloud drive: not connected.');
        else if (cloud.outcome === 'failed') { lines.push(`${name}: ${cloud.errors?.[0] ?? 'failed'}`); tone = 'error'; }
        else {
            lines.push(`${name}: ${describeCounts(cloud.counts, { sent: 'uploaded', received: 'downloaded' })}`);
            for (const message of cloud.errors ?? []) lines.push(`⚠ ${message}`);
            if (cloud.counts?.failed || cloud.ok === false) tone = tone === 'error' ? 'error' : 'warn';
        }
    }
    if (last.error) { lines.push(last.error); tone = 'error'; }
    if (!lines.length) lines.push('No devices are online right now.');
    if (last.at) lines.push(formatAgo(now, last.at));
    return { tone: lines.length === 1 && !last.at ? 'muted' : tone, lines };
}

export function describeProgress(progress) {
    if (!progress) return null;
    const total = progress.total || 0;
    const percent = total > 0 ? Math.min(100, Math.round((progress.done / total) * 100)) : 0;
    const where = progress.target === 'github' ? 'GitHub' : String(progress.target ?? '').replace(/^device:/, '') || 'device';
    const verb = progress.phase === 'scanning' ? 'Checking files' : 'Syncing';
    const file = progress.path ? ` — ${String(progress.path).split('/').slice(-1)[0]}` : '';
    return { percent, label: `${verb} with ${where}: ${progress.done ?? 0}/${total}${file}` };
}

export function describeConnection(connection, now) {
    const tone = connection.status === 'open' ? 'ok' : connection.status === 'connecting' ? 'warn' : 'muted';
    const state = connection.status === 'open' ? 'online' : connection.status === 'connecting' ? 'connecting…' : 'offline';
    return { tone, state, lastSync: `last sync: ${formatAgo(now, connection.lastSync)}` };
}

export function describeSummary(status, now) {
    if (!status) return 'Sync status is not available yet.';
    const count = status.config.pairs.length;
    const online = status.connections.filter(item => item.status === 'open').length;
    const parts = [count ? `${plural(count, 'device')} paired, ${online} online` : 'No devices paired'];
    if (status.config.github.enabled) parts.push('GitHub on');
    if (status.config.cloud?.enabled) parts.push(`${status.config.cloud.provider === 'google' ? 'Google Drive' : 'Dropbox'} on`);
    if (status.last?.at) parts.push(`last sync ${formatAgo(now, status.last.at)}`);
    return parts.join(' · ');
}
