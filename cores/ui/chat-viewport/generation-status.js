
/** Полоска-светофор генерации: события `generation.*` → статус сообщения. */
export function installGenerationStatus(ctx) {
    const { genStatus, subscriptions, host, coreOrNull } = ctx;

    function subscribeGeneration() {
            // Полоска-светофор — owner: "Посмотри в нашем светофоре" (тот же
            // словарь событий, что уже классифицирует `cores/ui/activity-
            // light.js`, но здесь ТРИ цвета вместо пяти — working/success/error,
            // "прервано без ошибки" и "настоящая ошибка" владелец слил в один
            // красный намеренно). `liveMesid()` — тот же приём, что уже даёт
            // `message-footer.js` самому RP Time (`pendingMesid.set(await
            // currentMesid())`): в payload'ах `generation.*` mesid не летит
            // вовсе (`cores/generation/index.js` несёт только `runId`), а
            // "последнее отрисованное сообщение ПРЯМО СЕЙЧАС" в момент события
            // — лучшее доступное приближение "какое сообщение генерируется".
            // Полоска — про ОДНУ генерацию ответа: цель (`genTarget`) — то сообщение, которое сейчас генерируется. Раньше каждое событие
            // метило «последнее сообщение на этот момент»: оранжевое оставалось на предыдущем сообщении, когда появлялось новое, а вытеснение
            // прогона (свайп/реролл) красило сообщение красным посреди живой генерации.
            let genTarget = null;
            const setGenStatus = (mesid, status) => {
                if (status == null) genStatus.delete(String(mesid)); else genStatus.set(String(mesid), status);
            };
            const followGeneration = async () => {
                const mesid = await coreOrNull('ui.messageFooter.liveMesid', {});
                if (mesid == null) return;
                const target = String(mesid);
                if (genTarget !== null && genTarget !== target && genStatus.get(genTarget) === 'working') setGenStatus(genTarget, null);
                genTarget = target;
                setGenStatus(target, 'working');
                ctx.render();
            };
            const finishGeneration = async status => {
                const mesid = await coreOrNull('ui.messageFooter.liveMesid', {});
                const target = mesid != null ? String(mesid) : genTarget;
                if (genTarget !== null && genTarget !== target && genStatus.get(genTarget) === 'working') setGenStatus(genTarget, null);
                genTarget = null;
                if (target == null) return;
                setGenStatus(target, status);
                ctx.render();
            };
            subscriptions.push(host.events.subscribe('generation.beforeSend', () => { followGeneration(); }));
            subscriptions.push(host.events.subscribe('generation.sending', () => { followGeneration(); }));
            subscriptions.push(host.events.subscribe('generation.toolCall', () => { followGeneration(); }));
            subscriptions.push(host.events.subscribe('generation.completed', payload => { finishGeneration(payload?.outcome === 'stopped' ? 'error' : 'success'); }));
            // `superseded` — прогон вытеснен НОВЫМ, который стартует сразу за ним: это не конец генерации и не ошибка.
            subscriptions.push(host.events.subscribe('generation.aborted', () => { finishGeneration('error'); }));
            subscriptions.push(host.events.subscribe('generation.prepareFailed', () => { finishGeneration('error'); }));
    }

    Object.assign(ctx, { subscribeGeneration });
}
