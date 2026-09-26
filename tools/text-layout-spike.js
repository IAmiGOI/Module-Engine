/*
 * ЭКСПЕРИМЕНТ (не продакшен-код): раскладка текста сообщений на Canvas 2D `measureText` против DOM. Вставляется в консоль страницы тестового ST (127.0.0.1:8010),
 * пробегает по чатам всех персонажей и сравнивает ВЫСОТУ сообщения: наша раскладка против настоящей раскладки браузера.
 *
 * Результат первого прогона (2026-09-27, 27 сообщений × ширины 300/389/520/800 = 100 замеров): точное совпадение высоты 94%, в пределах одной строки 96%, средняя
 * ошибка 1,7px; 8 замеров пропущены как «не поддерживается» (код, картинки, стили и т.п. — пойдут на запасной путь).
 * Найденные причины расхождений — см. TEXT_ENGINE_BRIEF.md, раздел «Что показал эксперимент».
 *
 * Это ОТПРАВНАЯ ТОЧКА для настоящей библиотеки (чистая раскладка с внешним `measure`, тесты в Node), а не то, что надо оставить как есть.
 */
(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ST = SillyTavern.getContext();
    const SIZE = 15, LH = 21, GAP = 10, FONT = '"Noto Sans", sans-serif';
    const cv = document.createElement('canvas').getContext('2d');
    const wc = new Map();
    const fontOf = st => `${st.i ? 'italic ' : ''}${st.b ? '700 ' : '400 '}${st.size || SIZE}px ${FONT}`;
    const W = (text, st) => {
        const k = (st.i ? 1 : 0) + '|' + (st.b ? 1 : 0) + '|' + (st.size || SIZE) + '|' + text;
        let v = wc.get(k);
        if (v === undefined) { cv.font = fontOf(st); v = cv.measureText(text).width; wc.set(k, v); }
        return v;
    };
    const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'PRE', 'HR', 'TABLE', 'DETAILS']);
    const HEAD = { H1: 2, H2: 1.5, H3: 1.17, H4: 1, H5: .83, H6: .67 };
    const BADSTYLE = /font-size|padding|margin|display|border|line-height|letter-spacing|font-family|position|float|width|height|background/i;
    let unsupported = false;

    // Плоский список: слово (набор фрагментов со стилем — слово может состоять из нескольких узлов без пробела между ними), пробел, перенос.
    function flatten(nodes, st, items) {
        for (const n of nodes) {
            if (n.nodeType === 3) {
                for (const piece of n.data.split(/(\s+)/)) {
                    if (!piece) continue;
                    if (/^\s+$/.test(piece)) { if (items.length && items[items.length - 1].t !== 'space') items.push({ t: 'space', st }); }
                    else { const last = items[items.length - 1]; if (last && last.t === 'word') last.f.push({ text: piece, st }); else items.push({ t: 'word', f: [{ text: piece, st }] }); }
                }
            } else if (n.nodeType === 1) {
                const tag = n.tagName;
                if (tag === 'BR') { items.push({ t: 'br' }); continue; }
                if (['IMG', 'CODE', 'SUB', 'SUP', 'SVG', 'INPUT', 'BUTTON', 'TABLE', 'PRE', 'DETAILS', 'IFRAME', 'VIDEO'].includes(tag)) unsupported = true;
                if (n.getAttribute && BADSTYLE.test(n.getAttribute('style') || '')) unsupported = true;
                const ns = { ...st };
                if (tag === 'EM' || tag === 'I') ns.i = true;
                if (tag === 'STRONG' || tag === 'B') ns.b = true;
                if (BLOCK.has(tag)) unsupported = true;
                flatten(n.childNodes, ns, items);
            }
        }
        return items;
    }

    // Жадный перенос: число строк блока при ширине `avail`.
    function lines(items, avail) {
        let n = 1, cur = 0, has = false, pend = 0, any = false, lastBr = false;
        for (const it of items) {
            lastBr = false;
            if (it.t === 'br') { n++; cur = 0; has = false; pend = 0; any = true; lastBr = true; }
            else if (it.t === 'space') { if (has) pend = W(' ', it.st); }
            else {
                any = true;
                const ww = it.f.reduce((a, f) => a + W(f.text, f.st), 0);
                if (has && cur + pend + ww > avail) { n++; cur = ww; } else cur += pend + ww;
                pend = 0; has = true;
            }
        }
        if (!any) return 0;
        if (lastBr) n--;
        return n;
    }

    function blockH(el, avail) {
        const tag = el.tagName;
        if (tag === 'UL' || tag === 'OL') { let h = 0; for (const li of el.children) h += blockH(li, avail - 21); return h; }
        if (tag === 'BLOCKQUOTE') return childrenH(el, avail - 10);
        if (tag === 'PRE' || tag === 'TABLE' || tag === 'DETAILS' || tag === 'HR') { unsupported = true; return 0; }
        const size = (HEAD[tag] || 1) * SIZE;
        const st = HEAD[tag] ? { b: true, size } : {};
        if ([...el.children].some(c => BLOCK.has(c.tagName))) return childrenH(el, avail);
        return lines(flatten(el.childNodes, st, []), avail) * (HEAD[tag] ? size * 1.4 : LH);
    }

    function childrenH(container, avail, top) {
        let total = 0, first = true, anon = [];
        const flushAnon = () => { if (anon.length) { const l = lines(flatten(anon, {}, []), avail); if (l) { total += l * LH; first = false; } anon = []; } };
        for (const n of container.childNodes) {
            if (n.nodeType === 1 && BLOCK.has(n.tagName)) {
                flushAnon();
                const h = blockH(n, avail);
                if (top && !first) total += GAP;
                total += h; first = false;
            } else anon.push(n);
        }
        flushAnon();
        return total;
    }

    const engineHeight = (html, width) => {
        unsupported = false;
        const d = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html').body;
        return { h: childrenH(d, width, true), unsupported };
    };

    // Настоящая раскладка: те же правила, что у зеркала Chat Viewport (styles/chat-viewport/mirror-row.css).
    const styleEl = document.createElement('style');
    styleEl.textContent = '.spk{position:absolute;visibility:hidden;left:-9999px;font:15px/1.4 "Noto Sans",sans-serif} .spk *{margin:0} .spk>*+*{margin-top:10px} .spk ul,.spk ol{padding-left:1.4em} .spk blockquote{padding-left:10px}';
    document.head.append(styleEl);
    const domHeight = (html, width) => { const d = document.createElement('div'); d.className = 'spk'; d.style.width = width + 'px'; d.innerHTML = html; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return h; };

    await document.fonts.load('15px "Noto Sans"'); await document.fonts.load('italic 15px "Noto Sans"'); await document.fonts.load('700 15px "Noto Sans"');
    const samples = [];
    for (let c = 0; c < ST.characters.length; c++) {
        await ST.selectCharacterById(c); await sleep(2500);
        const s2 = SillyTavern.getContext();
        s2.chat.forEach((m, idx) => { try { samples.push({ c, idx, html: s2.messageFormatting(m.mes, m.name, m.is_system, m.is_user, idx), len: m.mes.length }); } catch (e) { /* пропуск */ } });
    }
    let n = 0, sup = 0, exact = 0, within = 0, sumAbs = 0;
    const worst = [];
    for (const s of samples) for (const w of [300, 389, 520, 800]) {
        const e = engineHeight(s.html, w), d = domHeight(s.html, w);
        if (e.unsupported) { sup++; continue; }
        n++;
        const a = Math.abs(e.h - d);
        sumAbs += a; if (a < 0.5) exact++; if (a <= 21) within++;
        worst.push({ c: s.c, idx: s.idx, w, eng: Math.round(e.h), dom: Math.round(d), diff: Math.round(e.h - d) });
    }
    worst.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    return { messages: samples.length, tested: n, unsupportedRuns: sup, exactPct: Math.round(100 * exact / Math.max(1, n)), withinOneLinePct: Math.round(100 * within / Math.max(1, n)), meanAbs: +(sumAbs / Math.max(1, n)).toFixed(1), worst: worst.slice(0, 6) };
})();
