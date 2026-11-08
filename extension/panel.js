import { jbd } from './ble.js';
import { hoursToPercent } from './jbd.js';
import { loadTargets, saveTargets, checkTargets } from './alerts.js';

const DEVICE_KEY = 'device.id';
const C = {
  faint: '#3A434D', green: '#3DDC84', amber: '#FFB547', red: '#FF5A5F',
};
// LiFePO4 cell window, for the mini cell bars
const CELL_MIN = 2.8;
const CELL_MAX = 3.6;
const PRESETS = [10, 20, 30, 50, 80, 100];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function socColor(p) {
  if (p <= 20) return C.red;
  if (p <= 40) return C.amber;
  return C.green;
}

function fmtHours(h) {
  if (h === null) return '–';
  if (h <= 0) return 'now';
  if (h < 1 / 60) return '<1m';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

function hoursToFull(info) {
  if (info.current <= 0.05) return null;
  return Math.max(0, info.nominalAh - info.remainingAh) / info.current;
}

// ---- state ----
let status = 'Idle';
let reading = null;
let avg = null; // smoothed current, so time estimates don't jump with every load spike
let targets = [];
let watching = false;
let forcePick = false;
let listEditing = false;
let armedDelete = null; // alert id showing its red Delete button

// ---- toolbar badge ----
let port = null;
function openPort() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onDisconnect.addListener(() => { port = null; });
}
openPort();

function updateBadge(info) {
  if (!info) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Battery Watch' });
    document.title = 'Battery Watch';
    return;
  }
  chrome.action.setBadgeText({ text: String(info.soc) });
  chrome.action.setBadgeBackgroundColor({ color: socColor(info.soc) });
  chrome.action.setBadgeTextColor?.({ color: '#07090C' });
  const flow = info.current < -0.05 ? `using ${Math.abs(Math.round(info.power))}W`
    : info.current > 0.05 ? `charging at ${Math.round(info.power)}W` : 'resting';
  chrome.action.setTitle({ title: `Battery Watch: ${info.soc}%, ${flow}` });
  document.title = `${info.soc}% · Battery Watch`;
  if (!port) openPort();
  try { port.postMessage('hb'); } catch { port = null; }
}

// ---- data ----
jbd.onStatus((s) => { status = s; render(); });
jbd.onReading((r) => {
  reading = r;
  const cur = r.info.current;
  avg = avg === null || Math.sign(avg) !== Math.sign(cur) || Math.abs(cur) < 0.05
    ? cur
    : avg * 0.85 + cur * 0.15;
  checkTargets(r.info, targets);
  updateBadge(r.info);
  render();
});

function currentInfo() {
  // Estimates use the smoothed current; the Current tile shows the raw value.
  if (!reading) return null;
  return avg === null ? reading.info : { ...reading.info, current: avg };
}

