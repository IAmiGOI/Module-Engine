import { reconcileMeasuredHeight } from '../../../libraries/shared/chat-viewport-math.js';
import { HIDDEN_BODY_OPACITY, GLYPH_GAP, TEXT_PADDING, EDIT_MIN_HEIGHT, ROW_PAD, AVATAR_WRAP, GLYPH_MIN_HEIGHT } from './constants.js';

/** Раскладка одной строки кадра. */
export function installRenderRow(ctx) {
    const { s, heights, rasterizedText, physicalTextureSize, rowStates, genStatus, bodyUse, lastChromeHeight, bodyHeights, rowHeight, chromeMounts, serviceOrThrow } = ctx;

    /** Раскладывает одну строку кадра. Возвращает `'stale'`, если кадр устарел (не используется здесь, оставлено для симметрии). */
    async function layoutRow(f, idx) {
        const { visibleOnly, frameScrollTop, order, byMesid, glyphHeaderByMesid, glyphFinalByHeader, glyphMembersByHeader, quads, positions, glyphSpans, skeletonSpecs, neededGlyphs } = f;
        const isCot = m => !!(m && (m.isToolCall || m.reasoningText));
        const mesid = order[idx];
        const message = byMesid.get(mesid);
        const oldRowHeight = heights.get(mesid) ?? rowHeight;
        if (!f.anchorFound && f.oldCum + oldRowHeight > frameScrollTop) { f.anchorFound = true; f.anchorDelta = f.y - f.oldCum; }
        // Быстрая прокрутка: строка, которой ещё нет ни в кэше, ни в текстурах, не показывается вовсе (место держит оценка высоты) —
        // она появляется ЦЕЛИКОМ (шапка + текст + фон) на полном проходе после остановки или когда её подготовит камера предзагрузки.
        // Раньше кадр ждал подготовки каждой такой строки по очереди, и части появлялись вразнобой.
        if (visibleOnly && !message.isToolCall && !rasterizedText.has(mesid) && !bodyHeights.has(mesid)) {
            const estimate = (heights.get(mesid) ?? rowHeight) + ((glyphHeaderByMesid.get(mesid) === mesid && mesid !== order[0]) ? GLYPH_GAP : 0);
            const startsGlyph = glyphHeaderByMesid.get(mesid) === mesid && mesid !== order[0];
            skeletonSpecs.push({ top: (f.y + (startsGlyph ? GLYPH_GAP : 0)) - frameScrollTop, height: estimate - (startsGlyph ? GLYPH_GAP : 0) });
            f.y += estimate;
            f.oldCum += estimate;
            f.glyphOffset += estimate;
            return;
        }

        // `isLast` — НАЙДЕНО ЖИВЬЁМ в реальном исходнике ST: свайп и
        // регенерация жёстко работают ТОЛЬКО с последним сообщением
        // всего чата (`isMessageSwipeable()` требует `messageId ==
        // chat.length - 1`; `Generate('regenerate')` безусловно
        // удаляет `chat[chat.length - 1]` перед генерацией новой
        // реплики — не то, с чьей кнопки был вызов). Раньше кнопки
        // свайпа/реролла показывались на КАЖДОМ сообщении — свайп на
        // не-последнем молча ничего не делал (ST её тихо отклоняет),
        // а реролл на любом сообщении всё равно удалял и
        // перегенерировал ПОСЛЕДНЕЕ, что в коротком чате легко
        // спутать с "первым". `order` — это ВЕСЬ чат (не только
        // видимое окно), поэтому `order[order.length - 1]` — реальный
        // последний mesid, а не последний из отрендеренных.
        const isLast = mesid === order[order.length - 1];
        // `isGlyphStart` — owner: "Картинка и название и номер
        // привязывается только к началу глифа" — см. `buildRowTree()`
        // выше: только начало глифа рисует `MessageHeader` целиком
        // (аватар/имя/бейджи), продолжение — только строку действий.
        const glyphHeaderMesid = glyphHeaderByMesid.get(mesid) ?? mesid;
        const isGlyphStart = glyphHeaderMesid === mesid;
        // Зазор МЕЖДУ глифами (owner: "между ними нет спейса") —
        // добавляется ДО измерения позиции этой строки, если она
        // открывает НОВЫЙ глиф — кроме самого первого сообщения
        // чата целиком (`order[0]`): зазора НЕ должно быть перед
        // первой же строкой списка, иначе прокрутка начиналась бы
        // с пустого отступа сверху.
        const gap = (isGlyphStart && mesid !== order[0]) ? GLYPH_GAP : 0;
        const topPx = (f.y + gap) - frameScrollTop;

        // Хром (шапка/действия) — реальный DOM НАД телом сообщения, не
        // рядом с ним: тело начинается ПОСЛЕ хрома, а не с той же `y`
        // (найдено живьём в харнессе — без сдвига WebGL-текст и хром
        // рисовались друг НА друге). `chromeHeight` — измеренная РЕАЛЬНАЯ
        // высота (тем же приёмом, что высота тела через зеркало), не
        // угаданная константа, поэтому строки с разной длиной имени/
        // рассуждений не расходятся с реальной раскладкой.
        // ToolCall — НЕ растеризуется в WebGL вообще (owner: "ToolCall
        // не открывается"): своё тело несёт СОБСТВЕННЫЙ
        // `<details><summary>Tool calls: ...` внутри `mes`, а
        // растеризованный в текстуру `<details>` — просто картинка,
        // не кликается. Вместо канваса тело идёт в реальный DOM
        // хрома (`.stme-toolcall-body`, `buildRowTree()`/
        // `ensureRowChrome()` выше) — `bodyHeight` тогда 0 (место под
        // тело уже посчитано В хроме), и квад ниже для этого mesid не
        // создаётся вовсе.
        // `chromeHeight` СЧИТАЕТСЯ ПЕРВЫМ, ДО тела — owner: "Оно
        // должно быть СПРАВА от аватарки... И только после
        // заполнения той зоны спускаться вниз". Хром (шапка/
        // ризонинг/ToolCall) намеренно измеряется БЕЗ учёта
        // аватарки (float в `buildRowTree()` без clearfix — см. её
        // doc-comment) — эта высота и есть "сколько реального
        // контента уже обтекло аватарку сверху", остаток
        // (`avatarRemainder` ниже) достаётся телу.
        const toolCallHtml = message.isToolCall ? await serviceOrThrow('stChat.formatMessage', { mesid }) : null;
        if (isGlyphStart) f.glyphOffset = 0;
        const nextMesid = order[idx + 1];
        const nextInGlyph = nextMesid !== undefined && glyphHeaderByMesid.get(nextMesid) === glyphHeaderMesid;
        const tight = !isGlyphStart && isCot(message);
        const nextTight = nextInGlyph && isCot(byMesid.get(nextMesid));
        const isGlyphEnd = !nextInGlyph;
        const padTop = tight ? 0 : ROW_PAD;
        const padBottom = (isCot(message) || nextTight) ? 0 : ROW_PAD;
        const avatarFloatHeight = (chromeMounts && !isGlyphStart) ? Math.max(0, AVATAR_WRAP - (f.glyphOffset + padTop)) : 0;
        const chromeHeight = await ctx.ensureRowChrome(mesid, {
            padTop, padBottom, tight, avatarFloatHeight,
            name: message.name, avatarUrl: ctx.scaledAvatarUrl(message.avatarUrl), isUser: message.isUser,
            turnIndex: Number(mesid),
            // Таймер в шапке глифа — суммарное время генерации ВСЕХ склеенных сообщений глифа, а не только первого.
            genDurationMs: isGlyphStart ? ctx.sumGlyphDuration(glyphMembersByHeader?.get(glyphHeaderMesid), byMesid, message) : message.genDurationMs,
            sendDate: message.sendDate,
            reasoningText: message.reasoningText, swipeIndex: message.swipeIndex,
            swipeCount: message.swipeCount, text: message.text, isLast, isGlyphStart,
            // Кнопки глифа живут в его шапке и работают с ФИНАЛЬНЫМ сообщением глифа (последним), а не с первым, у которого шапка.
            ...(isGlyphStart ? (() => {
                const finalMesid = glyphFinalByHeader?.get(glyphHeaderMesid) ?? mesid;
                const finalMessage = byMesid.get(finalMesid) ?? message;
                return {
                    finalMesid, finalText: finalMessage.text, finalSwipeIndex: finalMessage.swipeIndex, finalSwipeCount: finalMessage.swipeCount,
                    finalIsUser: finalMessage.isUser, finalIsLast: finalMesid === order[order.length - 1],
                };
            })() : {}),
            isToolCall: message.isToolCall, toolCallHtml, genStatus: genStatus.get(mesid) ?? null,
            // Скрыто от промптов (`is_system` у ST): у шапки глифа — значок-призрак, тело нарисовано приглушённо.
            isHidden: Boolean(message.isSystem),
        });
        // Сколько высоты аватарки хром САМ не занял — ровно на
        // столько тело должно продолжить обтекание своей отдельной
        // заглушкой (`avatarSpacerHtml()` в `syncMesid()`). `0` для
        // ToolCall (у него нет WebGL-тела вовсе, обтекать нечем), для
        // продолжений глифа (аватарки нет — обтекать нечего с самого
        // начала) и когда `chromeMounts` вовсе не задан (см.
        // `ensureRowChrome()` выше — `createFinalUi` не дан Ядру,
        // хром отключён целиком: тогда и рисовать-то нечего, никакой
        // РЕАЛЬНОЙ аватарки на экране, чтобы вокруг неё обтекать).
        lastChromeHeight.set(mesid, chromeHeight);
        bodyUse.delete(mesid); bodyUse.set(mesid, true);
        const avatarRemainder = (chromeMounts && !message.isToolCall) ? Math.max(0, AVATAR_WRAP - (f.glyphOffset + chromeHeight)) : 0;
        const measuredBodyHeight = message.isToolCall ? 0 : await ctx.syncMesid(message, avatarRemainder);
        // Пока сообщение правится, под поле ввода закладывается минимум ~4 строки — короткое тело иначе давало бы крошечный textarea.
        const bodyHeight = rowStates.get(mesid)?.editing() ? Math.max(measuredBodyHeight, EDIT_MIN_HEIGHT) : measuredBodyHeight;
        if (chromeMounts && !message.isToolCall) await ctx.syncBodyImages(mesid, chromeHeight);
        // Зазор входит в `totalHeight` ЭТОГО сообщения (не отдельная
        // запись) — виртуализация (`computeVisibleRange`) суммирует
        // `heights` по `mesid`, ей негде было бы учесть зазор, будь
        // он отдельной сущностью; так `y` для следующей строки и
        // `heights`-карта остаются согласованы без специального кода
        // в `chat-viewport-math.js`. `Math.max(AVATAR_HEIGHT, ...)` —
        // НАЙДЕНО ЖИВЬЁМ: `chromeHeight + bodyHeight` сам по себе
        // может оказаться КОРОЧЕ аватарки (имя+один короткий абзац
        // текста, вместе меньше 136px) — без этой поправки
        // СЛЕДУЮЩАЯ строка начиналась бы, пока аватарка этой ещё
        // видна на экране, наезжая на её нижнюю часть.
        {
            const editState = rowStates.get(mesid);
            if (editState?.editing()) {
                const prev = editState.editRect.peek();
                const height = bodyHeight;
                if (!prev || prev.top !== chromeHeight || prev.height !== height) editState.editRect.set({ top: chromeHeight, height });
            }
        }
        const ownHeight = chromeHeight + bodyHeight;
        const totalHeight = ((chromeMounts && isGlyphEnd) ? Math.max(GLYPH_MIN_HEIGHT - f.glyphOffset, ownHeight) : ownHeight) + gap;
        f.glyphOffset += totalHeight - gap;
        positions.push({ mesid, y: topPx, width: s.viewportWidth });

        // Копим span фона текущего глифа по ходу того же прохода —
        // строки одного глифа всегда идут подряд в `order`. Новый
        // span запускается на смене `glyphHeaderMesid` относительно
        // ПОСЛЕДНЕГО добавленного — НЕ на `isGlyphStart`: если
        // видимое окно начинается СЕРЕДИНОЙ глифа (его заголовок
        // прокручен выше экрана), `isGlyphStart` для самой первой
        // видимой строки будет `false`, но span для её (уже
        // невидимого) заголовка ещё не заведён — `glyphSpans` был бы
        // пуст, и `glyphSpans[-1].height` упало бы (поймано тестами).
        const lastSpan = glyphSpans[glyphSpans.length - 1];
        if (!lastSpan || lastSpan.headerMesid !== glyphHeaderMesid) {
            glyphSpans.push({ headerMesid: glyphHeaderMesid, top: topPx, height: 0 });
        }
        glyphSpans[glyphSpans.length - 1].height += (totalHeight - gap);
        neededGlyphs.add(glyphHeaderMesid);

        const hadHeight = heights.has(mesid);
        const next = reconcileMeasuredHeight(heights, mesid, totalHeight);
        if (next) { if (hadHeight) f.heightsChanged = true; for (const [k, v] of next) heights.set(k, v); }

        // Квады — в ФИЗИЧЕСКИХ пикселях backing store канваса
        // (`webglChat.attach()`/`resize()` ниже уже выставили его
        // размер как `viewportWidth/Height * devicePixelRatio`) —
        // `computeQuadVertices` в webgl-renderer.js нормирует ровно по
        // `canvas.width/height`, так что единицы должны совпадать.
        // Хром — реальный DOM, остаётся в ЛОГИЧЕСКИХ пикселях (никакого
        // devicePixelRatio здесь — CSS и так рисует его резко).
        // `x: TEXT_PADDING * devicePixelRatio` — owner: "Глиф все-еще
        // слишком близко к левой и правой границе текста, без
        // спейсинга" — тело сдвинуто вправо на тот же отступ, что
        // `contentWidth()` уже вычло из ширины растеризации, иначе
        // текст оказался бы ýже фона, но всё ещё прижатым к левому
        // краю, а не отцентрован с равными полями по бокам.
        // `physicalTextureSize` — ТОЧНЫЙ размер уже загруженной
        // текстуры (см. doc-comment у самой карты выше за причиной:
        // пересчитывать `contentWidth() * devicePixelRatio` заново
        // здесь давало дробный результат при дробном DPR, на пиксель-
        // другой ШИРЕ реальной текстуры, округлённой ВНУТРИ
        // растеризатора — GPU растягивал текстуру под квад чуть
        // большего размера, `LINEAR`-фильтр честно интерполировал
        // край, и это выглядело как лёгкий блюр/ореол вокруг текста).
        // Фолбэк на пересчёт — только пока текстуры для ЭТОГО mesid
        // ещё вообще не было (первый кадр после `attach()`, до первого
        // `syncMesid()` в этом же проходе — практически никогда не
        // видим, `syncMesid()` выше уже гарантированно отработал).
        // ToolCall — нет текстуры вообще (тело целиком в хроме, см.
        // выше), значит и квада для неё нет: нечего рисовать на
        // канвасе для этого `mesid`.
        if (!message.isToolCall && !rowStates.get(mesid)?.editing()) {
            const physicalSize = physicalTextureSize.get(mesid)
                ?? { width: ctx.contentWidth() * s.devicePixelRatio, height: bodyHeight * s.devicePixelRatio };
            if (s.lastCanvas && mesid === s.lastBodyMesid) {
                f.lastPlacement = { mesid, cssX: TEXT_PADDING, cssY: topPx + chromeHeight, physicalSize, ...(message.isSystem ? { opacity: HIDDEN_BODY_OPACITY } : {}) };
            } else {
                quads.push({
                    textureId: mesid, x: TEXT_PADDING * s.devicePixelRatio,
                    y: (topPx + chromeHeight + ctx.canvasPad()) * s.devicePixelRatio,
                    width: physicalSize.width,
                    height: physicalSize.height,
                    ...(message.isSystem ? { opacity: HIDDEN_BODY_OPACITY } : {}),
                });
            }
        }
        f.y += totalHeight;
        f.oldCum += oldRowHeight;
    }

    Object.assign(ctx, { layoutRow });
}
