import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { MessageHeader, MessageActionsRow, ReasoningBlock, Button, Avatar, GenStripe } from '../../../libraries/shared/widgets.js';
import { TEXT_PADDING, ROW_PAD } from './constants.js';

/** Дерево `h()` одной строки хрома. */
export function installRowTree(ctx) {
    const { s, chromeHeightCache } = ctx;

    /**
     * Дерево ОДНОЙ строки хрома — построено РОВНО ОДИН РАЗ на `mesid`
     * (см. `ensureRowChrome`), дальше живёт только через свои сигналы.
     * Позиция (`state.position`) и контент (`state.content`) — РАЗНЫЕ
     * `computed()`, каждый в своей реактивной области diff.js: скролл
     * трогает только позицию, не пересобирая шапку/кнопки.
     */
    function buildRowTree(mesid, state) {
        return h('div', {
            class: 'stme-chat-viewport-row',
            'data-mesid': mesid,
            style: computed(() => ({
                position: 'absolute', top: '0px', left: '0px',
                transform: `translateY(${state.position().y}px)`,
                width: `${state.position().width}px`,
                paddingTop: `${state.content().padTop ?? ROW_PAD}px`,
                paddingBottom: `${state.content().padBottom ?? ROW_PAD}px`,
                // ВЫСОТА НЕ ставится явно — намеренно. Первая версия ставила
                // сюда `state.position().height`, а `ensureRowChrome()` тут же
                // измерял ЭТОТ ЖЕ узел через `dom.measureRect` — циклическая
                // зависимость: на первом кадре высота ещё 0 (значение по
                // умолчанию), измерение получало почти 0 вместо настоящих
                // ~56px, и весь расчёт строки съезжал (поймано живьём в
                // харнессе: шапка/тело реально накладывались друг на друга).
                // Без явной высоты узел сам принимает высоту своего контента
                // (аватар+имя+бейджи/кнопки) — то самое число, что и нужно
                // измерить.
            })),
        }, computed(() => {
            const c = state.content();
            // Правка ПРЯМО В СООБЩЕНИИ: пока `editing`, картинка тела (WebGL-квад) не рисуется (см. `render()`), а на её место
            // встаёт настоящий <textarea> ровно по границам тела; хром (аватар, имя, кнопки) остаётся на месте.
            const rect = state.editing() ? state.editRect() : null;
            const finishEdit = async save => {
                if (save) await ctx.editMessage({ mesid, text: state.draft() });
                state.editing.set(false);
                state.editRect.set(null);
                await ctx.render({ fresh: false });
            };
            const editOverlay = rect ? h('div', {
                class: 'stme-chat-viewport-edit-inline',
                style: { position: 'absolute', left: `${TEXT_PADDING}px`, top: `${rect.top}px`, width: `${ctx.contentWidth()}px`, height: `${rect.height}px` },
            },
                h('textarea', {
                    class: 'text_pole stme-chat-viewport-edit-area',
                    value: state.draft,
                    'on:input': event => state.draft.set(event.target.value),
                    'on:keydown': event => {
                        if (event.key === 'Escape') { event.preventDefault(); finishEdit(false); }
                        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishEdit(true); }
                    },
                }),
                h('div', { class: 'stme-chat-viewport-edit-buttons' },
                    Button('Save', () => finishEdit(true)),
                    Button('Cancel', () => finishEdit(false)),
                ),
            ) : null;
            // Кнопки — В ТОМ ЖЕ ряду, что имя (не отдельной строкой
            // ниже) и показываются только при наведении на строку
            // целиком — оба решения владельца, реализованы CSS'ом
            // (`.stme-message-header-name-row:hover .stme-message-
            // actions`), а не логикой здесь.
            // `c.isLast` гейтит свайп/реролл — см. doc-comment у
            // `isLast` в `render()`: сама ST функционально способна
            // свайпать/регенерировать ТОЛЬКО последнее сообщение
            // чата, показывать эти кнопки на остальных — предлагать
            // действие, которое либо молча ничего не сделает
            // (свайп), либо неожиданно удалит и перегенерирует
            // СОВСЕМ ДРУГОЕ сообщение (реролл).
            // Кнопки — ТОЛЬКО в шапке глифа и всегда про ФИНАЛЬНОЕ сообщение глифа (`c.finalMesid`): у склеенных сообщений (ризонинг,
            // раунды инструментов, ответ) отдельной правки у каждого нет — правится итоговое. У промежуточных строк кнопок нет вовсе.
            const targetMesid = c.finalMesid ?? mesid;
            const actions = c.isGlyphStart ? MessageActionsRow({
                onEdit: () => ctx.beginEdit(targetMesid),
                onDelete: () => ctx.deleteMessage({ mesid: targetMesid }),
                onSwipeLeft: (c.finalIsLast && c.finalSwipeCount > 1) ? () => ctx.swipe({ mesid: targetMesid, direction: 'left' }) : null,
                onSwipeRight: (c.finalIsLast && c.finalSwipeCount > 1) ? () => ctx.swipe({ mesid: targetMesid, direction: 'right' }) : null,
                onRegenerate: (c.finalIsLast && !c.finalIsUser) ? () => ctx.regenerate() : null,
                swipeIndex: c.finalSwipeIndex, swipeCount: c.finalSwipeCount,
            }) : null;
            // `c.isGlyphStart` — owner: "Картинка и название и номер
            // привязывается только к началу глифа" — аватар/имя/бейджи
            // рисуются ТОЛЬКО у первого сообщения цепочки (`computeGlyphs()`,
            // `render()` ниже); продолжение цепочки получает только строку
            // действий, но в ТОМ ЖЕ по классу "именном" ряду
            // (`.stme-message-header-name-row`) — исключительно чтобы
            // сохранить тот же hover-reveal CSS, действия должны так же
            // прятаться/появляться по наведению у каждого блока внутри
            // глифа, не только у первого.
            return h('div', {},
                // `.stme-chat-viewport-avatar-col` — owner: "Оно должно быть
                // СПРАВА от аватарки. Блоки ризонинга тоже. И только после
                // заполнения той зоны спускаться вниз." НАСТОЯЩИЙ CSS
                // `float: left` (styles/), а не `flex`-ребёнок внутри
                // шапки — floats в CSS обтекаются ЛЮБЫМ следующим блочным
                // содержимым в том же контексте форматирования, не только
                // непосредственным соседом: поставив аватарку ПЕРЕД
                // `.stme-chat-viewport-row-top`, `ReasoningBlock` И
                // `.stme-toolcall-body` (все — дальнейшие сиблинги здесь),
                // все они САМИ обтекают её, без единой строчки кода под
                // каждый из них отдельно. Намеренно БЕЗ `overflow`/
                // clearfix на этом узле или его предках (см. doc-comment
                // `AVATAR_HEIGHT` выше) — `dom.measureRect()` в
                // `ensureRowChrome()` должен видеть ТОЛЬКО высоту
                // реального содержимого (имя+дата+ризонинг+ToolCall), а не
                // раздутую до высоты аватарки: `render()` ниже сам решает,
                // остался ли ещё "зазор" под аватаркой, который должно
                // занять уже тело сообщения (WebGL-текстура, обтекать
                // умеет только через свою отдельную заглушку — не через
                // этот float).
                c.isGlyphStart ? h('div', { class: 'stme-chat-viewport-avatar-col' }, Avatar(c.avatarUrl, { name: c.name }), GenStripe(c.genStatus)) : null,
                // `.stme-chat-viewport-content-col` — НАЙДЕНО ЖИВЬЁМ: `root`
                // (сам `.stme-chat-viewport-row`) — `position: absolute`
                // (см. его inline-стиль выше, нужен виртуализации), а
                // `position: absolute` САМ ПО СЕБЕ безусловно заводит новый
                // block formatting context независимо от `overflow` — док-
                // комментарий у `AVATAR_HEIGHT` ошибочно предполагал, что
                // БЕЗ `overflow`/clearfix на `root` `dom.measureRect(root)`
                // не увидит высоту float-аватарки; на деле именно `position:
                // absolute` эту BFC и завёл, и `chromeHeight` ВСЕГДА
                // получался >= `AVATAR_HEIGHT` (родительский `root` ИЗ-ЗА
                // BFC растягивается под float) — `avatarRemainder` выходил
                // 0 для КАЖДОЙ строки, спейсер никогда не добавлялся, тело
                // обтекания не видело. Обёртка здесь — обычный блочный
                // сиблинг float-аватарки (сама БЕЗ `position`/`overflow`,
                // никакого своего BFC) — её СОБСТВЕННАЯ высота считается
                // только по ЕЁ ЖЕ содержимому (имя+дата+ризонинг+ToolCall),
                // float-сосед на высоту сиблинга не влияет (влияет только на
                // высоту СВОЕГО родителя, если тот без BFC, и на строки
                // ВНУТРИ сиблинга — что и нужно, обтекание ниже продолжает
                // работать как раньше). `ensureRowChrome()` теперь измеряет
                // ИМЕННО этот узел, не `root`.
                // Продолжение глифа: аватарки в этой строке нет, но она может
                // лежать в зоне аватарки первой строки — невидимый float
                // высотой в остаток зоны, чтобы хром обтекал её так же.
                (!c.isGlyphStart && c.avatarFloatHeight > 0)
                    ? h('div', { class: 'stme-chat-viewport-avatar-float', style: { height: `${c.avatarFloatHeight}px` } })
                    : null,
                h('div', { class: `stme-chat-viewport-content-col${c.tight ? ' stme-chat-viewport-content-col-tight' : ''}` },
                // `.stme-chat-viewport-row-top` — owner: "Компановка должна
                // быть такая: Красный прямоугольник - имя... Синий -
                // виджеты (RP Time)" — то есть РЯДОМ, на одной строке, а не
                // одно НАД другим (как эта же пара стояла в прошлой
                // версии). Шапка (или её компактная замена у продолжения
                // глифа) и заглушка подвала (`.stme-chat-viewport-footer-
                // slot`) — просто два flex-ребёнка этой строки;
                // `justify-content: space-between` (styles/) разводит их
                // по краям сам, шапка не растягивается на всю ширину (нет
                // своего `flex`), так что место под правый (синий) виджет
                // остаётся свободным без явного расчёта его ширины здесь.
                // Сам этот `.stme-chat-viewport-row-top` — обычный блочный
                // элемент, идущий ПОСЛЕ float-аватарки (см. выше) — значит
                // он САМ обтекает её как любой другой блок, отдельно
                // ничего задавать не нужно.
                // У шапки начала глифа — линия под ней в цвете светофора генерации (см. styles/ «Линия шапки»); класс несёт статус.
                h('div', { class: `stme-chat-viewport-row-top${c.isGlyphStart ? ` stme-chat-viewport-row-top-line${c.genStatus ? ` stme-chat-viewport-row-top-line-${c.genStatus}` : ''}` : ' stme-chat-viewport-row-top-compact'}` },
                    c.isGlyphStart
                        ? MessageHeader({
                            name: c.name, turnIndex: c.turnIndex,
                            genDurationMs: c.genDurationMs, timestampText: c.sendDate, isUser: c.isUser, hidden: c.isHidden,
                            actions,
                        })
                        : null,
                    // `.stme-chat-viewport-footer-slot` — owner: "RP Time и
                    // прочие штуки не отображаются корректно", позже "RP
                    // Time не вверху". Заглушка того же рода, что
                    // `.stme-toolcall-body` ниже, но пуста НАВСЕГДА со
                    // стороны `h()`/diff.js: содержимое сюда кладёт НЕ это
                    // Ядро, а `message-footer.js` — своим собственным
                    // `ensureFooter()`, через `ui.messageFooter.
                    // setHostResolver` (см. `attach()` ниже), напрямую
                    // вызовом `host.append()` мимо диффинга. `message-
                    // footer.js` по умолчанию крепит подвал (бейджи вроде
                    // RP Time) в НАСТОЯЩИЙ `.mes` — а тот скрыт вместе со
                    // всем `#chat` (`display:none`), пока включён Chat
                    // Viewport; резолвер перенаправляет ЕГО ЖЕ узел подвала
                    // сюда вместо невидимого родного DOM. НЕ `stme-message-
                    // footer-slot` — тот класс уже занят `message-footer.js`'s
                    // СОБСТВЕННЫМИ внутренними ячейками (`left`/`center`/
                    // `right`), это другая, внешняя обёртка.
                    h('div', { class: 'stme-chat-viewport-footer-slot' }),
                ),
                // `onToggle: render` — НАЙДЕНО ЖИВЬЁМ: раскрытие/сворачивание
                // рассуждений меняет реальную высоту этой строки, но это
                // чисто браузерное действие (`<details>`), никакое ST-событие
                // из `REDRAW_EVENTS` тут не срабатывает — без явного вызова
                // все строки НИЖЕ оставались на старой позиции и
                // накладывались на выросшую строку. `render()` уже
                // идемпотентен и безопасен звать когда угодно (см.
                // doc-comment самой функции) — просто пересчитывает все
                // позиции заново, тем же путём, что скролл/правка/свайп.
                ReasoningBlock(c.reasoningText, { onToggle: () => { s.toggleRender = true; chromeHeightCache.clear(); ctx.render({ fresh: false }); } }),
                // `.stme-toolcall-body` — owner: "ToolCall не открывается".
                // Пустая ЗАГЛУШКА здесь, `h()`/`diff.js` не умеют вставлять
                // сырой HTML декларативно — реальный HTML вставляется
                // ИМПЕРАТИВНО, `dom.setInnerHtml`, сразу после монтирования
                // (`ensureRowChrome()` ниже, через `dom.querySelector` по
                // этому классу). Только для ToolCall-сообщений: у ОБЫЧНОГО
                // тела `.mes` есть основания растеризоваться в WebGL-текстуру
                // (длинный текст, часто стримится по токену) — но
                // ToolCall-сообщение приходит целиком СРАЗУ и несёт СОБСТВЕННЫЙ
                // `<details><summary>Tool calls: ...` внутри своего же `mes`.
                // Растеризованный в текстуру `<details>` — просто картинка,
                // клик по ней ничего не переключает; настоящий `<details>`
                // в реальном DOM работает бесплатно, тем же браузерным
                // механизмом, что и наш собственный `ReasoningBlock`.
                c.isToolCall ? h('div', { class: 'stme-toolcall-body' }) : null,
                editOverlay,
                ),
            );
        }));
    }

    Object.assign(ctx, { buildRowTree });
}
