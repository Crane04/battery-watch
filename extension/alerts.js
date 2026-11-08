// Alert targets, stored in chrome.storage. Same rules as src/alerts.ts in the app.

const KEY = 'targets.v1';
const FIRED_KEY = 'targets.fired.v1';
const REARM_MARGIN = 3; // % past the target before it can fire again

export const DEFAULT_TARGETS = [
  { id: 'd50', percent: 50, direction: 'down', label: 'Halfway', enabled: true },
  { id: 'd30', percent: 30, direction: 'down', label: 'Start winding down', enabled: true },
  { id: 'd20', percent: 20, direction: 'down', label: 'Switch it off now', enabled: true },
  { id: 'u100', percent: 100, direction: 'up', label: 'Fully charged', enabled: true },
];

export async function loadTargets() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] ?? DEFAULT_TARGETS;
}

export async function saveTargets(t) {
  await chrome.storage.local.set({ [KEY]: t });
}

// Tracks which targets have fired so a reading hovering at 30% doesn't spam you.
// A target re-arms once the battery moves back past it by REARM_MARGIN.
let fired = null;

async function getFired() {
  if (!fired) fired = new Set((await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] ?? []);
  return fired;
}

export async function checkTargets(info, targets) {
  const f = await getFired();
  const soc = info.soc;
  const charging = info.current > 0.05;
  const discharging = info.current < -0.05;
  let changed = false;

  for (const t of targets) {
    if (!t.enabled) continue;

    const hit = t.direction === 'down'
      ? discharging && soc <= t.percent
      : charging && soc >= t.percent;

    const rearm = t.direction === 'down'
      ? soc >= t.percent + REARM_MARGIN
      : soc <= t.percent - REARM_MARGIN;

    if (hit && !f.has(t.id)) {
      f.add(t.id);
      changed = true;
      fire(t, info);
    } else if (rearm && f.has(t.id)) {
      f.delete(t.id);
      changed = true;
    }
  }

  if (changed) await chrome.storage.local.set({ [FIRED_KEY]: [...f] });
}

function fire(t, info) {
  const watts = Math.abs(Math.round(info.power));
  const message = t.direction === 'down'
    ? `Battery at ${info.soc}%. Drawing ${watts}W.`
    : `Battery at ${info.soc}%. You can unplug the charger.`;

  chrome.notifications.create(`alert-${t.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: t.label,
    message,
    priority: 2,
    requireInteraction: t.direction === 'down' && t.percent <= 20,
  });
}
