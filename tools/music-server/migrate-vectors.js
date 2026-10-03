import path from 'node:path';
import { promises as fs } from 'node:fs';
import { embedPassage, embedQuery, MODEL_ID } from './embed.js';

/**
 * Пересчёт ВСЕХ векторов каталога текущей моделью `embed.js` (после её смены). Векторы разных моделей несравнимы, поэтому, пока каталог не пересчитан, ME отбрасывает его как
 * несовместимый (проверка `model` в ответе). Запуск при ОСТАНОВЛЕННОМ сервисе: `DATA_DIR=/var/lib/me-music node migrate-vectors.js`. Перед записью рядом кладётся копия
 * `catalog.before-<модель>.json`. Теги и эталонные сцены не меняются — только вектора.
 */

const dir = path.resolve(process.env.DATA_DIR ?? './data');
const file = path.join(dir, 'catalog.json');
const cacheDir = path.join(dir, 'models');

const data = JSON.parse(await fs.readFile(file, 'utf8'));
await fs.copyFile(file, path.join(dir, `catalog.before-${MODEL_ID.replace(/[^\w.-]+/g, '_')}.json`));

const done = { groups: 0, tracks: 0, examples: 0, negatives: 0 };
const passage = text => embedPassage(text, { cacheDir });

for (const group of data.groups ?? []) {
    if (group.description) { group.vector = await passage(group.description); done.groups += 1; }
    if (group.negative) { group.negVector = await passage(group.negative); done.negatives += 1; }
}
for (const track of data.tracks ?? []) {
    // Теги есть у треков только в разделах «по трекам»; в групповых тег живёт у группы.
    if (track.description) { track.vector = await passage(track.description); done.tracks += 1; }
    if (track.negative) { track.negVector = await passage(track.negative); done.negatives += 1; }
}
for (const example of data.examples ?? []) {
    example.vector = await embedQuery(example.text, { cacheDir });
    done.examples += 1;
}

await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
await fs.rename(`${file}.tmp`, file);
console.log(`[migrate-vectors] ${MODEL_ID}:`, done);
