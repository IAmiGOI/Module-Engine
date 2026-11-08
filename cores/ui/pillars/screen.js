import { constellationStars, toCourt } from '../../../libraries/core/pillars-sources.js';
import { PILLARS_CSS } from './screen-css.js';
import { PILLARS_MARKUP } from './screen-markup.js';

/**
 * Экран «Пять столпов» — утверждённый макет (`docs/research-decision/mockups/five-pillars.html`),
 * перенесённый почти один в один: фон (шейдеры, схема, живые круги), эмблемы, книга, свиток, небо,
 * стол Court с падением в темноту. Живёт в теневом DOM, чтобы стили ST и макета не задевали друг друга.
 * Данные — готовые модели столпов (`load(id)` → модель из `libraries/core/pillars-sources.js`),
 * действия — `actions` (их проводит ядро через контракты движка). Своих данных экран не держит.
 */
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Barlow+Condensed:wght@400;500;600&family=IM+Fell+English:ital@0;1&family=IM+Fell+English+SC&family=Reenie+Beanie&display=swap';
// живые тексты длиннее макетных: ничего не выезжает за страницу — переносы, ограниченные колонки, многоточия
const FIT_CSS = `
.ink, .sheet-in, .depth-in, .entry, .art { overflow-wrap: anywhere; }
.ink > *, .ink dl, .ink dd, .ink dt, .ink p { max-width: 100%; min-width: 0; }
.ink dl { grid-template-columns: minmax(4.5em, 32%) minmax(0, 1fr); }
.ink dl + dl { margin-top: 9px; }
.ink img { max-width: 100%; }
.ink .nm, .ink .h, .ink .title .big { overflow-wrap: anywhere; hyphens: auto; }
.ink .toc button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ink .toc button b { flex: none; }
.thumb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thumb small { overflow: hidden; text-overflow: ellipsis; }
.ribbon { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.blank { max-width: 100%; overflow-wrap: anywhere; }
.entry .det pre, .slip pre { overflow-wrap: anywhere; white-space: pre-wrap; }
`;
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createPillarsScreen({ document = globalThis.document, load = async () => null, actions = {}, onHide = () => {} } = {}) {
  if (!document.querySelector(`link[href="${FONTS}"]`)) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = FONTS; document.head.append(link);
  }
  const host = document.createElement('div');
  host.className = 'stme-pillars-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:31000;display:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${PILLARS_CSS}${FIT_CSS}</style><div class="stage">${PILLARS_MARKUP}</div>`;
  const $ = selector => root.querySelector(selector), $$ = selector => root.querySelectorAll(selector);
  let visible = false, chatName = '';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function noise2(seed) {
    const p = new Uint8Array(512); let s = seed;
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    const v = (x, y) => p[p[x & 255] + (y & 255)] / 255, f = t => t * t * (3 - 2 * t);
    return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = f(x - xi), yf = f(y - yi), a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1); return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
  }
  const fbm = (n, x, y, o = 5) => { let s = 0, a = .5, f = 1; for (let i = 0; i < o; i++) { s += a * n(x * f, y * f); a *= .5; f *= 2.03; } return s; };

  const pillars = [...$$('.pillar')];
  let aspect = innerWidth / innerHeight;
  const pools = [];
  function placePools() {
    aspect = innerWidth / innerHeight; pools.length = 0;
    for (const p of pillars) { const r = p.querySelector('.disc').getBoundingClientRect();
      pools.push({ el: p, x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight, r: (r.width / innerHeight) * .95, power: .28, warm: p.hasAttribute('data-call') }); }
  }

  /* ===== Пятиугольник вокруг центра ===== */
  const ORDER = { court: -90, bank: -18, world: 54, charter: 126, canon: 198 };
  let center = { x: 0, y: 0 }, radius = 0;
  function positionPillars() {
    center = { x: innerWidth / 2, y: innerHeight * .5 };
    radius = Math.min(innerWidth * .34, innerHeight * .36);
    for (const p of pillars) { const a = ORDER[p.dataset.p] * Math.PI / 180, disc = p.querySelector('.disc').offsetHeight || 140;
      p.style.left = `${center.x + Math.cos(a) * radius}px`; p.style.top = `${center.y + Math.sin(a) * radius + p.offsetHeight / 2 - disc / 2}px`; }
  }

  /* ===== Старинная схема под столпами (рисуется один раз, на ресайз) ===== */
  /* ===== Живые круги на всех фонах: случайный круг просыпается с одним из пяти эффектов и плавно засыпает ===== */
  // эффекты по тому, что у фигуры есть: насечки скользят только по кольцу с насечками, вращение — где есть что вращать
  const effectsFor = f => ['glow', 'breathe', 'dot', ...(f.dash || f.ticks ? ['spin'] : []), ...(f.ticks ? ['slide', 'slide', 'slide'] : [])];
  const chartFx = root.getElementById('chartfx'), platefx = $('[data-platefx]');
  let chartFigs = [], plateFigs = [], chartMask = null;
  const inkA = a => `rgba(196,160,100,${Math.min(1, Math.max(0, a) * 2.1)})`;
  function fig(list, cx, cy, r, w, a, dash) {
    list.push({ cx, cy, r, w, a, dash, ticks: null, eff: null, env: 0, tgt: 0, until: 0, next: performance.now() + 800 + Math.random() * 9000, rot: 0, slide: 0, ph: Math.random() * 6.28, dir: Math.random() < .5 ? -1 : 1 });
  }
  function drawFigs(cv, figs, mask, k, now) {
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); if (!figs.length) return;
    const t = now / 1000; g.lineCap = 'round';
    for (const f of figs) {
      if (!f.eff && now > f.next) { const list = effectsFor(f); f.eff = list[Math.random() * list.length | 0]; f.tgt = 1; f.until = now + 6000 + Math.random() * 9000; }
      else if (f.eff && now > f.until) f.tgt = 0;
      f.env += (f.tgt - f.env) * .04;
      if (f.eff && !f.tgt && f.env < .01) { f.eff = null; f.env = 0; f.next = now + 3000 + Math.random() * 12000; }
      const e = f.env, eff = f.eff;
      let r = f.r, a = f.a;
      if (eff === 'glow') a *= 1 + 1.6 * e * (.5 + .5 * Math.sin(t * 1.7 + f.ph));          // 1. пульсация светом
      if (eff === 'spin') f.rot += .006 * e * f.dir;                                         // 2. вращение круга и делений
      if (eff === 'breathe') r *= 1 + .045 * e * Math.sin(t * 1.3 + f.ph);                   // 3. дыхание радиусом
      if (eff === 'slide') f.slide += .009 * e * f.dir * (.55 + .45 * Math.sin(t * .6 + f.ph)); // 4. насечки скользят по кольцу, кольцо стоит
      g.beginPath(); g.setLineDash(f.dash || []); g.lineDashOffset = -f.rot * r; g.arc(f.cx, f.cy, r, 0, 7); g.strokeStyle = inkA(a); g.lineWidth = f.w * k; g.stroke(); g.setLineDash([]);
      if (f.ticks) {
        const T = f.ticks, gain = a / f.a;
        for (let i = 0; i < T.n; i++) {
          const an = i / T.n * 6.2832 + f.rot + f.slide, maj = i % T.major === 0, l = maj ? T.long : T.short;
          g.beginPath(); g.moveTo(f.cx + Math.cos(an) * r, f.cy + Math.sin(an) * r); g.lineTo(f.cx + Math.cos(an) * (r + l), f.cy + Math.sin(an) * (r + l));
          g.strokeStyle = inkA((maj ? T.aMajor : T.aMinor) * gain); g.lineWidth = k; g.stroke();
        }
      }
      if (eff === 'dot' && e > .01) {                                                        // 5. точка чертит круг, след распадается
        const head = t * .7 * f.dir + f.ph, N = 40, st = .09 * f.dir;
        for (let i = 0; i < N; i++) {
          const a0 = head - st * (i + 1), a1 = head - st * i;
          g.beginPath(); g.arc(f.cx, f.cy, r, Math.min(a0, a1), Math.max(a0, a1)); g.strokeStyle = inkA(.32 * e * (1 - i / N) ** 1.6); g.lineWidth = (f.w + .6) * k; g.stroke();
        }
        g.beginPath(); g.arc(f.cx + Math.cos(head) * r, f.cy + Math.sin(head) * r, 2.2 * k, 0, 7); g.fillStyle = `rgba(255,214,150,${.85 * e})`; g.fill();
      }
    }
    if (mask) { g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, 0, 0, cv.width, cv.height); g.globalCompositeOperation = 'source-over'; }
  }

  const chart = root.getElementById('chart');
  function paintChart() {
    const W = chart.width = innerWidth * devicePixelRatio, H = chart.height = innerHeight * devicePixelRatio, k = devicePixelRatio;
    const g = chart.getContext('2d'), cx = center.x * k, cy = center.y * k, R = radius * k;
    g.clearRect(0, 0, W, H); g.lineCap = 'round';
    const ink = a => `rgba(196,160,100,${Math.min(1, a * 2.1)})`;
    chartFx.width = W; chartFx.height = H; chartFigs = [];
    const ring = (r, w, a, dash) => fig(chartFigs, cx, cy, r, w, a, dash);
    ring(R * 1.62, 1, .10); ring(R * 1.55, 3, .06, [1 * k, 9 * k]); ring(R * 1.32, 1, .09);
    ring(R, 1.4, .16); ring(R * .94, 4, .07, [1.2 * k, 7 * k]); ring(R * .52, 1, .12); ring(R * .44, 1, .08, [6 * k, 5 * k]); ring(R * .2, 1, .12);
    g.setLineDash([]);
    const pts = Object.values(ORDER).map(d => d * Math.PI / 180).map(a => [cx + Math.cos(a) * R, cy + Math.sin(a) * R, a]);
    for (const [, , a] of pts) { g.beginPath(); g.moveTo(cx + Math.cos(a) * R * .22, cy + Math.sin(a) * R * .22); g.lineTo(cx + Math.cos(a) * R * 1.6, cy + Math.sin(a) * R * 1.6); g.strokeStyle = ink(.1); g.lineWidth = k; g.stroke(); }
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.strokeStyle = ink(.11); g.lineWidth = 1.2 * k; g.stroke();
    g.beginPath(); [0, 2, 4, 1, 3, 0].forEach((i, n) => (n ? g.lineTo(pts[i][0], pts[i][1]) : g.moveTo(pts[i][0], pts[i][1]))); g.strokeStyle = ink(.05); g.stroke();
    chartFigs.find(f => Math.abs(f.r - R * 1.32) < 1).ticks = { n: 120, major: 10, short: 6 * k, long: 16 * k, aMinor: .08, aMajor: .16 };
    g.font = `500 ${14 * k}px "Cormorant Garamond", Georgia, serif`; g.textAlign = 'center'; g.fillStyle = ink(.22);
    ['I', 'II', 'III', 'IV', 'V'].forEach((n, i) => { const a = pts[i][2]; g.fillText(n, cx + Math.cos(a) * R * 1.44, cy + Math.sin(a) * R * 1.44 + 5 * k); });
    let seed = 5; const r = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 70; i++) { const a = r() * Math.PI * 2, d = R * (.3 + r() * 1.4); g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, (r() * 1.4 + .4) * k, 0, 7); g.fillStyle = ink(.12 + r() * .2); g.fill(); }
    for (let i = 0; i < 6; i++) { const a = r() * Math.PI * 2; g.beginPath(); g.arc(cx, cy, R * (.6 + r() * .9), a, a + .4 + r() * .8); g.strokeStyle = ink(.08); g.lineWidth = k; g.stroke(); }
    const m = document.createElement('canvas'), mw = 240, mh = Math.round(240 * H / W); m.width = mw; m.height = mh;
    const mg = m.getContext('2d'), mi = mg.createImageData(mw, mh), NM = noise2(91);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const n = fbm(NM, x / mw * 6, y / mh * 6 * mh / mw, 5); mi.data[(y * mw + x) * 4 + 3] = Math.max(0, Math.min(1, (n - .34) * 2.6)) * 255; }
    mg.putImageData(mi, 0, 0); chartMask = m;
    g.globalCompositeOperation = 'destination-in'; g.imageSmoothingEnabled = true; g.drawImage(m, 0, 0, W, H); g.globalCompositeOperation = 'source-over';
  }

  /* ===== Гравюра под меню: книга лежит в рамке переплётного орнамента и колец, свиток — в стрельчатой арке ===== */
  const plate = $('[data-plate]');
  let plateMask = null;
  function paintPlate(mode) {
    plate.classList.remove('on'); if (!mode) return;
    const k = devicePixelRatio, W = plate.width = innerWidth * k, H = plate.height = innerHeight * k, g = plate.getContext('2d');
    g.clearRect(0, 0, W, H); g.lineCap = 'round';
    const ink = a => `rgba(196,160,100,${Math.min(1, a * 2.1)})`;
    const line = (pts, w, a, dash) => { g.beginPath(); g.setLineDash(dash || []); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = ink(a); g.lineWidth = w * k; g.stroke(); };
    platefx.width = W; platefx.height = H; plateFigs = [];
    const ring = (x, y, r, w, a, dash) => { if (r >= 12 * k) return fig(plateFigs, x, y, r, w, a, dash); g.beginPath(); g.setLineDash(dash || []); g.arc(x, y, r, 0, 7); g.strokeStyle = ink(a); g.lineWidth = w * k; g.stroke(); };
    let seed = mode === 'book' ? 11 : 29; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    if (mode === 'court') {
      const b = $('[data-court]').getBoundingClientRect(), x0 = (b.left + b.width / 2) * k, y0 = (b.top + b.height / 2) * k, U = b.width * k / 1000;
      ring(x0, y0, 460 * U, 1.2, .15); ring(x0, y0, 446 * U, 4, .07, [1.2 * k, 7 * k]); ring(x0, y0, 520 * U, 1, .1); ring(x0, y0, 600 * U, 1, .06, [6 * k, 6 * k]);
      plateFigs.find(f => Math.abs(f.r - 520 * U) < 1).ticks = { n: 150, major: 10, short: 7 * k, long: 20 * k, aMinor: .12, aMajor: .16 };
      for (const d of [-90, -18, 54, 126, 198]) { const a = d * Math.PI / 180; line([[x0 + Math.cos(a) * 470 * U, y0 + Math.sin(a) * 470 * U], [x0 + Math.cos(a) * 640 * U, y0 + Math.sin(a) * 640 * U]], 1, .12); ring(x0 + Math.cos(a) * 600 * U, y0 + Math.sin(a) * 600 * U, 22 * k, 1.1, .13); }
      for (let i = 0; i < 110; i++) { const a = rnd() * 7, d = (480 + rnd() * 300) * U; g.beginPath(); g.arc(x0 + Math.cos(a) * d, y0 + Math.sin(a) * d, (rnd() * 1.3 + .4) * k, 0, 7); g.fillStyle = ink(.1 + rnd() * .22); g.fill(); }
    } else if (mode === 'sky') {
      const x0 = W / 2, y0 = H * .47, R = Math.min(W, H) * .46;
      ring(x0, y0, R, 1.3, .15); ring(x0, y0, R * .97, 4, .06, [1.2 * k, 7 * k]); ring(x0, y0, R * .62, 1, .1); ring(x0, y0, R * .3, 1, .08, [5 * k, 6 * k]);
      plateFigs.find(f => Math.abs(f.r - R) < 1).ticks = { n: 180, major: 15, short: 6 * k, long: 18 * k, aMinor: .11, aMajor: .11 };
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 12; line([[x0 + Math.cos(a) * R * .3, y0 + Math.sin(a) * R * .3], [x0 + Math.cos(a) * R, y0 + Math.sin(a) * R]], 1, .05); line([[x0 - Math.cos(a) * R * .3, y0 - Math.sin(a) * R * .3], [x0 - Math.cos(a) * R, y0 - Math.sin(a) * R]], 1, .05); }
      g.beginPath(); g.setLineDash([]); g.ellipse(x0, y0, R * .98, R * .42, -.38, 0, 7); g.strokeStyle = ink(.12); g.lineWidth = 1.2 * k; g.stroke();
      g.beginPath(); g.ellipse(x0, y0, R * .98, R * .48, -.38, 0, 7); g.strokeStyle = ink(.06); g.setLineDash([2 * k, 6 * k]); g.stroke(); g.setLineDash([]);
      g.font = `500 ${14 * k}px "Cormorant Garamond", Georgia, serif`; g.textAlign = 'center'; g.fillStyle = ink(.2);
      ['I', 'III', 'VI', 'IX'].forEach((n, i) => { const a = -Math.PI / 2 + i * Math.PI / 2; g.fillText(n, x0 + Math.cos(a) * R * 1.07, y0 + Math.sin(a) * R * 1.07 + 5 * k); });
      for (let i = 0; i < 160; i++) { const a = rnd() * 7, d = R * Math.sqrt(rnd()) * 1.3; g.beginPath(); g.arc(x0 + Math.cos(a) * d, y0 + Math.sin(a) * d, (rnd() * 1.2 + .3) * k, 0, 7); g.fillStyle = ink(.1 + rnd() * .22); g.fill(); }
    } else if (mode === 'book') {
      const t = $('[data-tome]'), w = t.offsetWidth * k, h = t.offsetHeight * k;
      const box = t.offsetParent.getBoundingClientRect(), x0 = (box.left + t.offsetLeft + t.offsetWidth / 2) * k, y0 = (box.top + t.offsetTop + t.offsetHeight / 2) * k;
      const R = Math.hypot(w, h) * .56;
      ring(x0, y0, R, 1.2, .15); ring(x0, y0, R * .965, 4, .07, [1.2 * k, 7 * k]); ring(x0, y0, R * 1.12, 1, .09); ring(x0, y0, R * 1.3, 1, .06, [6 * k, 6 * k]);
      plateFigs.find(f => Math.abs(f.r - R * 1.12) < 1).ticks = { n: 144, major: 12, short: 7 * k, long: 20 * k, aMinor: .12, aMajor: .12 };
      for (const m of [34, 58]) { const mw = w / 2 + m * k, mh = h / 2 + m * k; line([[x0 - mw, y0 - mh], [x0 + mw, y0 - mh], [x0 + mw, y0 + mh], [x0 - mw, y0 + mh], [x0 - mw, y0 - mh]], m === 34 ? 1.3 : 1, m === 34 ? .14 : .08, m === 34 ? [] : [2 * k, 6 * k]); }
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = x0 + sx * (w / 2 + 58 * k), cy = y0 + sy * (h / 2 + 58 * k);
        ring(cx, cy, 26 * k, 1.2, .14); ring(cx, cy, 16 * k, 1, .1, [1 * k, 4 * k]);
        line([[cx - sx * 26 * k, cy], [cx - sx * 140 * k, cy]], 1, .1); line([[cx, cy - sy * 26 * k], [cx, cy - sy * 110 * k]], 1, .1);
      }
      for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) line([[x0 + Math.cos(a) * R * .97, y0 + Math.sin(a) * R * .97], [x0 + Math.cos(a) * R * 1.3, y0 + Math.sin(a) * R * 1.3]], 1, .12);
      g.font = `500 ${14 * k}px "Cormorant Garamond", Georgia, serif`; g.textAlign = 'center'; g.fillStyle = ink(.2);
      ['N', 'E', 'S', 'W'].forEach((n, i) => { const a = -Math.PI / 2 + i * Math.PI / 2; g.fillText(n, x0 + Math.cos(a) * R * 1.21, y0 + Math.sin(a) * R * 1.21 + 5 * k); });
      for (let i = 0; i < 90; i++) { const a = rnd() * 7, d = R * (.6 + rnd() * .8); g.beginPath(); g.arc(x0 + Math.cos(a) * d, y0 + Math.sin(a) * d, (rnd() * 1.4 + .4) * k, 0, 7); g.fillStyle = ink(.12 + rnd() * .2); g.fill(); }
    } else {
      const sc = $('.scroll'), sw = sc.offsetWidth * k, x0 = (sc.getBoundingClientRect().left + sc.offsetWidth / 2) * k;
      const aw = sw / 2 + 90 * k, top = 120 * k;
      for (const [m, a, dash] of [[0, .15, []], [26 * k, .08, [2 * k, 6 * k]]]) {
        const hw = aw + m, sp = top - m + hw;
        g.beginPath(); g.setLineDash(dash); g.moveTo(x0 - hw, H); g.lineTo(x0 - hw, sp); g.quadraticCurveTo(x0 - hw, top - m, x0, top - m - 80 * k); g.quadraticCurveTo(x0 + hw, top - m, x0 + hw, sp); g.lineTo(x0 + hw, H); g.strokeStyle = ink(a); g.lineWidth = 1.2 * k; g.stroke();
      }
      g.setLineDash([]);
      for (const side of [-1, 1]) {
        const x = x0 + side * (aw + 52 * k);
        line([[x, top + aw * .8], [x, H]], 1, .1);
        for (let y = top + aw * .8; y < H; y += 26 * k) { line([[x - 5 * k, y], [x + 5 * k, y]], 1, .12); if (rnd() > .55) ring(x + side * 16 * k, y + 13 * k, 3 * k, 1, .12); }
      }
      const cy = top + 70 * k; ring(x0, cy, 46 * k, 1.2, .16); ring(x0, cy, 38 * k, 3, .07, [1 * k, 5 * k]); ring(x0, cy, 20 * k, 1, .12);
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; line([[x0 + Math.cos(a) * 20 * k, cy + Math.sin(a) * 20 * k], [x0 + Math.cos(a) * 64 * k, cy + Math.sin(a) * 64 * k]], 1, .1); }
      for (let i = 0; i < 70; i++) { const x = rnd() * W, y = rnd() * H; if (Math.abs(x - x0) < aw) continue; g.beginPath(); g.arc(x, y, (rnd() * 1.4 + .4) * k, 0, 7); g.fillStyle = ink(.12 + rnd() * .2); g.fill(); }
    }
    // те же рваные края, что у схемы главного экрана
    if (!plateMask) {
      const m = document.createElement('canvas'), mw = 240, mh = 150; m.width = mw; m.height = mh;
      const mg = m.getContext('2d'), mi = mg.createImageData(mw, mh), NM = noise2(97);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const n = fbm(NM, x / mw * 6, y / mh * 4, 5); mi.data[(y * mw + x) * 4 + 3] = Math.max(0, Math.min(1, (n - .3) * 2.6)) * 255; }
      mg.putImageData(mi, 0, 0); plateMask = m;
    }
    g.globalCompositeOperation = 'destination-in'; g.drawImage(plateMask, 0, 0, W, H); g.globalCompositeOperation = 'source-over';
    plate.classList.add('on');
  }

  /* ===== Края эмблем тают в темноте: маска из шума, своя у каждой ===== */
  function maskEmblems() {
    pillars.forEach((p, k) => {
      const c = document.createElement('canvas'), w = 120; c.width = c.height = w;
      const g = c.getContext('2d'), img = g.createImageData(w, w), N = noise2(300 + k * 17);
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const r = Math.hypot(x / w - .5, y / w - .5) * 2, n = fbm(N, x / w * 5, y / w * 5, 4);
        img.data[(y * w + x) * 4 + 3] = Math.min(255, Math.max(0, Math.min(1, (1.02 - r + (n - .5) * .55) * 3.2)) * (.72 + n * .4) * 255);
      }
      g.putImageData(img, 0, 0);
      const url = `url(${c.toDataURL()})`;
      p.querySelectorAll('.emblem').forEach(e => { e.style.webkitMaskImage = url; e.style.maskImage = url; });
    });
  }

  /* ===== «Стёртый металл» — один раз в картинку: дорогой SVG-фильтр больше не пересчитывается на кадрах ===== */
  const defs = $('svg[width="0"] defs').outerHTML;
  const fireOverlays = [];
  function bakeEmblems() {
    pillars.forEach(p => {
      const svg = p.querySelector('svg.emblem'); if (!svg) return;
      const box = svg.getAttribute('viewBox'), copy = svg.cloneNode(true);
      const fires = copy.querySelector('[data-fires]');
      if (fires) {
        // огни живут отдельно, без фильтра — только они меняются на кадрах
        const fx = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        fx.setAttribute('viewBox', box); fx.setAttribute('class', 'emblem-fx'); fx.setAttribute('aria-hidden', 'true');
        fx.appendChild(fires.cloneNode(true)); fires.remove();
        svg.after(fx); fireOverlays.push(...fx.querySelectorAll('path'));
      }
      const [, , w, h] = box.split(/\s+/).map(Number);
      const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${w * 2}" height="${h * 2}">${defs}${copy.innerHTML}</svg>`;
      const img = new Image(); img.className = 'emblem'; img.alt = ''; img.decoding = 'async';
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      svg.replaceWith(img);
    });
  }

  /* ===== WebGL: дым, свет за эмблемами, лучи, искры — внизу; тьма поверх эмблем и бездна — сверху ===== */
  const NOISE = `precision mediump float;
    uniform vec2 res; uniform float t;
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
      return mix(mix(hash(i), hash(i + vec2(1., 0.)), u.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), u.x), u.y); }
    float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }`;
  const GROUND = `${NOISE}
    uniform vec4 pools[5]; uniform float warm[5]; uniform vec4 zst; uniform float zz;
    void main(){
      vec2 uv = gl_FragCoord.xy / res; uv.y = 1. - uv.y; uv = zst.xy + (uv - zst.zw) / zz; float asp = res.x / res.y; vec2 q = vec2(uv.x * asp, uv.y);
      float tt = t / 14.;
      float w = fbm(q * 2. + vec2(tt, -tt * .5));
      float d = fbm(q * 2.6 + w * 1.4 + vec2(-tt * .6, 0.));
      float lit = max(0., d - .26);
      float glow = max(0., 1. - length(vec2(uv.x - .5, (uv.y - .5) * 1.3)) * 1.3) * .7;
      float hot = 0., cold = 0.;
      for (int i = 0; i < 5; i++) { vec4 p = pools[i]; float k = max(0., 1. - length(vec2((uv.x - p.x) * asp, uv.y - p.y)) / p.z); float l = k * k * p.w; if (warm[i] > .5) hot += l; else cold += l; }
      float shaft = max(0., 1. - abs((uv.x + uv.y * .42) - .38) / .07) * .55 + max(0., 1. - abs((uv.x + uv.y * .42) - .72) / .045) * .35;
      float l = lit * 95. * (.3 + glow) + lit * 260. * (hot + cold) + lit * shaft * 120. * (1. - uv.y * .6);
      vec3 col = vec3(6. + l * .62 + lit * hot * 420., 7. + l * .72 + lit * hot * 170., 9. + l * .95 + lit * cold * 90.) / 255.;
      for (int j = 0; j < 2; j++) {
        float fj = float(j);
        vec2 g = vec2(uv.x * asp * (12. + fj * 6.), uv.y * (8. + fj * 4.) + t * (.18 + fj * .1));
        vec2 id = floor(g), fr = fract(g) - .5; float h = hash(id + fj * 7.);
        if (h > .9) { vec2 pos = (vec2(hash(id + 3.), hash(id + 5.)) - .5) * .6; float dd = length(fr - pos);
          col += vec3(1., .55, .22) * smoothstep(.07, 0., dd) * (.35 + .35 * sin(t * 2.3 + h * 40.)); }
      }
      col *= 1. - smoothstep(.45, 1.15, length(vec2((uv.x - .5) * asp * .8, uv.y - .5)));
      gl_FragColor = vec4(col, 1.);
    }`;
  const TOP = `${NOISE}
    uniform vec4 pools[5]; uniform float hover[5]; uniform vec2 origin; uniform float spread;
    void main(){
      vec2 uv = gl_FragCoord.xy / res; uv.y = 1. - uv.y; float asp = res.x / res.y; vec2 q = vec2(uv.x * asp, uv.y);
      float tt = t / 11.;
      float d = fbm(q * 3.2 + vec2(-tt * .8, tt * .3));
      float a = max(0., d - .42) * 2.4;
      for (int i = 0; i < 5; i++) { vec4 p = pools[i]; float k = max(0., 1. - length(vec2((uv.x - p.x) * asp, uv.y - p.y)) / (p.z * .9)); a = a * (1. - k * .25) + k * k * .12 * d; }
      a = min(.9, a);
      float n = fbm(q * 5. + vec2(t / 6., -t / 6.));
      float front = spread * 1.9 - length(vec2(uv.x - origin.x, (uv.y - origin.y) / asp)) * 1.6 + (n - .5) * .5;
      float abyss = clamp(front * 4., 0., 1.) * (spread >= .999 ? .6 : 1.);
      float alpha = max(a, abyss);
      vec3 col = vec3(.016, .02, .028) + fbm(q * 3. - vec2(t / 6., 0.)) * vec3(.05, .055, .065) * abyss;
      gl_FragColor = vec4(col * alpha, alpha);
    }`;
  function glLayer(canvas, fragment) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = name => gl.getUniformLocation(prog, name);
    return { gl, canvas, u, size() { canvas.width = Math.round(innerWidth * .5); canvas.height = Math.round(innerHeight * .5); gl.viewport(0, 0, canvas.width, canvas.height); } };
  }
  const SHADE = `${NOISE}
    uniform vec4 pools[5]; uniform float hov[5];
    void main(){
      vec2 uv = gl_FragCoord.xy / res; uv.y = 1. - uv.y; float asp = res.x / res.y; vec2 q = vec2(uv.x * asp, uv.y);
      float edge = fbm(q * 6. + vec2(t * .25, -t * .1)), wisp = fbm(q * 2.5 - vec2(t * .12, 0.));
      float a = 0.;
      for (int i = 0; i < 5; i++) { vec4 p = pools[i]; float h = hov[i]; if (h < .001) continue;
        float r = length(vec2((uv.x - p.x) * asp, uv.y - p.y - p.z * .06)) / (p.z * 1.5);
        float rad = h * 1.6; a = max(a, (1. - smoothstep(rad - .55, rad, r + (edge - .5) * .6)) * min(1., h * 1.3)); }
      a = min(.985, a * (.9 + wisp * .2));
      vec3 col = vec3(.002, .003, .005);
      gl_FragColor = vec4(col * a, a);
    }`;
  const ground = glLayer(root.getElementById('ground'), GROUND);
  const shade = glLayer(root.getElementById('shade'), SHADE);
  const top = glLayer(root.getElementById('top'), TOP);

  /* ===== Огни ролей в The Court — живое пламя на отдельном слое ===== */
  let lit = [], heat = [0, 0, 0, 0, 0].map(() => ({ h: 0, t: 0 }));
  function paintFires() {
    fireOverlays.forEach((c, i) => {
      if (!lit.includes(i)) { c.setAttribute('fill', '#3a444d'); c.setAttribute('opacity', '.7'); return; }
      const s = heat[i]; if (Math.random() < .2) s.t = .45 + Math.random() * .55; s.h += (s.t - s.h) * .25;
      c.setAttribute('fill', `rgb(${210 + s.h * 45 | 0},${90 + s.h * 70 | 0},${40 + s.h * 20 | 0})`);
    });
  }

  /* ===== Меню: тьма из круга становится его фоном ===== */
  let spread = 0, target = 0, origin = { x: .5, y: .5 };
  const menu = $('.menu');
  const titles = { court: ['The Court', 'Five voices at work, and what waits for you.'], bank: ['The Great Bank', 'Five lives kept, and every change to them.'], canon: ['The Canon', 'Worlds sealed for another story.'], charter: ['The Charter', 'The laws this engine keeps.'], world: ['The World', 'What God wrote, and what the world has learned.'] };
  function open(p) {
    const r = p.querySelector('.disc').getBoundingClientRect();
    origin = { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight };
    const [t, l] = titles[p.dataset.p];
    $('[data-title]').textContent = t; $('[data-lead]').textContent = l;
    const bank = p.dataset.p === 'bank' || p.dataset.p === 'world';
    const charter = p.dataset.p === 'charter', canon = p.dataset.p === 'canon', court = p.dataset.p === 'court';
    $('[data-body="bank"]').hidden = !bank; $('[data-body="charter"]').hidden = !charter; $('[data-body="canon"]').hidden = !canon; $('[data-body="court"]').hidden = !court;
    $('[data-body="other"]').hidden = bank || charter || canon || court;
    menu.dataset.mode = bank ? 'bank' : p.dataset.p;
    // данные столпа — из моделей движка; вид рисуется, когда модель пришла
    if (court) openCourt();
    loadModel(p.dataset.p).then(() => document.fonts?.ready).then(() => { if (bank) { setVolume(p.dataset.p); openBook(); } if (charter) openCharter(); if (canon) openCanon(); if (court) openCourt(); });
    setTimeout(() => paintPlate(bank ? 'book' : charter ? 'scroll' : canon ? 'sky' : court ? 'court' : ''), reduce ? 0 : 700);
    target = 1; $('.pillars').classList.add('swallowed');
    setTimeout(() => menu.classList.add('open'), reduce ? 0 : 650);
  }
  function close() { plate.classList.remove('on'); resetView(); for (const c of [plate, platefx]) { c.style.transition = c.style.opacity = c.style.transformOrigin = ''; } closeBook(); menu.classList.remove('open'); target = 0; $('.pillars').classList.remove('swallowed'); }
  pillars.forEach(p => p.addEventListener('click', () => open(p)));
  $$('[data-back]').forEach(b => b.addEventListener('click', close));
  const onKey = e => {
    if (!visible || e.key !== 'Escape') return;
    if (!menu.classList.contains('open')) { hide(); return; }
    if (laneId) closeLane(); else close();
  };
  addEventListener('keydown', onKey);
  pillars.forEach(p => {
    p.addEventListener('pointerenter', () => { p.dataset.hover = '1'; }); p.addEventListener('pointerleave', () => { delete p.dataset.hover; });
    p.addEventListener('focus', () => { p.dataset.hover = '1'; }); p.addEventListener('blur', () => { delete p.dataset.hover; });
  });

  /* ===== The Great Bank — книга: страницы и кожа запекаются один раз, листание — CSS 3D ===== */
  const PARTS = [['material', 'Material', '#7a5a22'], ['spiritual', 'Spiritual', '#25385a'], ['knowledge', 'Knowledge', '#2f4a2c'], ['decree', 'Decree', '#6e1c16'], ['history', 'History', '#3a2a1e']];
  const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
  const tome = $('[data-tome]');
  const pagesEl = tome.querySelector('[data-pages]');
  let leftLeaf = null, rightLeaf = null;
  // книга рисует готовый том (`toBookVolume`): развороты, язычки, ленты — без своих данных
  const books = { bank: null, world: null }, savedAt = { bank: 1, world: 1 };
  let vol = 'bank', bm = { spreads: [], thumbs: [], ribbons: [] }, SPREADS = [];
  let state = { i: 0 }, busy = false;

  function bakeTexture(w, h, paint) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, gr, b] = paint(x / w, y / h), i = (y * w + x) * 4; img.data[i] = r; img.data[i + 1] = gr; img.data[i + 2] = b; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); return c.toDataURL('image/jpeg', .86);
  }
  let papers = [], paperNo = 0;
  function bakeBook() {
    const n1 = noise2(11), n2 = noise2(23), n3 = noise2(37);
    // шесть разных листов: у каждого свои волокна, пятна и прожоги
    papers = [0, 1, 2, 3, 4, 5].map(i => {
      const a = noise2(101 + i * 7), f = noise2(203 + i * 11), st = noise2(307 + i * 13), dx = i * 3.1, cut = .66 + (i % 3) * .03;
      return bakeTexture(320, 440, (u, v) => {
        const n = fbm(a, u * 5 + dx, v * 7, 4), fib = fbm(f, u * 90, v * 4 + dx, 2), s = fbm(st, u * 3 + dx, v * 3 - dx, 3);
        const edge = Math.min(u, 1 - u, v, 1 - v), burn = Math.max(0, 1 - edge * (12 + i) + (n - .5) * 1.5);
        const ring = Math.exp(-(((s - cut) / .007) ** 2)) * .12 + (s > cut ? .025 : 0);
        const k = (.84 + n * .26 + (fib - .5) * .07 - ring) * (1 - Math.min(.75, burn * burn * .75));
        return [212 * k, 190 * k * (1 - burn * .06), 146 * k * (1 - burn * .15)];
      });
    });
    const paper = papers[0];
    const hide = bakeTexture(300, 420, (u, v) => {
      const n = fbm(n1, u * 4, v * 5, 4), grain = fbm(n2, u * 120, v * 160, 2), crease = Math.abs(fbm(n3, u * 6, v * 8, 3) - .5);
      const edge = Math.min(u, 1 - u, v, 1 - v), wear = Math.max(0, 1 - edge * 22) * (.5 + n);
      const k = (.62 + n * .5 + (grain - .5) * .25) * (crease < .02 ? .7 : 1) + wear * .35;
      return [62 * k, 38 * k, 24 * k];
    });
    tome.style.setProperty('--paper-img', `url(${paper})`);
    tome.style.setProperty('--hide-img', `url(${hide})`);
    tome.querySelector('[data-cover]').src = $('.pillar[data-p="bank"] img.emblem')?.src ?? '';
  }

  // чернильные наброски — SVG с дрожью пера, запечённый в картинку
  const sketches = {};
  function sketch(kind) {
    if (sketches[kind]) return sketches[kind];
    const ticks = Array.from({ length: 18 }, (_, i) => `<path d="M186 ${40 + i * 10}h${i % 5 ? 4 : 8}"/>`).join('');
    const art = {
      figure: `<path d="M28 236C34 180 62 152 90 140L100 148L110 140C138 152 166 180 172 236" fill="url(#h)" stroke-width="2"/>
        <path d="M90 140C84 170 86 200 80 236M110 140C116 170 114 200 120 236M60 196c10-6 16-4 22 2M140 196c-10-6-16-4-22 2" stroke-width="1.1"/>
        <path d="M64 120C56 70 76 40 100 38C124 40 144 70 136 120" stroke-width="1.8"/><path d="M68 112C62 84 70 60 86 50M132 112C138 84 130 60 114 50" stroke-width=".8"/>
        <path d="M76 82C68 118 72 150 62 190M81 76C73 112 79 146 71 196M124 82C132 118 128 150 138 190M119 76C127 112 121 146 129 196" stroke-width="1.1"/>
        <path d="M76 88C76 64 88 54 100 54C112 54 124 64 124 88C124 108 112 124 100 126C88 124 76 108 76 88Z" stroke-width="1.8"/>
        <path d="M77 84C88 68 100 63 122 72M84 78c6-6 12-8 18-8" stroke-width="1.1"/>
        <path d="M86 92q5-4 10 0M104 92q5-4 10 0" stroke-width="1.5"/><circle cx="91" cy="93" r="1.4" fill="#2a1c10"/><circle cx="109" cy="93" r="1.4" fill="#2a1c10"/>
        <path d="M100 98l-3 10h5M94 114q6 3 12 0" stroke-width="1.1"/><path d="M80 100l5 9M120 100l-5 9M82 106l4 7" stroke-width=".5"/>
        <path d="M93 126v12M107 126v12" stroke-width="1.3"/><path d="M100 148v12" stroke-width=".8"/><path d="M100 160l7 9-7 9-7-9z" fill="url(#h2)" stroke-width="1.4"/>`,
      beast: `<path d="M70 206C60 166 72 140 100 138C128 140 140 166 130 206Z" fill="url(#h)" stroke-width="1.8"/>
        <path d="M62 108C62 80 80 66 100 66C120 66 138 80 138 108C138 130 120 142 100 142C80 142 62 130 62 108Z" stroke-width="1.8"/>
        <path d="M70 84L64 50L90 70M130 84L136 50L110 70M70 62l8 10M130 62l-8 10" stroke-width="1.6"/>
        <circle cx="86" cy="104" r="9" stroke-width="1.5"/><circle cx="114" cy="104" r="9" stroke-width="1.5"/><circle cx="88" cy="106" r="4" fill="#2a1c10"/><circle cx="116" cy="106" r="4" fill="#2a1c10"/>
        <path d="M97 118l3 4 3-4zM100 122v4M92 128q8 4 16 0M60 116l-22-4M60 122l-22 4M140 116l22-4M140 122l22 4" stroke-width="1"/>
        <path d="M130 196C166 198 176 160 154 148C140 142 132 156 144 162" stroke-width="1.6"/>
        <path d="M40 60l6 6M46 60l-6 6M160 40l5 5M165 40l-5 5M44 170l5 5M49 170l-5 5" stroke-width="1"/>`,
      map: `<path d="M40 80C60 60 90 70 104 56C120 42 150 50 158 72C168 98 150 112 160 136C170 162 140 190 112 184C90 180 70 198 52 176C36 156 54 132 42 112C34 98 32 90 40 80Z" stroke-width="1.8"/>
        <path d="M60 96c8 4 14 2 20-4M120 70l6 10 8-6M70 150l10-8 6 10 8-6M128 150c6-10 16-12 22-4" stroke-width="1"/><path d="M100 120l-4 6h8z M100 112v8" stroke-width="1.4"/><circle cx="100" cy="124" r="12" stroke-width=".8" stroke-dasharray="2 2"/>
        <path d="M150 50l14-14M164 36l-6 0M164 36l0 6M36 200h40M36 200v-6M56 200v-4M76 200v-6" stroke-width="1"/><path d="M84 92q8 10 0 20q-8 10 0 20" stroke-width="1" stroke-dasharray="3 2"/>`,
      scales: `<path d="M100 40V200M70 206h60M84 200l16-10 16 10" stroke-width="1.8"/><circle cx="100" cy="40" r="5" stroke-width="1.4"/>
        <path d="M40 70L160 60" stroke-width="2"/><path d="M40 70L24 120M40 70L56 120M160 60L144 110M160 60L176 110" stroke-width="1" stroke-dasharray="3 2"/>
        <path d="M18 120Q40 140 62 120Z" fill="url(#h)" stroke-width="1.6"/><path d="M138 110Q160 130 182 110Z" fill="url(#h2)" stroke-width="1.6"/>
        <path d="M34 114l6-8 6 8M150 104h20" stroke-width="1"/>`,
      quill: `<path d="M60 216C90 160 120 100 168 40C150 92 130 140 76 206Z" fill="url(#h)" stroke-width="1.6"/>
        <path d="M60 216L168 40M84 180l18-6M96 160l20-4M108 140l22-4M120 120l20-6M132 100l18-6" stroke-width="1"/>
        <path d="M60 216l-6 14M40 236c20-6 40-6 60 0" stroke-width="1.4"/><circle cx="52" cy="232" r="3" fill="#2a1c10"/>`,
    }[kind];
    const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 250" width="400" height="500"><defs>
      <filter id="w"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="3.6" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation=".25"/></filter>
      <pattern id="h" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(35)"><line x1="0" y1="0" x2="0" y2="4" stroke="#2a1c10" stroke-width=".9"/></pattern>
      <pattern id="h2" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(-50)"><line x1="0" y1="0" x2="0" y2="3" stroke="#2a1c10" stroke-width=".9"/></pattern></defs>
      <g filter="url(#w)" fill="none" stroke="#2a1c10" stroke-linecap="round" stroke-linejoin="round">
      <ellipse cx="100" cy="124" rx="86" ry="112" stroke-width="1.6"/><ellipse cx="100" cy="124" rx="80" ry="106" stroke-width=".7" stroke-dasharray="7 3 1 3"/>
      ${art}<g stroke-width=".8"><path d="M186 40V210"/>${ticks}</g></g></svg>`;
    return (sketches[kind] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
  }

  // шкала настроения пером: деления и клякса на значении
  const scale = ([lo, hi, v]) => `<div class="row"><span>${lo}</span><svg viewBox="0 0 200 20" preserveAspectRatio="none" height="20" width="100%"><path d="M4 11Q100 8 196 11" stroke="#2a1c10" fill="none" stroke-width="1.2"/>${[0, 50, 100, 150, 200].map(x => `<path d="M${Math.min(196, Math.max(4, x))} 6v9" stroke="#2a1c10" stroke-width="1"/>`).join('')}<ellipse cx="${4 + v * 192}" cy="10.5" rx="6" ry="5" fill="#7a2a18"/></svg><span>${hi}</span></div>`;

  const SKETCH_KINDS = ['figure', 'beast', 'quill', 'map', 'scales'];
  const RIBBON_COLORS = { material: '#7a5a22', spiritual: '#25385a', knowledge: '#2f4a2c', decree: '#6e1c16', history: '#3a2a1e', creation: '#7a5a22', scales: '#25385a', prayers: '#6e1c16' };
  const coverSrc = () => $(`.pillar[data-p="${vol}"] img.emblem`)?.src ?? '';
  const firstSpread = test => { const i = SPREADS.findIndex(test); return i < 0 ? 0 : i; };
  /** Куда ведёт язычок: в банке — та же часть другого персонажа, в мире — первая страница главы. */
  function targetOf(item) {
    const who = item.go?.who ?? item.id;
    if (vol === 'bank') {
      const part = SPREADS[state.i]?.part ?? 'decree';
      const exact = SPREADS.findIndex(s => s.who === who && s.part === part);
      return exact >= 0 ? exact : firstSpread(s => s.who === who);
    }
    return firstSpread(s => s.who === who);
  }
  // книга не показывает Markdown: звёздочки, решётки и списки становятся оформлением
  function md(value) {
    return esc(value)
      .replace(/^\s*#+\s*/, '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '• ')
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`)
      .replace(/(^|[\s(“"'])[*_](?=\S)(.+?)(?<=\S)[*_](?=[\s.,;:!?)”"']|$)/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  }
  // длинный абзац режется по предложениям, чтобы перенос на следующую страницу не оставлял дыр
  function sentences(value, max = 520) {
    const textValue = String(value ?? '');
    if (textValue.length <= max) return [textValue];
    const parts = textValue.match(/[^.!?]+[.!?]+["”')]*\s*|[^.!?]+$/g) ?? [textValue];
    const out = []; let cur = '';
    for (const part of parts) { if ((cur + part).length > max && cur) { out.push(cur.trim()); cur = ''; } cur += part; }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  // оглавление: номера и переходы ставятся по готовой раскладке страниц (`fillToc`)
  function tocPieces() {
    return ['<div class="h">Contents</div>', ...(bm.thumbs ?? []).filter(t => t.id !== 'contents').map(t => {
      const who = esc(t.go?.who ?? t.id);
      return `<ul class="toc"><li><button data-go="@go:${who}@"><span>${esc(t.label)}</span><i></i><b>@folio:${who}@</b></button></li></ul>`;
    })];
  }
  const fillToc = html => String(html ?? '').replace(/@go:([^@]*)@/g, (_, who) => targetOf({ id: who })).replace(/@folio:([^@]*)@/g, (_, who) => folioL(targetOf({ id: who })));
  /** Блоки страницы (`Page.blocks`) → куски разметки: по ним страница режется, если не влезает. */
  function blockPieces(pg, side) {
    const out = []; let heads = 0, texts = 0;
    for (const b of pg?.blocks ?? []) {
      if (b.type === 'heading') {
        if (side === 'right' && heads === 0 && b.text === 'Contents') return tocPieces();
        out.push(side === 'left' && heads === 0 ? `<div class="nm">${md(b.text)}</div>` : `<div class="h">${md(b.text)}</div>`);
        heads += 1;
      } else if (b.type === 'note') out.push(`<div class="chap">${md(b.text)}</div>`);
      else if (b.type === 'text') {
        if (!b.text) continue;
        if (side === 'left') { out.push(`<div class="caption">${md(b.text)}</div>`); continue; }
        for (const part of sentences(b.text)) { const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(part); out.push(`<p${texts++ || bullet ? '' : ' class="drop"'}>${md(part)}</p>`); }
      } else if (b.type === 'pairs') for (const [k, v] of b.pairs ?? []) out.push(`<dl><dt>${md(k)}</dt><dd>${md(v)}</dd></dl>`);
      else if (b.type === 'amend') out.push(`<div class="amend">${b.was ? `<div class="was">${md(b.was)}</div>` : ''}<div class="now">${md(b.now)}</div><div class="who">— ${esc(b.who)}</div></div>`);
      else if (b.type === 'sketch') out.push(`<img class="portrait" src="${sketch(SKETCH_KINDS.includes(b.kind) ? b.kind : 'figure')}" alt="">`);
    }
    return out;
  }
  // страница меряется невидимым листом того же размера: что не влезло — на следующую страницу, дальше по разворотам
  const folioL = i => 2 * i + 2, folioR = i => 2 * i + 3;
  let measure = null;
  function measureInk() {
    if (!measure) {
      measure = document.createElement('div'); measure.className = 'leaf measure';
      measure.style.cssText = 'visibility:hidden;pointer-events:none;z-index:-1;transform:none';
      measure.innerHTML = '<div class="face front"><div class="ink"></div></div>';
    }
    if (!measure.isConnected) pagesEl.append(measure);
    return measure.querySelector('.ink');
  }
  function fit(pieces) {
    const ink = measureInk();
    if (!ink.clientHeight) return [pieces.join('')]; // нет раскладки (узкий экран) — страницы и так растут вниз
    const pages = []; let cur = [];
    for (const piece of pieces) {
      ink.innerHTML = cur.concat(piece).join('');
      if (ink.scrollHeight > ink.clientHeight + 1 && cur.length) { pages.push(cur.join('')); cur = [piece]; } else cur.push(piece);
    }
    pages.push(cur.join('')); ink.innerHTML = '';
    return pages;
  }
  function paginate(spreads) {
    const out = [];
    for (const sp of spreads) {
      const chunks = fit(blockPieces(sp.right, 'right'));
      out.push({ ...sp, rightHTML: chunks[0] });
      for (let k = 1; k < chunks.length; k += 2) out.push({ who: sp.who, part: sp.part, group: sp.group, cont: true, leftHTML: chunks[k], rightHTML: chunks[k + 1] ?? '' });
    }
    measure?.remove();
    return out;
  }
  function pageL(i) {
    const sp = SPREADS[i];
    if (i === 0) {
      const pg = sp?.left, head = pg?.blocks?.find(b => b.type === 'heading')?.text ?? '', line = pg?.blocks?.find(b => b.type === 'text')?.text ?? '';
      return { html: `<div class="title"><div class="chap">being a true account of</div><div class="big">${md(head)}</div><img src="${coverSrc()}" alt=""><div class="sub">${md(line)}</div></div>`, no: folioL(0) };
    }
    return { html: sp?.cont ? fillToc(sp.leftHTML) : blockPieces(sp?.left, 'left').join(''), no: folioL(i) };
  }
  function pageR(i) { const sp = SPREADS[i]; return { html: fillToc(sp?.rightHTML ?? blockPieces(sp?.right, 'right').join('')), no: folioR(i) }; }
  function paintChrome() {
    const cur = SPREADS[state.i] ?? {};
    tome.dataset.kind = vol === 'world' ? 'chapter' : cur.who && cur.who !== 'contents' ? 'chapter' : 'contents';
    const group = cur.group ?? cur.who;
    tome.querySelector('[data-ribbons]').innerHTML = (bm.ribbons ?? []).map(r => {
      const i = vol === 'bank' ? firstSpread(s => s.who === cur.who && s.part === r.id) : targetOf(r);
      const on = vol === 'bank' ? cur.part === r.id : group === r.id;
      return `<button class="ribbon" role="tab" style="--c:${RIBBON_COLORS[r.id] ?? '#3a2a1e'}" data-go="${i}" aria-selected="${on}">${esc(r.label)}</button>`;
    }).join('');
    const thumbs = bm.thumbs ?? [];
    tome.querySelector('[data-thumbs]').innerHTML = thumbs.map((t, k) => `<button class="thumb${vol === 'world' && k === thumbs.length - 1 && k > 1 ? ' gap' : ''}" data-go="${targetOf(t)}" aria-current="${(t.go?.who ?? t.id) === cur.who}">${esc(t.label)}${t.group ? `<small>${esc(t.group)}</small>` : ''}</button>`).join('');
  }
  const EMPTY_SPREAD = v => ({ who: 'contents', left: { blocks: [{ type: 'heading', text: v === 'world' ? 'The World' : 'The Great Bank' }, { type: 'text', text: 'Nothing is written here yet.' }], folio: 1 }, right: { blocks: [], folio: 2 } });
  function setVolume(v) {
    vol = v; bm = books[v] ?? { spreads: [], thumbs: [], ribbons: [] };
    SPREADS = []; // targetOf в оглавлении читает уже готовую раскладку
    SPREADS = paginate(bm.spreads?.length ? bm.spreads : [EMPTY_SPREAD(v)]);
    state = { i: Math.min(savedAt[v] ?? 0, SPREADS.length - 1) };
    tome.querySelector('[data-cover]').src = coverSrc();
    tome.querySelector('.lid .seal span').textContent = v === 'world' ? 'The World' : 'The Great Bank';
    paintChrome();
  }
  const flyleaf = () => `<div class="title"><div class="chap">this book is kept for</div><div class="big">${esc(chatName || 'this world')}</div><div class="sub">and every soul that walks in it</div></div>`;
  const spreadOf = st => st.i;
  const BLANK = { html: '', no: '' };

  function setFace(leaf, side, page) {
    const face = leaf.querySelector(`.face.${side}`);
    face.innerHTML = `<div class="ink">${page.html}</div>${page.no ? `<div class="folio">${page.no}</div>` : ''}`;
  }
  function place(leaf, angle) {
    leaf.style.transform = `rotateY(${-angle}deg)`;
    leaf.classList.toggle('show-rear', angle > 90);
  }
  function makeLeaf(front, rear, turned, z) {
    const el = document.createElement('div');
    el.className = 'leaf'; el.style.zIndex = z;
    el.innerHTML = '<div class="face front"></div><div class="face rear"></div>';
    el.querySelectorAll('.face').forEach(face => face.style.setProperty('--paper-img', `url(${papers[paperNo++ % papers.length]})`));
    setFace(el, 'front', front); setFace(el, 'rear', rear); place(el, turned ? 180 : 0);
    pagesEl.appendChild(el); return el;
  }
  function mark() {
    pagesEl.querySelectorAll('.leaf').forEach(l => l.classList.remove('top-left', 'top-right'));
    leftLeaf.classList.add('top-left'); rightLeaf.classList.add('top-right');
  }
  // книга заново: первый разворот закрыт форзацем, он перевернётся вслед за обложкой
  function build(opened) {
    pagesEl.innerHTML = '';
    const i = spreadOf(state);
    rightLeaf = makeLeaf(pageR(i), BLANK, false, 40);
    leftLeaf = makeLeaf({ html: flyleaf(), no: 1 }, pageL(i), opened, 50);
    mark();
  }

  // листы летят веером: каждый следующий стартует чуть позже, кадры считает скрипт
  const ease = p => (p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  function fly(leaves, forward, done) {
    const n = leaves.length, D = n > 1 ? 820 : 1000, gap = Math.min(150, 700 / n), t0 = performance.now();
    function frame(now) {
      let busyNow = false;
      leaves.forEach((leaf, k) => {
        const p = Math.min(1, Math.max(0, (now - t0 - k * gap) / D));
        if (p < 1) busyNow = true;
        const angle = (forward ? ease(p) : 1 - ease(p)) * 180, landed = forward ? angle > 90 : angle < 90;
        place(leaf, angle);
        leaf.style.zIndex = landed ? 200 + k : 150 - k;
        leaf.style.setProperty('--s', (Math.sin(angle * Math.PI / 180) * .85).toFixed(3));
      });
      if (busyNow) requestAnimationFrame(frame); else done();
    }
    requestAnimationFrame(frame);
  }

  function go(next) {
    if (busy) return;
    const a = spreadOf(state), b = spreadOf(next);
    state = { ...next, part: next.part ?? state.part }; paintChrome();
    if (a === b) return;
    if (reduce || matchMedia('(max-width: 860px)').matches || !tome.classList.contains('open')) { setFace(leftLeaf, 'rear', pageL(b)); setFace(rightLeaf, 'front', pageR(b)); return; }
    busy = true;
    // чем дальше страница, тем больше листов пролетает (до семи), промежуточные — настоящие развороты между
    const n = Math.min(Math.abs(b - a), 7), path = Array.from({ length: n + 1 }, (_, k) => Math.round(a + (b - a) * k / n));
    const forward = b > a, leaves = [];
    if (forward) {
      for (let k = 0; k < n; k++) {
        const leaf = k === 0 ? rightLeaf : makeLeaf(pageR(path[k]), BLANK, false, 150 - k);
        setFace(leaf, 'rear', pageL(path[k + 1])); leaves.push(leaf);
      }
      const under = makeLeaf(pageR(b), BLANK, false, 40);
      fly(leaves, true, () => {
        const last = leaves.at(-1);
        pagesEl.querySelectorAll('.leaf').forEach(l => { if (l !== last && l !== under) l.remove(); });
        leftLeaf = last; last.style.zIndex = 50; rightLeaf = under; mark(); busy = false;
      });
    } else {
      for (let k = 0; k < n; k++) {
        const leaf = k === 0 ? leftLeaf : makeLeaf(BLANK, pageL(path[k]), true, 150 - k);
        setFace(leaf, 'front', pageR(path[k + 1])); leaves.push(leaf);
      }
      const under = makeLeaf(BLANK, pageL(b), true, 40);
      fly(leaves, false, () => {
        const last = leaves.at(-1);
        pagesEl.querySelectorAll('.leaf').forEach(l => { if (l !== last && l !== under) l.remove(); });
        rightLeaf = last; last.style.zIndex = 40; leftLeaf = under; under.style.zIndex = 50; mark(); busy = false;
      });
    }
  }
  tome.addEventListener('click', e => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn && (tome.dataset.kind === 'chapter' || !goBtn.classList.contains('ribbon'))) go({ i: +goBtn.dataset.go });
  });
  function openBook() {
    if (reduce || matchMedia('(max-width: 860px)').matches) { build(true); tome.classList.add('open'); busy = false; return; }
    tome.classList.remove('open'); build(false); busy = true;
    setTimeout(() => {
      tome.classList.add('open');
      setTimeout(() => fly([leftLeaf], true, () => { leftLeaf.style.zIndex = 50; busy = false; }), 380);
    }, 900);
  }
  function closeBook() { savedAt[vol] = state.i; setTimeout(() => tome.classList.remove('open'), 700); }

  /* ===== The Charter — статьи из настроек (`toCharter`); печать сохраняет через контракты движка ===== */
  let charterModel = null;
  const roman = n => { const m = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; };
  const blank = g => `<span class="bw"><button class="blank" data-key="${esc(g.key)}" data-was="${esc(g.value)}" data-opts="${esc((g.options ?? []).join('|'))}">${esc(g.value || '—')}</button></span>`;
  const hall = $('[data-hall]');
  function buildCharter() {
    const m = charterModel ?? { chapters: [], appendices: [] };
    let no = 0;
    hall.querySelector('[data-law]').innerHTML = `<img class="crest" src="${$('.pillar[data-p="charter"] img.emblem')?.src ?? ''}" alt="">
      <div class="t1">The Charter</div><div class="t2">the laws this engine keeps</div>
      ${(m.chapters ?? []).map(ch => `<h3 id="ch-${esc(ch.id)}">${esc(ch.title)}</h3>${(ch.articles ?? []).map(a => `<div class="art${a.struck ? ' struck' : ''}"><span class="no">Article ${roman(++no)}.</span> <span class="body">${(a.text ?? []).map(p => (typeof p === 'string' ? esc(p) : blank(p))).join('')}</span>${a.paid ? '<span class="paid">paid</span>' : ''}</div>`).join('')}`).join('')}
      ${(m.appendices ?? []).length ? `<h3 id="ch-appendices">Appendices</h3>${m.appendices.map(a => `<div class="slip"><button><span>Appendix ${esc(a.letter)} — ${esc(a.title)}</span><small>${esc(a.meta)}</small></button><div class="fold"><pre>${esc(a.text)}</pre></div></div>`).join('')}` : ''}
      <div class="sealing"><span class="count" data-count></span><button class="wax" data-seal>seal</button><button class="tear" data-tear>tear the changes</button></div>`;
  }
  function countDirty(note = '') {
    const n = hall.querySelectorAll('.blank.dirty').length;
    hall.querySelector('[data-count]').textContent = note || (n ? `${n} change${n > 1 ? 's' : ''} unsealed` : '');
  }
  hall.addEventListener('click', async e => {
    const t = e.target;
    const pickBtn = t.closest('.pick button');
    if (pickBtn) {
      const b = pickBtn.closest('.bw').querySelector('.blank'); b.textContent = pickBtn.textContent; b.classList.toggle('dirty', pickBtn.textContent !== b.dataset.was);
      pickBtn.closest('.pick').remove(); countDirty(); return;
    }
    const blankBtn = t.closest('.blank');
    if (blankBtn) {
      hall.querySelectorAll('.pick').forEach(p => p.remove());
      const pick = document.createElement('span'); pick.className = 'pick';
      pick.innerHTML = blankBtn.dataset.opts.split('|').filter(Boolean).map(o => `<button>${esc(o)}</button>`).join('');
      blankBtn.after(pick); return;
    }
    hall.querySelectorAll('.pick').forEach(p => p.remove());
    const slip = t.closest('.slip > button')?.parentElement;
    if (slip) { slip.classList.toggle('open'); return; }
    if (t.closest('[data-seal]')) {
      const wax = t.closest('[data-seal]'); wax.classList.remove('press'); void wax.offsetWidth; wax.classList.add('press');
      const dirty = [...hall.querySelectorAll('.blank.dirty')];
      if (!dirty.length) return;
      const result = await actions.sealCharter?.(dirty.map(b => ({ key: b.dataset.key, value: b.textContent })));
      if (result?.ok === false) { countDirty(result.error || 'The Charter was not sealed.'); return; }
      dirty.forEach(b => { b.dataset.was = b.textContent; b.classList.remove('dirty'); }); countDirty(); return;
    }
    if (t.closest('[data-tear]')) {
      hall.querySelectorAll('.blank.dirty').forEach(b => { b.textContent = b.dataset.was; b.classList.remove('dirty'); }); countDirty(); return;
    }
  });
  let scrollUrl = null;
  function scrollImg() {
    if (!scrollUrl) { const nf = noise2(611), ng = noise2(617); scrollUrl = `url(${bakeTexture(320, 1400, (u, v) => {
        const n = (1 - v) * fbm(nf, u * 5, v * 6, 4) + v * fbm(nf, u * 5, (v - 1) * 6, 4), fib = (1 - v) * fbm(ng, u * 90, v * 8, 2) + v * fbm(ng, u * 90, (v - 1) * 8, 2), burn = Math.max(0, 1 - Math.min(u, 1 - u) * 16 + (n - .5) * 1.4);
        const k = (.84 + n * .24 + (fib - .5) * .07) * (1 - Math.min(.7, burn * burn * .7));
        return [212 * k, 190 * k * (1 - burn * .06), 146 * k * (1 - burn * .15)];
      })})`; }
    return scrollUrl;
  }
  function openCharter() {
    hall.style.setProperty('--scroll-img', scrollImg());
    buildCharter();
    hall.classList.remove('unrolled'); menu.scrollTop = 0;
    setTimeout(() => hall.classList.add('unrolled'), reduce ? 0 : 750);
  }

  /* ===== The Canon — созвездия сохранённых миров (`toSky`); выбрать и запечатать — контракты Canon ===== */
  let skyModel = { constellations: [] };
  const sky = $('[data-sky]'), skyWrap = $('.sky');
  const ACT_LABELS = { choose: 'descend into this world' };
  function constellation(w, index) {
    const loose = w.stars ?? [];
    // у несвязанной россыпи финальная фигура считается здесь: звёзды стянутся в неё при печати
    const shape = w.unsealed ? constellationStars(loose.map(s => ({ name: s.name, main: s.main })), 7 + index) : { stars: loose, line: w.line, low: w.low };
    const finals = shape.stars, low = shape.low ?? w.low ?? 0;
    const acts = (w.actions ?? []).filter(a => a.call && ACT_LABELS[a.id]);
    return `<g class="cons${w.unsealed ? ' unsealed' : ''}" data-world="${esc(w.id)}" tabindex="0" style="transform: translate(${w.at[0]}px, ${w.at[1]}px)">
      <circle r="190" fill="transparent"/>
      <path class="ln" pathLength="1" d="${esc(shape.line || '')}"/>
      ${loose.map((s, i) => `<circle class="st" cx="${s.x}" cy="${s.y}" data-x="${finals[i]?.x ?? s.x}" data-y="${finals[i]?.y ?? s.y}" r="${(s.r ?? 3) * 2.4}" style="animation-delay:${-(i * 1.7 + index * 3) % 5}s"/>`).join('')}
      ${finals.map(s => `<text class="who" x="${s.x}" y="${s.y + (s.r ?? 3) * 2.4 + 11}">${esc(s.name)}</text>`).join('')}
      <text class="nm" y="${low + 50}">${esc(w.name)}</text><text class="meta" y="${low + 72}">${esc(w.meta)}</text>
      <g class="zt"><text class="n2" y="${low + 14}">${esc(w.name)}</text><text class="m2" y="${low + 20}">${esc(w.meta)}</text>
      ${acts.map((a, k) => `<text class="act" data-act="${esc(a.id)}" x="${(k - (acts.length - 1) / 2) * 50}" y="${low + 28}">${ACT_LABELS[a.id]}</text>`).join('')}</g>
    </g>`;
  }
  function buildSky() {
    sky.innerHTML = `<defs><radialGradient id="starglow"><stop offset="0" stop-color="#fff6dc"/><stop offset=".22" stop-color="#ffd890"/><stop offset=".5" stop-color="rgba(230,170,90,.35)"/><stop offset="1" stop-color="rgba(230,170,90,0)"/></radialGradient></defs><g class="cam">${(skyModel.constellations ?? []).map(constellation).join('')}</g>`;
  }
  // одна камера на всё: созвездия (SVG), гравюра (холст) и дым (шейдер) получают один сдвиг и масштаб в каждом кадре
  const view = { s: [.5, .5], d: [.5, .5], z: 1 };
  let zoomRun = null;
  function focusOn(g) {
    const cam = sky.querySelector('.cam'), prev = sky.querySelector('.cons.sel');
    sky.querySelectorAll('.cons').forEach(o => o.classList.toggle('sel', o === g));
    skyWrap.classList.toggle('focus', !!g);
    const target = g ?? prev; if (!target) return;
    const w = (skyModel.constellations ?? []).find(x => x.id === target.dataset.world), Z = 4.4, sv = [w.at[0], w.at[1] + 25], tv = [800, 400];
    const ctm = sky.getScreenCTM(), toScreen = ([x, y]) => [ctm.a * x + ctm.e, ctm.d * y + ctm.f];
    const S = toScreen(sv), T = toScreen(tv), from = view.k ?? 0, to = g ? 1 : 0, t0 = performance.now(), D = reduce ? 1 : 1600;
    const ease = p => (p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
    cancelAnimationFrame(zoomRun);
    (function step(now) {
      const p = Math.min(1, (now - t0) / D), k = from + (to - from) * ease(p), zc = 1 + (Z - 1) * k;
      const dv = [sv[0] + k * (tv[0] - sv[0]), sv[1] + k * (tv[1] - sv[1])], ds = [S[0] + k * (T[0] - S[0]), S[1] + k * (T[1] - S[1])];
      cam.setAttribute('transform', `translate(${dv[0] - zc * sv[0]} ${dv[1] - zc * sv[1]}) scale(${zc})`);
      platefx.style.transform = plate.style.transform = `translate(${ds[0] - zc * S[0]}px, ${ds[1] - zc * S[1]}px) scale(${zc})`;
      Object.assign(view, { k, z: zc, s: [S[0] / innerWidth, S[1] / innerHeight], d: [ds[0] / innerWidth, ds[1] / innerHeight] });
      if (p < 1) zoomRun = requestAnimationFrame(step);
    })(t0);
  }
  sky.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]'), g = e.target.closest('.cons');
    const w = g ? (skyModel.constellations ?? []).find(x => x.id === g.dataset.world) : null;
    if (act && g?.classList.contains('sel')) {
      g.classList.remove('flare'); void g.getBBox(); g.classList.add('flare');
      if (act.dataset.act === 'choose') {
        const result = await actions.applyCanon?.(w?.id);
        if (result?.ok !== false) setTimeout(() => { close(); hide(); }, 1100);
      }
      return;
    }
    if (g?.classList.contains('unsealed')) {
      // россыпь звёзд стягивается в фигуру, линии прочерчиваются, проступает имя — мир запечатан
      g.querySelectorAll('.st').forEach(st => { st.style.cx = `${st.dataset.x}px`; st.style.cy = `${st.dataset.y}px`; });
      g.classList.remove('unsealed'); g.classList.add('bound');
      const result = await actions.saveCanon?.(w?.name);
      g.querySelector('.meta').textContent = result?.ok === false ? (result.error || 'The world was not sealed.') : 'sealed just now';
      if (result?.ok !== false) setTimeout(async () => { skyModel = (await load('canon')) ?? skyModel; buildSky(); }, 3200);
      return;
    }
    focusOn(g && !g.classList.contains('sel') ? g : null);
  });
  sky.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.cons')) e.target.closest('.cons').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  function openCanon() { buildSky(); skyWrap.classList.remove('focus'); resetView(); }
  function resetView() { cancelAnimationFrame(zoomRun); Object.assign(view, { k: 0, z: 1, s: [.5, .5], d: [.5, .5] }); plate.style.transform = ''; platefx.style.transform = ''; }

  /* ===== The Court — круглый стол (`toCourt`): роли, ходы, Ведомость, файлы; падение в темноту — чат роли пером ===== */
  let courtModel = toCourt({});
  let turnFilter = null;
  const courtSvg = $('[data-court]'), lane = $('[data-lane]');
  // знаки ролей — гравюра тем же пером, что эмблемы главного экрана
  const SIGILS = {
    god: '<circle r="13"/><circle r="5" fill="rgba(214,180,120,.6)"/><path d="M-30 0Q0 -24 30 0Q0 24 -30 0Z"/><path d="M0 -36v-8M0 36v8M-36 0h-8M36 0h8M-25 -25l-6 -6M25 25l6 6M25 -25l6 -6M-25 25l-6 6"/>',
    director: '<path d="M-26 10L-30 -18L-14 -4L0 -26L14 -4L30 -18L26 10Z"/><path d="M-26 18H26M-22 26H22"/><circle cx="0" cy="-30" r="3"/>',
    counsellor: '<path d="M-20 -26H20V18Q20 28 10 28H-20Z"/><path d="M-12 -14H12M-12 -4H12M-12 6H6"/><path d="M20 -26Q30 -26 30 -16Q30 -8 20 -8"/>',
    resolver: '<path d="M0 -30V28M-24 -20H24"/><path d="M-24 -20L-34 6H-14Z M24 -20L14 6H34Z"/><path d="M-12 28H12"/>',
    writer: '<path d="M-22 26C-8 4 8 -14 26 -32C18 -10 4 8 -16 30Z"/><path d="M-22 26l-6 8M-14 12l10 -2M-6 2l12 -2M4 -10l10 -3"/>',
  };
  function buildCourt() {
    const C = 500, pos = (deg, d) => [C + Math.cos(deg * Math.PI / 180) * d, C + Math.sin(deg * Math.PI / 180) * d];
    const star = [-90, 54, 198, -18, 126, -90].map(a => pos(a, 300)), turns = (courtModel.turns ?? []).slice(-28), roles = courtModel.roles ?? [];
    const ticks = Array.from({ length: 180 }, (_, i) => { const a = i * 2, [x1, y1] = pos(a, 330), [x2, y2] = pos(a, i % 15 ? 337 : 348); return `M${x1} ${y1}L${x2} ${y2}`; }).join('');
    courtSvg.innerHTML = `<g class="eng" fill="none" stroke-linecap="round">
      <circle cx="${C}" cy="${C}" r="330" stroke-width="1.6"/><circle cx="${C}" cy="${C}" r="322" stroke-width="5" stroke-dasharray="1.2 7" class="faint"/>
      <path d="${ticks}" stroke-width="1" class="faint"/><circle cx="${C}" cy="${C}" r="380" stroke-width="1" class="faint" stroke-dasharray="6 6"/>
      <circle cx="${C}" cy="${C}" r="230" stroke-width="1" class="faint"/><circle cx="${C}" cy="${C}" r="150" stroke-width="1" class="faint" stroke-dasharray="2 6"/>
      <path d="M${star.map(p => p.join(' ')).join('L')}" stroke-width="1.2" class="faint"/>
      ${roles.map(r => { const [x1, y1] = pos(r.angle, 96), [x2, y2] = pos(r.angle, 230); return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke-width="1" class="faint"/>`; }).join('')}</g>
      <g class="ledger-medal eng" data-open="ledger" tabindex="0" role="button" aria-label="The Ledger" fill="none">
        <circle cx="${C}" cy="${C}" r="92" fill="rgba(0,0,0,.001)" stroke-width="1.4"/><circle cx="${C}" cy="${C}" r="84" stroke-width="4" stroke-dasharray="1 6" class="faint"/>
        <text class="table-mid" x="${C}" y="${C - 10}">The Ledger</text><text class="table-mid2" x="${C}" y="${C + 14}">${esc(courtModel.rpTime || '')}</text><text class="table-mid2" x="${C}" y="${C + 34}" data-turnlabel>all turns</text></g>
      <g class="coffer eng" data-open="files" tabindex="0" role="button" aria-label="The coffer of files" fill="none" transform="translate(${C} ${C + 178})">
        <rect x="-40" y="-20" width="80" height="44" fill="rgba(0,0,0,.001)" stroke-width="1.4"/><path d="M-40 -20L-30 -32H30L40 -20M-40 -4H40M-18 -20V24M18 -20V24" stroke-width="1"/><rect x="-6" y="-6" width="12" height="10" stroke-width="1.2"/>
        <text class="table-mid2" y="44">the coffer</text></g>
      ${turns.map((t, i) => { const n = t.n, [x, y] = pos(-90 + 12 + i * (336 / Math.max(turns.length, 14)), 360);
        return `<g class="stud eng" data-turn="${n}" tabindex="0" role="button" aria-label="Turn ${n}"><circle cx="${x}" cy="${y}" r="11" fill="rgba(0,0,0,.001)" stroke-width="1.2"/><text x="${x}" y="${y + 4}">${n}</text></g>`; }).join('')}
      ${roles.map(r => {
        const [sx, sy] = pos(r.angle, 330), [lx, ly] = pos(r.angle, 330 + 108);
        return `<g class="seat eng${r.lit ? ' lit' : ''}" data-role="${r.id}" tabindex="0" role="button" aria-label="${esc(r.name)}" fill="none">
          <g transform="translate(${sx} ${sy})">
            <circle r="66" fill="rgba(7,8,10,.92)" stroke-width="1.6"/><circle r="58" stroke-width="1"/><circle r="74" stroke-width="1" class="faint" stroke-dasharray="3 5"/>
            <g class="orbit"><circle r="74" stroke-width="2.4" stroke-dasharray="14 30" class="glow"/><circle cx="74" cy="0" r="3.4" class="dot"/></g>
            <g stroke-width="1.6" stroke-linejoin="round">${SIGILS[r.id] ?? ''}</g></g>
          <text class="lbl" x="${lx}" y="${ly + (ly > C ? 8 : 0)}">${esc(r.name)}</text><text class="sub" x="${lx}" y="${ly + (ly > C ? 26 : 18)}">${esc(r.sub)}</text>
        </g>`;
      }).join('')}`;
  }
  const HIDDEN_RAW = new Set(['messages', 'system', 'prompt', 'prompts', 'request', 'response', 'context', 'thinking', 'reasoning', 'usage', 'raw', 'body', 'transcript']);
  const rawOf = value => {
    const textValue = JSON.stringify(value ?? {}, (key, v) => (HIDDEN_RAW.has(key) ? undefined : typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v), 1);
    return textValue && textValue !== '{}' ? textValue.slice(0, 4000) : '';
  };
  const roleOf = id => (courtModel.roles ?? []).find(r => r.id === id);
  const entryHTML = e => {
    const ask = e.ask ? `<div class="sum">${md(e.ask.prompt)}</div><div class="answer" contenteditable="true" data-ph="write your answer…"></div><button class="send" data-ask="${esc(e.ask.id ?? '')}">send</button>` : '';
    const det = e.ask ? '' : `<div class="det"><div>${(e.fields ?? []).length ? `<dl>${e.fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}${(e.fields ?? []).length ? '' : (raw => (raw ? `<pre>${esc(raw)}</pre>` : ''))(rawOf(e.raw?.rows?.filter?.(r => r?.kind === 'call' || r?.kind === 'petition').map(r => ({ call: r.name, args: r.args })) ?? null))}</div></div>`;
    return `<div class="entry${e.ask ? ' ask' : ''}"><div class="when">${esc(e.when)}</div><div class="what">${esc(e.title)}</div>${e.summary ? `<div class="sum">${md(e.summary)}</div>` : ''}${ask}${det}</div>`;
  };
  const byTurn = list => (list ?? []).filter(e => turnFilter === null || e.turn === turnFilter);
  function stagger() { const all = lane.querySelectorAll('.entry'); all.forEach((en, i) => en.style.setProperty('--i', Math.max(0, i - all.length + 12))); }
  function laneHTML(id) {
    const tag = turnFilter === null ? '' : ` · turn ${turnFilter}`;
    if (id === 'ledger') return `<div class="t1">The Ledger</div><div class="t2">what happened${tag}</div>${byTurn(courtModel.ledger).slice(0, 80).reverse().map(entryHTML).join('') || '<p class="sum">Nothing here yet.</p>'}`;
    if (id === 'files') return `<div class="t1">The Coffer</div><div class="t2">every file the voices read</div>${(courtModel.files ?? []).map(f => `<div class="entry file"><div class="when">${esc(f.role || 'engine')} · ${Number(f.tokens || 0).toLocaleString('en')} tokens</div><div class="what">${esc(f.path || f.title)}</div>${f.usage ? `<div class="sum">${esc(f.usage)}</div>` : ''}<div class="det"><pre>${esc(f.text)}</pre></div></div>`).join('') || '<p class="sum">The coffer is empty.</p>'}`;
    const r = roleOf(id) ?? { name: id, sub: '', records: [] };
    return `<div class="t1">${esc(r.name)}</div><div class="t2">${esc(r.sub)}${tag}</div>${byTurn([...(r.records ?? []).filter(e => !e.ask), ...(r.records ?? []).filter(e => e.ask)]).slice(-80).map(entryHTML).join('') || `<p class="sum">${esc(r.empty || 'Nothing here yet.')}</p>`}
      ${id === 'counsellor' ? '<div class="entry ask"><div class="when">you</div><div class="answer" contenteditable="true" data-ph="speak to the Counsellor…"></div><button class="send" data-say>send</button></div>' : ''}`;
  }
  let laneId = null;
  const courtWrap = $('.court');
  const fallTo = el => {
    const b = el.getBoundingClientRect(), sb = courtSvg.getBoundingClientRect(), ox = b.left + b.width / 2, oy = b.top + b.height / 2;
    courtSvg.style.transformOrigin = `${ox - sb.left}px ${oy - sb.top}px`;
    for (const c of [plate, platefx]) { c.style.transition = 'transform 1.3s cubic-bezier(.6,0,.9,.35), opacity 1.2s ease'; c.style.transformOrigin = `${ox}px ${oy}px`; }
  };
  // мы падаем в темноту: стол и гравюра разлетаются вокруг места роли с ускорением, внизу пером рисуется её чат
  function openLane(id) {
    if (laneId) return;
    laneId = id;
    const el = courtSvg.querySelector(`[data-role="${id}"] circle, [data-open="${id}"] circle, [data-open="${id}"] rect`) ?? courtSvg;
    fallTo(el);
    courtWrap.classList.add('deep'); courtSvg.style.transform = 'scale(9)';
    plate.style.transform = platefx.style.transform = 'scale(9)'; plate.style.opacity = platefx.style.opacity = '0';
    lane.querySelector('[data-sigil]').innerHTML = SIGILS[id] ?? (id === 'ledger' ? '<circle r="30"/><circle r="22" stroke-dasharray="1 5"/><path d="M-14 -6H14M-14 4H14M-14 14H6"/>' : '<rect x="-30" y="-14" width="60" height="36"/><path d="M-30 -14L-22 -26H22L30 -14M-30 0H30M-12 -14V22M12 -14V22"/>');
    lane.querySelector('[data-lane-in]').innerHTML = laneHTML(id);
    stagger();
    setTimeout(() => { lane.hidden = false; void lane.offsetWidth; lane.classList.add('in'); lane.scrollTop = lane.scrollHeight; }, reduce ? 0 : 1000);
  }
  function closeLane() {
    if (!laneId) return;
    laneId = null; lane.classList.remove('in');
    setTimeout(() => {
      lane.hidden = true; courtWrap.classList.remove('deep'); courtSvg.style.transform = '';
      for (const c of [plate, platefx]) { c.style.transition = 'transform 1.1s cubic-bezier(.2,.6,.3,1), opacity 1s ease'; c.style.transform = ''; c.style.opacity = ''; }
    }, reduce ? 0 : 500);
  }
  courtSvg.addEventListener('click', e => {
    const stud = e.target.closest('.stud');
    if (stud) {
      const n = +stud.dataset.turn; turnFilter = turnFilter === n ? null : n;
      courtSvg.querySelectorAll('.stud').forEach(x => x.classList.toggle('on', +x.dataset.turn === turnFilter));
      courtSvg.querySelector('[data-turnlabel]').textContent = turnFilter === null ? 'all turns' : `turn ${turnFilter}`;
      if (laneId) lane.querySelector('[data-lane-in]').innerHTML = laneHTML(laneId);
      return;
    }
    const opener = e.target.closest('.seat, [data-open]'), id = opener?.dataset.role ?? opener?.dataset.open;
    if (id) openLane(id);
  });
  courtSvg.addEventListener('keydown', e => { const seat = e.target.closest('.seat'); if (seat && e.key === 'Enter') openLane(seat.dataset.role); });
  lane.addEventListener('click', async e => {
    if (e.target.closest('[data-rise]')) { closeLane(); return; }
    const send = e.target.closest('.send');
    if (send) {
      const box = send.parentElement.querySelector('.answer'), said = box?.textContent.trim() ?? '';
      if (!said) return;
      send.classList.remove('press'); void send.offsetWidth; send.classList.add('press');
      const result = send.hasAttribute('data-say') ? await actions.messageCounsellor?.(said) : await actions.answerGod?.(send.dataset.ask, said);
      if (result?.ok === false) { box.dataset.ph = result.error || 'Not sent.'; box.textContent = ''; return; }
      box.textContent = '';
      courtModel = (await load('court')) ?? courtModel;
      if (laneId) { lane.querySelector('[data-lane-in]').innerHTML = laneHTML(laneId); stagger(); }
      return;
    }
    const en = e.target.closest('.entry');
    if (en && !e.target.closest('.answer') && en.querySelector('.det')) en.classList.toggle('open');
  });
  function openCourt() { buildCourt(); laneId = null; lane.hidden = true; lane.classList.remove('in'); courtWrap.classList.remove('deep'); courtSvg.style.transform = ''; }

  async function loadModel(id) {
    const model = await Promise.resolve(load(id)).catch(error => { console.warn(`[ST Module Engine (Beta)] The ${id} pillar could not load its data:`, error); return null; });
    if (id === 'bank' || id === 'world') books[id] = model;
    if (id === 'charter') charterModel = model;
    if (id === 'canon') skyModel = model ?? { constellations: [] };
    if (id === 'court') courtModel = model ?? courtModel;
  }

  function layout() { if (!visible) return; positionPillars(); placePools(); paintChart(); ground?.size(); top?.size(); shade?.size(); }
  bakeEmblems(); bakeBook(); maskEmblems();
  const onResize = () => layout();
  addEventListener('resize', onResize);

  // 30 кадров в секунду; пока экран скрыт или вкладка спрятана — ничего не рисуем
  let last = 0, rafId = 0;
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    if (!visible || document.hidden || t - last < 33) return;
    last = t;
    for (const p of pools) { const goal = p.warm ? .34 + Math.random() * .1 : .24; p.power += (goal - p.power) * .12; p.hov = (p.hov ?? 0) + ((p.el.dataset.hover ? 1 : 0) - (p.hov ?? 0)) * (p.el.dataset.hover ? .12 : .06); }
    spread += Math.sign(target - spread) * Math.min(reduce ? 1 : .06, Math.abs(target - spread));
    const sec = reduce ? 0 : t / 1000, flat = pools.flatMap(p => [p.x, p.y, p.r, p.power]);
    if (ground) { const { gl, u } = ground; gl.uniform4f(u('zst'), view.s[0], view.s[1], view.d[0], view.d[1]); gl.uniform1f(u('zz'), view.z); gl.uniform2f(u('res'), ground.canvas.width, ground.canvas.height); gl.uniform1f(u('t'), sec); gl.uniform4fv(u('pools'), flat); gl.uniform1fv(u('warm'), pools.map(p => (p.warm ? 1 : 0))); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    if (top) { const { gl, u } = top; gl.uniform2f(u('res'), top.canvas.width, top.canvas.height); gl.uniform1f(u('t'), sec); gl.uniform4fv(u('pools'), flat); gl.uniform1fv(u('hover'), pools.map(p => (p.el.dataset.hover ? 1 : 0))); gl.uniform2f(u('origin'), origin.x, origin.y); gl.uniform1f(u('spread'), spread); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    { const now = performance.now(), menuFull = menu.classList.contains('open') && spread >= .999;
      if (!menuFull) drawFigs(chartFx, chartFigs, chartMask, devicePixelRatio, now);
      if (plate.classList.contains('on')) drawFigs(platefx, plateFigs, plateMask, devicePixelRatio, now); }
    if (shade) { const { gl, u } = shade; gl.uniform2f(u('res'), shade.canvas.width, shade.canvas.height); gl.uniform1f(u('t'), sec); gl.uniform4fv(u('pools'), flat); gl.uniform1fv(u('hov'), pools.map(p => p.hov ?? 0)); gl.clear(gl.COLOR_BUFFER_BIT); if (pools.some(p => (p.hov ?? 0) > .001)) gl.drawArrays(gl.TRIANGLES, 0, 3); }
    paintFires();
  }

  function show() {
    if (visible) return;
    visible = true; host.style.display = 'block';
    layout(); document.fonts?.ready?.then(layout);
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function hide() {
    if (!visible) return;
    if (menu.classList.contains('open')) close();
    visible = false; host.style.display = 'none';
    cancelAnimationFrame(rafId); rafId = 0;
    onHide();
  }
  /** Подписи под эмблемами: `{ id: { text, call } }`; `call` — тёплый свет (кто-то ждёт тебя). */
  function setStates(states = {}) {
    for (const [id, s] of Object.entries(states ?? {})) {
      const el = $(`.pillar[data-p="${id}"]`); if (!el) continue;
      el.querySelector('.state').textContent = s?.state ?? s?.text ?? '';
      el.toggleAttribute('data-call', Boolean(s?.call));
    }
    if (visible) placePools();
  }
  function setHub({ name = '', sub = '' } = {}) { chatName = name; $('.hubtext span').textContent = name; $('.hubtext em').textContent = sub; }
  function setFires(on = []) { lit = on.map((x, i) => (x ? i : -1)).filter(i => i >= 0); }

  return {
    mount: parent => parent.append(host),
    show, hide, toggle: () => (visible ? hide() : show()), isVisible: () => visible,
    setStates, setHub, setFires,
    dispose: () => { cancelAnimationFrame(rafId); removeEventListener('resize', onResize); removeEventListener('keydown', onKey); host.remove(); },
  };
}
