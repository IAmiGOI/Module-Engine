import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Card, Badge } from '../../../libraries/shared/widgets.js';

/** Карточка «Updates»: ручная проверка обновления движка. */
export function createUpdatesCard(deps) {
    const { call, flash, notify, collapse, repository } = deps;

    const updateText = signal('Not checked yet.');

    const updateTone = signal('muted');

    const updateBusy = signal(false);

    // Та же вспышка обводки, что и у проверки подключения («Test»): синяя
    // пульсация пока идёт запрос, зелёная/красная — на исход. Раньше об
    // исходе проверки версии движка говорил только текст статуса, и его
    // легко было не заметить рядом с остальной панелью.
    const updateFlash = signal('');

    /**
     * Обновление. До этого оно жило ТОЛЬКО в консоли: ход запускался при
     * старте и молчал, что бы ни случилось, — а «молчит, когда сказать нечего»
     * незаметно превратилось в «молчит всегда», и отличить работающее
     * самообновление от сломанного было нечем. Здесь оно наконец видно и
     * запускается руками.
     */
    async function checkUpdates() {
        updateBusy.set(true);
        updateText.set('Checking…');
        updateTone.set('muted');
        // Синяя пульсация, ровно как у «Test» на воркере, пока идёт запрос.
        updateFlash.set('testing');
        // `force`: явное нажатие не должно молча упираться в паузу между
        // попытками — она существует против цикла «обновились → перезагрузка →
        // обновились», а не против пользователя.
        const result = await call('selfUpdate.run', { force: true });
        updateBusy.set(false);
        if (!result.ok) {
            updateTone.set('error'); updateText.set(result.error.message); flash(updateFlash, 'error');
            await notify('error', `Update check failed: ${result.error.message}`); return;
        }

        const { outcome, error, reason, diagnosis } = result.value ?? {};
        const mismatch = diagnosis?.applicable && !diagnosis.matches;
        if (outcome === 'updated') {
            updateTone.set('ok'); updateText.set('Updated — reloading SillyTavern…'); flash(updateFlash, 'ok');
            await notify('ok', 'Engine updated — reloading'); return;
        }
        if (outcome === 'failed') {
            updateTone.set('error'); updateText.set(error ?? 'Update failed.'); flash(updateFlash, 'error');
            await notify('error', `Update failed: ${error ?? 'unknown reason'}`); return;
        }
        if (outcome === 'unavailable') {
            updateTone.set('error');
            flash(updateFlash, 'error');
            // Самая частая причина — копия, положенная руками: git-эндпоинтов
            // у такой установки нет вовсе. Говорим это прямо, а не «ошибка», —
            // и ДОСЛОВНО показываем, чем ответила ST: без этого «не работает
            // обновление» невозможно отличить от «обновляться нечем».
            updateText.set(`SillyTavern cannot check this copy — it is not a git install, or its update endpoints refused. Update the folder by hand.${reason ? ` (${reason})` : ''}`);
            await notify('error', 'Update check unavailable for this install');
            return;
        }
        if (mismatch) {
            // Ровно тот случай, ради которого сверка с GitHub и существует.
            updateTone.set('error');
            flash(updateFlash, 'error');
            updateText.set(`SillyTavern says up to date at ${String(diagnosis.localSha).slice(0, 7)}, but GitHub's "${diagnosis.branch}" is at ${String(diagnosis.remoteSha).slice(0, 7)}. The local checkout is stuck behind origin.`);
            await notify('error', 'Local copy is behind GitHub despite SillyTavern saying otherwise');
            return;
        }
        updateTone.set('ok');
        flash(updateFlash, 'ok');
        updateText.set(diagnosis?.applicable
            ? `Up to date — commit ${String(diagnosis.localSha).slice(0, 7)} on "${diagnosis.branch}" matches GitHub.`
            : 'Up to date, as far as SillyTavern can tell (GitHub was not reachable for a direct check).');
        await notify('ok', 'Engine is up to date');
    }

    function updatesCard() {
        return Card('Updates', {
            ...collapse.bind('card:updates'),
            subtitle: 'Where this engine comes from, and whether it is current',
            className: computed(() => (updateFlash() ? `stme-flash stme-flash-${updateFlash()}` : '')),
        },
            Row(
                computed(() => Badge(repository().owner && repository().repo ? `${repository().owner}/${repository().repo}` : 'repository unknown', { tone: 'muted' })),
                computed(() => Badge(repository().extensionName ? `folder: ${repository().extensionName}` : 'folder unknown', { tone: repository().extensionName ? 'muted' : 'error' })),
            ),
            h('p', { class: computed(() => `stme-update-status stme-update-${updateTone()}`) }, updateText),
            Row(computed(() => Button(updateBusy() ? 'Checking…' : 'Check for updates', checkUpdates))),
        );
    }

    return { updatesCard };
}
