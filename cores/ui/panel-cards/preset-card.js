import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Card } from '../../../libraries/shared/widgets.js';

/** Карточка «Preset»: экспорт/импорт снимка настроек. */
export function createPresetCard(deps) {
    const { call, flash, notify, callService, collapse } = deps;

    // Карточка Preset: та же вспышка обводки, что у проверки обновления, и
    // флаг «идёт импорт» — импорт асинхронный (файл → снапшот → reconcile
    // всех Модулей), и без него кнопка выглядела бы мёртвой на время работы.
    const presetFlash = signal('');

    const presetBusy = signal(false);

    /**
     * Пресет — один файл со ВСЕЙ настройкой движка. Экспортируется ТОЛЬКО
     * источник `settings` (extensionSettings — настройки всех Ядер и
     * Модулей, включая `core.runner.enabledModules`, то есть состав
     * Модулей): chat-scoped данные (граф памяти, саммари, аннотации —
     * источник `chatMemory`) в пресете не нужны и могут весить десятки
     * мегабайт. Никакой своей сборки здесь нет: набор источников решает
     * сборщик движка (engine-wiring.js), панель лишь называет нужные.
     *
     * Импорт: файл пользователь выбирает САМ (виджет `h('input type=file')`
     * со своим `on:change` — vnode нельзя «нажать» за него, см. тот же
     * приём в Модуле Music) → `file.readText` (Сервис, а не FileReader
     * напрямую) → JSON.parse → `backup.import` → перезагрузка страницы.
     *
     * Почему перезагрузка, а не «перечитать в живые Ядра»: конфигурацию
     * Ядра подняли из storage один раз при старте движка
     * (`restoreWorkers()`/`load()`/...), повторный прогон этих путей
     * небезопасен — `summaryCore.load()`, например, повторно регистрирует
     * этапы пайплайна и подписки. Перезагрузка — тот же паттерн, что у
     * самообновления: движок при старте восстанавливает всё из записанного
     * пресетом состояния сам, каждый Ядро — своим собственным путём.
     */
    async function exportPreset() {
        const result = await call('backup.export', { sourceIds: ['settings'] });
        if (!result.ok) { flash(presetFlash, 'error'); await notify('error', result.error.message); return; }
        const stamp = new Date().toISOString().slice(0, 10);
        const saved = await callService('file.download', { filename: `stme-preset-${stamp}.json`, content: JSON.stringify(result.value, null, 2) });
        flash(presetFlash, saved.ok ? 'ok' : 'error');
        await notify(saved.ok ? 'ok' : 'error',
            saved.ok ? 'Preset downloaded — all settings and the module set in one file.' : saved.error.message);
    }

    async function importPreset(file) {
        if (!file) return;
        presetBusy.set(true);
        try {
            const read = await callService('file.readText', { file });
            if (!read.ok) { flash(presetFlash, 'error'); await notify('error', read.error.message); return; }
            let snapshot;
            try { snapshot = JSON.parse(read.value); }
            catch (error) { flash(presetFlash, 'error'); await notify('error', `Not a valid preset file: ${error.message}`); return; }
            const imported = await call('backup.import', { snapshot });
            if (!imported.ok) { flash(presetFlash, 'error'); await notify('error', imported.error.message); return; }
            flash(presetFlash, 'ok');
            const sources = imported.value.join(', ') || 'none';
            await notify('ok', `Preset imported (sources: ${sources}) — reloading the page to apply it.`);
            // Дать тосту дожить: страница уйдёт раньше, чем его увидят,
            // если перезагрузить в тот же тик.
            setTimeout(() => { window.location.reload(); }, 600);
        } finally {
            presetBusy.set(false);
        }
    }

    function presetCard() {
        /**
         * file-input НЕ рисуется как системная плитка «Choose file»: на части
         * поверхностей встроенная кнопка выбора файла не отрисовывается вовсе
         * (пользователь видел «просто текст»). Виджет у нас — `Button()`, а
         * инпут нужен только как носитель диалога выбора: держим его
         * СКРЫТЫМ рядом с кнопкой и кликаем программно из её обработчика —
         * легально, потому что вызов идёт из пользовательского клика.
         * Пара «кнопка + инпут» — СОСЕДИ под общим `<div>`: обработчик
         * кнопки находит инпут запросом по этому div'у. Дерево — vnode'ы,
         * слушатели ставит Сервис DOM на настоящие узлы, поэтому
         * `querySelector` в обработчике честно находит живой инпут.
         */
        const fileInput = h('input', {
            type: 'file', accept: 'application/json,.json', class: 'stme-preset-file-hidden',
            'on:change': event => {
                const input = event.target;
                importPreset(input.files?.[0]);
                input.value = '';
            },
        });
        const pickFile = h('div', {
            class: 'stme-preset-pick',
            // Слушатель на ОБЁРТКЕ, а не на кнопке: клик по кнопке всплывает
            // сюда, и инпут — ПРЯМОЙ ребёнок этой обёртки, его поиск не
            // зависит ни от `closest`/`parent` (у настоящих DOM-узлов нет
            // `.parent` — ровно на этом первый вариант и сломался в реальном
            // ST, хотя в фейковом документе тестов работал), ни от глубины.
            'on:click': event => {
                const wrapper = event.currentTarget;
                for (const child of wrapper.children ?? []) {
                    if (child.tagName === 'INPUT' && child.type === 'file') { child.click(); return; }
                }
            },
        },
            Button('Import preset file…'),
            fileInput,
        );
        return Card('Preset', {
            ...collapse.bind('card:preset'),
            subtitle: 'All settings + the module set, in one file',
            className: computed(() => (presetFlash() ? `stme-flash stme-flash-${presetFlash()}` : '')),
        },
            h('p', { class: 'stme-summary-help' }, 'Export downloads everything the engine remembers globally — all settings and which modules are enabled. Import restores it and reloads the page. Chat-scoped data (memory graph, summaries, per-chat notes) is not part of a preset.'),
            Row(
                Button('Export preset file', exportPreset),
                pickFile,
            ),
        );
    }

    return { presetCard };
}
