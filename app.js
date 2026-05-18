// ════════════════════════════════════════════
//  CONSTANTS & STATE
// ════════════════════════════════════════════
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
let currentMonth, currentYear;
let state;
let _cargoModalTarjetaId = null;
let _pagoModalTarjetaId = null;
let _openTarjetaCards = new Set();

function monthKey(y,m) { return `${y}-${String(m+1).padStart(2,'0')}`; }
function currentKey() { return monthKey(currentYear, currentMonth); }
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ════════════════════════════════════════════
//  LOAD / SAVE STATE
// ════════════════════════════════════════════
function loadState() {
  // Limpiar versiones viejas — solo una vez (flag de migración)
  if (!localStorage.getItem('finanzas-v2-cleaned')) {
    localStorage.removeItem('finanzas-v2');
    localStorage.setItem('finanzas-v2-cleaned', '1');
  }
  try { state = JSON.parse(localStorage.getItem('finanzas-v3')) || {}; }
  catch { state = {}; }
  if (!state.months) state.months = {};
  if (!state.deuda) state.deuda = { tarjetas: [] };
  // Strip any computed fields that may have leaked into storage in previous versions
  Object.keys(state.months).forEach(k => {
    const md = state.months[k];
    if (!md.tarjetas) {
      md.tarjetas = JSON.parse(JSON.stringify(state.deuda.tarjetas));
    }
    md.tarjetas = md.tarjetas.map(t => {
      const clean = { id: t.id, name: t.name, cargo: t.cargo || 0, cargoItems: t.cargoItems || [], fechaCorte: t.fechaCorte || '', fuentePago: t.fuentePago || '' };
      if (t.saldoOverride !== undefined) clean.saldoOverride = t.saldoOverride;
      return clean;
    });
  });
}
function saveState() {
  _effectiveTarjetasCache = {}; // invalidate memoization cache on any state change
  try {
    // Before saving, strip the live-computed saldoBase/saldo from tarjetas
    // so they are always re-derived fresh from the previous month on load.
    // We only persist what the user actually entered: cargo, cargoItems, fechaCorte, name, id.
    const toSave = JSON.parse(JSON.stringify(state));
    Object.keys(toSave.months).forEach(k => {
      const md = toSave.months[k];
      if (!md.tarjetas) return;
      md.tarjetas = md.tarjetas.map(t => ({
        id: t.id,
        name: t.name,
        cargo: t.cargo || 0,
        cargoItems: t.cargoItems || [],
        fechaCorte: t.fechaCorte || '',
        fuentePago: t.fuentePago || '',
        ...(t.saldoOverride !== undefined ? { saldoOverride: t.saldoOverride } : {})
      }));
      if (md._removedTarjetas && md._removedTarjetas.length > 0) {
        toSave.months[k]._removedTarjetas = md._removedTarjetas;
      }
    });
    localStorage.setItem('finanzas-v3', JSON.stringify(toSave));
  } catch(e) {}
}

// Ensures the month exists in state WITHOUT triggering a save (read-safe).
// Call ensureMonth() for side-effect-only usage; getMonthData() when you need the computed view.
function ensureMonth(key) {
  if (!state.months[key]) {
    state.months[key] = {
      nomina: 0, vales: 0,
      ingresos: [],
      expenses: defaultExpenses(),
      tarjetas: []
    };
    saveState();
  }
}

