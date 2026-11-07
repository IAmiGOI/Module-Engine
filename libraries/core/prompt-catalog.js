import { promptCatalog } from './prompt-overrides.js';
import * as basePrompts from './decision-prompts.js';
import * as bankPrompts from './decision-prompts-bank.js';
import * as resolverPrompts from './decision-prompts-resolver.js';
import * as counsellorPrompts from './decision-prompts-counsellor.js';
import * as directorPrompts from './decision-prompts-director.js';

/** Каталог всех встроенных промптов игры — общий для ядра и окна The Court (часть 21). */
export function builtInPrompts() {
    return promptCatalog([['director', basePrompts], ['banks', bankPrompts], ['resolver', resolverPrompts], ['counsellor', counsellorPrompts], ['director-decree', directorPrompts]]);
}
