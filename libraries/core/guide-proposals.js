import { CREATE_ACTIONS, describeProposal as describeCreate } from './guide-create.js';
import { EDIT_ACTIONS, describeEdit } from './guide-edit.js';
import { CHARACTER_ACTIONS, describeCharacter } from './guide-character.js';

/**
 * Все действия, которые гид присылает блоком ```proposal``` (карточка «что изменится» + кнопка): создание (guide-create.js) и правка/удаление/настройки (guide-edit.js).
 * `context` — `{ settingsOf(moduleId), titleOf(moduleId) }` для карточки настроек («было → стало»).
 */
export const PROPOSAL_ACTIONS = Object.freeze([...CREATE_ACTIONS, ...EDIT_ACTIONS, ...CHARACTER_ACTIONS]);

export function describeProposal(action, params, context) {
    if (CHARACTER_ACTIONS.includes(action)) return describeCharacter(action, params);
    return EDIT_ACTIONS.includes(action) ? describeEdit(action, params, context) : describeCreate(action, params);
}
