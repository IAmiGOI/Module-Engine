# План: Модуль «Music» для Beta (полностью локальный подбор по эмбедингам)

Концепт (согласован с владельцем): классификация сцены LLM НЕ нужна. Трек описывается
текстовой «визиткой», вектор считается один раз (кэш на треке). Сцена = текст последних
реплик чата → один `embedding.compute` на смену сцены. Выбор: максимум косинуса,
при близких счётах — взвешенный `1/(playCount+1)` (наследие Alpha's selection.js).
Ниже порога косинуса — НЕ меняем играющий трек. Плеер — FloatingPanel, аудио — IndexedDB.

Порядок (по правилу LIBRARIES.md — Библиотека перед кодом):

1. **Библиотека** `libraries/core/track-selection.js` (Ядра): чистые функции —
   `cosineSimilarity()`, `selectTrack({tracks, sceneVector, randomFn})`:
   фильтр без вектора/порога → максимум косинуса → кластер «близких» (в пределах
   `closeMargin` от лучшего) → weighted pick. Инъектируемый `randomFn`.
2. **Тесты Библиотеки** `tests/track-selection.test.js` — юнит: пустые входы,
   трек без вектора не участвует, победа по косинусу, кластер близких и weighted
   fallback, ниже порога → null. Bypass-then-restore не применим (новый код),
   но каждый тест обязан пиновать конкретное поведение.
3. **Сервис** `services/audio-store.js` — единственное место, трогающее indexedDB
   (`audio.put/get/delete`, `audio.url` не нужен — blob отдаётся Модулю).
   Фейковый аналог в тестах — Map вместо IndexedDB.
4. **Модуль** `modules/music/index.js`:
   - манифест-форма Beta (id `music`, community-уровень прав);
   - конфигурация — `storage.settings` (namespace модуля): tracks (id, name,
     description, vector, playCount), volume, player-геометрия;
   - пересчёт вектора трека — при добавлении/правке описания через `embedding.compute`
     (Сервис, через `host.services`, как в memory-graph);
   - триггер смены сцены — `generation.completed` (условие Директора): собрать
     текст последних реплик, один `embedding.compute`, `selectTrack`, играть;
     `st.chatChanged` — перечитать состояние чата (без смены трека);
   - смена трека ТОЛЬКО если новый лучший косинус выше текущего на margin;
     ниже порога — играющий трек продолжается;
   - плеер — FloatingPanel (библиотека), play/pause/skip/volume, now-playing;
   - `generation.registerTool` НЕ нужен (не инструмент модели).
5. **Тесты Модуля** `tests/music-module.test.js` — сценарные через реальный движок
   (фейк только Сервисов): embedding-фейк детерминированный, audio-фейк на Map;
   прогон `generation.completed` → выбрался правильный трек; близкие счёты →
   weighted по playCount; слабый косинус → трек не сменился; персист конфига.
6. **Проводка** — реестр Модулей в `harness/engine-wiring.js` (community-права),
   без харнесс-прогона (не работает в среде ассистента — решено владельцем).
7. Финальный прогон: `node --test tests/*.test.js` (glob-форма!), всё зелёное.

Ограничения: без вызовов LLM вовсе; `embedding.compute` недоступен → мягкая
деградация (трек не меняется, ошибка на карточке модуля, не тост-шторм).
