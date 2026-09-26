import { widgetCss } from './widget-contract.js';
import { BLOCK_KINDS, CHARACTER_BLOCK, FIRST_START_ITEMS, HEAD_H, CHECK_PROGRESS_H, CHECK_ROW_H, RECENT_ROW_H, RECENT_MAX_ROWS, checklistProgress } from './home-model.js';

/**
 * HTML тела блока главного экрана для растеризации в WebGL-текстуру (`htmlRasterizer.rasterize`) — чистые строки, без DOM.
 * В растре ТОЛЬКО текст (прозрачный фон): плита, аватары, кнопки и галочки — DOM (cores/ui/home/blocks-dom.js), они лежат под прозрачным
 * канвасом на тех же координатах, поэтому все размеры здесь — пара к `styles/home/blocks.css` и константам `home-model.js`.
 * Любой внешний текст (имя, сообщение) экранируется: он попадает в SVG, который браузер парсит как XML.
 *
 * ВАЖНО для растра (найдено живьём): у корня `.hb` нельзя `overflow: hidden` (высота обёртки нулевая — обрежет всё), и все позиции — только `top`,
 * не `bottom`.
 */

/** Строка «Недавних чатов»: слева колонка аватара, справа — место под три кнопки. */
export const RECENT_TEXT_X = 58;
export const RECENT_BUTTONS_W = 92;
export const CHECK_TEXT_X = 50;
export const BLOCK_PAD = 14;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch]);

/** CSS растра. `tokens` — уже разрешённые цвета/шрифт (`foreignObject` не наследует переменные страницы): `{ text, muted, accent, font }`. */
export function homeCss({ text = '#e8e6df', muted = 'rgba(232,230,223,.62)', accent = '#f5c518', font = 'system-ui, sans-serif' } = {}) {
    return `
.hb { position: relative; width: 100%; height: 100%; font-family: ${font}; color: ${text}; }
.hb > * { position: absolute; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.hb-title { left: 16px; top: 13px; right: 52px; font-size: 15px; font-weight: 700; line-height: 20px; color: ${accent}; }
.hb-sub { left: 16px; top: 33px; right: 16px; font-size: 11.5px; line-height: 15px; color: ${muted}; }
.hb-row-name { left: ${RECENT_TEXT_X}px; right: ${RECENT_BUTTONS_W + BLOCK_PAD}px; font-size: 13.5px; font-weight: 600; line-height: 18px; }
.hb-row-sub { left: ${RECENT_TEXT_X}px; right: ${RECENT_BUTTONS_W + BLOCK_PAD}px; font-size: 11.5px; line-height: 15px; color: ${muted}; }
.hb-empty { left: 16px; right: 16px; font-size: 12.5px; line-height: 20px; color: ${muted}; }
.hb-cname { left: 8px; right: 8px; text-align: center; font-size: 13.5px; font-weight: 600; line-height: 18px; }
.hb-row-title { left: ${CHECK_TEXT_X}px; right: ${BLOCK_PAD}px; font-size: 13.5px; font-weight: 600; line-height: 18px; }
.hb-row-hint { left: ${CHECK_TEXT_X}px; right: ${BLOCK_PAD}px; font-size: 11.5px; line-height: 15px; color: ${muted}; }
.hb-done { text-decoration: line-through; opacity: .55; }
.hb-progress { left: 16px; right: 16px; font-size: 11.5px; line-height: 16px; color: ${muted}; }
${widgetCss({ text, muted, accent })}`;
}

const header = (title, subtitle) => `<div class="hb-title">${escapeHtml(title)}</div>${subtitle ? `<div class="hb-sub">${escapeHtml(subtitle)}</div>` : ''}`;

/** Строки блока «Недавние чаты» — не больше `RECENT_MAX_ROWS`; `chats` — форма из `stHome.state` (services/st-home.js). */
export const visibleRecent = chats => chats.slice(0, RECENT_MAX_ROWS);

/** Тело блока «Недавние чаты»: имя персонажа, под ним файл чата и дата. */
export function recentBlockHtml(chats = []) {
    const rows = visibleRecent(chats);
    if (!rows.length) return `<div class="hb">${header('Recent chats', 'Pick up where you left off')}<div class="hb-empty" style="top:${HEAD_H}px">No recent chats yet.</div></div>`;
    const body = rows.map((chat, index) => {
        const top = HEAD_H + index * RECENT_ROW_H;
        const sub = [chat.chatName, chat.date].filter(Boolean).join(' · ');
        return `<div class="hb-row-name" style="top:${top + 5}px">${escapeHtml(chat.character || 'Unknown')}</div><div class="hb-row-sub" style="top:${top + 24}px">${escapeHtml(sub)}</div>`;
    }).join('');
    return `<div class="hb">${header('Recent chats', 'Pick up where you left off')}${body}</div>`;
}

/** Тело карточки персонажа: только имя под аватаром (аватар — DOM). */
export const characterBlockHtml = name => `<div class="hb"><div class="hb-cname" style="top:${CHARACTER_BLOCK.h - 32}px">${escapeHtml(name || 'Unknown')}</div></div>`;

/** Заглушка виджета, которого сейчас нет (удалён или не загрузился): сохранённое на столе место не теряется. */
export const widgetUnavailableHtml = (title, reason) => `<div class="hb"><div class="hb-title" style="right:44px">${escapeHtml(title)}</div><div class="hb-sub" style="top:36px">${escapeHtml(reason || 'Widget unavailable')}</div></div>`;

export const actionsBlockHtml = () => `<div class="hb">${header('Quick actions', 'Jump straight in')}</div>`;

/** Тело чек-листа; `done` — множество отмеченных id. Строки идут с шагом `CHECK_ROW_H` под шапкой и строкой прогресса. */
export function checklistBlockHtml(done = new Set(), items = FIRST_START_ITEMS) {
    const progress = checklistProgress(done, items);
    const rowsTop = HEAD_H + CHECK_PROGRESS_H;
    const rows = items.map((item, index) => {
        const top = rowsTop + index * CHECK_ROW_H;
        const cls = done.has(item.id) ? 'hb-row-title hb-done' : 'hb-row-title';
        return `<div class="${cls}" style="top:${top + 5}px">${escapeHtml(item.title)}</div><div class="hb-row-hint" style="top:${top + 24}px">${escapeHtml(item.hint)}</div>`;
    }).join('');
    return `<div class="hb">${header('First steps', 'Getting to know the engine')}<div class="hb-progress" style="top:${HEAD_H}px">${progress.done} of ${progress.total} done</div>${rows}</div>`;
}

/** HTML тела блока по его виду. `data`: `{ chats }` для «Недавних», `{ name }` для карточки персонажа, `{ done }` для чек-листа, `{ html }` — готовое тело виджета. */
export function blockHtml(block, data = {}) {
    if (block.kind === BLOCK_KINDS.RECENT) return recentBlockHtml(data.chats);
    if (block.kind === BLOCK_KINDS.CHARACTER) return characterBlockHtml(data.name);
    if (block.kind === BLOCK_KINDS.WIDGET) return data.html;
    if (block.kind === BLOCK_KINDS.CHECKLIST) return checklistBlockHtml(data.done);
    return actionsBlockHtml();
}
