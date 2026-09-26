import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { request } from '../../../libraries/shared/request.js';
import { Button, Toggle, Row, Card } from '../../../libraries/shared/widgets.js';

/** Карточка «Backgrounds»: фоны из репозитория. */
export function createBackgroundsCard(deps) {
    const { host, collapse } = deps;

    // Фоны из репозитория (cores/backgrounds): состояние карточки «Backgrounds».
    const backgroundsStatus = signal(null);

    const backgroundsAuto = signal(true);

    const backgroundsRemoveDeleted = signal(true);

    const backgroundsBusy = signal(false);

    async function refreshBackgrounds() {
        const result = await request(host.own, 'backgrounds.status', { params: {} });
        if (!result.ok) return;
        backgroundsStatus.set(result.value);
        backgroundsAuto.set(result.value.enabled);
        backgroundsRemoveDeleted.set(result.value.removeDeleted);
    }

    async function syncBackgroundsNow() {
        if (backgroundsBusy.peek()) return;
        backgroundsBusy.set(true);
        try {
            await request(host.own, 'backgrounds.sync', { params: { force: true } });
        } finally {
            backgroundsBusy.set(false);
            await refreshBackgrounds();
        }
    }

    const backgroundsSummary = computed(() => {
        const status = backgroundsStatus();
        if (!status) return 'Backgrounds status is not available yet.';
        const last = status.lastOutcome;
        if (backgroundsBusy() || status.running) return 'Syncing…';
        if (!last) return `${status.installedCount} installed. Not synced yet in this session.`;
        if (last.outcome === 'synced') return `${status.installedCount} installed — last sync: +${last.installed} / -${last.removed}${last.failed ? `, ${last.failed} failed` : ''}${last.skipped ? `, ${last.skipped} skipped` : ''}.`;
        if (last.outcome === 'unchanged') return `${status.installedCount} installed — the repository has not changed.`;
        if (last.outcome === 'empty') return 'The backgrounds repository is empty — add an image or video to it and it will appear here.';
        if (last.outcome === 'disabled') return 'Auto-install is off.';
        return `${status.installedCount} installed — last sync did not run (${last.error ?? last.outcome}).`;
    });

    function backgroundsCard() {
        return Card('Backgrounds', {
            ...collapse.bind('card:backgrounds'),
            subtitle: computed(() => (backgroundsStatus() ? `${backgroundsStatus().repository.owner}/${backgroundsStatus().repository.repo}` : 'from a GitHub repository')),
        },
            h('p', { class: 'stme-summary-help' }, 'Any image or video added to the backgrounds repository appears in the SillyTavern background list on the next start, named "stme-<folder>-<file>". Files you delete by hand are not brought back unless they change in the repository.'),
            h('p', { class: 'stme-update-status' }, backgroundsSummary),
            Toggle('Install automatically at startup', backgroundsAuto, { onChange: value => { request(host.own, 'backgrounds.setSettings', { params: { enabled: value } }); } }),
            Toggle('Remove backgrounds deleted from the repository', backgroundsRemoveDeleted, { onChange: value => { request(host.own, 'backgrounds.setSettings', { params: { removeDeleted: value } }); } }),
            Row(computed(() => Button(backgroundsBusy() ? 'Syncing…' : 'Sync now', syncBackgroundsNow))),
        );
    }

    return { refreshBackgrounds, backgroundsCard };
}