// ---- render ----
function render() {
  const info = currentInfo();
  const raw = reading?.info ?? null;
  const connected = watching && status === 'Connected';
  const charging = !!info && info.current > 0.05;
  const discharging = !!info && info.current < -0.05;
  const accent = info ? socColor(info.soc) : C.faint;
  document.documentElement.style.setProperty('--accent', accent);

  // header pill
  const live = connected && !!info;
  $('pill').classList.toggle('live', live);
  $('pill-text').textContent = live ? 'Live' : watching ? status : 'Ready';

  // battery
  $('bat-body').classList.toggle('on', !!info);
  $('bat-nub').classList.toggle('on', !!info);
  const soc = info?.soc ?? 0;
  $('bat-fill').style.width = `${soc}%`;
  $('bat-fill').classList.toggle('some', soc > 0);
  $('bat-bolt').hidden = !charging;

  const markers = $('markers');
  markers.replaceChildren(...targets.filter((t) => t.enabled && t.percent < 100).map((t) => {
    const m = el('div', 'marker');
    m.style.left = `${t.percent}%`;
    const tick = el('div', 'tick');
    tick.style.background = socColor(t.percent);
    m.append(tick, el('div', 'marker-text', String(t.percent)));
    return m;
  }));

  // Countdown to the next whole percent, in the direction the battery is moving.
  let next = null;
  if (info && (charging || discharging)) {
    const pct = info.soc + (charging ? 1 : -1);
    if (pct >= 0 && pct <= 100) {
      const targetAh = (info.nominalAh * pct) / 100;
      const ah = charging ? targetAh - info.remainingAh : info.remainingAh - targetAh;
      const at = Date.now() + (Math.max(0, ah) / Math.abs(info.current)) * 3600_000;
      next = { pct, at, up: charging };
    }
  }
  // Keep the running countdown unless the new estimate disagrees by more than
  // 10s, so it ticks down smoothly instead of jumping with every reading.
  if (!next) countdown = null;
  else if (!countdown || countdown.pct !== next.pct || countdown.up !== next.up
    || Math.abs(countdown.at - next.at) > 10_000) countdown = next;
  renderCountdown();

  $('soc').firstChild.textContent = info ? String(info.soc) : '--';

  let headline = 'Not connected';
  let subline = watching ? status : (status !== 'Idle' && status !== 'Stopped' ? status : 'Click connect to start watching');
  if (info) {
    const nextTarget = discharging
      ? targets.find((t) => t.enabled && t.direction === 'down' && t.percent < info.soc)
      : null;
    if (discharging) {
      headline = `Using ${Math.abs(Math.round(info.power))}W`;
      subline = nextTarget
        ? `${nextTarget.percent}% in about ${fmtHours(hoursToPercent(info, nextTarget.percent))}`
        : `Empty in about ${fmtHours(hoursToPercent(info, 0))}`;
    } else if (charging) {
      headline = `Charging at ${Math.round(info.power)}W`;
      subline = `Full in about ${fmtHours(hoursToFull(info))}`;
    } else {
      headline = 'Resting';
      subline = `${info.remainingAh.toFixed(0)} of ${info.nominalAh.toFixed(0)}Ah stored`;
    }
    if (watching && !connected) subline = status;
  }
  $('headline').textContent = headline;
  $('subline').textContent = subline;

  // stats
  const stats = $('stats');
  stats.hidden = !info;
  if (info) {
    stats.replaceChildren(
      stat('Voltage', info.voltage.toFixed(2), 'V'),
      stat('Current', raw.current.toFixed(1), 'A'),
      stat('Stored', info.remainingAh.toFixed(1), 'Ah'),
      stat('Temp', info.temps[0] !== undefined ? String(info.temps[0]) : '–', '°C'),
    );
  }

  // protections
  const prot = $('protections');
  prot.hidden = !info || info.protections.length === 0;
  if (!prot.hidden) {
    prot.replaceChildren(el('h2', 'card-title', '⚠ Protection active'),
      ...info.protections.map((p) => el('div', '', p)));
  }

  // cells
  const cells = reading?.cells ?? [];
  $('cells-card').hidden = cells.length === 0;
  if (cells.length) {
    const delta = (Math.max(...cells) - Math.min(...cells)) * 1000;
    const badge = $('cell-delta');
    badge.textContent = `Δ ${delta.toFixed(0)}mV${info?.balancing ? ' · balancing' : ''}`;
    badge.style.color = delta > 50 ? C.amber : C.green;
    $('cells').replaceChildren(...cells.map((v, i) => {
      const f = Math.min(1, Math.max(0.05, (v - CELL_MIN) / (CELL_MAX - CELL_MIN)));
      const cell = el('div', 'cell');
      const track = el('div', 'cell-track');
      const fill = el('div', 'cell-fill');
      fill.style.height = `${f * 100}%`;
      track.append(fill);
      cell.append(track, el('div', 'cell-v', v.toFixed(3)), el('div', 'dim', `Cell ${i + 1}`));
      return cell;
    }));
  }

  renderAlerts(info);

  // connect button
  const btn = $('connect');
  btn.textContent = watching ? 'Stop watching' : forcePick ? 'Choose battery & watch' : 'Connect & watch';
  btn.classList.toggle('stop', watching);
  $('show-all').hidden = watching;
}

let countdown = null; // { pct, at (ms timestamp), up }