function getMonthData(key) {
  ensureMonth(key);
  migrateIngresos(state.months[key]);
  migrateFechaCorte(state.months[key]);

  // Compute live tarjetas WITHOUT mutating state.months[key].tarjetas.
  // We return a shallow copy of md with tarjetas replaced by the computed array.
  const md = state.months[key];
  const prevTarjetas = getPrevMonthTarjetas(key);

  const removed = new Set(md._removedTarjetas || []);
  let computedTarjetas;

  if (prevTarjetas.length > 0) {
    const prevIds = new Set(prevTarjetas.map(p => p.id));
    const storedTarjetas = md.tarjetas || [];

    const carried = prevTarjetas
      .filter(prev => !removed.has(prev.id))
      .map(prev => {
        const existing = storedTarjetas.find(t => t.id === prev.id);
        if (existing) {
          const base = existing.saldoOverride !== undefined ? existing.saldoOverride : prev.saldo;
          const itemsTotal = (existing.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
          return { ...existing, saldoBase: base, saldo: base + itemsTotal, cargo: existing.cargo || 0 };
        }
        return { ...prev, cargo: 0, cargoItems: [] };
      }).filter(t => (t.saldoOverride !== undefined ? t.saldoOverride : t.saldo) > 0);

    const brandNew = storedTarjetas.filter(t => !prevIds.has(t.id) && !removed.has(t.id));
    computedTarjetas = [...carried, ...brandNew];
  } else {
    computedTarjetas = (md.tarjetas || []).map(t => {
      const base = t.saldoOverride !== undefined ? t.saldoOverride : (t.saldo || 0);
      const itemsTotal = (t.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
      return { ...t, saldoBase: base, saldo: base + itemsTotal };
    });
  }

  // Return a view object — tarjetas is computed; everything else is a live reference to md.
  // IMPORTANT: never assign this back to state.months[key]; it is read-only for rendering.
  return { ...md, tarjetas: computedTarjetas };
}

function getPrevMonthTarjetas(key) {
  const allKeys = Object.keys(state.months).filter(k => k < key).sort().reverse();
  for (const k of allKeys) {
    const prevMd = state.months[k];
    // Get the STORED tarjetas for that month (what the user actually saved)
    // We need to know the real saldo for that month, which may itself be computed
    // So we call getEffectiveTarjetas recursively (with depth guard)
    const tarjetas = getEffectiveTarjetas(k);
    if (tarjetas && tarjetas.length > 0) {
      return tarjetas.map(t => {
        // t.saldo from getEffectiveTarjetas already = saldo neto (después del pago)
        // No restar cargo de nuevo — ya fue descontado dentro de getEffectiveTarjetas
        const saldoArrastrado = Math.max(0, t.saldo || 0);
        return {
          ...t,
          saldo: saldoArrastrado,
          saldoBase: saldoArrastrado,
          cargo: 0,
          cargoItems: []
        };
      }).filter(t => t.saldo > 0); // don't carry paid-off debts
    }
  }
  return [];
}

// Memoization cache for getEffectiveTarjetas — cleared on every saveState()
let _effectiveTarjetasCache = {};

function getEffectiveTarjetas(key, depth) {
  if ((depth || 0) > 12) return []; // safety guard against infinite recursion
  // Only cache top-level calls (depth === 0 or undefined) — not recursive ones
  if (!depth && _effectiveTarjetasCache[key]) return _effectiveTarjetasCache[key];
  const md = state.months[key];
  if (!md) return [];
  const stored = md.tarjetas || [];

  // Find the previous month's effective tarjetas to compute saldoBase
  const allPrevKeys = Object.keys(state.months).filter(k => k < key).sort().reverse();
  let prevEffective = [];
  for (const k of allPrevKeys) {
    const pe = getEffectiveTarjetas(k, (depth || 0) + 1);
    if (pe.length > 0) { prevEffective = pe; break; }
  }

  if (prevEffective.length > 0) {
    const removed = new Set((md._removedTarjetas || []));
    const prevIds = new Set(prevEffective.map(p => p.id));

    const carried = prevEffective
      .filter(prev => !removed.has(prev.id))
      .map(prev => {
      const storedT = stored.find(t => t.id === prev.id) || {};
      // prev.saldo = saldo after previous month's payment (already net)
      const base = storedT.saldoOverride !== undefined
        ? storedT.saldoOverride
        : (prev.saldo || 0);
      const itemsTotal = (storedT.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
      const cargoThisMonth = storedT.cargo || 0;
      const effectiveSaldo = base + itemsTotal;
      // Return saldo = net after this month's payment, so next month's chain gets the right value
      const saldoNet = Math.max(0, effectiveSaldo - cargoThisMonth);
      return { ...prev, ...storedT, saldoBase: base, saldo: saldoNet, cargo: cargoThisMonth };
    }).filter(t => t.saldo > 0); // stop carrying once paid off

    // Brand-new tarjetas created in this month
    const brandNew = stored.filter(t => !prevIds.has(t.id) && !removed.has(t.id)).map(t => {
      const base = t.saldoOverride !== undefined ? t.saldoOverride : (t.saldo || 0);
      const itemsTotal = (t.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
      const cargoThisMonth = t.cargo || 0;
      const saldoNet = Math.max(0, base + itemsTotal - cargoThisMonth);
      return { ...t, saldoBase: base, saldo: saldoNet, cargo: cargoThisMonth };
    });

    const result = [...carried, ...brandNew];
    if (!depth) _effectiveTarjetasCache[key] = result;
    return result;
  }

  // First month ever — stored saldo is authoritative, but must discount cargo (payment made)
  const firstMonthResult = stored.map(t => {
    const base = t.saldoOverride !== undefined ? t.saldoOverride : (t.saldo || 0);
    const itemsTotal = (t.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
    const cargoThisMonth = t.cargo || 0;
    const effectiveSaldo = base + itemsTotal;
    const saldoNet = Math.max(0, effectiveSaldo - cargoThisMonth);
    return { ...t, saldoBase: base, saldo: saldoNet, cargo: cargoThisMonth };
  });
  if (!depth) _effectiveTarjetasCache[key] = firstMonthResult;
  return firstMonthResult;
}

function defaultExpenses() {
  return [];
}

function getDefaultPagoFuente(ingresos) {
  const firstNoVales = (ingresos || []).find(i => !String(i.name || '').toLowerCase().includes('vale'));
  return firstNoVales ? firstNoVales.id : ((ingresos || [])[0] ? ingresos[0].id : '');
}

function getTarjetaPagoFuente(t, ingresos) {
  return t.fuentePago || getDefaultPagoFuente(ingresos);
}

// ════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════
function renderAjustes() {
  const keys = Object.keys(state.months).sort().reverse();
  // Badge
  const badge = document.getElementById('ajustes-meses-badge');
  if (badge) badge.textContent = `${keys.length} ${keys.length === 1 ? 'mes' : 'meses'}`;

  // Resumen de meses
  const el = document.getElementById('ajustes-resumen-meses');
  if (!el) return;
  if (keys.length === 0) {
    el.innerHTML = `<p class="small-muted" style="text-align:center;padding:12px 0">Sin datos todavía</p>`;
    return;
  }
  el.innerHTML = keys.map(k => {
    const [y, m] = k.split('-').map(Number);
    const md = state.months[k];
    const totalIngresos = (md.ingresos||[]).reduce((s,i)=>s+(i.amount||0),0) || (md.nomina||0);
    const tarjetasK = md.tarjetas || [];
    const totalCortes = tarjetasK.reduce((s,t)=>s+(t.cargo||0),0);
    const totalGastos = (md.expenses||[]).filter(e=>e.type!=='vales'&&e.fuente!=='__AHORRO__').reduce((s,e)=>s+(e.amount||0),0) + totalCortes;
    const libre = totalIngresos - totalGastos;
    const tieneAhorro = getTotalAhorradoMes(k) > 0;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
        <div style="flex:1;min-width:0">
          <div style="font-size:0.85rem;font-weight:700">${MONTHS_ES[m-1]} ${y} ${tieneAhorro?'🐷':''}</div>
          <div style="font-size:0.65rem;color:var(--muted);margin-top:2px">Ingresos ${fmtPos(totalIngresos)} · Gastos ${fmtNeg(totalGastos)}</div>
        </div>
        <div style="font-size:0.85rem;font-weight:800;color:${libre>=0?'var(--green)':'var(--red)'};flex-shrink:0">${libre>=0?fmtPos(libre):fmtNeg(Math.abs(libre))}</div>
      </div>`;
  }).join('') + `<div style="padding-top:10px;border-top:2px solid rgba(0,0,0,0.05);display:flex;justify-content:space-between;align-items:center;margin-top:2px">
    <span style="font-size:0.72rem;font-weight:700;color:var(--muted)">${keys.length} ${keys.length===1?'mes':'meses'} registrados</span>
  </div>`;
}

// Cerrar menú al tocar fuera (legacy — eliminado, ya no hay menú)

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  document.getElementById('nav-'+id).classList.add('active');
  renderAll();
}

function changeMonth(dir) {
  const now = new Date();
  const nextM = currentMonth + dir;
  const nextY = currentYear + (nextM > 11 ? 1 : nextM < 0 ? -1 : 0);
  const normM = (nextM + 12) % 12;
  if (dir > 0) {
    const nextIsReal = nextY < now.getFullYear() || (nextY === now.getFullYear() && normM <= now.getMonth());
    if (!nextIsReal) return;
    // Check if there's libre to carry over
    if (checkArrastreLibre()) {
      openArrastreModal(normM, nextY);
      return;
    }
  }
  currentMonth = normM;
  currentYear = nextY;
  renderAll();
  showUpdatedBadge();
}

function isCurrentMonth() {
  const now = new Date();
  return currentYear === now.getFullYear() && currentMonth === now.getMonth();
}
// ════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════
function fmt(n) {
  if (isNaN(n)) return '$0';
  const hasDecimals = n % 1 !== 0;
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: hasDecimals ? 2 : 0, maximumFractionDigits: 2 });
}
function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: n % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 });
}
// Signed helpers for list items — ingreso/libre/positivo → "+$X", gasto/negativo → "-$X"
function fmtPos(n) { return '+' + fmt(n); }
function fmtNeg(n) { return '-' + fmt(n); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function toast(msg) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.classList.remove('show'); }, 1800);
}
const showToast = toast;
function showUpdatedBadge() {
  const b = document.getElementById('updatedBadge'); if(!b) return;
  b.classList.add('show');
  try { navigator.vibrate && navigator.vibrate(10); } catch(e) {}
  clearTimeout(window.__updTimer);
  window.__updTimer = setTimeout(()=>b.classList.remove('show'), 1200);
}

function openDonutModal(ingId) {
  document.getElementById('modal-donut').classList.add('show');
  const md = getMonthData(currentKey());
  setTimeout(() => drawDonutForIngreso(md, ingId), 50);
}

function drawDonutForIngreso(md, ingId) {
  const ingresos = md.ingresos || [];
  const tarjetas = md.tarjetas || [];
  const primerNoVales = ingresos.find(i => !i.name.toLowerCase().includes('vale'));

  const depositos = md.depositos || [];
  const ahorroMes = depositos.reduce((s,d)=>s+(d.amount||0),0);

  if (ingId && ingresos.length > 0) {
    const ing = ingresos.find(i => i.id === ingId);
    if (!ing) return;

    const gastos = md.expenses.filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
    const esPrimero = ing === primerNoVales;
    const tarjetasAqui = esPrimero ? tarjetas.filter(t=>(t.cargo||0)>0) : [];
    const ahorroDeEste = esPrimero ? ahorroMes : 0;
    const ingresoTotal = ing.amount || 0;

    // Agrupar gastos por nombre (case-insensitive)
    const grouped = {};
    const categories = [];
    gastos.forEach(e => {
      if (e.amount <= 0) return;
      const key = (e.name || '').trim().toLowerCase();
      if (grouped[key]) {
        grouped[key].amount += e.amount;
      } else {
        const item = { label: e.name, amount: e.amount, icon: e.icon || '💰' };
        grouped[key] = item;
        categories.push(item);
      }
    });

    tarjetasAqui.forEach(t => {
      if ((t.cargo||0) > 0) categories.push({ label: t.name, amount: t.cargo, icon: '💳' });
    });
    if (ahorroDeEste > 0) categories.push({ label: 'Ahorro del mes', amount: ahorroDeEste, icon: '🐷' });

    const totalGastos = categories.reduce((s,c)=>s+c.amount, 0);
    const libre = Math.max(0, ingresoTotal - totalGastos);
    if (libre > 0) categories.push({ label: 'Libre', amount: libre, _libre: true, icon: '✅' });

    drawDonutWithCategories(categories, ing.name, totalGastos);
  } else {
    const nomina = md.nomina || 0;
    const vales = md.vales || 0;
    drawDonut(md.expenses, nomina, vales, md);
  }
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('show'); });
});

// ════════════════════════════════════════════
//  INGRESOS
// ════════════════════════════════════════════
function renderIngresos(md) {
  const list = document.getElementById('ingresos-list');
  const totalRow = document.getElementById('ingresos-total-row');
  const totalVal = document.getElementById('ingresos-total-val');
  if (!list) return;
  const ingresos = md.ingresos || [];

  if (ingresos.length === 0) {
    list.innerHTML = `<p class="small-muted" style="text-align:center;padding:12px 0">Toca "+ Agregar" para añadir un ingreso</p>`;
    if(totalRow) totalRow.style.display = 'none';
    return;
  }

  const ACCENT_COLOR = 'var(--green)';

  list.innerHTML = ingresos.map((ing, idx) => {
    const subs = ing.subItems || [];
    const hasSubs = subs.length > 0;
    const conceptTotal = hasSubs ? subs.reduce((s,si)=>s+(si.amount||0),0) : (ing.amount||0);
    const accent = ACCENT_COLOR;

    const subItemsHtml = subs.map(sub => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.04)" id="sub-row-${sub.id}">
        <div style="width:5px;height:5px;border-radius:50%;background:${accent};flex-shrink:0;opacity:0.55"></div>
        <input
          style="flex:1;background:none;border:none;outline:none;font-size:0.82rem;font-weight:500;color:var(--text);padding:0;min-width:0"
          value="${sub.name}" placeholder="Concepto"
          onchange="updateSubIngreso('${ing.id}','${sub.id}','name',this.value)"/>
        <div style="display:flex;align-items:baseline;gap:1px;flex-shrink:0">
          <span style="font-size:0.72rem;color:var(--muted);font-weight:600">$</span>
          <input
            type="text" inputmode="decimal"
            style="background:none;border:none;border-bottom:1.5px solid rgba(0,0,0,0.08);outline:none;font-size:0.82rem;font-weight:700;color:var(--green);text-align:right;width:72px;padding:1px 2px"
            value="${fmtNum(sub.amount)}" placeholder="0"
            onfocus="focusSubIngresoInput(this)"
            onblur="blurSubIngresoInput(this,'${ing.id}','${sub.id}')"
            data-raw="${sub.amount||0}"/>
        </div>
        <button onclick="removeSubIngreso('${ing.id}','${sub.id}')"
          style="background:none;border:none;color:var(--red);font-size:0.78rem;cursor:pointer;padding:3px 4px;opacity:0.5;flex-shrink:0">✕</button>
      </div>`).join('');

    const addSubBtn = `
      <div style="padding:8px 0 ${hasSubs?'4px':'0'}">
        <button onclick="event.stopPropagation();addSubIngreso('${ing.id}')"
          style="background:none;border:1px dashed rgba(0,0,0,0.12);color:var(--muted);border-radius:8px;padding:5px 10px;font-size:0.72rem;font-weight:600;cursor:pointer;width:100%">
          + Sub-ingreso
        </button>
      </div>`;

    // Always show total line — editable input when no subs, read-only when has subs
    const totalLineHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;${hasSubs?'border-top:1px solid rgba(0,0,0,0.05);margin-top:2px':''}">
        <span style="font-size:0.6rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em">Total ${ing.name}</span>
        <span style="font-size:0.88rem;font-weight:800;color:${accent};font-variant-numeric:tabular-nums">${fmt(conceptTotal)}</span>
      </div>`;

    return `
    <div style="border-bottom:1px solid rgba(0,0,0,0.06);padding-bottom:12px;margin-bottom:10px" id="ing-row-${ing.id}">
      <!-- Header: arrow + emoji + name + total | move + delete -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:0" onclick="toggleSubIngresos('${ing.id}')" style="cursor:pointer">
        <button id="ing-arrow-${ing.id}" onclick="event.stopPropagation();toggleSubIngresos('${ing.id}')"
          style="background:rgba(0,0,0,0.06);border:none;color:var(--muted);font-size:0.65rem;cursor:pointer;padding:4px 8px;flex-shrink:0;line-height:1;border-radius:99px;display:flex;align-items:center;gap:3px;font-weight:700;transition:background 0.15s;white-space:nowrap">
          <svg id="ing-arrow-svg-${ing.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;transition:transform 0.25s;transform:rotate(${(hasSubs&&_openIngresos.has(ing.id))?'90deg':'0deg'})"><path d="M9 18l6-6-6-6"/></svg>
          <span id="ing-arrow-label-${ing.id}">${(hasSubs&&_openIngresos.has(ing.id))?'Ocultar':'Ver'}</span>
        </button>
        <span style="font-size:0.92rem;flex-shrink:0">💰</span>
        <input
          style="flex:1;background:none;border:none;outline:none;font-size:0.88rem;font-weight:700;color:var(--text);padding:0;min-width:0"
          value="${ing.name}" placeholder="Concepto"
          onclick="event.stopPropagation()"
          onchange="updateIngreso('${ing.id}','name',this.value)"/>
        <button onclick="event.stopPropagation();moveIngreso('${ing.id}',-1)" style="background:none;border:none;color:var(--muted);font-size:0.85rem;cursor:pointer;padding:2px 3px;flex-shrink:0;opacity:0.6">↑</button>
        <button onclick="event.stopPropagation();moveIngreso('${ing.id}',1)"  style="background:none;border:none;color:var(--muted);font-size:0.85rem;cursor:pointer;padding:2px 3px;flex-shrink:0;opacity:0.6">↓</button>
        <button onclick="event.stopPropagation();removeIngreso('${ing.id}')"  style="background:none;border:none;color:var(--red);font-size:0.85rem;cursor:pointer;padding:2px 3px;flex-shrink:0;opacity:0.55">✕</button>
        <!-- Total siempre visible -->
        <span style="font-size:0.88rem;font-weight:800;color:${accent};font-variant-numeric:tabular-nums;flex-shrink:0;min-width:52px;text-align:right">${fmt(conceptTotal)}</span>
      </div>
      <!-- Sub-panel colapsado por defecto -->
      <div id="sub-ing-${ing.id}" style="display:${(hasSubs&&_openIngresos.has(ing.id))?'block':'none'};padding-left:22px;margin-top:8px">
        ${subItemsHtml}
        ${addSubBtn}
        ${totalLineHtml}
      </div>
    </div>`;
  }).join('');

  const total = ingresos.reduce((s,i)=>{
    const subs = i.subItems||[];
    return s + (subs.length > 0 ? subs.reduce((a,si)=>a+(si.amount||0),0) : (i.amount||0));
  }, 0);
  if(totalRow) totalRow.style.cssText += ';display:flex';
  if(totalVal) totalVal.textContent = fmt(total);
}

function focusSubIngresoInput(el) {
  const raw = el.dataset.raw || '0';
  el.value = raw === '0' ? '' : raw;
  el.type = 'number';
}
function blurSubIngresoInput(el, ingresoId, subId) {
  el.type = 'text';
  const val = parseFloat(el.value) || 0;
  el.dataset.raw = val;
  el.value = fmtNum(val);
  updateSubIngreso(ingresoId, subId, 'amount', val);
}
function updateIngreso(id, field, value) {
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  if (!raw.ingresos) raw.ingresos = [];
  const ing = raw.ingresos.find(i => i.id === id);
  if (!ing) return;
  if (field === 'amount') ing.amount = parseFloat(value) || 0;
  else ing[field] = value;
  syncLegacyIngresos(raw);
  saveState();
  renderAll();
  showUpdatedBadge();
}
function addIngreso() {
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  if (!raw.ingresos) raw.ingresos = [];
  const defaults = ['Nómina', 'Vales despensa', 'Ingreso extra'];
  const name = defaults[raw.ingresos.length] || 'Ingreso';
  raw.ingresos.push({ id: uid(), name, amount: 0, subItems: [] });
  saveState();
  renderAll();
  showUpdatedBadge();
}
function addSubIngreso(ingresoId) {
  const key = currentKey();
  getMonthData(key);
  const raw = state.months[key];
  if (!raw.ingresos) return;
  const ing = raw.ingresos.find(i => i.id === ingresoId);
  if (!ing) return;
  if (!ing.subItems) ing.subItems = [];
  ing.subItems.push({ id: uid(), name: 'Sub-ingreso', amount: 0 });
  ing.amount = ing.subItems.reduce((s,si)=>s+(si.amount||0),0);
  syncLegacyIngresos(raw);
  saveState();
  // Abrir el panel del ingreso al que se agrega
  _openIngresos.add(ingresoId);
  renderAll();
  showUpdatedBadge();
}
function updateSubIngreso(ingresoId, subId, field, value) {
  const key = currentKey();
  getMonthData(key);
  const raw = state.months[key];
  if (!raw.ingresos) return;
  const ing = raw.ingresos.find(i => i.id === ingresoId);
  if (!ing || !ing.subItems) return;
  const sub = ing.subItems.find(s => s.id === subId);
  if (!sub) return;
  if (field === 'amount') sub.amount = parseFloat(value) || 0;
  else sub[field] = value;
  // Recalc parent total
  ing.amount = ing.subItems.reduce((s,si)=>s+(si.amount||0),0);
  syncLegacyIngresos(raw);
  saveState();
  renderAll();
  showUpdatedBadge();
}
function removeSubIngreso(ingresoId, subId) {
  if (!confirm('¿Eliminar este sub-ingreso?')) return;
  const key = currentKey();
  getMonthData(key);
  const raw = state.months[key];
  if (!raw.ingresos) return;
  const ing = raw.ingresos.find(i => i.id === ingresoId);
  if (!ing || !ing.subItems) return;
  ing.subItems = ing.subItems.filter(s => s.id !== subId);
  ing.amount = ing.subItems.reduce((s,si)=>s+(si.amount||0),0);
  syncLegacyIngresos(raw);
  saveState();
  renderAll();
  showUpdatedBadge();
}
function toggleSubIngresos(ingresoId) {
  const el = document.getElementById('sub-ing-' + ingresoId);
  const arrow = document.getElementById('ing-arrow-' + ingresoId);
  const svg = document.getElementById('ing-arrow-svg-' + ingresoId);
  const label = document.getElementById('ing-arrow-label-' + ingresoId);
  if (!el) return;
  const open = el.style.display !== 'none';
  // Actualizar estado persistente
  if (open) _openIngresos.delete(ingresoId);
  else _openIngresos.add(ingresoId);
  el.style.display = open ? 'none' : 'block';
  if (svg) svg.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
  if (label) label.textContent = open ? 'Ver' : 'Ocultar';
  if (arrow) {
    arrow.style.background = open ? 'rgba(0,0,0,0.06)' : 'rgba(0,122,255,0.12)';
    arrow.style.color = open ? 'var(--muted)' : 'var(--blue)';
  }
}
function removeIngreso(id) {
  if (!confirm('¿Eliminar este ingreso?')) return;
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  if (!raw.ingresos) return;
  raw.ingresos = raw.ingresos.filter(i => i.id !== id);
  syncLegacyIngresos(raw);
  saveState();
  renderAll();
  showUpdatedBadge();
}
function moveIngreso(id, dir) {
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  if (!raw.ingresos) return;
  const idx = raw.ingresos.findIndex(i => i.id === id);
  if (idx < 0) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= raw.ingresos.length) return;
  [raw.ingresos[idx], raw.ingresos[ni]] = [raw.ingresos[ni], raw.ingresos[idx]];
  saveState(); renderAll(); showUpdatedBadge();
}
function syncLegacyIngresos(md) {
  if (!md.ingresos) { md.nomina = 0; md.vales = 0; return; }
  const valesEnt = md.ingresos.find(i => i.name.toLowerCase().includes('vale'));
  const nominaEnts = md.ingresos.filter(i => !i.name.toLowerCase().includes('vale'));
  md.nomina = nominaEnts.reduce((s,i) => s + (i.amount||0), 0);
  md.vales = valesEnt ? (valesEnt.amount||0) : 0;
}
function migrateIngresos(md) {
  if (md.ingresos) {
    // Ensure all ingresos have subItems array
    md.ingresos.forEach(i => { if (!i.subItems) i.subItems = []; });
    return;
  }
  md.ingresos = [];
  if ((md.nomina||0)>0) md.ingresos.push({ id: uid(), name: 'Nómina', amount: md.nomina, subItems: [] });
  if ((md.vales||0)>0) md.ingresos.push({ id: uid(), name: 'Vales despensa', amount: md.vales, subItems: [] });
}

function migrateFechaCorte(md) {
  // Convert old full-date fechaCorte (e.g. "2026-05-14") to day-only (e.g. "14")
  if (!md.tarjetas) return;
  md.tarjetas.forEach(t => {
    if (t.fechaCorte && t.fechaCorte.includes('-')) {
      try {
        const d = new Date(t.fechaCorte + 'T12:00:00');
        t.fechaCorte = String(d.getDate());
      } catch { t.fechaCorte = ''; }
    }
  });
}

// ════════════════════════════════════════════
//  RENDER ALL
// ════════════════════════════════════════════
function renderAll() {
  const key = currentKey();
  const md = getMonthData(key);
  const label = `${MONTHS_ES[currentMonth]} ${currentYear}`;
  document.querySelectorAll('[id$="-month-label"]').forEach(el => el.textContent = label);
  document.querySelectorAll('.month-bar').forEach(bar => {
    const btns = bar.querySelectorAll('.month-nav');
    if (btns[1]) btns[1].style.opacity = isCurrentMonth() ? '0.25' : '1';
  });
  const now = new Date();
  document.getElementById('home-date').textContent =
    now.toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long'});
  calcAndRender(md, key);
  renderIngresos(md);
  renderCerrarMes(md);
  renderGastos(md, key);
  renderDeuda(md);
  renderHistorial();
  renderAhorro();
  renderAjustes();
}

// ════════════════════════════════════════════
//  CALC & HOME
// ════════════════════════════════════════════
function calcAndRender(md, key) {
  if (md.ingresos) syncLegacyIngresos(md);
  const nomina = md.nomina || 0;
  const vales = md.vales || 0;
  const ingresos = md.ingresos || [];
  const totalIngresos = ingresos.reduce((s,i)=>s+(i.amount||0),0);

  // Gastos del ahorro (fuente == '__AHORRO__') — separados del resto
  const gastosDelAhorro = md.expenses.filter(e => e.fuente === '__AHORRO__');
  const totalGastosAhorro = gastosDelAhorro.reduce((s,e)=>s+(e.amount||0),0);

  const nominaExp = md.expenses.filter(e => e.type !== 'vales' && e.fuente !== '__AHORRO__');
  const valesExp = md.expenses.filter(e => e.type === 'vales' && e.fuente !== '__AHORRO__');
  const tarjetas = md.tarjetas || [];
  const totalTarjetaCortes = tarjetas.reduce((s,t) => s+(t.cargo||0), 0);
  const totalGastos = nominaExp.reduce((s,e) => s+(e.amount||0), 0) + totalTarjetaCortes;
  const totalValesGasto = valesExp.reduce((s,e) => s+(e.amount||0), 0);

  // Ahorro registrado del mes actual (resta de ingresos disponibles)
  const ahorroMes = (md.ahorroReal !== undefined && md.ahorroReal !== null) ? (md.ahorroReal || 0) : 0;

  const ingresosNoVales = ingresos.filter(i => !i.name.toLowerCase().includes('vale'));
  const totalIngresosNoVales = ingresosNoVales.reduce((s,i)=>s+(i.amount||0),0);
  const baseParaLibre = totalIngresosNoVales > 0 ? totalIngresosNoVales : nomina;
  // Libre = ingresos - gastos normales - ahorro comprometido del mes
  const libre = baseParaLibre - totalGastos - ahorroMes;
  const valesLibre = vales - totalValesGasto;

  // Legacy hidden spans for other functions
  document.getElementById('kpi-nomina').textContent = fmt(nomina);
  document.getElementById('kpi-vales').textContent = fmt(vales);
  document.getElementById('kpi-gastos').textContent = fmt(totalGastos);
  document.getElementById('kpi-libre').textContent = fmt(libre);
  document.getElementById('kpi-gasto-vales').textContent = fmt(totalValesGasto);
  document.getElementById('kpi-vales-libre').textContent = fmt(valesLibre);

  // KPIs dinámicos — movidos fuera del Resumen

  // Donut
  drawDonut(md.expenses, nomina, vales, md);

  // Bars
  const bars = document.getElementById('bars-home');
  const sorted = [...nominaExp].sort((a,b) => b.amount - a.amount);
  bars.innerHTML = sorted.map(e => {
    const total = totalIngresos > 0 ? totalIngresos : nomina;
    const pct = total > 0 ? Math.min((e.amount/total)*100,100) : 0;
    const color = 'var(--red)';
    return `<div class="bar-row-s">
      <div class="bar-label-s">${e.icon||'💰'} ${e.name}</div>
      <div class="bar-track-s"><div class="bar-fill-s" style="width:${pct}%;background:${color}"></div></div>
      <div class="bar-amt-s">${fmt(e.amount)}</div>
    </div>`;
  }).join('');

  // Ahorro tip
  const ahorroEl = document.getElementById('ahorro-tip');
  if (libre <= 0) {
    ahorroEl.innerHTML = `<div class="tip-box" style="border-color:rgba(255,59,48,0.3);background:rgba(255,59,48,0.07)">
      <strong style="color:var(--red)">⚠️ Gastos mayores al ingreso</strong><br>
      Te faltan <strong>${fmt(Math.abs(libre))}</strong> para cubrir todo. Revisa tus gastos variables.
    </div>`;
  } else {
    const ahorroRec = Math.floor(libre * 0.3);
    const ahorroAgr = Math.floor(libre * 0.5);
    ahorroEl.innerHTML = `<div class="tip-box">
      <strong>💡 Con ${fmt(libre)} libre puedes:</strong><br><br>
      🟡 Conservador: ahorrar <strong>${fmt(ahorroRec)}</strong> (30%)<br>
      🟢 Agresivo: ahorrar <strong>${fmt(ahorroAgr)}</strong> (50%)<br><br>
      El resto queda para gastos inesperados del mes.
    </div>`;
  }

  // Desglose completo
  const desgloseEl = document.getElementById('home-desglose');
  if (desgloseEl) {
    const mkExpRow = (icon, name, amount, color, extraHtml='') =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0 6px 8px;border-bottom:1px solid rgba(0,0,0,0.04)">
        <span style="font-size:0.82rem;display:flex;align-items:center;gap:5px">${icon} ${name}${extraHtml}</span>
        <span style="font-size:0.8rem;font-weight:600;color:${color};flex-shrink:0">${color==='var(--green)'?fmtPos(amount):fmtNeg(amount)}</span>
      </div>`;

    const mkLibreRow = (libreVal) => {
      const color = libreVal >= 0 ? 'var(--green)' : 'var(--red)';
      const label = libreVal >= 0 ? 'Libre' : 'Déficit';
      const sign = libreVal >= 0 ? '+' : '-';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;margin-top:4px;background:${libreVal>=0?'rgba(26,122,58,0.07)':'rgba(255,59,48,0.07)'};border-radius:8px">
        <span style="font-size:0.75rem;font-weight:700;color:${color}">${label}</span>
        <span style="font-size:0.85rem;font-weight:800;color:${color}">${sign}${fmt(Math.abs(libreVal))}</span>
      </div>`;
    };

    let html = '';

    if (ingresos.length === 0) {
      // Sin ingresos: fallback simple
      const allExp = md.expenses.filter(e => e.amount > 0 && e.fuente !== '__AHORRO__');
      if (allExp.length > 0) {
        allExp.forEach(e => { html += mkExpRow(e.icon||'💰', e.name, e.amount, 'var(--red)'); });
        tarjetas.filter(t=>(t.cargo||0)>0).forEach(t => {
          html += mkExpRow('💳', t.name, t.cargo, 'var(--red)', '');
        });
      }
      if (ahorroMes > 0) {
        html += mkExpRow('🐷', 'Ahorro del mes', ahorroMes, 'var(--green)');
      }
      html += `<div style="margin-top:10px;border-top:2px solid rgba(0,0,0,0.06);padding-top:10px;display:flex;justify-content:space-between">
        <span style="font-size:0.8rem;font-weight:700">Total gastos</span>
        <span style="font-weight:800;color:var(--red)">${fmt(totalGastos)}</span>
      </div>`;
    } else {
      // Con ingresos: una sección por ingreso con sus gastos y su propio libre
      const primerNoVales = ingresos.find(i => !i.name.toLowerCase().includes('vale'));

      ingresos.forEach(ing => {
        // Excluir gastos del ahorro de esta sección
        const gastos = md.expenses.filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
        const esTarjetasIng = ing.id === getDefaultPagoFuente(ingresos);
        const tarjetasAqui = tarjetas.filter(t => (t.cargo || 0) > 0 && getTarjetaPagoFuente(t, ingresos) === ing.id);
        // El ahorro del mes se resta del primer ingreso no-vales
        const ahorroDeEsteIng = (esTarjetasIng && ahorroMes > 0) ? ahorroMes : 0;
        const totalGastosIng = gastos.reduce((s,e)=>s+(e.amount||0),0)
          + tarjetasAqui.reduce((s,t)=>s+(t.cargo||0),0)
          + ahorroDeEsteIng;
        const libreIng = (ing.amount||0) - totalGastosIng;

        html += `<div style="margin-bottom:12px;padding-bottom:4px">
          <div style="display:flex;align-items:center;padding:8px 0 4px;gap:6px">
            <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);flex:1">💰 ${ing.name}</span>
            <button onclick="openDonutModal('${ing.id}')" style="background:none;border:1px solid rgba(0,0,0,0.12);color:var(--muted);border-radius:8px;padding:3px 7px;font-size:0.65rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:3px;flex-shrink:0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v9h9"/></svg>Gráfica</button>
            <span style="font-size:0.75rem;font-weight:700;color:var(--green);flex-shrink:0;min-width:48px;text-align:right">${fmtPos(ing.amount)}</span>
          </div>`;

        gastos.forEach(e => { html += mkExpRow(e.icon||'💰', e.name, e.amount, 'var(--red)'); });
        tarjetasAqui.forEach(t => {
          html += mkExpRow('💳', t.name, t.cargo, 'var(--red)', '');
        });
        if (ahorroDeEsteIng > 0) {
          html += mkExpRow('🐷', 'Ahorro del mes', ahorroDeEsteIng, 'var(--red)');
        }

        if (gastos.length === 0 && tarjetasAqui.length === 0 && ahorroDeEsteIng === 0) {
          html += `<div style="padding:6px 8px;font-size:0.75rem;color:var(--muted);font-style:italic">Sin gastos asignados</div>`;
        }
        html += mkLibreRow(libreIng);
        html += `</div><div style="border-top:1px solid rgba(0,0,0,0.06);margin-bottom:12px"></div>`;
      });

      // Gastos sin ingreso asignado (excluir gastos del ahorro)
      const sinFuente = md.expenses.filter(e => e.fuente !== '__AHORRO__' && (!e.fuente || !ingresos.find(i=>i.id===e.fuente)));
      if (sinFuente.length > 0) {
        html += `<div style="margin-bottom:12px">
          <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);padding:4px 0 8px">❓ Sin ingreso asignado</div>`;
        sinFuente.forEach(e => { html += mkExpRow(e.icon||'💰', e.name, e.amount, 'var(--muted)'); });
        html += `</div>`;
      }

      // Sección del ahorro: gastos + ahorro del mes
      const hayGastosAhorro = gastosDelAhorro.length > 0;
      const hayAhorroMes = ahorroMes > 0;
      if (hayGastosAhorro || hayAhorroMes) {
        const saldoAhorro = calcSaldoAhorro();
        html += `<div style="margin-bottom:4px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 4px;border-top:2px solid rgba(26,122,58,0.15);margin-top:4px">
            <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--green)">🐷 Ahorro</span>
            <span style="font-size:0.65rem;color:${saldoAhorro<0?'var(--red)':'var(--muted)'}">Saldo: ${fmt(saldoAhorro)}</span>
          </div>`;
        if (hayAhorroMes) {
          html += mkExpRow('💰', 'Guardado este mes', ahorroMes, 'var(--green)');
        }
        if (hayGastosAhorro) {
          gastosDelAhorro.forEach(e => {
            html += mkExpRow(e.icon||'💸', e.name, e.amount, 'var(--red)', ' <span style="font-size:0.55rem;background:rgba(255,59,48,0.1);color:var(--red);padding:1px 5px;border-radius:99px">del ahorro</span>');
          });
          html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;margin-top:4px;background:rgba(255,59,48,0.06);border-radius:8px">
            <span style="font-size:0.75rem;font-weight:700;color:var(--red)">Gastado del ahorro</span>
            <span style="font-size:0.85rem;font-weight:800;color:var(--red)">${fmtNeg(totalGastosAhorro)}</span>
          </div>`;
        }
        html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 8px;margin-top:6px;background:rgba(26,122,58,0.07);border-radius:8px;border:1px solid rgba(26,122,58,0.15)">
          <span style="font-size:0.75rem;font-weight:700;color:var(--green)">🐷 Saldo en ahorro</span>
          <span style="font-size:0.88rem;font-weight:800;color:${saldoAhorro>=0?'var(--green)':'var(--red)'}">${saldoAhorro>=0?fmtPos(saldoAhorro):fmtNeg(Math.abs(saldoAhorro))}</span>
        </div>`;
        html += `</div>`;
      }
    }

    desgloseEl.innerHTML = html;
  }
}

// ════════════════════════════════════════════
//  DONUT (interactive)
// ════════════════════════════════════════════
let _donutCategories = [];
const _openIngresos = new Set();
let _donutSelectedIdx = -1;
let _donutTotal = 0;
let _donutTotalExp = 0;

// Register canvas click handler once — reads live state vars
(function() {
  function handleDonutClick(e) {
    const canvas = document.getElementById('donutCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const SIZE_L = 220;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cx = SIZE_L / 2, cy = SIZE_L / 2;
    const dx = mx - cx, dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = SIZE_L * 0.36, stroke = SIZE_L * 0.13;
    if (dist < r - stroke / 2 - 4 || dist > r + stroke / 2 + 4) {
      donutSelectSlice(-1, _donutTotal, _donutTotalExp); return;
    }
    let angle = Math.atan2(dy, dx);
    if (angle < -Math.PI / 2) angle += Math.PI * 2;
    const idx = _donutCategories.findIndex(c => {
      let s = c._startAngle, en = c._endAngle;
      if (s > en) en += Math.PI * 2;
      let a = angle < -Math.PI / 2 ? angle + Math.PI * 2 : angle;
      return a >= s && a <= en;
    });
    donutSelectSlice(idx >= 0 ? idx : -1, _donutTotal, _donutTotalExp);
  }
  // Bind after DOM is ready (init() runs after this script block)
  document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('donutCanvas');
    if (canvas) canvas.addEventListener('click', handleDonutClick);
  });
  // Fallback if DOMContentLoaded already fired (inline script)
  window._donutClickHandler = handleDonutClick;
})();

function assignDonutColors(categories) {
  // Full palette — diverse hues spaced far apart
  const palette = [
    '#ff3b30','#c0392b','#e74c3c','#ff6b6b','#ff3b30',
    '#ec4899','#14b8a6','#f97316','#6366f1','#84cc16',
    '#e11d48','#0ea5e9','#a855f7','#10b981','#fb923c'
  ];
  // Assign colors ensuring no two consecutive items share a similar hue
  const used = [];
  categories.forEach((c, i) => {
    // Find a palette color not too close to the previous one
    const prev = used[i - 1] || null;
    let chosen = null;
    for (const col of palette) {
      if (col === prev) continue;
      if (!used.includes(col)) { chosen = col; break; }
    }
    // Fallback: avoid only the immediate previous
    if (!chosen) {
      for (const col of palette) {
        if (col !== prev) { chosen = col; break; }
      }
    }
    c.color = chosen || palette[i % palette.length];
    used.push(c.color);
  });
}

function drawDonutFrame(canvas, categories, selectedIdx, total) {
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 220;
  if (canvas.width !== SIZE * dpr || canvas.height !== SIZE * dpr) {
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);
  const cx = SIZE/2, cy = SIZE/2;
  const r = SIZE * 0.36;
  const stroke = SIZE * 0.13;
  const gapRad = 2.5 / r;
  const singleSegment = categories.length === 1;
  let start = -Math.PI / 2;

  categories.forEach((c, i) => {
    const slice = (c.amount / total) * Math.PI * 2;
    const gap = (!singleSegment && slice > gapRad * 3) ? gapRad : 0;
    const isSelected = i === selectedIdx;
    const expandR = isSelected ? r + 5 : r;
    const expandStroke = isSelected ? stroke + 5 : stroke;
    ctx.globalAlpha = selectedIdx >= 0 && !isSelected ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, expandR, start + gap, start + slice - gap);
    ctx.strokeStyle = c.color;
    ctx.lineWidth = expandStroke;
    ctx.lineCap = 'butt';
    ctx.stroke();
    c._startAngle = start + gap;
    c._endAngle = start + slice - gap;
    start += slice;
  });
  ctx.globalAlpha = 1;
}

function drawDonutWithCategories(categories, titulo, totalGastos) {
  const canvas = document.getElementById('donutCanvas');
  const legend = document.getElementById('donut-legend');
  const labelEl = document.getElementById('donut-center-label');
  const valEl = document.getElementById('donut-center-val');

  const h3 = document.querySelector('#modal-donut h3');
  if (h3) h3.textContent = '📊 ' + titulo;

  const total = categories.reduce((s,c)=>s+c.amount, 0);

  if (categories.length === 0 || total === 0) {
    legend.innerHTML = '<p style="font-size:0.75rem;color:var(--muted);text-align:center;padding:10px">Sin gastos este mes</p>';
    labelEl.textContent = '';
    valEl.textContent = '';
    return;
  }

  const PALETTE = [
    '#e74c3c','#e67e22','#9b59b6','#3498db','#1abc9c',
    '#f39c12','#e91e63','#00bcd4','#8bc34a','#ff5722',
    '#607d8b','#795548','#673ab7','#03a9f4','#cddc39'
  ];

  let pi = 0;
  categories.forEach(c => {
    if (c._libre) c.color = '#1a7a3a';
    else { c.color = PALETTE[pi % PALETTE.length]; pi++; }
  });

  _donutCategories = categories;
  _donutSelectedIdx = -1;
  _donutTotal = total;
  _donutTotalExp = totalGastos;
  drawDonutFrame(canvas, categories, -1, total);

  labelEl.textContent = 'Total gastos';
  valEl.textContent = fmt(totalGastos);
  valEl.style.color = 'var(--red)';

  // Leyenda debajo: dot + concepto a la izquierda, monto + % a la derecha
  legend.innerHTML = categories.map((c, i) => {
    const pct = total > 0 ? ((c.amount / total) * 100).toFixed(1) : '0.0';
    return `<div class="legend-item" style="cursor:pointer;border-radius:8px;padding:6px 8px;transition:background 0.15s;display:flex;align-items:center;gap:8px;width:100%"
      onclick="donutLegendClick(${i})" id="legend-item-${i}">
      <div style="width:10px;height:10px;border-radius:50%;background:${c.color};flex-shrink:0"></div>
      <span style="font-size:0.82rem;flex:1;font-weight:600">${c.icon||''} ${c.label}</span>
      <span style="font-size:0.82rem;font-weight:800;font-variant-numeric:tabular-nums">${fmt(c.amount)}</span>
      <span style="font-size:0.72rem;color:var(--muted);font-weight:600;min-width:38px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');

  // Click handled by single registered listener (see _donutClickHandler setup)
}

function drawDonut(expenses, nomina, vales, md) {
  const canvas = document.getElementById('donutCanvas');
  const tarjetasD = md.tarjetas || [];
  const totalCortes = tarjetasD.reduce((s,t)=>s+(t.cargo||0),0);
  const categories = [];
  const fijos = expenses.filter(e=>e.type==='fijo'&&e.amount>0);
  fijos.forEach(e=>{ categories.push({label:e.name,amount:e.amount}); });
  const varManuales = expenses.filter(e=>e.type==='variable'&&e.amount>0);
  varManuales.forEach(e=>{ categories.push({label:e.name,amount:e.amount}); });
  if (totalCortes>0) categories.push({label:'Tarjetas',amount:totalCortes});
  const totalExp = categories.reduce((s,c)=>s+c.amount,0);
  const libre = Math.max(0, nomina - totalExp);
  if (libre>0) categories.push({label:'Libre',amount:libre,_libre:true});
  const total = categories.reduce((s,c)=>s+c.amount,0);

  if (total===0) {
    document.getElementById('donut-legend').innerHTML='<p style="font-size:0.75rem;color:var(--muted);text-align:center;padding:10px">Sin datos este mes</p>';
    document.getElementById('donut-center-label').textContent='';
    document.getElementById('donut-center-val').textContent='';
    return;
  }

  assignDonutColors(categories);
  categories.forEach(c=>{ if(c._libre) c.color='#1a7a3a'; });

  _donutCategories = categories;
  _donutSelectedIdx = -1;
  _donutTotal = total;
  _donutTotalExp = totalExp;
  drawDonutFrame(canvas, categories, -1, total);

  document.getElementById('donut-center-label').textContent = 'Total gastos';
  document.getElementById('donut-center-val').textContent = fmt(totalExp);
  document.getElementById('donut-center-val').style.color = 'var(--red)';

  // Leyenda debajo: dot + concepto izquierda, monto + % derecha
  document.getElementById('donut-legend').innerHTML = categories.map((c,i) => {
    const pct = total > 0 ? ((c.amount / total) * 100).toFixed(1) : '0.0';
    return `<div class="legend-item" style="cursor:pointer;border-radius:8px;padding:6px 8px;transition:background 0.15s;display:flex;align-items:center;gap:8px;width:100%"
      onclick="donutLegendClick(${i})" id="legend-item-${i}">
      <div class="ldot" style="background:${c.color}"></div>
      <span style="font-size:0.82rem;flex:1;font-weight:600">${c.label}</span>
      <span style="font-size:0.82rem;font-weight:800;font-variant-numeric:tabular-nums">${fmt(c.amount)}</span>
      <span style="font-size:0.72rem;color:var(--muted);font-weight:600;min-width:38px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');
  // Click handled by single registered listener
}

function donutLegendClick(i) {
  const totalExp = _donutCategories.filter(c=>!c._libre).reduce((s,c)=>s+c.amount,0);
  const total = _donutCategories.reduce((s,c)=>s+c.amount,0);
  donutSelectSlice(_donutSelectedIdx === i ? -1 : i, total, totalExp);
}

function donutSelectSlice(idx, total, totalExp) {
  _donutSelectedIdx = idx;
  _donutTotal = total;
  _donutTotalExp = totalExp;
  const canvas = document.getElementById('donutCanvas');
  drawDonutFrame(canvas, _donutCategories, idx, total);
  const labelEl = document.getElementById('donut-center-label');
  const valEl = document.getElementById('donut-center-val');
  if (idx < 0) {
    labelEl.textContent = 'Total gastos';
    valEl.textContent = fmt(totalExp);
    valEl.style.color = 'var(--red)';
  } else {
    const c = _donutCategories[idx];
    const pct = Math.round(c.amount/total*100);
    labelEl.textContent = c.label + ' · ' + pct + '%';
    valEl.textContent = fmt(c.amount);
    valEl.style.color = c.color;
  }
  // Highlight legend
  _donutCategories.forEach((_,i)=>{
    const el = document.getElementById('legend-item-'+i);
    if (!el) return;
    el.style.background = i===idx ? 'rgba(0,0,0,0.06)' : '';
    el.style.fontWeight = i===idx ? '700' : '';
  });
}

// ════════════════════════════════════════════
//  GASTOS PAGE
// ════════════════════════════════════════════
function renderGastos(md, key) {
  const ingresos = md.ingresos || [];
  const tarjetas = md.tarjetas || [];
  const totalTarjetas = tarjetas.reduce((s,t)=>s+(t.cargo||0),0);

  // ── Resumen por categoría (basado en ingresos) ──
  const resumenEl = document.getElementById('gastos-resumen');
  if (resumenEl) {
    let grandTotal = 0;
    const rows = [];

    if (ingresos.length === 0) {
      // fallback legacy - only show if there's actual data
      const fijoList = md.expenses.filter(e=>e.type==='fijo');
      const varList = md.expenses.filter(e=>e.type==='variable');
      const valesList = md.expenses.filter(e=>e.type==='vales');
      const totalFijo = fijoList.reduce((s,e)=>s+(e.amount||0),0);
      const totalVar = varList.reduce((s,e)=>s+(e.amount||0),0) + totalTarjetas;
      const totalVales = valesList.reduce((s,e)=>s+(e.amount||0),0);
      grandTotal = totalFijo + totalVar + totalVales;
      if (grandTotal === 0) {
        resumenEl.innerHTML = `<p class="small-muted" style="text-align:center;padding:12px 0">Sin gastos este mes</p>`;
        return;
      }
      const tarjetaItemsFallback = tarjetas.filter(t=>(t.cargo||0)>0).map(t=>({name:t.name,amount:t.cargo,icon:'💳',isTarjeta:true}));
      if (totalFijo > 0) rows.push({label:'💡 Gastos fijos', amount:totalFijo, color:'var(--red)', items:fijoList});
      if (totalVar > 0) rows.push({label:'📈 Variables + tarjetas', amount:totalVar, color:'var(--red)', items:varList, tarjetaItems:tarjetaItemsFallback});
      if (totalVales > 0) rows.push({label:'🟣 Vales despensa', amount:totalVales, color:'var(--red)', items:valesList});
    } else {
      const ROW_COLOR = 'var(--red)';
      ingresos.forEach((ing, i) => {
        const gastos = md.expenses.filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
        const tarjetaItems = tarjetas.filter(t => (t.cargo || 0) > 0 && getTarjetaPagoFuente(t, ingresos) === ing.id)
          .map(t => ({ name: t.name, amount: t.cargo, icon: '💳', isTarjeta: true }));
        const total = gastos.reduce((s,e)=>s+(e.amount||0),0) + tarjetaItems.reduce((s,t)=>s+(t.amount||0),0);
        grandTotal += total;
        rows.push({label:`${ing.name}`, amount:total, color: ROW_COLOR, items:gastos, tarjetaItems});
      });
      // Gastos sin fuente asignada (excluir __AHORRO__ y los de ingresos conocidos)
      const sinFuente = md.expenses.filter(e => e.fuente !== '__AHORRO__' && (!e.fuente || !ingresos.find(i=>i.id===e.fuente)));
      const totalSinFuente = sinFuente.reduce((s,e)=>s+(e.amount||0),0);
      if (sinFuente.length > 0) {
        grandTotal += totalSinFuente;
        rows.push({label:'Sin ingreso asignado', amount:totalSinFuente, color:'var(--muted)', items:sinFuente});
      }
      // Los pagos de tarjeta ya se suman dentro del ingreso elegido.
      // Gastos del ahorro — SIEMPRE AL FINAL, sección propia verde, NO afectan grandTotal
      const gastosAhorro = md.expenses.filter(e => e.fuente === '__AHORRO__');
      const totalAhorro = gastosAhorro.reduce((s,e)=>s+(e.amount||0),0);
      if (gastosAhorro.length > 0) {
        rows.push({label:'🐷 Del Ahorro', amount:totalAhorro, color:'var(--green)', items:gastosAhorro, esAhorro:true});
      }
    }

    const mkBar = (row, grandTotal, rowIdx) => {
      const { label, amount, color, items, tarjetaItems } = row;
      const pct = grandTotal > 0 ? Math.min((amount/grandTotal)*100, 100) : 0;
      const allItems = [...(items||[]), ...(tarjetaItems||[])];
      const itemsHtml = allItems.length > 0
        ? `<div style="margin-top:4px">
            ${allItems.map(it => `
              <div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;margin-bottom:3px;background:rgba(0,0,0,0.025)">
                <span style="font-size:0.95rem;width:22px;text-align:center;flex-shrink:0">${it.icon||'💰'}</span>
                <span style="flex:1;font-size:0.82rem;font-weight:500;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.name}</span>
                ${!it.isTarjeta ? `
                  <button onclick="moveExpense('${it.id}',-1)" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:3px;font-size:0.8rem;flex-shrink:0;line-height:1;opacity:0.5">↑</button>
                  <button onclick="moveExpense('${it.id}',1)" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:3px;font-size:0.8rem;flex-shrink:0;line-height:1;opacity:0.5">↓</button>
                  <button onclick="openEditGasto('${it.id}','${key}')" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:3px;font-size:0.85rem;flex-shrink:0;line-height:1">✏️</button>
                  <button onclick="deleteExpense('${it.id}','${key}')" style="background:none;border:none;color:var(--red);cursor:pointer;padding:3px;font-size:0.75rem;opacity:0.5;flex-shrink:0;line-height:1">✕</button>
                ` : ''}
                ${it.isTarjeta ? `<span style="font-size:0.55rem;background:rgba(0,0,0,0.07);color:var(--muted);padding:2px 6px;border-radius:99px;flex-shrink:0;font-weight:700">tarjeta</span>` : ''}
                <span style="font-size:0.85rem;font-weight:700;color:var(--red);flex-shrink:0;min-width:52px;text-align:right">${fmtNeg(it.amount)}</span>
              </div>`).join('')}
          </div>`
        : '';
      const catId = 'cat-' + label.replace(/[^a-z0-9]/gi,'').toLowerCase() + '-' + rowIdx;
      return `
        <div style="margin-bottom:10px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.07);border-radius:14px;overflow:hidden">
          <div onclick="toggleCatBlock('${catId}')" style="display:flex;align-items:center;padding:12px 12px 12px;cursor:pointer;user-select:none;-webkit-user-select:none">
            <span id="${catId}-arrow" style="display:inline-flex;align-items:center;gap:3px;background:rgba(0,0,0,0.06);border-radius:99px;padding:4px 8px;font-size:0.65rem;font-weight:700;color:var(--muted);transition:background 0.2s,color 0.2s;white-space:nowrap;margin-right:8px;flex-shrink:0">
              <svg id="${catId}-arrow-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;transition:transform 0.25s;transform:rotate(0deg)"><path d="M9 18l6-6-6-6"/></svg>
              <span id="${catId}-arrow-label">Ver</span>
            </span>
            <div style="width:4px;height:16px;background:${color};border-radius:99px;margin-right:8px;flex-shrink:0"></div>
            <span style="font-size:0.85rem;font-weight:700;color:var(--text);flex:1">${label}</span>
            <span style="font-size:0.82rem;font-weight:700;color:var(--red);flex-shrink:0">${fmtNeg(amount)}</span>
          </div>
          <div id="${catId}" style="display:none;padding:0 12px 10px">
            ${itemsHtml || '<div style="font-size:0.75rem;color:var(--muted);padding:4px 0 4px 2px;font-style:italic">Sin gastos</div>'}
          </div>
        </div>`;
    };

    const visibleRows = rows.filter(r => !r.esAhorro);
    const ahorroRows = rows.filter(r => r.esAhorro);

    // Build category totals summary
    const catSummaryHtml = visibleRows.length > 0
      ? `<div style="margin-top:14px;padding-top:12px;border-top:1.5px solid rgba(0,0,0,0.07)">
          <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:10px">💰 Total gastado por categoría</div>
          ${visibleRows.map(r => {
            const pct = grandTotal > 0 ? ((r.amount / grandTotal) * 100).toFixed(1) : '0.0';
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:10px;margin-bottom:4px;background:rgba(0,0,0,0.025)">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
                <div style="width:8px;height:8px;border-radius:50%;background:${r.color};flex-shrink:0"></div>
                <span style="font-size:0.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.label}</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <span style="font-size:0.65rem;color:var(--muted);font-weight:500">${pct}%</span>
                <span style="font-size:0.85rem;font-weight:800;color:var(--red);font-variant-numeric:tabular-nums">${fmtNeg(r.amount)}</span>
              </div>
            </div>`;
          }).join('')}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 10px 2px;border-top:2px solid rgba(0,0,0,0.07);margin-top:4px">
            <span style="font-size:0.82rem;font-weight:700;color:var(--text)">Total gastado</span>
            <span style="font-size:0.95rem;font-weight:800;color:var(--red);font-variant-numeric:tabular-nums">${fmtNeg(grandTotal)}</span>
          </div>
        </div>`
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 2px;border-top:2px solid rgba(0,0,0,0.07);margin-top:2px">
          <span style="font-size:0.82rem;font-weight:700;color:var(--text)">Total gastado</span>
          <span style="font-size:0.95rem;font-weight:800;color:var(--red);font-variant-numeric:tabular-nums">${fmtNeg(grandTotal)}</span>
        </div>`;

    // Guardar qué categorías están abiertas antes de re-renderizar
    const openCats = new Set();
    resumenEl.querySelectorAll('[id^="cat-"]').forEach(el => {
      if (!el.id.endsWith('-arrow') && !el.id.endsWith('-arrow-svg') && !el.id.endsWith('-arrow-label')) {
        if (el.style.display !== 'none') openCats.add(el.id);
      }
    });

    resumenEl.innerHTML = visibleRows.map((r, i) => mkBar(r, grandTotal, i)).join('') + catSummaryHtml;

    // Restaurar categorías que estaban abiertas
    openCats.forEach(id => {
      const body = document.getElementById(id);
      const arrow = document.getElementById(id + '-arrow');
      const svg = document.getElementById(id + '-arrow-svg');
      const label = document.getElementById(id + '-arrow-label');
      if (body) body.style.display = 'block';
      if (svg) svg.style.transform = 'rotate(90deg)';
      if (label) label.textContent = 'Ocultar';
      if (arrow) { arrow.style.background = 'rgba(0,122,255,0.12)'; arrow.style.color = 'var(--blue)'; }
    });
  }

  // ── Listas dinámicas por ingreso ── (redundante con resumen por categoría)
  const listContainer = document.getElementById('gastos-listas-dinamicas');
  if (!listContainer) return;
  listContainer.innerHTML = '';
}

