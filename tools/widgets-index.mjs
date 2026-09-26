#!/usr/bin/env node
/**
 * Пересобирает `widgets/index.json` — список папок виджетов. Браузер не умеет читать содержимое папки расширения (ST отдаёт файлы по прямому
 * адресу, а листинга каталога нет), поэтому рабочий стол берёт список из этого файла. Новый виджет: положить папку `widgets/<id>/widget.js` и запустить
 *   node tools/widgets-index.mjs
 * (тест `tests/widgets-index.test.js` падает, если файл разошёлся с папкой, — забыть не получится).
 */
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const widgetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'widgets');

/** Идентификаторы папок, в которых есть `widget.js`, по алфавиту. */
export function scanWidgetFolders(dir = widgetsDir) {
    return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'widget.js')))
        .map(entry => entry.name)
        .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const ids = scanWidgetFolders();
    writeFileSync(join(widgetsDir, 'index.json'), `${JSON.stringify({ widgets: ids }, null, 2)}\n`);
    console.log(`widgets/index.json: ${ids.join(', ') || '(none)'}`);
}
