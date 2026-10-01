/**
 * Что показать вместо лица Меа — чистые функции, без DOM/сети/таймеров (их держит `cores/guide/avatar.js`). Каждая деталь решена
 * владельцем явно (не угадана):
 *
 * **Приоритет** (треки НЕ комбинируются в одну картинку — независимые наборы, первое совпадение побеждает):
 *   1. Чиби — если её последний CoT (думает + отвечает, СЫРОЙ текст последней генерации целиком, до вырезания `<think>`; НЕ история
 *      чата и НЕ реплика пользователя) совпал с одной из настроенных владельцем поз.
 *   2. Внутри чиби здоровье ME всё равно главнее конкретной позы: `red` → её чиби-«злость», `green` → чиби-«радость» (это ЗАМЕНА
 *      найденной по ключевым словам позы на этот ход, не отдельная поза по ключевым словам).
 *   3. Без чиби — обычный статус: `red`/`green` как отдельные картинки.
 *   4. Белый (штатно) — тир одежды по накопленному времени, с neko-версией, если открыт чек-лист первого запуска (4/4).
 *
 * **Здоровье ME** — не светофор генераций (`cores/ui/activity-light.js`, тот про текущий прогон и гаснет через секунды): это
 * `model.workers.status`, KOEP ME's сайдкары/воркеры отдельно. `degraded` не в счёт (владелец: иначе красный горел бы почти всегда) —
 * только настоящий `down`. Зелёный — не «генерация прошла», а «последний упавший воркер только что перестал быть down»; держится
 * `STATUS_HOLD_MS` и гаснет в белый сам.
 */

/** Сколько держится зелёный («только что починилось») после того, как упавший воркер вернулся в строй. */
export const STATUS_HOLD_MS = 5 * 60 * 1000;

/** Хоть один воркер по-настоящему `down` (не `degraded` — см. doc-comment файла). */
export const anyDown = workers => (workers ?? []).some(worker => worker?.state === 'down');

/**
 * Красный/зелёный/белый с памятью о переходе. `previous` — `{ down, recoveredAt }` от прошлого вызова (`null` в первый раз).
 * `recoveredAt` ставится РОВНО в момент "было down → стало не down"; зелёный держится, пока `now - recoveredAt < holdMs`, потом сам
 * гаснет в белый на следующем вызове — без отдельного таймера, только сравнение времени.
 */
export function nextHealthStatus(previous, { workers, now, holdMs = STATUS_HOLD_MS }) {
    const down = anyDown(workers);
    const wasDown = previous?.down ?? false;
    const recoveredAt = !down && wasDown ? now : (previous?.recoveredAt ?? null);
    const justRecovered = !down && recoveredAt !== null && now - recoveredAt < holdMs;
    return { down, recoveredAt: down ? null : recoveredAt, status: down ? 'red' : justRecovered ? 'green' : 'white' };
}

/** Тир одежды из накопленных часов: 1 (полная) ниже первого порога, 2 (короче) ниже второго, иначе 3 (топлесс). `thresholds` — `[N, 2N]` часов. */
export function tierFromHours(hoursElapsed, thresholds) {
    const hours = Number(hoursElapsed) || 0;
    if (hours < thresholds[0]) return 1;
    if (hours < thresholds[1]) return 2;
    return 3;
}

/**
 * Первая подошедшая чиби-поза по СЫРОМУ тексту последней генерации (см. doc-comment файла — не история, не реплика юзера).
 * `poses` — задаёт владелец: `[{ id, keywords?: string[], pattern?: string }]`. `id` = имя файла `chibi-<id>.png`. `angry`/`happy`
 * сюда НЕ включаются — они не по ключевым словам, их подставляет `resolveAvatar` по здоровью (см. ниже). Пустой/не заданный список —
 * `null` всегда, чиби никогда не включается за вас.
 */
export function matchChibiPose(text, poses) {
    const haystack = String(text ?? '').toLowerCase();
    for (const pose of poses ?? []) {
        if (!pose?.id) continue;
        if (pose.pattern && new RegExp(pose.pattern, 'i').test(text ?? '')) return pose.id;
        if (pose.keywords?.some(word => haystack.includes(String(word).toLowerCase()))) return pose.id;
    }
    return null;
}

/**
 * Сводит всё воедино по приоритету из doc-comment файла. Возвращает один из:
 * `{ track: 'chibi', id }`, `{ track: 'status', id: 'red'|'green' }`, `{ track: 'normal', tier, neko }`.
 */
export function resolveAvatar({ health, lastCoT, chibiPoses, tier, nekoUnlocked, mode = 'normal', defaultChibi = 'side' }) {
    // Режим «чиби» (выбор владельца в шапке окна): основной вид — всегда чиби. Поза по ключевым словам, как обычно; здоровье ME всё так же главнее (red → злость, green → радость);
    // нет ни позы, ни проблем — базовая поза `defaultChibi` (файл `chibi-<id>.png`).
    if (mode === 'chibi') {
        if (health === 'red') return { track: 'chibi', id: 'angry' };
        if (health === 'green') return { track: 'chibi', id: 'happy' };
        return { track: 'chibi', id: matchChibiPose(lastCoT, chibiPoses) ?? defaultChibi };
    }
    const chibiPose = matchChibiPose(lastCoT, chibiPoses);
    if (chibiPose !== null) {
        if (health === 'red') return { track: 'chibi', id: 'angry' };
        if (health === 'green') return { track: 'chibi', id: 'happy' };
        return { track: 'chibi', id: chibiPose };
    }
    if (health === 'red' || health === 'green') return { track: 'status', id: health };
    return { track: 'normal', tier, neko: Boolean(nekoUnlocked) };
}

/** Имя файла тира — тройка владельца (все под префиксом `tier-1-`, номер тира — в слове, не в цифре); используется и для обычной, и для neko-версии (`neko-tier-1-…`). */
export const TIER_NAMES = Object.freeze({ 1: 'tier-1-full', 2: 'tier-1-shorts', 3: 'tier-1-topless' });

/** `resolveAvatar()`'s итог → путь файла ОТНОСИТЕЛЬНО `assets/guide-avatars/` (см. `cores/guide/avatar.js` за базовым URL и фолбэком, если neko-файла нет). Плоские имена, без подпапок (владелец: не может класть в `chibi/`). */
export function avatarFileFor(picked) {
    if (picked.track === 'status') return `status-${picked.id}.png`;
    if (picked.track === 'chibi') return `chibi-${picked.id}.png`;
    const base = TIER_NAMES[picked.tier] ?? TIER_NAMES[1];
    return picked.neko ? `neko-${base}.png` : `${base}.png`;
}
