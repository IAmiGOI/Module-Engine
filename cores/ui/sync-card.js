import { h } from './tree.js';
import { signal, computed, effect } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import {
    Button, TextInput, NumberInput, Toggle, Field, Row, Card, Section, Badge, EmptyState, ProgressBar, HoldButton, Select,
} from '../../libraries/shared/widgets.js';
import { describeConnection, describeLastRun, describeProgress, describeSummary } from '../../libraries/shared/sync-panel-model.js';

/**
 * Карточка «Sync» панели движка: сопряжение устройств, что синхронизировать, расписание, прогресс и результат, необязательный
 * репозиторий GitHub. Панель ничего не решает сама — все действия идут в Ядро синхронизации (`sync.*`), а состояние читается
 * из `sync.status` и обновляется по событию `sync.changed`/`sync.progress`, без опроса по таймеру.
 *
 * Настройки сохраняются САМИ через полсекунды после последней правки (как в панели графа памяти) — отдельных «Save» нет.
 * Пока значения подтягиваются из Ядра, автосохранение молчит, иначе чтение настроек тут же записывало бы их обратно.
 */

const CATEGORY_LABELS = Object.freeze([
    ['characters', 'Characters'],
    ['chats', 'Chats (including group chats)'],
    ['worlds', 'Lorebooks'],
    ['backgrounds', 'Backgrounds'],
    ['personas', 'Persona avatars'],
]);