function renderCountdown() {
  const pill = $('next-pill');
  pill.hidden = !countdown;
  if (!countdown) return;
  const left = Math.max(0, Math.round((countdown.at - Date.now()) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = String(left % 60).padStart(2, '0');
  const time = left === 0 ? 'Any moment'
    : h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  pill.textContent = `${countdown.up ? '▲' : '▼'}  ${time} to ${countdown.pct}%`;
}
setInterval(renderCountdown, 1000);

function stat(label, value, unit) {
  const s = el('div', 'stat');
  const v = el('div', 'stat-v', value);
  v.append(el('span', 'stat-unit', ` ${unit}`));
  s.append(el('div', 'stat-label', label.toUpperCase()), v);
  return s;
}

function alertEta(t, info) {
  if (!info || !t.enabled) return null;
  if (t.direction === 'down' && info.current < -0.05 && info.soc > t.percent) {
    return fmtHours(hoursToPercent(info, t.percent));
  }
  if (t.direction === 'up' && info.current > 0.05 && info.soc < t.percent) {
    return fmtHours(Math.max(0, (info.nominalAh * t.percent) / 100 - info.remainingAh) / info.current);
  }
  return null;
}

function renderAlerts(info) {
  $('alerts-sub').textContent = `${targets.filter((t) => t.enabled).length} of ${targets.length} on`;
  const editBtn = $('edit-btn');
  editBtn.hidden = targets.length === 0;
  editBtn.textContent = listEditing ? 'Done' : 'Edit';
  editBtn.classList.toggle('on', listEditing);
  $('add-btn').hidden = listEditing;

  const list = $('alerts');
  if (targets.length === 0) {
    list.replaceChildren(el('div', 'empty', 'No alerts yet. Add one to get a notification at a charge level.'));
    return;
  }

  list.replaceChildren(...targets.map((t) => {
    const col = t.direction === 'up' ? C.green : socColor(t.percent);
    const row = el('div', `alert-row${t.enabled ? '' : ' off'}`);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    if (listEditing) {
      const minus = el('button', 'minus', '−');
      minus.setAttribute('aria-label', `Delete ${t.label}`);
      minus.addEventListener('click', (e) => {
        e.stopPropagation();
        armedDelete = armedDelete === t.id ? null : t.id;
        render();
      });
      row.append(minus);
    }

    const badge = el('div', 'alert-badge');
    badge.style.setProperty('--c', col);
    badge.append(el('div', 'alert-pct', String(t.percent)), el('div', 'alert-arrow', t.direction === 'up' ? '▲' : '▼'));

    const text = el('div', 'alert-text');
    const sub = el('div', 'alert-sub', t.direction === 'up' ? `Charging to ${t.percent}%` : `Dropping below ${t.percent}%`);
    const eta = alertEta(t, info);
    if (eta) {
      const e = el('span', '', `  ·  in ~${eta}`);
      e.style.color = col;
      sub.append(e);
    }
    text.append(el('div', 'alert-title', t.label), sub);
    row.append(badge, text);

    if (listEditing && armedDelete === t.id) {
      const del = el('button', 'delete', 'Delete');
      del.style.padding = '8px 14px';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteAlert(t.id); });
      row.append(del);
    } else if (!listEditing) {
      const sw = el('label', 'switch');
      sw.addEventListener('click', (e) => e.stopPropagation());
      const input = el('input');
      input.type = 'checkbox';
      input.checked = t.enabled;
      input.setAttribute('aria-label', `${t.label} on`);
      input.addEventListener('change', () => {
        updateTargets(targets.map((x) => x.id === t.id ? { ...x, enabled: input.checked } : x));
      });
      sw.append(input, el('span'));
      row.append(sw);
    }

    // Click to edit; long-press jumps straight to delete.
    let pressTimer = null;
    let longPressed = false;
    row.addEventListener('pointerdown', () => {
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        listEditing = true;
        armedDelete = t.id;
        render();
      }, 550);
    });
    const cancelPress = () => clearTimeout(pressTimer);
    row.addEventListener('pointerup', cancelPress);
    row.addEventListener('pointerleave', cancelPress);
    row.addEventListener('click', () => {
      if (longPressed) return;
      if (listEditing) { armedDelete = armedDelete === t.id ? null : t.id; render(); return; }
      openSheet(t);
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); });
    return row;
  }));
}

function updateTargets(next) {
  targets = [...next].sort((a, b) => b.percent - a.percent);
  saveTargets(targets);
  render();
}

function deleteAlert(id) {
  armedDelete = null;
  updateTargets(targets.filter((x) => x.id !== id));
  if (targets.length === 0) listEditing = false;
  closeSheet();
  render();
}

// ---- edit sheet ----
let sheetTarget = null; // 'new' or the alert being edited
let sheetPct = 20;
let sheetDir = 'down';
let deleteArmed = false;

function openSheet(target) {
  sheetTarget = target;
  deleteArmed = false;
  if (target === 'new') { sheetPct = 20; sheetDir = 'down'; $('sheet-name').value = ''; }
  else { sheetPct = target.percent; sheetDir = target.direction; $('sheet-name').value = target.label; }
  $('sheet-backdrop').hidden = false;
  renderSheet();
}

function closeSheet() {
  sheetTarget = null;
  $('sheet-backdrop').hidden = true;
}

function fallbackLabel() {
  return sheetDir === 'up' ? `Charged to ${sheetPct}%` : `Battery at ${sheetPct}%`;
}