function toggleCatBlock(id) {
  const body = document.getElementById(id);
  const arrow = document.getElementById(id + '-arrow');
  const svg = document.getElementById(id + '-arrow-svg');
  const label = document.getElementById(id + '-arrow-label');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (svg) svg.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
  if (label) label.textContent = isOpen ? 'Ver' : 'Ocultar';
  if (arrow) {
    arrow.style.background = isOpen ? 'rgba(0,0,0,0.06)' : 'rgba(0,122,255,0.12)';
    arrow.style.color = isOpen ? 'var(--muted)' : 'var(--blue)';
  }
}

function expenseRow(e, key, md) {
  if (!md) md = getMonthData(key); // fallback for legacy callers
  const ingresos = md.ingresos || [];
  const ingreso = ingresos.find(i => i.id === e.fuente);
  const fuenteLabel = ingreso ? ingreso.name : (e.fuente && e.fuente.length > 10 ? null : e.fuente);
  return `<div class="expense-item">
    <div class="expense-icon">${e.icon||'💰'}</div>
    <div class="expense-info">
      <div class="expense-name">${e.name}</div>
      ${fuenteLabel ? `<div class="expense-sub">${fuenteLabel}</div>` : ''}
    </div>
    <button class="reorder-btn" onclick="moveExpense('${e.id}',-1)">↑</button>
    <button class="reorder-btn" onclick="moveExpense('${e.id}',1)">↓</button>
    <button class="expense-edit" onclick="openEditGasto('${e.id}','${key}')">✏️</button>
    <button class="expense-del" onclick="deleteExpense('${e.id}','${key}')">✕</button>
    <div class="expense-amount">${fmtNeg(e.amount)}</div>
  </div>`;
}