export function createSyncCard({ host, collapse, notify = () => {}, now = () => Date.now(), saveDelayMs = 500 }) {
    const call = (contract, params) => request(host.own, contract, { params: params ?? {} });

    const status = signal(null);
    const clock = signal(now());
    const pairCodeInput = signal('');
    const busy = signal(false);
    const githubMessage = signal('');

    // Значения полей (двусторонняя привязка); подтягиваются из `sync.status`.
    const deviceName = signal('');
    const autoSync = signal(true);
    const intervalMin = signal(10);
    const categories = Object.fromEntries(CATEGORY_LABELS.map(([id]) => [id, signal(true)]));
    const github = { enabled: signal(false), repository: signal(''), branch: signal('main'), token: signal(''), rootDir: signal(''), maxFileMb: signal(25), auto: signal(false) };
    const cloud = { provider: signal('dropbox'), enabled: signal(false), auto: signal(false), code: signal(''), message: signal(''), dropboxKey: signal(''), googleId: signal(''), googleSecret: signal('') };
    let applying = false;

    function applyStatus(next) {
        applying = true;
        status.set(next);
        clock.set(now());
        const config = next.config;
        deviceName.set(config.deviceName);
        autoSync.set(config.autoSync);
        intervalMin.set(config.intervalMin);
        for (const [id] of CATEGORY_LABELS) categories[id].set(config.categories.includes(id));
        github.enabled.set(config.github.enabled);
        github.repository.set(config.github.repository);
        github.branch.set(config.github.branch);
        github.rootDir.set(config.github.rootDir);
        github.maxFileMb.set(config.github.maxFileMb);
        github.auto.set(config.github.auto);
        github.token.set('');
        cloud.provider.set(config.cloud.provider);
        cloud.enabled.set(config.cloud.enabled);
        cloud.auto.set(config.cloud.auto);
        for (const field of [cloud.dropboxKey, cloud.googleId, cloud.googleSecret]) field.set('');
        applying = false;
    }

    async function refresh() {
        const result = await call('sync.status');
        if (result.ok) applyStatus(result.value);
    }

    /** Отправить правку настроек; ответ Ядра (уже нормализованный) заново кладётся в поля. */
    async function save(patch) {
        const result = await call('sync.configure', patch);
        if (!result.ok) { notify('error', `Sync settings were not saved: ${result.error.message}`); return; }
        await refresh();
    }

    const timers = new Map();
    /** Автосохранение одного поля: после `saveDelayMs` тишины отправляет `toPatch(value)`. */
    function bindAutosave(source, toPatch) {
        let first = true;
        return effect(() => {
            const value = source();
            if (first) { first = false; return; }
            if (applying) return;
            clearTimeout(timers.get(source));
            timers.set(source, setTimeout(() => save(toPatch(value)), saveDelayMs));
        });
    }

    const disposers = [
        bindAutosave(deviceName, value => ({ deviceName: value })),
        bindAutosave(autoSync, value => ({ autoSync: value })),
        bindAutosave(intervalMin, value => ({ intervalMin: value })),
        ...CATEGORY_LABELS.map(([id]) => bindAutosave(categories[id], () => ({ categories: CATEGORY_LABELS.map(([key]) => key).filter(key => categories[key].peek()) }))),
        bindAutosave(github.enabled, value => ({ github: { enabled: value } })),
        bindAutosave(github.repository, value => ({ github: { repository: value } })),
        bindAutosave(github.branch, value => ({ github: { branch: value } })),
        bindAutosave(github.rootDir, value => ({ github: { rootDir: value } })),
        bindAutosave(github.maxFileMb, value => ({ github: { maxFileMb: value } })),
        bindAutosave(github.auto, value => ({ github: { auto: value } })),
        bindAutosave(github.token, value => (value ? { github: { token: value } } : {})),
        bindAutosave(cloud.provider, value => ({ cloud: { provider: value } })),
        bindAutosave(cloud.enabled, value => ({ cloud: { enabled: value } })),
        bindAutosave(cloud.auto, value => ({ cloud: { auto: value } })),
        bindAutosave(cloud.dropboxKey, value => (value ? { cloud: { apps: { dropbox: { clientId: value } } } } : {})),
        bindAutosave(cloud.googleId, value => (value ? { cloud: { apps: { google: { clientId: value } } } } : {})),
        bindAutosave(cloud.googleSecret, value => (value ? { cloud: { apps: { google: { clientSecret: value } } } } : {})),
    ];

    // ── Действия ────────────────────────────────────────────────────────────────────────────────────────────────────

    async function guarded(task) {
        if (busy.peek()) return;
        busy.set(true);
        try { await task(); } finally { busy.set(false); await refresh(); }
    }

    const startPairing = () => guarded(async () => {
        const result = await call('sync.pair.start');
        if (!result.ok) notify('error', `Could not start pairing: ${result.error.message}`);
    });
    const joinPairing = () => guarded(async () => {
        const result = await call('sync.pair.join', { code: pairCodeInput.peek() });
        if (!result.ok) notify('error', result.error.message); else pairCodeInput.set('');
    });
    const cancelPairing = () => guarded(async () => { await call('sync.pair.cancel'); });
    const removePair = id => guarded(async () => { await call('sync.pair.remove', { id }); });
    const syncNow = () => { call('sync.run', { target: 'all' }).then(refresh); };
    const abort = () => { call('sync.abort'); };
    const testGithub = () => guarded(async () => {
        githubMessage.set('Checking…');
        const result = await call('sync.github.test');
        githubMessage.set(result.ok ? result.value.message : result.error.message);
    });
    const syncGithubNow = () => { call('sync.run', { target: 'github' }).then(refresh); };
    const forgetToken = () => save({ github: {}, clearToken: true });

    const beginCloud = () => guarded(async () => {
        cloud.message.set('');
        const result = await call('sync.cloud.begin', { provider: cloud.provider.peek() });
        if (!result.ok) cloud.message.set(result.error.message);
    });
    const finishCloud = () => guarded(async () => {
        const result = await call('sync.cloud.finish', { code: cloud.code.peek() });
        if (!result.ok) cloud.message.set(result.error.message); else cloud.code.set('');
    });
    const cancelCloud = () => guarded(async () => { await call('sync.cloud.cancel'); });
    const disconnectCloud = () => guarded(async () => { await call('sync.cloud.disconnect'); cloud.message.set(''); });
    const testCloud = () => guarded(async () => {
        cloud.message.set('Checking…');
        const result = await call('sync.cloud.test');
        cloud.message.set(result.ok ? result.value.message : result.error.message);
    });
    const syncCloudNow = () => { call('sync.run', { target: 'cloud' }).then(refresh); };

    // ── Разметка ────────────────────────────────────────────────────────────────────────────────────────────────────

    const running = computed(() => Boolean(status()?.running));
    const progressView = computed(() => describeProgress(status()?.progress));
    const lastView = computed(() => describeLastRun(status()?.last, clock()));

    function devicesSection() {
        return Section('Devices', collapse.bind('section:sync-devices', { open: true }),
            computed(() => {
                const connections = status()?.connections ?? [];
                if (!connections.length) return EmptyState('No devices paired yet. Show a code here and enter it on the other device (or the other way round).');
                return h('div', { class: 'stme-sync-devices' }, connections.map(connection => {
                    const view = describeConnection(connection, clock());
                    return h('div', { class: 'stme-sync-device', key: connection.id },
                        h('strong', {}, connection.name),
                        Badge(view.state, { tone: view.tone }),
                        h('small', {}, view.lastSync),
                        HoldButton('Hold to unpair', () => removePair(connection.id), { holdMs: 900 }),
                    );
                }));
            }),
            computed(() => {
                const pairing = status()?.pairing;
                if (!pairing || pairing.status === 'cancelled') return null;
                return h('div', { class: 'stme-sync-pairing' },
                    pairing.status === 'waiting' && pairing.mode === 'host' ? h('div', { class: 'stme-sync-code' }, pairing.code) : null,
                    h('p', { class: `stme-update-status stme-update-${pairing.status === 'failed' || pairing.status === 'expired' ? 'error' : pairing.status === 'done' ? 'ok' : 'muted'}` }, pairing.message),
                    pairing.status === 'waiting' ? Button('Cancel pairing', cancelPairing) : null,
                );
            }),
            Row(
                Button('Show a pairing code', startPairing, { disabled: busy }),
                TextInput(pairCodeInput, { placeholder: 'or enter the code from the other device' }),
                Button('Connect', joinPairing, { disabled: computed(() => busy() || !pairCodeInput().trim()) }),
            ),
            Field('This device is called', TextInput(deviceName)),
        );
    }

    function contentSection() {
        return Section('What to sync', collapse.bind('section:sync-content', { open: true }),
            ...CATEGORY_LABELS.map(([id, label]) => Toggle(label, categories[id])),
            Toggle('Sync automatically while paired devices are online', autoSync),
            Field('Every (minutes)', NumberInput(intervalMin, { min: 1, max: 240, step: 1 }), { hint: 'Devices also sync once whenever they connect.' }),
        );
    }

    function githubSection() {
        return Section('GitHub repository (optional)', collapse.bind('section:sync-github'),
            h('p', { class: 'stme-summary-help' }, 'Keeps a copy of the selected files in a repository you own. Only files that changed are uploaded, in a single commit per sync. Use a private repository and a token with write access to it (a fine-grained token limited to that one repository is best).'),
            Toggle('Use GitHub', github.enabled),
            Field('Repository', TextInput(github.repository, { placeholder: 'owner/name or https://github.com/owner/name' })),
            Row(
                Field('Branch', TextInput(github.branch)),
                Field('Folder in the repository', TextInput(github.rootDir, { placeholder: '(root)' })),
            ),
            Field('Token', TextInput(github.token, { type: 'password', placeholder: computed(() => (status()?.config.github.hasToken ? 'saved — type to replace' : 'ghp_… or github_pat_…')) }),
                { hint: 'Stored in this SillyTavern\'s settings on your computer, like the other API keys of this engine.' }),
            Field('Skip files larger than (MB)', NumberInput(github.maxFileMb, { min: 1, max: 95, step: 1 }), { hint: 'GitHub itself refuses files over 100 MB; keep this small to keep the repository light.' }),
            Toggle('Also sync with GitHub in the background', github.auto),
            Row(
                Button('Test connection', testGithub, { disabled: busy }),
                Button('Sync with GitHub now', syncGithubNow, { disabled: running }),
                computed(() => (status()?.config.github.hasToken ? Button('Forget token', forgetToken, { variant: 'danger' }) : null)),
            ),
            computed(() => (githubMessage() ? h('p', { class: 'stme-update-status' }, githubMessage()) : null)),
        );
    }

    const cloudName = computed(() => (cloud.provider() === 'google' ? 'Google Drive' : 'Dropbox'));
    const cloudConnected = computed(() => Boolean(status()?.config.cloud.connected));

    /** Вход в облако: у Dropbox — ссылка и вставка кода, у Google — код для google.com/device (страница сама ждёт подтверждения). */
    function cloudSignInBlock() {
        return computed(() => {
            const auth = status()?.cloudAuth;
            if (!auth || auth.status === 'cancelled') return null;
            const tone = auth.status === 'failed' ? 'error' : auth.status === 'done' ? 'ok' : 'muted';
            return h('div', { class: 'stme-sync-pairing' },
                auth.status === 'waiting' && auth.kind === 'device' ? h('div', { class: 'stme-sync-code' }, auth.userCode) : null,
                auth.status === 'waiting' && auth.url ? h('a', { href: auth.url, target: '_blank', rel: 'noopener noreferrer', class: 'stme-sync-link' }, auth.kind === 'device' ? 'Open google.com/device' : 'Open Dropbox to allow access') : null,
                auth.status === 'waiting' && auth.kind === 'code' ? Row(TextInput(cloud.code, { placeholder: 'paste the code Dropbox shows' }), Button('Finish', finishCloud, { disabled: computed(() => busy() || !cloud.code().trim()) })) : null,
                h('p', { class: `stme-update-status stme-update-${tone}` }, auth.message),
                auth.status === 'waiting' ? Button('Cancel', cancelCloud) : null,
            );
        });
    }

    function cloudSection() {
        return Section('Cloud drive (optional)', collapse.bind('section:sync-cloud'),
            h('p', { class: 'stme-summary-help' }, 'An extra way to keep the files in step: your own Dropbox or Google Drive, in a hidden app folder only this engine can see. Unlike direct sync, the devices do not have to be online at the same time. Only changed files are uploaded. Everything above works without it.'),
            Field('Service', Select(cloud.provider, [{ value: 'dropbox', label: 'Dropbox' }, { value: 'google', label: 'Google Drive' }])),
            computed(() => (cloudConnected()
                ? h('div', { class: 'stme-sync-cloud-connected' },
                    Badge(`connected to ${cloudName()}`, { tone: 'ok' }),
                    Toggle('Use it when syncing', cloud.enabled),
                    Toggle('Also sync with it in the background', cloud.auto),
                    Row(
                        Button('Test connection', testCloud, { disabled: busy }),
                        Button('Sync with the cloud now', syncCloudNow, { disabled: running }),
                        HoldButton('Hold to disconnect', disconnectCloud, { holdMs: 900 }),
                    ))
                : Row(Button(computed(() => `Sign in to ${cloudName()}`), beginCloud, { disabled: busy })))),
            cloudSignInBlock(),
            computed(() => (cloud.message() ? h('p', { class: 'stme-update-status' }, cloud.message()) : null)),
            Section('Use my own app key (advanced)', collapse.bind('section:sync-cloud-keys'),
                h('p', { class: 'stme-summary-help' }, 'Only needed if this build has no built-in key for the service. Create a free app in the service\'s developer console and paste its key here: Dropbox — an "App folder" app, its App key; Google — an OAuth client of type "TVs and Limited Input devices" with the Drive API enabled, its Client ID and secret.'),
                Field('Dropbox app key', TextInput(cloud.dropboxKey, { placeholder: computed(() => (status()?.config.cloud.apps.dropbox.hasClientId ? 'saved — type to replace' : 'App key')) })),
                Field('Google client ID', TextInput(cloud.googleId, { placeholder: computed(() => (status()?.config.cloud.apps.google.hasClientId ? 'saved — type to replace' : 'Client ID')) })),
                Field('Google client secret', TextInput(cloud.googleSecret, { type: 'password', placeholder: computed(() => (status()?.config.cloud.apps.google.hasClientSecret ? 'saved — type to replace' : 'Client secret')) })),
            ),
        );
    }

    function resultBlock() {
        return h('div', { class: 'stme-sync-result' },
            computed(() => {
                const progress = progressView();
                return progress ? h('div', { class: 'stme-sync-progress' }, ProgressBar(progress.percent, progress.label), Button('Stop', abort, { variant: 'danger' })) : null;
            }),
            computed(() => {
                const view = lastView();
                return h('div', { class: `stme-update-status stme-update-${view.tone === 'muted' ? 'idle' : view.tone}` }, view.lines.map((line, index) => h('div', { key: `${index}:${line}` }, line)));
            }),
            Row(computed(() => Button(running() ? 'Syncing…' : 'Sync now', syncNow, { disabled: running }))),
        );
    }

    function card() {
        return Card('Sync', {
            ...collapse.bind('card:sync'),
            subtitle: computed(() => describeSummary(status(), clock())),
        },
            h('p', { class: 'stme-summary-help' }, 'Keeps your characters, chats, lorebooks and backgrounds the same on all your devices. Devices connect to each other directly (no cloud, no size limit) — SillyTavern must be open on both. Only what changed is sent.'),
            resultBlock(),
            devicesSection(),
            contentSection(),
            githubSection(),
            cloudSection(),
        );
    }

    /** События Ядра синхронизации: любое изменение состояния и ход прохода. */
    function watch() {
        return [
            host.events.subscribe('sync.changed', () => { refresh(); }),
            host.events.subscribe('sync.progress', payload => {
                const current = status.peek();
                if (current) status.set({ ...current, progress: payload?.progress ?? null });
            }),
        ];
    }

    function dispose() { for (const timer of timers.values()) clearTimeout(timer); for (const stop of disposers) stop?.(); }

    return { card, watch, refresh, dispose };
}
