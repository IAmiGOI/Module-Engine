import { h } from '../tree.js';
import { TwoColumn } from '../../../libraries/shared/widgets.js';

/** Два дерева Ядра панели: основной экран и экран настроек. */
export function createPanelTrees(deps) {
    const { modelsCard, macrosCard, lorebookCard, summaryCard, modulesCard, statusCard, chatViewportCard, presetCard, updatesCard, syncCard, backgroundsCard } = deps;

    function tree() {
        return h('div', { class: 'stme-panel' },
            TwoColumn({
                // memoryGraphCard(), presetCard() и updatesCard() здесь БОЛЬШЕ
                // НЕТ (решено с пользователем: граф — «уже есть в боковой
                // панели, убери из основной»; пресеты и апдейты — «перенеси
                // в экран настроек»). Граф живёт своим плавающим окном, вход —
                // кнопка в доке-пилюле; пресеты и апдейты — на ОТДЕЛЬНОМ экране
                // настроек (settingsTree() ниже, вход — шестерёнка в доке).
                // Сигналы и подписки watch() остались здесь же НАРОЧНО: оба
                // дерева — дети одного Ядра, и переезд не разорвал ни одну
                // цепочку событий.
                left: [modelsCard(), macrosCard(), lorebookCard(), summaryCard()],
                right: [modulesCard()],
            }),
        );
    }

    /**
     * Второе дерево Ядра — ЭКРАН НАСТРОЕК (решено с пользователем: «перенеси
     * в экран настроек раздел пресетов и апдейтов из основного меню»).
     * Живёт в том же Ядре, что и основная панель, намеренно: presetCard() и
     * updatesCard() держатся за общие сигналы (repository, presetFlash,
     * updateFlash…) и общие `collapse`-памятки — выносить их в отдельное Ядро
     * значило бы дублировать состояние. Монтируется СВОИМ ключом
     * (`settingsScreen`), поэтому деревья не сталкиваются в реестре
     * монтирований — тот же приём, что у `hud()` модулей.
     */
    function settingsTree() {
        return h('div', { class: 'stme-panel' },
            // statusCard() («Engine») тоже переехал сюда (решено с
            // пользователем: «перенеси вкладку с названием Engine туда же»):
            // список контрактов и показание генерации — служебные сведения о
            // машине, им место рядом с пресетами и апдейтами, а не в основном
            // экране работы.
            statusCard(),
            chatViewportCard(),
            presetCard(),
            updatesCard(),
            syncCard.card(),
            backgroundsCard(),
        );
    }

    return { tree, settingsTree };
}