// onEditTypeChange removed — no logic needed per type

function openAddGasto() {
  document.getElementById('edit-gasto-id').value = '';
  document.getElementById('edit-name').value = '';
  document.getElementById('edit-amount').value = '';
  document.getElementById('edit-type').value = 'fijo';
  document.getElementById('edit-icon').value = '';
  document.getElementById('modal-gasto-title').textContent = '➕ Nuevo gasto';
  document.getElementById('modal-gasto-btn').textContent = 'Agregar';
  // Populate fuente selector
  populateFuenteSelector(null);
  document.getElementById('modal-edit-gasto').classList.add('show');
}

function populateFuenteSelector(currentFuente) {
  const md = getMonthData(currentKey());
  const ingresos = md.ingresos || [];
  const sel = document.getElementById('edit-fuente');
  if (ingresos.length === 0) {
    sel.innerHTML = `<option value="">— Agrega ingresos primero —</option>`;
  } else {
    sel.innerHTML = ingresos.map(ing =>
      `<option value="${ing.id}" ${currentFuente===ing.id?'selected':''}>${ing.name}</option>`
    ).join('');
    if (!currentFuente || !ingresos.find(i => i.id === currentFuente)) {
      sel.value = ingresos[0].id;
    }
  }
}

function openEditGasto(id, key) {
  const md = getMonthData(key);
  const e = md.expenses.find(x => x.id === id);
  if (!e) return;
  document.getElementById('edit-gasto-id').value = id;
  document.getElementById('edit-name').value = e.name;
  document.getElementById('edit-amount').value = e.amount;
  document.getElementById('edit-type').value = e.type;
  document.getElementById('edit-icon').value = e.icon||'';
  document.getElementById('modal-gasto-title').textContent = '✏️ Editar gasto';
  document.getElementById('modal-gasto-btn').textContent = 'Guardar';
  populateFuenteSelector(e.fuente||null);
  document.getElementById('modal-edit-gasto').classList.add('show');
}

function saveEditGasto() {
  const id = document.getElementById('edit-gasto-id').value;
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  const name = document.getElementById('edit-name').value.trim();
  const amount = parseFloat(document.getElementById('edit-amount').value);
  const icon = document.getElementById('edit-icon').value.trim() || '💰';
  const fuente = document.getElementById('edit-fuente').value || '';
  const ingresos = raw.ingresos || [];
  const ingreso = ingresos.find(i => i.id === fuente);
  const type = ingreso
    ? (ingreso.name.toLowerCase().includes('vale') ? 'vales' : 'fijo')
    : 'fijo';

  if (!id) {
    if (!name || isNaN(amount) || amount <= 0) return alert('Llena nombre y monto');
    if (!raw.expenses) raw.expenses = [];
    raw.expenses.push({ id: uid(), name, icon, amount, type, fuente });
  } else {
    const e = (raw.expenses || []).find(x => x.id === id);
    if (!e) return;
    e.name = name || e.name;
    e.amount = isNaN(amount) ? e.amount : amount;
    e.type = type;
    e.icon = icon || e.icon;
    e.fuente = fuente;
  }
  saveState();
  closeModal('modal-edit-gasto');
  const openCatsEdit = [...document.querySelectorAll('[id^="cat-"]')]
    .filter(el => el.style.display === 'block')
    .map(el => el.id);
  renderAll();
  openCatsEdit.forEach(id => {
    const el = document.getElementById(id);
    const arrow = document.getElementById(id + '-arrow');
    if (el) el.style.display = 'block';
    if (arrow) { arrow.style.transform = 'rotate(180deg)'; }
  });
  showUpdatedBadge();
}

function deleteExpense(id, key) {
  if (!confirm('¿Eliminar este gasto?')) return;
  ensureMonth(key);
  const raw = state.months[key];
  raw.expenses = (raw.expenses || []).filter(e => e.id !== id);
  saveState();
  const openCats = [...document.querySelectorAll('[id^="cat-"]')]
    .filter(el => el.style.display === 'block')
    .map(el => el.id);
  renderAll();
  openCats.forEach(id => {
    const el = document.getElementById(id);
    const arrow = document.getElementById(id + '-arrow');
    if (el) el.style.display = 'block';
    if (arrow) { arrow.style.transform = 'rotate(180deg)'; }
  });
  showUpdatedBadge();
}

function moveExpense(id, dir) {
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  const idx = (raw.expenses || []).findIndex(e => e.id === id);
  if (idx < 0) return;
  const ni = idx + dir;
  if (ni < 0 || ni >= raw.expenses.length) return;
  [raw.expenses[idx], raw.expenses[ni]] = [raw.expenses[ni], raw.expenses[idx]];
  saveState(); renderAll(); showUpdatedBadge();
}

