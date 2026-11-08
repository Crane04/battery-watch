import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { BasicInfo } from './jbd';

export type Target = {
  id: string;
  percent: number;
  direction: 'down' | 'up'; // down = discharging past it, up = charging past it
  label: string;
  enabled: boolean;
};

const KEY = 'targets.v1';
const FIRED_KEY = 'targets.fired.v1';
const REARM_MARGIN = 3; // % past the target before it can fire again

export const DEFAULT_TARGETS: Target[] = [
  { id: 'd50', percent: 50, direction: 'down', label: 'Halfway', enabled: true },
  { id: 'd30', percent: 30, direction: 'down', label: 'Start winding down', enabled: true },
  { id: 'd20', percent: 20, direction: 'down', label: 'Switch it off now', enabled: true },
  { id: 'u100', percent: 100, direction: 'up', label: 'Fully charged', enabled: true },
];

export async function loadTargets(): Promise<Target[]> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : DEFAULT_TARGETS;
}

export async function saveTargets(t: Target[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(t));
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission() {
  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return status === 'granted';
}

// Tracks which targets have fired so a reading hovering at 30% doesn't spam you.
// A target re-arms once the battery moves back past it by REARM_MARGIN.
let fired: Set<string> | null = null;

async function getFired() {
  if (!fired) fired = new Set(JSON.parse((await AsyncStorage.getItem(FIRED_KEY)) ?? '[]'));
  return fired;
}

export async function checkTargets(info: BasicInfo, targets: Target[]) {
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
      await fire(t, info);
    } else if (rearm && f.has(t.id)) {
      f.delete(t.id);
      changed = true;
    }
  }

  if (changed) await AsyncStorage.setItem(FIRED_KEY, JSON.stringify([...f]));
}

async function fire(t: Target, info: BasicInfo) {
  const watts = Math.abs(Math.round(info.power));
  const body = t.direction === 'down'
    ? `Battery at ${info.soc}%. Drawing ${watts}W.`
    : `Battery at ${info.soc}%. You can unplug the charger.`;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: t.label,
      body,
      sound: 'default',
      interruptionLevel: 'timeSensitive', // breaks through Focus modes
    },
    trigger: null,
  });
}
