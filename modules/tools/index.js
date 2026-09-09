/**
 * Папка «Tools» — НЕ Модуль, а группировка в UI. Каждый инструмент живёт
 * своим файлом здесь и включается собственным тумблером в панели, как
 * любой самостоятельный Модуль; папка только собирает их визуально.
 * Этот файл — точка экспорта набора для реестра (engine-wiring.js).
 */
export { NOTEBOOK_MODULE_ID as MODULE_ID, createNotebookSubmodule, createNotebookModule } from './notebook.js';
export { SECRETS_MODULE_ID, createSecretsModule, SECRETS_TOOL_SCHEMA } from './secrets.js';