// ════════════════════════════════════════════
//  DEUDA PAGE
// ════════════════════════════════════════════
function renderDeuda(md) {
  const tarjetas = md.tarjetas || [];
  // Deuda total = restante real despues de pagos.
  const totalDeuda = tarjetas.reduce((s,t)=>{
    const base = t.saldoBase !== undefined ? t.saldoBase : (t.saldo||0);
    const items = (t.cargoItems||[]).reduce((a,ci)=>a+(ci.amount||0),0);
    return s + Math.max(0, base + items - (t.cargo || 0));
  },0);
  const totalCargo = tarjetas.reduce((s,t)=>s+(t.cargo||0),0);

  document.getElementById('deuda-total-kpi').textContent = fmt(totalDeuda);
  document.getElementById('deuda-meses-kpi').textContent = `Abono total este mes: ${fmt(totalCargo)}`;

  const tbl = document.getElementById('tarjetas-table');

  if (tarjetas.length === 0) {
    tbl.innerHTML = `<p class="small-muted" style="text-align:center;padding:16px">Toca "+ Agregar" para añadir una tarjeta</p>`;
  } else {
    tbl.innerHTML = tarjetas.map(t => {
      const items = t.cargoItems || [];
      const itemsTotal = items.reduce((s,ci)=>s+(ci.amount||0),0);
      const hasItems = items.length > 0;
      // saldoBase = deuda anterior (sin gastos del mes)
      const saldoBase = t.saldoBase !== undefined ? t.saldoBase : (t.saldo || 0);
      // deuda bruta = anterior + gastos mes
      const deudaBruta = saldoBase + itemsTotal;
      // lo que ya pagó
      const abonoMes = t.cargo || 0;
      // restante = deuda bruta - pagado
      const saldoRestante = Math.max(0, deudaBruta - abonoMes);
      const hayDeuda = deudaBruta > 0;
      const pagadoCompleto = hayDeuda && saldoRestante === 0;
      const cardOpen = _openTarjetaCards.has(t.id);

      return `
      <div class="card-row" id="card-${t.id}" style="padding:0;overflow:hidden">
        <div onclick="toggleTarjetaCard('${t.id}')" style="display:flex;align-items:center;gap:8px;padding:12px 12px;cursor:pointer;user-select:none">
          <span id="tarjeta-arrow-${t.id}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(37,99,235,0.1);border-radius:9px;padding:4px 8px;font-size:0.65rem;font-weight:800;color:var(--blue);white-space:nowrap;flex-shrink:0">
            <svg id="tarjeta-arrow-svg-${t.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;transition:transform 0.2s;transform:${cardOpen?'rotate(90deg)':'rotate(0deg)'}"><path d="M9 18l6-6-6-6"/></svg>
            <span id="tarjeta-arrow-label-${t.id}">${cardOpen?'Ocultar':'Ver'}</span>
          </span>
          <div style="width:4px;height:16px;background:var(--red);border-radius:99px;flex-shrink:0"></div>
          <input class="card-row-name" value="${t.name}" placeholder="Nombre deuda"
            onclick="event.stopPropagation()"
            onchange="updateTarjeta('${t.id}','name',this.value)"
            style="font-size:0.9rem;font-weight:900;letter-spacing:-0.01em;flex:1;min-width:0;margin:0"/>
          <span style="font-size:0.86rem;font-weight:900;color:${saldoRestante>0?'var(--red)':'var(--green)'};flex-shrink:0">${fmt(saldoRestante)}</span>
          <button class="del-card-btn" onclick="event.stopPropagation();removeTarjeta('${t.id}')" style="flex-shrink:0">x</button>
        </div>

        <div id="tarjeta-body-${t.id}" style="display:${cardOpen?'block':'none'};padding:0 14px 12px">
          <div style="border-top:1px solid var(--border);padding-top:6px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
              <span style="font-size:0.78rem;font-weight:800;color:var(--text2)">Lista de gastos</span>
              <button onclick="openCargoItems('${t.id}')"
                style="background:var(--s2);border:1px solid var(--border);color:var(--text2);border-radius:8px;padding:4px 8px;font-size:0.66rem;font-weight:900;cursor:pointer;font-family:inherit">
                + Gasto
              </button>
            </div>
            ${!hasItems ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
              <span style="font-size:0.76rem;color:var(--muted);font-style:italic">Sin gastos</span>
              <span style="font-size:0.78rem;font-weight:800;color:var(--muted)">$0</span>
            </div>` : items.map(ci=>`
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0 6px 10px;border-bottom:1px solid rgba(0,0,0,0.04)">
                <span style="font-size:0.76rem;font-weight:650;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:7px">
                  <span style="width:5px;height:5px;background:var(--red);border-radius:99px;flex-shrink:0;opacity:0.75"></span>${ci.name||'Sin nombre'}
                </span>
                <span style="font-size:0.78rem;font-weight:900;color:var(--red);flex-shrink:0">${fmtNeg(ci.amount||0)}</span>
              </div>`).join('')}
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 7px;border-bottom:1px solid rgba(0,0,0,0.05)">
              <span style="font-size:0.78rem;font-weight:800;color:var(--text2)">Total gastado</span>
              <span style="font-size:0.8rem;font-weight:900;color:${itemsTotal>0?'var(--red)':'var(--muted)'}">${itemsTotal > 0 ? fmtNeg(itemsTotal) : '$0'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
              <span style="font-size:0.78rem;font-weight:800;color:var(--text2)">Saldo anterior</span>
              <input type="text" inputmode="decimal"
                style="background:transparent;border:none;outline:none;font-size:0.8rem;font-weight:900;color:var(--red);width:105px;text-align:right;font-family:inherit;padding:0"
                value="$${fmtNum(saldoBase)}" placeholder="$0"
                onfocus="focusTarjetaInput(this)"
                onblur="blurTarjetaInput(this,'${t.id}','saldo');recalcSaldoRestante('${t.id}')"
                oninput="autoSizeTarjetaInput(this)"
                data-raw="${saldoBase}"/>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
              <span style="font-size:0.78rem;font-weight:800;color:var(--text2)">Saldo nuevo</span>
              <span style="font-size:0.8rem;font-weight:900;color:${deudaBruta>0?'var(--red)':'var(--muted)'}">${deudaBruta > 0 ? fmt(deudaBruta) : '$0'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
              <div style="display:flex;align-items:center;gap:8px;min-width:0">
                <span style="font-size:0.78rem;font-weight:800;color:var(--text2)">Pagado</span>
                <button onclick="openPagarTarjeta('${t.id}')"
                  style="background:rgba(26,122,58,0.09);border:1px solid rgba(26,122,58,0.18);color:var(--green);border-radius:8px;padding:3px 8px;font-size:0.64rem;font-weight:900;cursor:pointer;font-family:inherit">
                  Pagar
                </button>
              </div>
              <span style="font-size:0.8rem;font-weight:900;color:${abonoMes>0?'var(--green)':'var(--muted)'};flex-shrink:0;text-align:right;min-width:72px">${abonoMes > 0 ? fmt(abonoMes) : '$0'}</span>
            </div>
            <div id="resta-wrap-${t.id}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 2px">
              <span style="font-size:0.8rem;font-weight:900;color:${pagadoCompleto?'var(--green)':'var(--text)'}">Restante</span>
              <span id="resta-${t.id}" style="font-size:0.86rem;font-weight:900;color:${pagadoCompleto?'var(--green)':saldoRestante>0?'var(--red)':'var(--muted)'}">${!hayDeuda?'$0':fmt(saldoRestante)}</span>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

  }

}

function toggleTarjetaCard(id) {
  const body = document.getElementById('tarjeta-body-' + id);
  const svg = document.getElementById('tarjeta-arrow-svg-' + id);
  const label = document.getElementById('tarjeta-arrow-label-' + id);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  if (isOpen) {
    _openTarjetaCards.delete(id);
  } else {
    _openTarjetaCards.add(id);
  }
  body.style.display = isOpen ? 'none' : 'block';
  if (svg) svg.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
  if (label) label.textContent = isOpen ? 'Ver' : 'Ocultar';
}

// Live recalc saldo restante while typing (no save)
function liveRecalcSaldoRestante(tarjetaId, inputVal) {
  const md = getMonthData(currentKey());
  const t = md.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  const saldoBase = t.saldoBase !== undefined ? t.saldoBase : (t.saldo || 0);
  const itemsTotal = (t.cargoItems || []).reduce((s,ci)=>s+(ci.amount||0),0);
  const deudaBruta = saldoBase + itemsTotal;
  const pago = parseFloat(inputVal) || 0;
  const resta = Math.max(0, deudaBruta - pago);
  const hayDeuda = deudaBruta > 0;
  const el = document.getElementById('resta-' + tarjetaId);
  if (!el) return;
  el.textContent = !hayDeuda ? '$0' : fmt(resta);
  el.style.color = resta === 0 && hayDeuda ? 'var(--green)' : resta > 0 ? 'var(--red)' : 'var(--muted)';
}

// After save, full recalc
function recalcSaldoRestante(tarjetaId) {
  const md = getMonthData(currentKey());
  const t = md.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  const saldoBase = t.saldoBase !== undefined ? t.saldoBase : (t.saldo || 0);
  const itemsTotal = (t.cargoItems || []).reduce((s,ci)=>s+(ci.amount||0),0);
  const deudaBruta = saldoBase + itemsTotal;
  const pago = t.cargo || 0;
  const resta = Math.max(0, deudaBruta - pago);
  const hayDeuda = deudaBruta > 0;
  const pagadoCompleto = hayDeuda && resta === 0;
  const el = document.getElementById('resta-' + tarjetaId);
  if (!el) return;
  el.textContent = !hayDeuda ? '$0' : fmt(resta);
  el.style.color = pagadoCompleto ? 'var(--green)' : resta > 0 ? 'var(--red)' : 'var(--muted)';
  const wrap = document.getElementById('resta-wrap-' + tarjetaId);
  if (wrap) {
    wrap.querySelector('span').style.color = pagadoCompleto ? 'var(--green)' : 'var(--red)';
    wrap.querySelector('span').textContent = 'Restante';
  }
}

// ── Day Picker Modal ──
let _dayPickerTarjetaId = null;
function openDayPicker(tarjetaId) {
  _dayPickerTarjetaId = tarjetaId;
  const md = getMonthData(currentKey());
  const t = md.tarjetas.find(x => x.id === tarjetaId);
  const selected = t ? parseInt(t.fechaCorte) : null;
  const todayDay = new Date().getDate();
  const grid = document.getElementById('day-picker-grid');
  let html = '';
  for (let d = 1; d <= 31; d++) {
    const isSel = d === selected;
    const isToday = d === todayDay;
    html += `<button class="day-btn${isSel?' selected':''}${isToday&&!isSel?' today-day':''}" onclick="selectCorteDay(${d})">${d}</button>`;
  }
  grid.innerHTML = html;
  document.getElementById('day-picker-overlay').classList.add('show');
}
function selectCorteDay(day) {
  if (!_dayPickerTarjetaId) return;
  updateTarjeta(_dayPickerTarjetaId, 'fechaCorte', String(day));
  closeDayPickerDirect();
}
function closeDayPicker(e) {
  if (e.target === document.getElementById('day-picker-overlay')) closeDayPickerDirect();
}
function closeDayPickerDirect() {
  document.getElementById('day-picker-overlay').classList.remove('show');
  _dayPickerTarjetaId = null;
}

// ── Cargo Items Modal ──
// Helper: get the raw stored tarjeta object (writable), never the computed view
function getRawStoredTarjeta(key, id) {
  if (!state.months[key]) return null;
  return (state.months[key].tarjetas || []).find(t => t.id === id) || null;
}

function ensureRawStoredTarjeta(key, id) {
  getMonthData(key);
  if (!state.months[key].tarjetas) state.months[key].tarjetas = [];
  let raw = getRawStoredTarjeta(key, id);
  if (raw) return raw;
  const view = getMonthData(key).tarjetas.find(t => t.id === id);
  if (!view) return null;
  raw = {
    id: view.id,
    name: view.name,
    cargo: view.cargo || 0,
    cargoItems: view.cargoItems || [],
    fechaCorte: view.fechaCorte || '',
    fuentePago: view.fuentePago || ''
  };
  state.months[key].tarjetas.push(raw);
  return raw;
}

function openCargoItems(tarjetaId) {
  _cargoModalTarjetaId = tarjetaId;
  const key = currentKey();
  // Use computed view for saldoBase (it has the correctly derived base from prev month)
  const md = getMonthData(key);
  const tView = md.tarjetas.find(x => x.id === tarjetaId);
  if (!tView) return;
  document.getElementById('modal-cargo-title').textContent = `💳 ${tView.name} — En qué gasté`;
  const base = tView.saldoBase !== undefined ? tView.saldoBase : (tView.saldo || 0);
  document.getElementById('modal-saldo-base-val').textContent = fmt(base);
  // Use raw stored record for the editable cargoItems list
  const tRaw = ensureRawStoredTarjeta(key, tarjetaId);
  renderCargoItemsList(tRaw ? (tRaw.cargoItems || []) : []);
  document.getElementById('modal-cargo-items').classList.add('show');
}

function openPagarTarjeta(tarjetaId) {
  _pagoModalTarjetaId = tarjetaId;
  const key = currentKey();
  const md = getMonthData(key);
  const tView = md.tarjetas.find(x => x.id === tarjetaId);
  if (!tView) return;
  const tRaw = ensureRawStoredTarjeta(key, tarjetaId);
  const ingresos = md.ingresos || [];
  document.getElementById('modal-pago-title').textContent = `Pagar ${tView.name}`;
  document.getElementById('pago-tarjeta-monto').value = tRaw && tRaw.cargo ? tRaw.cargo : '';
  const sel = document.getElementById('pago-tarjeta-fuente');
  sel.innerHTML = ingresos.length
    ? ingresos.map(i => `<option value="${i.id}">${i.name} - ${fmt(i.amount || 0)}</option>`).join('')
    : `<option value="">Sin ingresos</option>`;
  sel.value = (tRaw && tRaw.fuentePago) || getDefaultPagoFuente(ingresos);
  document.getElementById('modal-pagar-tarjeta').classList.add('show');
}

function guardarPagoTarjeta() {
  const key = currentKey();
  const tRaw = ensureRawStoredTarjeta(key, _pagoModalTarjetaId);
  if (!tRaw) return;
  const monto = parseFloat(document.getElementById('pago-tarjeta-monto').value) || 0;
  const fuente = document.getElementById('pago-tarjeta-fuente').value || '';
  tRaw.cargo = Math.max(0, monto);
  tRaw.fuentePago = fuente;
  delete tRaw.saldo;
  delete tRaw.saldoBase;
  saveState();
  closeModal('modal-pagar-tarjeta');
  renderAll();
  showUpdatedBadge();
}

function renderCargoItemsList(items) {
  const list = document.getElementById('cargo-items-list');
  list.innerHTML = items.map((ci,i) => `
    <div class="cargo-item-row">
      <input class="inp-sm" type="text" placeholder="Concepto (ej. Uber Eats)" value="${ci.name||''}"
        oninput="updateCargoItem(${i},'name',this.value)"/>
      <input class="inp-sm" type="number" inputmode="decimal" placeholder="$" value="${ci.amount||''}" style="max-width:80px"
        oninput="updateCargoItem(${i},'amount',parseFloat(this.value)||0)"/>
      <button class="cargo-item-del" onclick="deleteCargoItem(${i})">✕</button>
    </div>`).join('');
  updateCargoTotal();
}

function updateCargoItem(i, field, value) {
  const key = currentKey();
  const t = getRawStoredTarjeta(key, _cargoModalTarjetaId);
  if (!t) return;
  if (!t.cargoItems) t.cargoItems = [];
  if (!t.cargoItems[i]) t.cargoItems[i] = {};
  t.cargoItems[i][field] = value;
  updateCargoTotal();
  saveState();
}

function deleteCargoItem(i) {
  const key = currentKey();
  const t = getRawStoredTarjeta(key, _cargoModalTarjetaId);
  if (!t || !t.cargoItems) return;
  t.cargoItems.splice(i, 1);
  renderCargoItemsList(t.cargoItems);
  updateCargoTotal();
  saveState();
}

function addCargoItem() {
  const key = currentKey();
  const t = getRawStoredTarjeta(key, _cargoModalTarjetaId);
  if (!t) return;
  if (!t.cargoItems) t.cargoItems = [];
  t.cargoItems.push({ name: '', amount: 0 });
  renderCargoItemsList(t.cargoItems);
  saveState();
}

function updateCargoTotal() {
  const key = currentKey();
  // Use computed view for reading the current saldoBase (display purposes)
  const md = getMonthData(key);
  const tView = md.tarjetas.find(x => x.id === _cargoModalTarjetaId);
  // Write cargoItems sum back to the raw stored record only
  const tRaw = getRawStoredTarjeta(key, _cargoModalTarjetaId);
  const items = tRaw ? (tRaw.cargoItems || []) : [];
  const itemsSum = items.reduce((s, ci) => s + (ci.amount || 0), 0);
  const base = tView ? (tView.saldoBase !== undefined ? tView.saldoBase : (tView.saldo || 0)) : 0;
  const total = base + itemsSum;
  const el = document.getElementById('cargo-items-total-val');
  if (el) el.textContent = fmt(total);
  // Do NOT write computed saldo back into stored tarjeta — saldo is always re-derived on load
  saveState();
}

function saveCargoItems() {
  // cargoItems are already persisted incrementally by updateCargoItem/addCargoItem/deleteCargoItem.
  // We only need to ensure the raw stored record is clean (no leaked computed saldo).
  const key = currentKey();
  const tRaw = getRawStoredTarjeta(key, _cargoModalTarjetaId);
  if (tRaw) {
    // Remove any accidentally leaked computed fields from stored record
    delete tRaw.saldoBase;
    delete tRaw.saldo; // saldo is always re-derived; only saldoOverride may be stored if user set it
  }
  saveState();
  closeModal('modal-cargo-items');
  renderAll();
  showUpdatedBadge();
}

// ── Tarjeta helpers ──
function autoSizeTarjetaInput(el) {
  const len = (el.value || '').replace(/[,.$]/g,'').length || 1;
  if (len <= 5)       el.style.fontSize = '1rem';
  else if (len <= 7)  el.style.fontSize = '0.82rem';
  else if (len <= 9)  el.style.fontSize = '0.68rem';
  else                el.style.fontSize = '0.56rem';
}

function focusTarjetaInput(el) {
  const raw = el.dataset.raw || '0';
  el.value = raw === '0' ? '' : raw;
  el.type = 'number';
  autoSizeTarjetaInput(el);
}
function blurTarjetaInput(el, id, field) {
  el.type = 'text';
  const val = parseFloat(el.value) || 0;
  el.dataset.raw = val;
  el.value = '$' + fmtNum(val);
  autoSizeTarjetaInput(el);
  if (field === 'saldo') {
    // User is manually overriding the saldo for this month — persist as saldoOverride only
    const key = currentKey();
    const tRaw = getRawStoredTarjeta(key, id);
    if (tRaw) {
      tRaw.saldoOverride = val;
      // Remove computed fields that may have leaked into storage before this fix
      delete tRaw.saldo;
      delete tRaw.saldoBase;
      saveState();
      renderAll();
    }
  } else {
    updateTarjeta(id, field, val);
  }
}
function updateTarjeta(id, field, value) {
  const key = currentKey();
  // Write directly to the raw stored tarjetas, never to the computed view from getMonthData
  if (!state.months[key]) return;
  const t = ensureRawStoredTarjeta(key, id);
  if (!t) return;
  t[field] = value;
  saveState();
  renderAll();
}
function addTarjeta() {
  const key = currentKey();
  // Ensure month exists
  getMonthData(key);
  if (!state.months[key].tarjetas) state.months[key].tarjetas = [];
  state.months[key].tarjetas.push({ id: uid(), name: 'Nueva tarjeta', saldoOverride: 0, cargo: 0, fechaCorte: '', fuentePago: '', cargoItems: [] });
  saveState();
  renderAll();
}
function removeTarjeta(id) {
  if (!confirm('¿Eliminar esta deuda?')) return;
  const key = currentKey();
  if (!state.months[key]) return;
  const md = state.months[key];
  // Always allow deletion — store as explicit removal for this month
  if (!md._removedTarjetas) md._removedTarjetas = [];
  if (!md._removedTarjetas.includes(id)) md._removedTarjetas.push(id);
  md.tarjetas = (md.tarjetas || []).filter(t => t.id !== id);
  _openTarjetaCards.delete(id);
  saveState();
  renderAll();
}

// ════════════════════════════════════════════
//  CERRAR MES (auto — sin UI, solo sincroniza ahorroReal desde depósitos)
// ════════════════════════════════════════════
function syncAhorroRealDesdeDepositos(key) {
  const md = getMonthData(key);
  if (md.depositos && md.depositos.length > 0) {
    md.ahorroReal = md.depositos.reduce((s, d) => s + (d.amount || 0), 0);
  }
}
function renderCerrarMes(md) {
  // Sección eliminada — el ahorro se maneja en el apartado de Ahorro.
  // Sincronizar ahorroReal desde depósitos automáticamente.
  syncAhorroRealDesdeDepositos(currentKey());
}

// ════════════════════════════════════════════
//  HISTORIAL
// ════════════════════════════════════════════
function openHistorialModal() {
  const keys = Object.keys(state.months).sort().reverse();
  const el = document.getElementById('modal-historial-content');
  if (!el) return;

  if (keys.length === 0) {
    el.innerHTML = `<p class="small-muted" style="text-align:center;padding:16px 0">Sin meses registrados todavía</p>`;
    document.getElementById('modal-historial').classList.add('show');
    return;
  }

  el.innerHTML = keys.map(k => {
    const [y, m] = k.split('-').map(Number);
    const md = state.months[k];
    const totalIngresos = (md.ingresos||[]).reduce((s,i) => {
      const subs = i.subItems||[];
      return s + (subs.length > 0 ? subs.reduce((a,si)=>a+(si.amount||0),0) : (i.amount||0));
    }, 0) || (md.nomina||0);
    const tarjetasK = md.tarjetas || [];
    const totalCortes = tarjetasK.reduce((s,t)=>s+(t.cargo||0),0);
    const totalGastos = (md.expenses||[]).filter(e=>e.type!=='vales'&&e.fuente!=='__AHORRO__').reduce((s,e)=>s+(e.amount||0),0) + totalCortes;
    const ahorro = getTotalAhorradoMes(k);
    const libre = totalIngresos - totalGastos - ahorro;
    const tieneAhorro = ahorro > 0;

    return `
      <div style="padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:0.9rem;font-weight:800;letter-spacing:-0.01em">${MONTHS_ES[m-1]} ${y} ${tieneAhorro?'🐷':''}</div>
          <div style="font-size:0.88rem;font-weight:800;color:${libre>=0?'var(--green)':'var(--red)'}">${libre>=0?fmtPos(libre):fmtNeg(Math.abs(libre))}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr ${tieneAhorro?'1fr':'0fr'};gap:6px">
          <div style="background:rgba(26,122,58,0.07);border-radius:10px;padding:8px 10px">
            <div style="font-size:0.55rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--green);margin-bottom:3px">Ingresos</div>
            <div style="font-size:0.82rem;font-weight:700;color:var(--green);font-variant-numeric:tabular-nums">${fmt(totalIngresos)}</div>
          </div>
          <div style="background:rgba(255,59,48,0.06);border-radius:10px;padding:8px 10px">
            <div style="font-size:0.55rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--red);margin-bottom:3px">Gastos</div>
            <div style="font-size:0.82rem;font-weight:700;color:var(--red);font-variant-numeric:tabular-nums">${fmt(totalGastos)}</div>
          </div>
          ${tieneAhorro ? `
          <div style="background:rgba(26,122,58,0.08);border-radius:10px;padding:8px 10px">
            <div style="font-size:0.55rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--green);margin-bottom:3px">🐷 Ahorro</div>
            <div style="font-size:0.82rem;font-weight:700;color:var(--green);font-variant-numeric:tabular-nums">${fmt(ahorro)}</div>
          </div>` : ''}
        </div>
      </div>`;
  }).join('') + `
    <div style="padding-top:12px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:0.7rem;color:var(--muted);font-weight:600">${keys.length} ${keys.length===1?'mes':'meses'} registrados</span>
    </div>`;

  document.getElementById('modal-historial').classList.add('show');
}

function renderHistorial() {
  const keys = Object.keys(state.months).sort().reverse();
  const sel = document.getElementById('historial-select');
  sel.innerHTML = `<option value="">— Selecciona un mes —</option>` +
    keys.map(k => {
      const [y,m] = k.split('-').map(Number);
      const tieneAhorro = getTotalAhorradoMes(k) > 0;
      return `<option value="${k}">${MONTHS_ES[m-1]} ${y}${tieneAhorro?' ✅':''}</option>`;
    }).join('');
  // Never auto-select — historial only shown in modal now
}

// ════════════════════════════════════════════
//  EXPORTAR / IMPORTAR

function renderHistorialDetail() {
  const sel = document.getElementById('historial-select');
  const detail = document.getElementById('historial-detail');
  const key = sel ? sel.value : '';
  if (!key) { detail.style.display = 'none'; return; }
  const md = state.months[key];
  if (!md) { detail.style.display = 'none'; return; }
  const tarjetas = md.tarjetas || [];
  const tieneAhorro = getTotalAhorradoMes(key) > 0;
  const ahorroReal = getTotalAhorradoMes(key);
  const snap = md.deudaSnapshot || tarjetas.map(t => ({ id:t.id, name:t.name, saldo:t.saldo||0, abono:t.cargo||0 }));
  const totalSaldo = snap.reduce((s,t)=>s+t.saldo,0);
  const totalAbono = snap.reduce((s,t)=>s+t.abono,0);
  const ingresos = md.ingresos || [];
  const totalIngresos = ingresos.reduce((s,i)=>s+(i.amount||0),0) || (md.nomina||0);
  const hdTarjetas = md.tarjetas || [];
  const hdTotalCortes = hdTarjetas.reduce((s,t)=>s+(t.cargo||0),0);
  const hdTotalGastos = md.expenses.filter(e=>e.type!=='vales'&&e.fuente!=='__AHORRO__').reduce((s,e)=>s+(e.amount||0),0) + hdTotalCortes;
  const hdLibre = totalIngresos - hdTotalGastos;

  // ── Ahorro acumulado hasta este mes ──
  const depositos = md.depositos || [];
  const gastosDelAhorro = (md.expenses || []).filter(e => e.fuente === '__AHORRO__');
  // Acumulado hasta este mes (inclusive)
  const allKeysSorted = Object.keys(state.months).sort().filter(k => k <= key);
  const ahorroAcumulado = allKeysSorted.reduce((s, k) => s + getTotalAhorradoMes(k), 0);
  const gastadoAcumulado = allKeysSorted.reduce((s, k) => {
    const m2 = state.months[k];
    return s + (m2 ? (m2.expenses||[]).filter(e=>e.fuente==='__AHORRO__').reduce((a,e)=>a+(e.amount||0),0) : 0);
  }, 0);
  const netoAhorro = ahorroAcumulado - gastadoAcumulado;
  // Solo este mes para el detalle de depósitos/salidas
  const totalGastadoAhorro = gastosDelAhorro.reduce((s, e) => s + (e.amount || 0), 0);

  const depositosHtml = depositos.length > 0
    ? depositos.map(d => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(26,122,58,0.1)">
          <span style="font-size:0.85rem;flex-shrink:0">🐷</span>
          <span style="flex:1;font-size:0.82rem;font-weight:500">${d.nota || 'Depósito'}</span>
          ${d.fecha ? `<span style="font-size:0.65rem;color:var(--muted)">${d.fecha}</span>` : ''}
          <span style="font-size:0.82rem;font-weight:700;color:var(--green);flex-shrink:0">+${fmt(d.amount)}</span>
        </div>`).join('')
    : (md.ahorroReal ? `<div style="padding:6px 0;font-size:0.82rem;color:var(--muted)">Registrado al cerrar mes</div>` : '');

  const gastosAhorroHtml = gastosDelAhorro.length > 0
    ? gastosDelAhorro.map(e => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
          <span style="font-size:0.9rem;width:20px;text-align:center;flex-shrink:0">${e.icon||'💸'}</span>
          <span style="flex:1;font-size:0.82rem;font-weight:500">${e.name}</span>
          <span style="font-size:0.82rem;font-weight:700;color:var(--red);flex-shrink:0">-${fmt(e.amount)}</span>
        </div>`).join('')
    : '';

  const ahorroSection = tieneAhorro || gastosDelAhorro.length > 0 ? `
    <div style="background:rgba(26,122,58,0.05);border:1px solid rgba(26,122,58,0.2);border-radius:14px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--green)">🐷 Ahorro acumulado</div>
        <div style="font-size:0.6rem;color:var(--muted)">hasta este mes</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;margin-bottom:${depositosHtml||gastosAhorroHtml?'12px':'0'}">
        <div style="background:rgba(26,122,58,0.08);border-radius:10px;padding:8px 4px">
          <div style="font-size:0.92rem;font-weight:800;color:var(--green)">${fmtPos(ahorroAcumulado)}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Guardado</div>
        </div>
        <div style="background:rgba(255,59,48,0.06);border-radius:10px;padding:8px 4px">
          <div style="font-size:0.92rem;font-weight:800;color:var(--red)">${fmtNeg(gastadoAcumulado)}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Gastado</div>
        </div>
        <div style="background:rgba(0,0,0,0.04);border-radius:10px;padding:8px 4px">
          <div style="font-size:0.92rem;font-weight:800;color:${netoAhorro>=0?'var(--green)':'var(--red)'}">${netoAhorro>=0?fmtPos(netoAhorro):fmtNeg(Math.abs(netoAhorro))}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Saldo</div>
        </div>
      </div>
      ${depositosHtml ? `<div style="border-top:1px solid rgba(26,122,58,0.15);padding-top:8px;margin-bottom:${gastosAhorroHtml?'10px':'0'}">${depositosHtml}</div>` : ''}
      ${gastosAhorroHtml ? `
        <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:8px;margin-top:${depositosHtml?'0':'0'}">
          <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:4px">Salidas del ahorro</div>
          ${gastosAhorroHtml}
        </div>` : ''}
    </div>` : '';

  const deudaRows = snap.map(t => `
    <div style="padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <div style="font-size:0.82rem;font-weight:700;margin-bottom:6px">💳 ${t.name}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center">
        <div style="background:rgba(255,59,48,0.06);border-radius:10px;padding:7px 4px">
          <div style="font-size:0.85rem;font-weight:800;color:var(--red)">${fmt(t.saldo)}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Saldo</div>
        </div>
        <div style="background:rgba(255,159,10,0.06);border-radius:10px;padding:7px 4px">
          <div style="font-size:0.85rem;font-weight:800;color:var(--green)">${fmt(t.abono)}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Abonado</div>
        </div>
        <div style="background:rgba(0,122,255,0.06);border-radius:10px;padding:7px 4px">
          <div style="font-size:0.85rem;font-weight:800;color:var(--red)">${fmt(Math.max(0,t.saldo-t.abono))}</div>
          <div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Resta</div>
        </div>
      </div>
    </div>`).join('');

  detail.innerHTML = `
    <div style="text-align:center;margin-bottom:14px">
      <span style="font-size:0.72rem;font-weight:700;padding:4px 12px;border-radius:99px;background:${tieneAhorro?'rgba(26,122,58,0.12)':'rgba(0,0,0,0.06)'};color:${tieneAhorro?'var(--green)':'var(--muted)'}">${tieneAhorro?'🐷 Con ahorro':'📋 Sin ahorro registrado'}</span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      <div style="background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:12px 8px;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.04)">
        <div style="font-size:0.95rem;font-weight:800;color:var(--green)">${fmtPos(totalIngresos)}</div>
        <div style="font-size:0.58rem;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:0.05em">Ingresos</div>
      </div>
      <div style="background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:12px 8px;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.04)">
        <div style="font-size:0.95rem;font-weight:800;color:var(--red)">${fmtNeg(hdTotalGastos)}</div>
        <div style="font-size:0.58rem;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:0.05em">Gastos</div>
      </div>
      <div style="background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:12px 8px;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.04)">
        <div style="font-size:0.95rem;font-weight:800;color:${hdLibre>=0?'var(--green)':'var(--red)'}">${hdLibre>=0?fmtPos(hdLibre):fmtNeg(Math.abs(hdLibre))}</div>
        <div style="font-size:0.58rem;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:0.05em">Libre</div>
      </div>
    </div>

    ${ahorroSection}

    ${snap.length > 0 ? `
    <div onclick="toggleDeudaDesglose()" style="background:rgba(255,59,48,0.05);border:1px solid rgba(255,59,48,0.15);border-radius:14px;padding:12px 14px;cursor:pointer;user-select:none">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:0.65rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--red)">💳 Deuda ese mes</span>
        <span id="hd-deuda-arrow" style="font-size:0.75rem;color:var(--muted)">▾ Ver</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
        <div><div style="font-size:0.92rem;font-weight:800;color:var(--red)">${fmt(totalSaldo)}</div><div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Saldo</div></div>
        <div><div style="font-size:0.92rem;font-weight:800;color:var(--green)">${fmt(totalAbono)}</div><div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Abonado</div></div>
        <div><div style="font-size:0.92rem;font-weight:800;color:var(--red)">${fmt(Math.max(0,totalSaldo-totalAbono))}</div><div style="font-size:0.55rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Resta</div></div>
      </div>
      <div id="hd-deuda-desglose" style="display:none;margin-top:10px;border-top:1px solid rgba(0,0,0,0.05);padding-top:6px">${deudaRows}</div>
    </div>` : ''}
  `;
  detail.style.display = 'block';
}

function toggleDeudaDesglose() {
  const el = document.getElementById('hd-deuda-desglose');
  const arrow = document.getElementById('hd-deuda-arrow');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▾ Ver tarjetas' : '▴ Ocultar';
}

// ════════════════════════════════════════════
//  AHORRO
// ════════════════════════════════════════════

// Devuelve los depósitos del mes (nuevo sistema)
function getDepositos(key) {
  const md = state.months[key];
  if (!md) return [];
  if (!md.depositos) md.depositos = [];
  return md.depositos;
}

// Total ahorrado en un mes = suma de depósitos (nuevo) O ahorroReal legacy (si no tiene depósitos)
function getTotalAhorradoMes(key) {
  const md = state.months[key];
  if (!md) return 0;
  if (md.depositos && md.depositos.length > 0) {
    return md.depositos.reduce((s, d) => s + (d.amount || 0), 0);
  }
  return md.ahorroReal || 0;
}

function getNetoAhorroMes(key) {
  const md = state.months[key];
  if (!md) return 0;
  const gastado = (md.expenses || [])
    .filter(e => e.fuente === '__AHORRO__')
    .reduce((s, e) => s + (e.amount || 0), 0);
  return getTotalAhorradoMes(key) - gastado;
}

function calcSaldoAhorro(upToKey) {
  // upToKey: solo contar meses <= upToKey (inclusive). Si no se pasa, usa el mes actual.
  const limit = upToKey || currentKey();
  const allKeys = Object.keys(state.months).sort().filter(k => k <= limit);
  let saldo = 0;
  allKeys.forEach(k => {
    const m2 = state.months[k];
    if (!m2) return;
    saldo += getTotalAhorradoMes(k);
    const gastosK = (m2.expenses || []).filter(e => e.fuente === '__AHORRO__').reduce((s, e) => s + (e.amount || 0), 0);
    saldo -= gastosK;
  });
  return saldo;
}

function renderAhorro() {
  const allKeys = Object.keys(state.months).sort();

  const nowKey = currentKey();
  const saldoReal = calcSaldoAhorro(nowKey);

  const keysHastaAhora = allKeys.filter(k => k <= nowKey);
  const mesesConAhorro = keysHastaAhora.filter(k => getTotalAhorradoMes(k) > 0);
  const totalBruto = mesesConAhorro.reduce((s, k) => s + getTotalAhorradoMes(k), 0);
  const totalGastadoAhorro = keysHastaAhora.reduce((s, k) => {
    const m2 = state.months[k];
    return s + (m2 ? (m2.expenses || []).filter(e => e.fuente === '__AHORRO__').reduce((a, e) => a + (e.amount || 0), 0) : 0);
  }, 0);
  const prevM = currentMonth === 0 ? 11 : currentMonth - 1;
  const prevY = currentMonth === 0 ? currentYear - 1 : currentYear;
  const prevKey = monthKey(prevY, prevM);
  const curAhorro = getNetoAhorroMes(nowKey);
  const prevAhorro = getNetoAhorroMes(prevKey);

  document.getElementById('ahorro-kpi-prev').textContent = prevAhorro > 0 ? fmt(prevAhorro) : '—';
  document.getElementById('ahorro-kpi-prev-label').textContent = `${MONTHS_ES[prevM]} ${prevY}`;
  document.getElementById('ahorro-kpi-cur').textContent = curAhorro > 0 ? fmt(curAhorro) : '—';
  document.getElementById('ahorro-kpi-cur-label').textContent = `${MONTHS_ES[currentMonth]} ${currentYear}`;
  const kpiTotal = document.getElementById('ahorro-kpi-total');
  kpiTotal.textContent = fmt(saldoReal);
  kpiTotal.style.color = saldoReal < 0 ? 'var(--red)' : 'var(--green)';
  document.getElementById('ahorro-kpi-months').textContent =
    totalGastadoAhorro > 0
      ? `Ahorrado: ${fmt(totalBruto)} · Gastado: ${fmt(totalGastadoAhorro)}`
      : `${mesesConAhorro.length} ${mesesConAhorro.length === 1 ? 'mes' : 'meses'} con ahorro registrado`;

  // Render lista de depósitos del mes actual
  renderMovimientosAhorro(nowKey);

  // Populate select desglose (now lives in historial page)
  const sel = document.getElementById('ahorro-desglose-select');
  if (!sel) return;
  const savedVal = sel.value;
  const allWithAhorro = [...new Set([...mesesConAhorro, ...Object.keys(state.months)])].sort().reverse()
    .filter(k => getTotalAhorradoMes(k) > 0 || (state.months[k] && (state.months[k].depositos||[]).length > 0));
  sel.innerHTML = `<option value="">— Selecciona un mes —</option>` +
    allWithAhorro.map(k => {
      const [y, m] = k.split('-').map(Number);
      const md = state.months[k];
      const gastosK = (md.expenses || []).filter(e => e.fuente === '__AHORRO__').reduce((s, e) => s + (e.amount || 0), 0);
      const neto = getTotalAhorradoMes(k) - gastosK;
      return `<option value="${k}">${MONTHS_ES[m - 1]} ${y} · ${fmt(neto)}</option>`;
    }).join('');
  if (savedVal && sel.querySelector(`option[value="${savedVal}"]`)) sel.value = savedVal;
  renderAhorroDesgloseDetail();
}

// ── Lista de depósitos (mes actual) ──
function renderDepositosList(key) { renderMovimientosAhorro(key); }

function renderMovimientosAhorro(key) {
  const listEl = document.getElementById('ahorro-depositos-list');
  const badgeEl = document.getElementById('ahorro-depositos-total-badge');
  if (!listEl) return;

  const depositos = getDepositos(key);
  const md = getMonthData(key);
  const salidas = (md.expenses || []).filter(e => e.fuente === '__AHORRO__');

  const totalDep = depositos.reduce((s, d) => s + (d.amount || 0), 0);
  const totalSal = salidas.reduce((s, e) => s + (e.amount || 0), 0);
  const neto = totalDep - totalSal;

  if (badgeEl) {
    badgeEl.textContent = neto !== 0 ? (neto > 0 ? '+' : '') + fmt(neto) : '';
    badgeEl.style.background = neto >= 0 ? 'rgba(26,122,58,0.12)' : 'rgba(255,59,48,0.1)';
    badgeEl.style.color = neto >= 0 ? 'var(--green)' : 'var(--red)';
  }

  if (depositos.length === 0 && salidas.length === 0) {
    listEl.innerHTML = `<p class="small-muted" style="text-align:center;padding:12px 0;font-size:0.78rem">Sin movimientos este mes</p>`;
    return;
  }

  // Build unified list: deposits first, then salidas, sorted by date if possible
  const depRows = depositos.map((d, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:1.1rem;width:24px;text-align:center;flex-shrink:0">🐷</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.nota || 'Depósito al ahorro'}</div>
        <div style="font-size:0.62rem;color:var(--muted);margin-top:1px">${[d.fuenteNombre ? '💰 '+d.fuenteNombre : '', d.fecha].filter(Boolean).join(' · ')}</div>
      </div>
      <button onclick="editDeposito(${i},'${key}')" style="background:none;border:none;color:var(--muted);font-size:0.9rem;padding:4px;cursor:pointer;flex-shrink:0">✏️</button>
      <button onclick="deleteDeposito(${i},'${key}')" style="background:none;border:none;color:var(--red);font-size:0.8rem;padding:4px;cursor:pointer;opacity:0.6;flex-shrink:0">✕</button>
      <span style="font-size:0.92rem;font-weight:800;color:var(--green);flex-shrink:0;min-width:48px;text-align:right">+${fmt(d.amount)}</span>
    </div>`).join('');

  const salRows = salidas.map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:1.1rem;width:24px;text-align:center;flex-shrink:0">${e.icon || '💸'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.name}</div>
        <div style="font-size:0.62rem;color:var(--muted);margin-top:1px">Salida del ahorro</div>
      </div>
      <button onclick="openAddSalida('${e.id}')" style="background:none;border:none;color:var(--muted);font-size:0.9rem;padding:4px;cursor:pointer;flex-shrink:0">✏️</button>
      <button onclick="deleteExpense('${e.id}','${key}')" style="background:none;border:none;color:var(--red);font-size:0.8rem;padding:4px;cursor:pointer;opacity:0.6;flex-shrink:0">✕</button>
      <span style="font-size:0.92rem;font-weight:800;color:var(--red);flex-shrink:0;min-width:48px;text-align:right">-${fmt(e.amount)}</span>
    </div>`).join('');

  const netoRow = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 2px;border-top:2px solid rgba(0,0,0,0.08);margin-top:4px">
      <span style="font-size:0.75rem;font-weight:700;color:${neto>=0?'var(--green)':'var(--red)'}">${neto>=0?'NETO DEL MES':'DÉFICIT DEL MES'}</span>
      <span style="font-size:1rem;font-weight:800;color:${neto>=0?'var(--green)':'var(--red)'}">${neto>=0?'+':''}${fmt(neto)}</span>
    </div>`;

  listEl.innerHTML = depRows + salRows + netoRow;
}

function openAddSalida(editId) {
  document.getElementById('salida-edit-id').value = editId || '';
  document.getElementById('salida-modal-nombre').value = '';
  document.getElementById('salida-modal-monto').value = '';
  document.getElementById('salida-modal-icon').value = '';
  document.getElementById('modal-salida-title').textContent = '💸 Salida del ahorro';
  document.getElementById('salida-modal-btn').textContent = 'Registrar salida';
  if (editId) {
    const md = getMonthData(currentKey());
    const e = (md.expenses || []).find(x => x.id === editId);
    if (e) {
      document.getElementById('salida-modal-nombre').value = e.name || '';
      document.getElementById('salida-modal-monto').value = e.amount || '';
      document.getElementById('salida-modal-icon').value = e.icon && e.icon !== '💸' ? e.icon : '';
      document.getElementById('modal-salida-title').textContent = '✏️ Editar salida';
      document.getElementById('salida-modal-btn').textContent = 'Guardar cambios';
    }
  }
  document.getElementById('modal-add-salida').classList.add('show');
}

function guardarSalida() {
  const key = currentKey();
  ensureMonth(key);
  const raw = state.months[key];
  const nombre = document.getElementById('salida-modal-nombre').value.trim();
  const amount = parseFloat(document.getElementById('salida-modal-monto').value) || 0;
  const icon = document.getElementById('salida-modal-icon').value.trim() || '💸';
  const editId = document.getElementById('salida-edit-id').value;
  if (!nombre) return alert('Escribe un nombre para la salida');
  if (amount <= 0) return alert('Ingresa un monto válido');
  if (!raw.expenses) raw.expenses = [];
  if (editId) {
    const e = raw.expenses.find(x => x.id === editId);
    if (e) { e.name = nombre; e.amount = amount; e.icon = icon; e.fuente = '__AHORRO__'; }
  } else {
    raw.expenses.push({ id: uid(), name: nombre, icon, amount, type: 'fijo', fuente: '__AHORRO__' });
  }
  saveState();
  closeModal('modal-add-salida');
  renderAll();
  showUpdatedBadge();
  toast('💸 Salida registrada');
}

function populateFuenteDeposito(currentFuente) {
  const md = getMonthData(currentKey());
  const ingresos = md.ingresos || [];
  const sel = document.getElementById('deposito-modal-fuente');
  if (!sel) return;
  if (ingresos.length === 0) {
    sel.innerHTML = `<option value="">— Sin ingresos registrados —</option>`;
  } else {
    sel.innerHTML = ingresos.map(ing =>
      `<option value="${ing.id}" ${currentFuente===ing.id?'selected':''}>${ing.name}</option>`
    ).join('');
    if (!currentFuente || !ingresos.find(i => i.id === currentFuente)) {
      sel.value = ingresos[0].id;
    }
  }
}

function openAddDeposito() {
  document.getElementById('deposito-edit-id').value = '';
  document.getElementById('deposito-modal-monto').value = '';
  document.getElementById('deposito-modal-nota').value = '';
  document.getElementById('modal-deposito-title').textContent = 'Agregar depósito';
  document.getElementById('deposito-modal-btn').textContent = '🐷 Agregar depósito';
  populateFuenteDeposito(null);
  document.getElementById('modal-add-deposito').classList.add('show');
}

function editDeposito(idx, key) {
  const depositos = getDepositos(key);
  const d = depositos[idx];
  if (!d) return;
  document.getElementById('deposito-edit-id').value = String(idx);
  document.getElementById('deposito-modal-monto').value = d.amount || '';
  document.getElementById('deposito-modal-nota').value = d.nota || '';
  document.getElementById('modal-deposito-title').textContent = 'Editar depósito';
  document.getElementById('deposito-modal-btn').textContent = '💾 Guardar cambios';
  populateFuenteDeposito(d.fuente || null);
  document.getElementById('modal-add-deposito').classList.add('show');
}

function guardarDeposito() {
  const key = currentKey();
  const amount = parseFloat(document.getElementById('deposito-modal-monto').value) || 0;
  const nota = document.getElementById('deposito-modal-nota').value.trim();
  const fuente = document.getElementById('deposito-modal-fuente').value || '';
  const editIdx = document.getElementById('deposito-edit-id').value;
  if (amount <= 0) return alert('Ingresa un monto válido');

  if (!state.months[key]) {
    const prevTarjetas = getPrevMonthTarjetas(key);
    state.months[key] = { nomina: 0, vales: 0, ingresos: [], expenses: [], tarjetas: JSON.parse(JSON.stringify(prevTarjetas)) };
  }
  const md = state.months[key];
  if (!md.depositos) md.depositos = [];

  // Get ingreso name for display
  const ingresos = md.ingresos || [];
  const ingreso = ingresos.find(i => i.id === fuente);
  const fuenteNombre = ingreso ? ingreso.name : null;

  const now = new Date();
  const fechaStr = now.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });

  if (editIdx !== '') {
    const i = parseInt(editIdx);
    md.depositos[i].amount = amount;
    md.depositos[i].nota = nota || undefined;
    md.depositos[i].fuente = fuente || undefined;
    md.depositos[i].fuenteNombre = fuenteNombre || undefined;
  } else {
    md.depositos.push({ id: uid(), amount, nota: nota || undefined, fuente: fuente || undefined, fuenteNombre: fuenteNombre || undefined, fecha: fechaStr });
  }

  // Sync ahorroReal to total of depositos (for cerrar mes compatibility)
  md.ahorroReal = md.depositos.reduce((s, d) => s + (d.amount || 0), 0);
  saveState();
  closeModal('modal-add-deposito');
  renderAll();
  toast('🐷 Depósito guardado');
}

function deleteDeposito(idx, key) {
  if (!confirm('¿Eliminar este depósito?')) return;
  const md = state.months[key];
  if (!md || !md.depositos) return;
  md.depositos.splice(idx, 1);
  md.ahorroReal = md.depositos.reduce((s, d) => s + (d.amount || 0), 0);
  saveState();
  renderAll();
  showUpdatedBadge();
  toast('🗑️ Depósito eliminado');
}

function renderAhorroDesgloseDetail() {
  const sel = document.getElementById('ahorro-desglose-select');
  const detail = document.getElementById('ahorro-desglose-detail');
  if (!sel || !detail) return;
  const key = sel.value;
  if (!key) { detail.innerHTML = ''; return; }
  const md = state.months[key];
  if (!md) { detail.innerHTML = ''; return; }
  const [y, m] = key.split('-').map(Number);

  const ahorroBase = getTotalAhorradoMes(key);
  const depositos = md.depositos || [];
  const gastosDelAhorro = (md.expenses || []).filter(e => e.fuente === '__AHORRO__');
  const totalGastado = gastosDelAhorro.reduce((s, e) => s + (e.amount || 0), 0);
  const neto = ahorroBase - totalGastado;

  // Depositos list
  const depositosHtml = depositos.length > 0
    ? `<div style="margin-bottom:10px">
        <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--green);margin-bottom:6px">Depósitos</div>
        ${depositos.map(d => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
            <span style="font-size:0.85rem;width:20px;text-align:center;flex-shrink:0">🐷</span>
            <span style="flex:1;font-size:0.82rem;font-weight:500">${d.nota || 'Depósito'}</span>
            ${d.fecha ? `<span style="font-size:0.65rem;color:var(--muted)">${d.fecha}</span>` : ''}
            <span style="font-size:0.82rem;font-weight:700;color:var(--green);flex-shrink:0">+${fmt(d.amount)}</span>
          </div>`).join('')}
      </div>`
    : (md.ahorroReal ? `<div style="padding:8px 0;font-size:0.82rem;color:var(--muted)">Ahorro registrado por cierre de mes: ${fmt(md.ahorroReal)}</div>` : '');

  const gastosRows = gastosDelAhorro.length > 0
    ? gastosDelAhorro.map(e => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
        <span style="font-size:0.9rem;width:22px;text-align:center;flex-shrink:0">${e.icon||'💸'}</span>
        <span style="flex:1;font-size:0.82rem;font-weight:500">${e.name}</span>
        <button onclick="openEditGasto('${e.id}','${key}')" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:2px;font-size:0.85rem;flex-shrink:0">✏️</button>
        <button onclick="deleteExpense('${e.id}','${key}')" style="background:none;border:none;color:var(--red);cursor:pointer;padding:2px;font-size:0.75rem;opacity:0.6;flex-shrink:0">✕</button>
        <span style="font-size:0.82rem;font-weight:700;color:var(--red);flex-shrink:0;min-width:48px;text-align:right">-${fmt(e.amount)}</span>
      </div>`).join('')
    : `<p class="small-muted" style="text-align:center;padding:8px 0;font-size:0.75rem">Sin salidas del ahorro este mes</p>`;

  detail.innerHTML = `
    <div style="background:rgba(26,122,58,0.06);border:1px solid rgba(26,122,58,0.2);border-radius:14px;padding:14px;margin-bottom:12px">
      <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--green);margin-bottom:10px">
        ${MONTHS_ES[m - 1]} ${y}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;margin-bottom:${depositosHtml?'10px':'0'}">
        <div>
          <div style="font-size:0.95rem;font-weight:800;color:var(--green)">${fmtPos(ahorroBase)}</div>
          <div style="font-size:0.58rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Guardado</div>
        </div>
        <div>
          <div style="font-size:0.95rem;font-weight:800;color:var(--red)">${fmtNeg(totalGastado)}</div>
          <div style="font-size:0.58rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Gastado</div>
        </div>
        <div>
          <div style="font-size:0.95rem;font-weight:800;color:${neto>=0?'var(--green)':'var(--red)'}">${neto>=0?fmtPos(neto):fmtNeg(Math.abs(neto))}</div>
          <div style="font-size:0.58rem;color:var(--muted);margin-top:2px;text-transform:uppercase">Neto</div>
        </div>
      </div>
      ${depositosHtml}
    </div>

    <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:8px">Salidas del ahorro este mes</div>
    ${gastosRows}
  `;
}

// eliminarAhorroMes / editarAhorroMes: removed — not called from UI.
// If needed in future: delete md.ahorroReal/md.depositos or call openAddAhorro() with preset key.

function openAddAhorro() {
  const sel = document.getElementById('ahorro-modal-mes');
  const allKeys = Object.keys(state.months).sort().reverse();
  const nowKey = currentKey();
  const options = [...new Set([nowKey, ...allKeys])].sort().reverse();
  sel.innerHTML = options.map(k => {
    const [y,m] = k.split('-').map(Number);
    const md = state.months[k];
    const yaAhorro = getTotalAhorradoMes(k) > 0;
    return `<option value="${k}">${MONTHS_ES[m-1]} ${y}${yaAhorro?' ✅':''}${k===nowKey?' (actual)':''}</option>`;
  }).join('');
  sel.value = nowKey;

  const curMd = state.months[nowKey];
  const montoInput = document.getElementById('ahorro-modal-monto');
  const notaInput = document.getElementById('ahorro-modal-nota');
  const total = getTotalAhorradoMes(nowKey);
  if (total > 0) {
    montoInput.dataset.raw = total;
    montoInput.value = '$' + Number(total).toLocaleString('es-MX');
    notaInput.value = curMd && curMd.notaAhorro || '';
  } else {
    montoInput.dataset.raw = '';
    montoInput.value = '';
    notaInput.value = '';
  }

  sel.onchange = () => {
    const k = sel.value;
    const t2 = getTotalAhorradoMes(k);
    const md2 = state.months[k];
    if (t2 > 0) {
      montoInput.dataset.raw = t2;
      montoInput.value = '$' + Number(t2).toLocaleString('es-MX');
      notaInput.value = md2 && md2.notaAhorro || '';
    } else {
      montoInput.dataset.raw = '';
      montoInput.value = '';
      notaInput.value = '';
    }
  };

  document.getElementById('modal-add-ahorro').classList.add('show');
}

function guardarAhorroModal() {
  const key = document.getElementById('ahorro-modal-mes').value;
  const montoInput = document.getElementById('ahorro-modal-monto');
  const nota = document.getElementById('ahorro-modal-nota').value.trim();
  const raw = montoInput.dataset.raw || montoInput.value.replace(/[^0-9.]/g,'');
  const monto = parseFloat(raw) || 0;

  if (!key) return alert('Selecciona un mes');
  if (monto < 0) return alert('El monto no puede ser negativo');

  if (!state.months[key]) {
    const prevTarjetas = getPrevMonthTarjetas(key);
    state.months[key] = {
      nomina: 0, vales: 0, ingresos: [],
      expenses: [], tarjetas: JSON.parse(JSON.stringify(prevTarjetas))
    };
  }
  const md = state.months[key];
  md.ahorroReal = monto;
  md.notaAhorro = nota || undefined;
  // Si no tiene depósitos, crear uno con este total para compatibilidad
  if (!md.depositos || md.depositos.length === 0) {
    md.depositos = [{ id: uid(), amount: monto, nota: nota || 'Ahorro del mes' }];
  }
  saveState();
  closeModal('modal-add-ahorro');
  renderAll();
  toast('🐷 Ahorro guardado');
}

// ════════════════════════════════════════════
//  EXPORTAR / IMPORTAR
// ════════════════════════════════════════════
function resetearDatos() {
  if (!confirm('⚠️ ¿Borrar TODOS los datos?\n\nEsto eliminará meses, gastos, tarjetas e ingresos. No se puede deshacer.\n\nExporta primero si quieres respaldo.')) return;
  localStorage.removeItem('finanzas-v2');
  localStorage.removeItem('finanzas-v3');
  loadState();
  renderAll();
  toast('🗑️ Datos borrados — fresh start');
}

function exportarDatos() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const fecha = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `finanzas-backup-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('📤 Archivo exportado');
}

function importarDatos(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.months) throw new Error('Formato inválido');
      if (!confirm(`¿Importar datos de ${file.name}?\n\nEsto reemplazará todos tus datos actuales.`)) return;
      state = imported;
      saveState();
      renderAll();
      toast('📥 Datos importados correctamente');
    } catch(err) {
      alert('Error al importar: el archivo no es válido.\n' + err.message);
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════
function init() {
  const d = new Date();
  currentMonth = d.getMonth();
  currentYear = d.getFullYear();
  loadState();
  renderAll();
  fixSafeAreaPadding();
}

function fixSafeAreaPadding() {
  // In standalone (PWA) mode, safe-area-inset-top handles the notch.
  // In normal Safari/browser, we need to account for the browser chrome ourselves.
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const safeTop = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue('--safe-top')) || 0;
  // Use actual safe area if standalone, otherwise just 16px (browser has its own chrome)
  const pt = isStandalone ? Math.max(safeTop + 16, 56) : 16;
  document.querySelectorAll('.page').forEach(p => p.style.paddingTop = pt + 'px');
}
init();

// Zoom block
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTap = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTap < 300) e.preventDefault();
  lastTap = now;
}, { passive: false });

