/**
 * Вклад модуля в промпт через Prompt Manager (контракт chat-inject нового образца).
 * Раньше каждый вкладчик правил `chat` руками (`chat.unshift/splice`); теперь, если PM берёт сборку на себя,
 * вклад объявляется `promptManager.contribute`, а место выбирает пользователь в окне PM. Если PM выключен,
 * не поддерживает текущий чат или недоступен — работает прежняя вставка (`legacy`), поведение не меняется.
 *
 * **Публикуется ВСЕГДА, даже с пустым `content`** (решение владельца: «модуль должен публиковать своё место даже
 * если он пустой») — иначе узел вклада никогда не появлялся бы в дереве пресета (`placeContribution()` ставит узел
 * только для того, что реально в реестре), и пользователь не мог бы заранее занять ему место в PM: модуль без ни
 * разу не бывшего содержимого (блокнот, в который ещё ничего не записали) был бы попросту невидим в редакторе.
 * Пустой вклад в сборке ничего не отправляет — `pm-assemble.js` сам отмечает узел `inject` с пустым текстом как
 * «empty» и пропускает; отчёт превью честно покажет причину.
 *
 *   call(contract, params) → конверт `{ ok, value }` (как у `request()` вызывающего)
 *   contribution — { id, name, role, content, defaultPlacement, stable }
 *   legacy() — прежняя вставка в `chat`
 * Возвращает 'contributed' | 'legacy'. Никогда не бросает.
 */
export async function deliverToPrompt({ call, contribution, legacy }) {
    let takesOver = false;
    try {
        const answer = await call('promptManager.takesOver', {});
        takesOver = Boolean(answer?.ok && answer.value === true);
    } catch { takesOver = false; }
    if (!takesOver) { legacy?.(); return 'legacy'; }
    try {
        const answer = await call('promptManager.contribute', contribution);
        if (answer?.ok) return 'contributed';
    } catch { /* ниже — прежний путь */ }
    legacy?.();
    return 'legacy';
}
