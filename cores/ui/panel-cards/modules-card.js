import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Toggle, Card, Section, EmptyState } from '../../../libraries/shared/widgets.js';

/** Карточка «Modules»: то, что пользователь подключает сам. */
export function createModulesCard(deps) {
    const { enabledSignal, collapse, toggleModule, modules } = deps;

    /**
     * Правая половина — то, что подключает пользователь. Панель НЕ рисует
     * содержимое Модуля сама: у каждого включённого Модуля своё независимое
     * дерево и свой Final UI (см. Ядро UI модулей), а здесь только его
     * карточка-переключатель и пустое место под него. Иначе панель знала бы
     * про внутренности каждого Модуля — ровно то, чего вся эта конструкция и
     * избегает.
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
    function groupedModuleEntries() {
        const entries = modules();
        const folders = [];
        const byFolder = new Map();
        const loose = [];
        for (const entry of entries) {
            if (entry.folder) {
                if (!byFolder.has(entry.folder)) {
                    byFolder.set(entry.folder, []);
                    folders.push(entry.folder);
                }
                byFolder.get(entry.folder).push(entry);
            } else {
                loose.push(entry);
            }
        }
        return [...loose.map(entry => ({ kind: 'module', entry })), ...folders.map(name => ({ kind: 'folder', name, entries: byFolder.get(name) }))];
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
        );
    }

    return { modulesCard };
}