// ════════════════════════════════════════════
//  SWIPE HORIZONTAL ENTRE PESTAÑAS
// ════════════════════════════════════════════
(function() {
  const PAGES = ['home', 'gastos', 'deuda', 'ahorro', 'ajustes'];
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  let currentPageId = 'home';

  function getCurrentPageIndex() {
    return PAGES.indexOf(currentPageId);
  }

  document.addEventListener('touchstart', e => {
    // Ignorar si hay modal abierto
    if (document.querySelector('.modal-overlay.show')) return;
    // Ignorar si el touch empieza sobre un elemento scrollable horizontal
    const el = e.target.closest('select, input, canvas, .day-picker-sheet');
    if (el) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touchStartX) return;
    if (document.querySelector('.modal-overlay.show')) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartTime;

    // Solo si es mayormente horizontal, rápido y suficientemente largo
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6 || dt > 400) return;

    const idx = getCurrentPageIndex();
    if (dx < 0 && idx < PAGES.length - 1) {
      // Swipe izquierda → siguiente pestaña
      currentPageId = PAGES[idx + 1];
      showPage(currentPageId);
    } else if (dx > 0 && idx > 0) {
      // Swipe derecha → pestaña anterior
      currentPageId = PAGES[idx - 1];
      showPage(currentPageId);
    }
    touchStartX = 0;
  }, { passive: true });

  // Sincronizar currentPageId cuando se cambia por botón
  const _origShowPage = showPage;
  window.showPage = function(id) {
    currentPageId = id;
    _origShowPage(id);
  };
})();

