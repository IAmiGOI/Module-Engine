/*
 * Сверка раскладчика на НАСТОЯЩИХ чатах в живой ST: вставить в консоль страницы ST с установленным движком. Корпус — все сообщения всех
 * персонажей (`messageFormatting`, как у Chat Viewport), шрифт — шрифт темы. Эталон — настоящее зеркало на странице ST (его CSS уже загружен
 * движком). `BASE` — путь к папке расширения, если она названа иначе.
 */
(async () => {
    const BASE = '/scripts/extensions/third-party/Module-Engine/';
    const WIDTHS = [300, 389, 520, 800];
    const { runLayoutCheck } = await import(`${BASE}tools/text-layout-check/check.js`);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const fontFamily = getComputedStyle(document.querySelector('.mes_text') ?? document.body).fontFamily;
    for (const variant of ['', 'italic ', '700 ', 'italic 700 ']) await document.fonts.load(`${variant}15px ${fontFamily}`);
    const samples = [];
    const initial = SillyTavern.getContext();
    for (let index = 0; index < initial.characters.length; index += 1) {
        await initial.selectCharacterById(index);
        await sleep(2500);
        const context = SillyTavern.getContext();
        context.chat.forEach((message, mesid) => {
            try { samples.push({ id: `${index}:${mesid}`, html: context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, mesid) }); } catch { /* пропуск */ }
        });
    }
    const host = document.createElement('div');
    host.className = 'stme-chat-viewport-mirror-host';
    document.body.append(host);
    try {
        const report = await runLayoutCheck({ samples, widths: WIDTHS, theme: { fontFamily, fontSize: 15, lineHeight: 1.4, blockGap: 10 }, host });
        console.log(report);
        return report;
    } finally {
        host.remove();
    }
})();
