// @ts-check
import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Toggle, Card, Section, EmptyState } from '../../../libraries/shared/widgets.js';
import { createModulesInstall } from './modules-install.js';

/** @typedef {import('../../../libraries/core/module-types.js').RegistryListItem} RegistryListItem */
/** @typedef {import('../../../libraries/core/module-types.js').ModuleRegistry} ModuleRegistry */
/** @typedef {import('../ui-types.js').UiNode} UiNode */
/** @template [T=any] @typedef {import('../ui-types.js').Signal<T>} Signal */

/**
 * Элемент списка карточки: отдельный Модуль либо папка с несколькими.
 * @typedef {{ kind: 'module', entry: RegistryListItem } | { kind: 'folder', name: string, entries: RegistryListItem[] }} ModuleGroup
 */

/**
 * Карточка «Modules»: то, что пользователь подключает сам.
 *
 * @param {{
 *   enabledSignal: (id: string) => Signal<boolean>,
 *   collapse: { bind: (key: string, options?: { open?: boolean }) => Record<string, unknown> },
 *   toggleModule: (entry: RegistryListItem, enable: boolean) => unknown,
 *   modules: () => RegistryListItem[],
 *   registry?: ModuleRegistry | null,
 *   notify?: (tone: string, text: string) => unknown,
 *   refresh?: () => void }} deps
 * @returns {{ modulesCard: () => UiNode, loadModulesInstall: () => Promise<void>, reloadModuleProblems: () => void }}
 */
export function createModulesCard(deps) {
    const { enabledSignal, collapse, toggleModule, modules, registry = null, notify = () => {}, refresh = () => {} } = deps;
    const install = createModulesInstall({ registry, notify, refresh });

    /**
     * Правая половина — то, что подключает пользователь. Панель НЕ рисует
     * содержимое Модуля сама: у каждого включённого Модуля своё независимое
     * дерево и свой Final UI (см. Ядро UI модулей), а здесь только его
     * карточка-переключатель и пустое место под него. Иначе панель знала бы
     * про внутренности каждого Модуля — ровно то, чего вся эта конструкция и
     * избегает.
     *
     * @param {RegistryListItem} entry
     * @returns {UiNode}
     */
    function moduleCard(entry) {
        const enabled = enabledSignal(entry.id);
        return Section(entry.title, {
            key: entry.id,
            ...collapse.bind(`module:${entry.id}`),
            subtitle: entry.description,
            // Тумблер, а не пара кнопок «Enable»/«Disable»: включённость это
            // СОСТОЯНИЕ, и переключатель показывает его сам, не заставляя
            // читать надпись на кнопке и догадываться, что она означает —
            // текущее положение или то, что случится по нажатию. Так же в Alpha.
            actions: [Toggle('Enabled', enabled, { onChange: value => toggleModule(entry, value) })],
        },
            // Версия, уровень доверия и «Remove» — только у установленных (у встроенных нечего показывать).
            install.installedBadges(entry),
            // Место под собственное дерево Модуля. Его Final UI монтируется
            // сюда тем, кто собирал движок — панель только выделяет слот.
            computed(() => (enabled()
                ? h('div', { class: 'stme-module-slot', 'data-module': entry.id })
                : h('small', { class: 'stme-module-off' }, 'Disabled — the engine keeps running without it.'))),
        );
    }

    /**
     * Модули с `folder` группируются в карточку-папку: сама папка НЕ
     * Модуль — у неё нет тумблера и живого экземпляра, она только
     * собирает карточки своих Модулей визуально (каждый включается
     * СВОИМ тумблером, как раньше). Без папки — обычная карточка.
     * Порядок: папки в порядке первого появления их Модулей в реестре,
     * внутри папки — порядок реестра.
     */
    /** @returns {ModuleGroup[]} */
    function groupedModuleEntries() {
        const entries = modules();
        /** @type {string[]} */
        const folders = [];
        /** @type {Map<string, RegistryListItem[]>} */
        const byFolder = new Map();
        /** @type {RegistryListItem[]} */
        const loose = [];
        for (const entry of entries) {
            if (entry.folder) {
                if (!byFolder.has(entry.folder)) {
                    byFolder.set(entry.folder, []);
                    folders.push(entry.folder);
                }
                byFolder.get(entry.folder)?.push(entry);
            } else {
                loose.push(entry);
            }
        }
        return [
            ...loose.map(entry => /** @type {ModuleGroup} */ ({ kind: 'module', entry })),
            ...folders.map(name => /** @type {ModuleGroup} */ ({ kind: 'folder', name, entries: byFolder.get(name) ?? [] })),
        ];
    }

    // Список Модулей раскрыт по умолчанию: это единственное место, где
    // пользователь что-то подключает, и прятать его за лишним кликом незачем.
    function modulesCard() {
        return Card('Modules', { ...collapse.bind('card:modules', { open: true }), subtitle: 'What you plug in yourself' },
            computed(() => {
                if (!modules().length) return [EmptyState('No modules installed. The engine runs without them — that is exactly what makes something a Module rather than a Core.')];
                return groupedModuleEntries().map(group => (group.kind === 'folder'
                    ? Section(group.name, { key: `folder:${group.name}`, subtitle: 'Tools the AI operates itself — each one enabled separately.' }, group.entries.map(moduleCard))
                    : moduleCard(group.entry)));
            }),
            // Отдельными аргументами, а не элементами массива: computed внутри массива другого computed не разворачивается.
            install.problemsSection(),
            install.installSection(),
        );
    }

    return { modulesCard, loadModulesInstall: install.loadSavedRepository, reloadModuleProblems: install.reloadProblems };
}