// ════════════════════════════════════════════
//  ARRASTRE AL SIGUIENTE MES
// ════════════════════════════════════════════

function checkArrastreLibre() {
  const key = currentKey();
  const md = getMonthData(key);
  const ingresos = md.ingresos || [];
  const depositos = md.depositos || [];
  const ahorroMes = depositos.reduce((s, d) => s + (d.amount || 0), 0);
  const hayLibre = ingresos.some((ing, idx) => {
    const gastos = (md.expenses || []).filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
    const gastado = gastos.reduce((s, e) => s + (e.amount || 0), 0);
    const pagoTarjetas = (md.tarjetas || [])
      .filter(t => (t.cargo || 0) > 0 && getTarjetaPagoFuente(t, ingresos) === ing.id)
      .reduce((s, t) => s + (t.cargo || 0), 0);
    const ahorroDe = idx === 0 ? ahorroMes : 0;
    return (ing.amount || 0) - gastado - pagoTarjetas - ahorroDe > 0.01;
  });
  return hayLibre || getDeudasPendientesArrastre(key).length > 0;
}

function getDeudasPendientesArrastre(key) {
  const tarjetas = getMonthData(key).tarjetas || [];
  return tarjetas.map(t => {
    const saldoBase = t.saldoBase !== undefined ? t.saldoBase : (t.saldo || 0);
    const itemsTotal = (t.cargoItems || []).reduce((s, ci) => s + (ci.amount || 0), 0);
    const pagado = t.cargo || 0;
    const pendiente = Math.max(0, saldoBase + itemsTotal - pagado);
    return { ...t, saldoBase, itemsTotal, pagado, pendiente };
  }).filter(t => t.pendiente > 0.01);
}