function renderSheet() {
  const isNew = sheetTarget === 'new';
  const col = sheetDir === 'up' ? C.green : socColor(sheetPct);
  $('sheet').style.setProperty('--sheet-c', col);
  $('sheet-title').textContent = isNew ? 'New alert' : 'Edit alert';
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.dir === sheetDir));
  $('big-pct').firstChild.textContent = String(sheetPct);
  $('presets').replaceChildren(...PRESETS.map((p) => {
    const b = el('button', `preset${p === sheetPct ? ' on' : ''}`, `${p}%`);
    b.addEventListener('click', () => { sheetPct = p; renderSheet(); });
    return b;
  }));
  $('sheet-name').placeholder = fallbackLabel();
  $('sheet-preview').textContent =
    `You'll be notified when the battery ${sheetDir === 'up' ? 'charges up to' : 'drops to'} ${sheetPct}%.`;
  const del = $('sheet-delete');
  del.hidden = isNew;
  del.textContent = deleteArmed ? 'Click again to delete' : 'Delete alert';
}

function saveSheet() {
  const isNew = sheetTarget === 'new';
  const t = {
    id: isNew ? `${sheetDir[0]}${sheetPct}-${Date.now()}` : sheetTarget.id,
    percent: sheetPct,
    direction: sheetDir,
    label: $('sheet-name').value.trim() || fallbackLabel(),
    enabled: isNew ? true : sheetTarget.enabled,
  };
  const exists = targets.some((x) => x.id === t.id);
  updateTargets(exists ? targets.map((x) => x.id === t.id ? t : x) : [...targets, t]);
  closeSheet();
}

const bump = (d) => { sheetPct = Math.min(100, Math.max(1, sheetPct + d)); renderSheet(); };
$('minus').addEventListener('click', (e) => bump(e.shiftKey ? -1 : -5));
$('plus').addEventListener('click', (e) => bump(e.shiftKey ? 1 : 5));
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { sheetDir = b.dataset.dir; renderSheet(); }));
$('sheet-cancel').addEventListener('click', closeSheet);
$('sheet-save').addEventListener('click', saveSheet);
$('sheet-name').addEventListener('input', renderSheet);
$('sheet-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSheet(); });
$('sheet-delete').addEventListener('click', () => {
  if (!deleteArmed) { deleteArmed = true; renderSheet(); return; }
  deleteAlert(sheetTarget.id);
});
$('sheet-backdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetTarget) closeSheet();
});

// ---- alerts header ----
$('add-btn').addEventListener('click', () => openSheet('new'));
$('edit-btn').addEventListener('click', () => { listEditing = !listEditing; armedDelete = null; render(); });

// ---- connect ----
function showError(msg) {
  const box = $('error');
  box.textContent = msg ?? '';
  box.hidden = !msg;
}

// Looked up ahead of time: Chrome only opens its device picker if requestDevice()
// is called right inside the click, so the click handler can't wait on storage first.
let knownDevice = null;
async function preloadKnown() {
  const { [DEVICE_KEY]: savedId } = await chrome.storage.local.get(DEVICE_KEY);
  knownDevice = await jbd.known(savedId);
}

async function connect(showAll = false) {
  showError(null);
  if (watching) {
    jbd.stop();
    watching = false;
    reading = null;
    avg = null;
    updateBadge(null);
    render();
    return;
  }

  let device = !showAll && !forcePick ? knownDevice : null;
  try {
    if (!device) {
      const picking = jbd.pick(showAll); // must stay the first call in the click
      status = 'Choose your battery…';
      render();
      device = await picking;
      showError(null);
    }
    watching = true;
    render();
    const id = await jbd.start(device);
    forcePick = false;
    knownDevice = device;
    await chrome.storage.local.set({ [DEVICE_KEY]: id });
  } catch (e) {
    console.error('Battery Watch connect failed', e);
    watching = false;
    status = 'Idle';
    if (e?.name === 'NotFoundError') {
      showError(`No battery chosen. If it wasn't in the list, close the battery's other apps and try "Show all devices".`);
    } else {
      showError(`${e?.name ?? 'Error'}: ${e?.message ?? 'Failed to connect'}`);
    }
    // A remembered battery that won't answer: offer the picker on the next click.
    forcePick = true;
    render();
  }
}

window.addEventListener('error', (e) => showError(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showError(`Error: ${e.reason?.message ?? e.reason}`));

$('connect').addEventListener('click', () => connect(false));
$('show-all').addEventListener('click', () => connect(true));

// ---- startup ----
if (!jbd.supported) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
  $('show-all').hidden = true;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes['targets.v1']) {
    targets = changes['targets.v1'].newValue ?? [];
    render();
  }
});

window.addEventListener('pagehide', () => {
  if (watching) jbd.stop(true);
  updateBadge(null);
});

loadTargets().then((t) => { targets = t; render(); });
preloadKnown().catch(() => {});
render();