function openArrastreModal(targetNormM, targetY) {
  const key = currentKey();
  const md = getMonthData(key);
  const ingresos = md.ingresos || [];
  const [y, m] = key.split('-').map(Number);
  const nm = targetNormM + 1; // 1-based month
  const ny = targetY;
  const nextKey = `${ny}-${String(nm).padStart(2, '0')}`;

  const tituloEl = document.getElementById('arrastre-titulo');
  const subEl = document.getElementById('arrastre-subtitulo');
  if (tituloEl) tituloEl.textContent = `Pasar a ${MONTHS_ES[nm - 1]} ${ny}`;
  if (subEl) subEl.textContent = `Libre de ${MONTHS_ES[m - 1]} ${y} para arrastrar`;

  let html = '';
  let totalArrastre = 0;
  let hasLibreArrastre = false;
  const depositos = md.depositos || [];
  const ahorroMes = depositos.reduce((s, d) => s + (d.amount || 0), 0);
  const deudasPendientes = getDeudasPendientesArrastre(key);
  const totalDeudaPendiente = deudasPendientes.reduce((s, t) => s + t.pendiente, 0);

  ingresos.forEach(ing => {
    const conceptTotal = ing.amount || 0;
    const gastos = (md.expenses || []).filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
    const gastado = gastos.reduce((s, e) => s + (e.amount || 0), 0);
    const pagoTarjetas = (md.tarjetas || [])
      .filter(t => (t.cargo || 0) > 0 && getTarjetaPagoFuente(t, ingresos) === ing.id)
      .reduce((s, t) => s + (t.cargo || 0), 0);
    // Ahorro from this ingreso
    const esPrimero = ingresos.indexOf(ing) === 0;
    const ahorroDe = esPrimero ? ahorroMes : 0;
    const libre = conceptTotal - gastado - pagoTarjetas - ahorroDe;

    if (libre > 0.01) {
      hasLibreArrastre = true;
      totalArrastre += libre;
      html += `
        <div style="background:rgba(26,122,58,0.05);border:1px solid rgba(26,122,58,0.15);border-radius:12px;padding:12px 14px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span style="font-size:0.85rem;font-weight:700">💰 ${ing.name}</span>
            <span style="font-size:0.88rem;font-weight:800;color:var(--green)">${fmtPos(libre)}</span>
          </div>
          <div style="font-size:0.68rem;color:var(--muted);display:flex;flex-direction:column;gap:3px">
            <div style="display:flex;justify-content:space-between"><span>Ingreso</span><span>${fmt(conceptTotal)}</span></div>
            <div style="display:flex;justify-content:space-between"><span>Gastos</span><span>-${fmt(gastado)}</span></div>
            ${pagoTarjetas > 0 ? `<div style="display:flex;justify-content:space-between"><span>Pago tarjetas</span><span>-${fmt(pagoTarjetas)}</span></div>` : ''}
            ${ahorroDe > 0 ? `<div style="display:flex;justify-content:space-between"><span>Ahorro</span><span>-${fmt(ahorroDe)}</span></div>` : ''}
            <div style="display:flex;justify-content:space-between;font-weight:700;color:var(--green);border-top:1px solid rgba(26,122,58,0.15);padding-top:3px;margin-top:2px">
              <span>Libre → sub-ingreso en ${MONTHS_ES[nm - 1]}</span><span>${fmtPos(libre)}</span>
            </div>
          </div>
        </div>`;
    }
  });

  if (deudasPendientes.length > 0) {
    html += `
      <div style="background:rgba(220,38,38,0.05);border:1px solid rgba(220,38,38,0.16);border-radius:12px;padding:12px 14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px">
          <span style="font-size:0.85rem;font-weight:800">💳 Deuda pendiente</span>
          <span style="font-size:0.88rem;font-weight:900;color:var(--red)">${fmt(totalDeudaPendiente)}</span>
        </div>
        <div style="font-size:0.68rem;color:var(--muted);display:flex;flex-direction:column;gap:5px">
          ${deudasPendientes.map(t => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
              <span style="font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name || 'Deuda'}</span>
              <span style="font-weight:900;color:var(--red);flex-shrink:0">${fmt(t.pendiente)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding-bottom:4px;border-bottom:1px solid rgba(220,38,38,0.1)">
              <span>Se arrastra a ${MONTHS_ES[nm - 1]}</span>
              <span>${t.pagado > 0 ? `pagaste ${fmt(t.pagado)}` : 'sin pago este mes'}</span>
            </div>
          `).join('')}
          <div style="display:flex;justify-content:space-between;font-weight:800;color:var(--red);padding-top:3px">
            <span>Total deuda que pasa</span><span>${fmt(totalDeudaPendiente)}</span>
          </div>
        </div>
      </div>`;
  }

  if (!html) {
    html = `<p style="text-align:center;color:var(--muted);font-size:0.82rem;padding:16px 0">No hay libre para arrastrar este mes.</p>`;
  } else if (hasLibreArrastre) {
    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(26,122,58,0.1);border-radius:12px;margin-top:4px">
        <span style="font-size:0.82rem;font-weight:700">Total a arrastrar</span>
        <span style="font-size:1rem;font-weight:800;color:var(--green)">${fmtPos(totalArrastre)}</span>
      </div>`;
  }

  // Store data for confirmar
  window._arrastreData = { key, nextKey, ingresos, md, targetNormM, targetY };
  document.getElementById('arrastre-content').innerHTML = html;
  document.getElementById('modal-arrastre').classList.add('show');
}

function confirmarArrastre() {
  const { key, nextKey, ingresos, md } = window._arrastreData || {};
  if (!key || !nextKey) return;

  const depositos = md.depositos || [];
  const ahorroMes = depositos.reduce((s, d) => s + (d.amount || 0), 0);

  // Ensure next month exists
  getMonthData(nextKey);
  const nextMd = state.months[nextKey];
  if (!nextMd.ingresos) nextMd.ingresos = [];
  if (!nextMd.tarjetas) nextMd.tarjetas = [];

  const [ny, nm] = nextKey.split('-').map(Number);
  const mesNombre = MONTHS_ES[nm - 1] + ' ' + ny;
  const deudasPendientes = getDeudasPendientesArrastre(key);

  deudasPendientes.forEach(t => {
    if (nextMd._removedTarjetas) {
      nextMd._removedTarjetas = nextMd._removedTarjetas.filter(id => id !== t.id);
    }

    let nextTarjeta = nextMd.tarjetas.find(nt => nt.id === t.id);
    if (!nextTarjeta) {
      nextTarjeta = {
        id: t.id,
        name: t.name || 'Deuda',
        saldoOverride: 0,
        cargo: 0,
        fechaCorte: t.fechaCorte || '',
        fuentePago: t.fuentePago || '',
        cargoItems: []
      };
      nextMd.tarjetas.push(nextTarjeta);
    }

    nextTarjeta.name = t.name || nextTarjeta.name || 'Deuda';
    nextTarjeta.saldoOverride = Math.round(t.pendiente * 100) / 100;
    nextTarjeta.cargo = 0;
    nextTarjeta.cargoItems = [];
    nextTarjeta.fechaCorte = t.fechaCorte || nextTarjeta.fechaCorte || '';
    nextTarjeta.fuentePago = t.fuentePago || nextTarjeta.fuentePago || '';
    delete nextTarjeta.saldo;
    delete nextTarjeta.saldoBase;
  });

  ingresos.forEach((ing, idx) => {
    const conceptTotal = ing.amount || 0;
    const gastos = (md.expenses || []).filter(e => e.fuente === ing.id && e.fuente !== '__AHORRO__');
    const gastado = gastos.reduce((s, e) => s + (e.amount || 0), 0);
    const pagoTarjetas = (md.tarjetas || [])
      .filter(t => (t.cargo || 0) > 0 && getTarjetaPagoFuente(t, ingresos) === ing.id)
      .reduce((s, t) => s + (t.cargo || 0), 0);
    const esPrimero = idx === 0;
    const ahorroDe = esPrimero ? ahorroMes : 0;
    const libre = conceptTotal - gastado - pagoTarjetas - ahorroDe;
    if (libre < 0.01) return;

    // Find matching ingreso in next month or create it
    let nextIng = nextMd.ingresos.find(i => i.name === ing.name);
    if (!nextIng) {
      nextIng = { id: uid(), name: ing.name, amount: 0, subItems: [] };
      nextMd.ingresos.push(nextIng);
    }
    if (!nextIng.subItems) nextIng.subItems = [];

    // Remove any previous "restante" sub-item for this ingreso to avoid duplication
    nextIng.subItems = nextIng.subItems.filter(s => !s._esRestante || s._deMes !== key);

    // Add the libre as sub-ingreso
    nextIng.subItems.push({
      id: uid(),
      name: `Restante ${MONTHS_ES[nm - 2 < 0 ? 11 : nm - 2]}`,
      amount: Math.round(libre * 100) / 100,
      _esRestante: true,
      _deMes: key
    });

    // Recalculate ingreso amount
    nextIng.amount = nextIng.subItems.reduce((s, si) => s + (si.amount || 0), 0);
  });

  saveState();
  closeModal('modal-arrastre');

  // Navigate to next month
  const [ny2, nm2] = nextKey.split('-').map(Number);
  currentYear = ny2;
  currentMonth = nm2 - 1;
  renderAll();
  showUpdatedBadge();

  // Show confirmation toast
  showToast('✅ Arrastrado a ' + mesNombre);
}

function cancelarArrastre() {
  closeModal('modal-arrastre');
  const { targetNormM, targetY } = window._arrastreData || {};
  if (targetNormM !== undefined) {
    currentMonth = targetNormM;
    currentYear = targetY;
    renderAll();
    showUpdatedBadge();
  }
}
