import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Switch, StyleSheet, StatusBar, TextInput, Animated, Easing, Alert,
  Modal, KeyboardAvoidingView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { jbd, Reading } from './src/ble';
import { BasicInfo, hoursToPercent, SOFTWARE_LOCK } from './src/jbd';
import {
  Target, loadTargets, saveTargets, checkTargets, requestNotificationPermission,
} from './src/alerts';

const DEVICE_KEY = 'device.id';

const C = {
  bg: '#07090C', card: '#11151A', cardHi: '#171C22', line: '#232A32', text: '#F4F6F8', dim: '#7D8792',
  faint: '#3A434D', green: '#3DDC84', amber: '#FFB547', red: '#FF5A5F', blue: '#4FB3FF',
};

// LiFePO4 cell window, for the mini cell bars
const CELL_MIN = 2.8;
const CELL_MAX = 3.6;

function socColor(p: number) {
  if (p <= 20) return C.red;
  if (p <= 40) return C.amber;
  return C.green;
}

function fmtHours(h: number | null) {
  if (h === null) return '–';
  if (h <= 0) return 'now';
  if (h < 1 / 60) return '<1m';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

function hoursToFull(info: BasicInfo) {
  if (info.current <= 0.05) return null;
  return Math.max(0, info.nominalAh - info.remainingAh) / info.current;
}

export default function App() {
  const [status, setStatus] = useState('Idle');
  const [reading, setReading] = useState<Reading | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [watching, setWatching] = useState(false);
  const targetsRef = useRef<Target[]>([]);
  const [avgCurrent, setAvgCurrent] = useState<number | null>(null);
  const avgRef = useRef<number | null>(null);

  useEffect(() => {
    loadTargets().then((t) => { setTargets(t); targetsRef.current = t; });
    requestNotificationPermission();
    const offS = jbd.onStatus(setStatus);
    const offR = jbd.onReading((r) => {
      setReading(r);
      // Smooth current so time estimates don't jump with every load spike.
      const prev = avgRef.current;
      const cur = r.info.current;
      avgRef.current = prev === null || Math.sign(prev) !== Math.sign(cur) || Math.abs(cur) < 0.05
        ? cur
        : prev * 0.85 + cur * 0.15;
      setAvgCurrent(avgRef.current);
      checkTargets(r.info, targetsRef.current, autoCutOff);
    });
    return () => { offS(); offR(); };
  }, []);

  const [outputBusy, setOutputBusy] = useState(false);

  const autoCutOff = async () => {
    try { await jbd.setDischarge(false); return null; } catch (e: any) { return e?.message ?? 'Unknown error.'; }
  };

  const switchOutput = async (on: boolean) => {
    setOutputBusy(true);
    try {
      await jbd.setDischarge(on);
    } catch (e: any) {
      Alert.alert(
        on ? "Couldn't turn output on" : "Couldn't turn output off",
        (e?.message ?? 'Unknown error.') + (on
          ? '\n\nThe inverter\'s inrush can trip short-circuit protection. Wait a few seconds and try again.'
          : '\n\nSwitch the load off at the inverter instead.'),
      );
    } finally {
      setOutputBusy(false);
    }
  };

  const confirmOutputOff = () => {
    Alert.alert(
      'Turn battery output off?',
      'This cuts power to everything on the battery, including the inverter. Turn heavy loads off first if you can. Charging stays enabled.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn off', style: 'destructive', onPress: () => switchOutput(false) },
      ],
    );
  };

  const updateTargets = (next: Target[]) => {
    const sorted = [...next].sort((a, b) => b.percent - a.percent);
    setTargets(sorted);
    targetsRef.current = sorted;
    saveTargets(sorted);
  };

  const toggleWatch = async () => {
    if (watching) { jbd.stop(); setWatching(false); return; }
    try {
      setWatching(true);
      const saved = await AsyncStorage.getItem(DEVICE_KEY);
      const id = await jbd.start(saved ?? undefined);
      await AsyncStorage.setItem(DEVICE_KEY, id);
    } catch (e: any) {
      setWatching(false);
      setStatus(e?.message ?? 'Failed to connect');
    }
  };

  // Estimates below use the smoothed current; the Current tile shows the raw value.
  const raw = reading?.info;
  const info = raw && avgCurrent !== null ? { ...raw, current: avgCurrent } : raw;
  const nextTarget = useMemo(() => {
    if (!info || info.current >= 0) return null;
    return targets.find((t) => t.enabled && t.direction === 'down' && t.percent < info.soc) ?? null;
  }, [info, targets]);

  // null = sheet closed, 'new' = adding, otherwise the alert being edited
  const [editing, setEditing] = useState<Target | 'new' | null>(null);

  const saveAlert = (t: Target) => {
    const exists = targets.some((x) => x.id === t.id);
    updateTargets(exists ? targets.map((x) => x.id === t.id ? t : x) : [...targets, t]);
    setEditing(null);
  };

  const deleteAlert = (id: string) => {
    updateTargets(targets.filter((x) => x.id !== id));
    setEditing(null);
  };

  const [listEditing, setListEditing] = useState(false);

  const confirmDelete = (t: Target) => {
    Alert.alert(`Delete "${t.label}"?`, `You won't be notified at ${t.percent}% any more.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteAlert(t.id) },
    ]);
  };

  const alertEta = (t: Target) => {
    if (!info || !t.enabled) return null;
    if (t.direction === 'down' && info.current < -0.05 && info.soc > t.percent) {
      return fmtHours(hoursToPercent(info, t.percent));
    }
    if (t.direction === 'up' && info.current > 0.05 && info.soc < t.percent) {
      return fmtHours(Math.max(0, (info.nominalAh * t.percent) / 100 - info.remainingAh) / info.current);
    }
    return null;
  };

  const charging = !!info && info.current > 0.05;
  const discharging = !!info && info.current < -0.05;
  const accent = info ? socColor(info.soc) : C.faint;

  let headline = 'Not connected';
  let subline = watching ? status : 'Tap connect to start watching';
  if (info) {
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
  }

  // Time until the next whole percent in the direction the battery is moving.
  let nextStep: { pct: number; text: string } | null = null;
  if (info && (charging || discharging)) {
    const pct = info.soc + (charging ? 1 : -1);
    if (pct >= 0 && pct <= 100) {
      const targetAh = (info.nominalAh * pct) / 100;
      const ah = charging ? targetAh - info.remainingAh : info.remainingAh - targetAh;
      const mins = Math.max(0, ah) / Math.abs(info.current) * 60;
      const text = mins < 1 ? 'Under a minute'
        : mins < 60 ? `${Math.round(mins)} min`
        : `${Math.floor(mins / 60)}h ${Math.round(mins % 60)} min`;
      nextStep = { pct, text };
    }
  }

  const cells = reading?.cells ?? [];
  const cellDelta = cells.length ? (Math.max(...cells) - Math.min(...cells)) * 1000 : 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <Text style={s.title}>Battery Watch</Text>
          <LivePill live={watching && !!info} label={watching ? (info ? 'Live' : status) : 'Offline'} />
        </View>

        <View style={s.hero}>
          <BigBattery soc={info?.soc ?? 0} color={accent} charging={charging} empty={!info}
            markers={targets.filter((t) => t.enabled && t.percent < 100).map((t) => t.percent)} />
          {nextStep && (
            <View style={[s.nextPill, { borderColor: accent + '55', backgroundColor: accent + '14' }]}>
              <Text style={[s.nextText, { color: accent }]}>
                {charging ? '▲' : '▼'}  {nextStep.text} to {nextStep.pct}%
              </Text>
            </View>
          )}
          <Text style={[s.soc, { color: info ? accent : C.faint }]}>
            {info ? info.soc : '--'}<Text style={s.socPct}>%</Text>
          </Text>
          <Text style={s.headline}>{headline}</Text>
          <Text style={s.subline}>{subline}</Text>
        </View>

        {info && (
          <View style={s.grid}>
            <Stat label="Voltage" value={info.voltage.toFixed(2)} unit="V" />
            <Stat label="Current" value={(raw ?? info).current.toFixed(1)} unit="A" />
            <Stat label="Stored" value={info.remainingAh.toFixed(1)} unit="Ah" />
            <Stat label="Temp" value={info.temps[0] !== undefined ? `${info.temps[0]}` : '–'} unit="°C" />
          </View>
        )}

        {info && info.protections.some((p) => p !== SOFTWARE_LOCK) && (
          <View style={[s.card, s.warnCard]}>
            <Text style={[s.cardTitle, { color: C.red }]}>⚠ Protection active</Text>
            {info.protections.filter((p) => p !== SOFTWARE_LOCK).map((p) => <Text key={p} style={s.warnText}>{p}</Text>)}
          </View>
        )}

        {info && (
          <View style={[s.card, !info.dischargeMos && { borderColor: C.amber + '88' }]}>
            <View style={s.rowBetween}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={s.cardTitle}>Battery output</Text>
                <Text style={[s.cardSub, { color: info.dischargeMos ? C.green : C.amber }]}>
                  {info.dischargeMos ? 'On · inverter has power' : 'Off · inverter has no battery power'}
                </Text>
              </View>
              <Pressable
                disabled={outputBusy}
                onPress={() => info.dischargeMos ? confirmOutputOff() : switchOutput(true)}
                style={({ pressed }) => [
                  s.outBtn,
                  { backgroundColor: (info.dischargeMos ? C.red : C.green) + '22' },
                  (pressed || outputBusy) && { opacity: 0.6 },
                ]}>
                <Text style={[s.outText, { color: info.dischargeMos ? C.red : C.green }]}>
                  {outputBusy ? 'Working…' : info.dischargeMos ? 'Turn off' : 'Turn on'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {cells.length > 0 && (
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.cardTitle}>Cells</Text>
              <Text style={[s.badge, { color: cellDelta > 50 ? C.amber : C.green }]}>
                Δ {cellDelta.toFixed(0)}mV{info?.balancing ? ' · balancing' : ''}
              </Text>
            </View>
            <View style={s.cells}>
              {cells.map((v, i) => {
                const f = Math.min(1, Math.max(0.05, (v - CELL_MIN) / (CELL_MAX - CELL_MIN)));
                return (
                  <View key={i} style={s.cell}>
                    <View style={s.cellTrack}>
                      <View style={[s.cellFill, { height: `${f * 100}%`, backgroundColor: accent }]} />
                    </View>
                    <Text style={s.cellV}>{v.toFixed(3)}</Text>
                    <Text style={s.dim}>Cell {i + 1}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        <View style={s.card}>
          <View style={s.rowBetween}>
            <View>
              <Text style={s.cardTitle}>Alerts</Text>
              <Text style={s.cardSub}>{targets.filter((t) => t.enabled).length} of {targets.length} on</Text>
            </View>
            <View style={s.headerBtns}>
              {targets.length > 0 && (
                <Pressable onPress={() => setListEditing((v) => !v)} hitSlop={8}
                  style={({ pressed }) => [s.editBtn, listEditing && s.editBtnOn, pressed && { opacity: 0.7 }]}>
                  <Text style={[s.editText, listEditing && { color: C.text }]}>{listEditing ? 'Done' : 'Edit'}</Text>
                </Pressable>
              )}
              {!listEditing && (
                <Pressable onPress={() => setEditing('new')} style={({ pressed }) => [s.addBtn, pressed && { opacity: 0.7 }]}>
                  <Text style={s.addText}>+ New</Text>
                </Pressable>
              )}
            </View>
          </View>
          {targets.length === 0 && (
            <Text style={s.empty}>No alerts yet. Add one to get a notification at a charge level.</Text>
          )}
          {targets.map((t, i) => {
            const col = t.direction === 'up' ? C.green : socColor(t.percent);
            const eta = alertEta(t);
            return (
              <Pressable key={t.id}
                onPress={() => listEditing ? confirmDelete(t) : setEditing(t)}
                onLongPress={() => confirmDelete(t)}
                style={({ pressed }) => [s.alertRow, i > 0 && s.alertDivider, pressed && { opacity: 0.6 }]}>
                {listEditing && (
                  <Pressable onPress={() => confirmDelete(t)} hitSlop={10} style={s.minus}>
                    <Text style={s.minusText}>−</Text>
                  </Pressable>
                )}
                <View style={[s.alertBadge, { backgroundColor: col + (t.enabled ? '22' : '0D'), borderColor: col + (t.enabled ? '66' : '22') }]}>
                  <Text style={[s.alertPct, { color: t.enabled ? col : C.dim }]}>{t.percent}</Text>
                  <Text style={[s.alertArrow, { color: t.enabled ? col : C.dim }]}>{t.direction === 'up' ? '▲' : '▼'}</Text>
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[s.alertTitle, !t.enabled && { color: C.dim }]} numberOfLines={1}>{t.label}</Text>
                  <Text style={s.alertSub} numberOfLines={1}>
                    {t.direction === 'up' ? `Charging to ${t.percent}%` : `Dropping below ${t.percent}%`}
                    {t.direction === 'down' && t.cutoff && <Text style={{ color: C.amber }}>  ·  cuts output</Text>}
                    {eta && <Text style={{ color: col }}>  ·  in ~{eta}</Text>}
                  </Text>
                </View>
                {!listEditing && (
                  <Switch
                    value={t.enabled}
                    trackColor={{ true: C.green }}
                    onValueChange={(enabled) => updateTargets(targets.map((x) => x.id === t.id ? { ...x, enabled } : x))}
                  />
                )}
              </Pressable>
            );
          })}
        </View>

        <AlertSheet
          target={editing}
          onClose={() => setEditing(null)}
          onSave={saveAlert}
          onDelete={deleteAlert}
        />

        <Pressable onPress={toggleWatch} style={({ pressed }) => [s.btn, watching && s.btnStop, pressed && { opacity: 0.8 }]}>
          <Text style={[s.btnText, watching && { color: C.text }]}>{watching ? 'Stop watching' : 'Connect & watch'}</Text>
        </Pressable>

        <Text style={s.foot}>Keep the app open or in the background with Bluetooth on. Alerts fire once per crossing.</Text>
      </ScrollView>
    </View>
  );
}

function BigBattery({ soc, color, charging, empty, markers }: {
  soc: number; color: string; charging: boolean; empty: boolean; markers: number[];
}) {
  const fill = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: soc, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
  }, [soc]);

  useEffect(() => {
    if (!charging) { glow.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 1200, useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0, duration: 1200, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [charging]);

  const width = fill.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <View style={b.wrap}>
      <View style={b.row}>
        <View style={[b.body, !empty && { borderColor: color + '88', shadowColor: color }]}>
          <Animated.View style={[b.fill, { width, backgroundColor: color }]}>
            <View style={b.shine} />
          </Animated.View>
          {[20, 40, 60, 80].map((p) => <View key={p} style={[b.seg, { left: `${p}%` }]} />)}
          {charging && (
            <Animated.Text style={[b.bolt, { opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }]}>
              ⚡
            </Animated.Text>
          )}
        </View>
        <View style={[b.nub, !empty && { backgroundColor: color + '88' }]} />
      </View>
      <View style={b.markers}>
        {markers.map((p) => (
          <View key={p} style={[b.marker, { left: `${p}%` }]}>
            <View style={[b.tick, { backgroundColor: socColor(p) }]} />
            <Text style={b.markerText}>{p}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const PRESETS = [10, 20, 30, 50, 80, 100];

function AlertSheet({ target, onClose, onSave, onDelete }: {
  target: Target | 'new' | null;
  onClose: () => void;
  onSave: (t: Target) => void;
  onDelete: (id: string) => void;
}) {
  const isNew = target === 'new';
  const [percent, setPercent] = useState(20);
  const [direction, setDirection] = useState<Target['direction']>('down');
  const [label, setLabel] = useState('');
  const [cutoff, setCutoff] = useState(false);

  useEffect(() => {
    if (!target) return;
    if (target === 'new') { setPercent(20); setDirection('down'); setLabel(''); setCutoff(false); }
    else { setPercent(target.percent); setDirection(target.direction); setLabel(target.label); setCutoff(!!target.cutoff); }
  }, [target]);

  const col = direction === 'up' ? C.green : socColor(percent);
  const bump = (d: number) => setPercent((p) => Math.min(100, Math.max(1, p + d)));
  const fallbackLabel = direction === 'up' ? `Charged to ${percent}%` : `Battery at ${percent}%`;

  const save = () => onSave({
    id: isNew || !target ? `${direction[0]}${percent}-${Date.now()}` : target.id,
    percent, direction, label: label.trim() || fallbackLabel,
    enabled: isNew || !target ? true : target.enabled,
    cutoff: direction === 'down' && cutoff,
  });

  return (
    <Modal visible={!!target} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={sh.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={sh.sheet}>
          <View style={sh.grabber} />
          <View style={s.rowBetween}>
            <Pressable onPress={onClose} hitSlop={10}><Text style={sh.cancel}>Cancel</Text></Pressable>
            <Text style={sh.title}>{isNew ? 'New alert' : 'Edit alert'}</Text>
            <Pressable onPress={save} hitSlop={10}><Text style={sh.save}>Save</Text></Pressable>
          </View>

          <View style={sh.segment}>
            {(['down', 'up'] as const).map((d) => (
              <Pressable key={d} onPress={() => setDirection(d)} style={[sh.segBtn, direction === d && sh.segOn]}>
                <Text style={[sh.segText, direction === d && { color: C.text }]}>
                  {d === 'down' ? '▼  Dropping' : '▲  Charging'}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={sh.dial}>
            <Pressable onPress={() => bump(-5)} onLongPress={() => bump(-1)} style={sh.stepBtn}>
              <Text style={sh.stepText}>−</Text>
            </Pressable>
            <Text style={[sh.bigPct, { color: col }]}>{percent}<Text style={sh.bigPctSign}>%</Text></Text>
            <Pressable onPress={() => bump(5)} onLongPress={() => bump(1)} style={sh.stepBtn}>
              <Text style={sh.stepText}>+</Text>
            </Pressable>
          </View>
          <Text style={sh.hint}>Tap ± for 5%, hold for 1%</Text>

          <View style={sh.presets}>
            {PRESETS.map((p) => (
              <Pressable key={p} onPress={() => setPercent(p)}
                style={[sh.preset, percent === p && { borderColor: col, backgroundColor: col + '22' }]}>
                <Text style={[sh.presetText, percent === p && { color: col }]}>{p}%</Text>
              </Pressable>
            ))}
          </View>

          <Text style={sh.fieldLabel}>NAME</Text>
          <TextInput
            style={sh.input}
            value={label}
            onChangeText={setLabel}
            placeholder={fallbackLabel}
            placeholderTextColor={C.faint}
            returnKeyType="done"
          />
          {direction === 'down' && (
            <View style={s.rowBetween}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={sh.toggleTitle}>Cut off output</Text>
                <Text style={sh.toggleSub}>Switch the battery off (and the inverter with it) when this fires</Text>
              </View>
              <Switch value={cutoff} onValueChange={setCutoff} trackColor={{ true: C.amber }} />
            </View>
          )}
          <Text style={sh.preview}>
            You'll be notified when the battery {direction === 'up' ? 'charges up to' : 'drops to'} {percent}%
            {direction === 'down' && cutoff ? ', and its output will be switched off.' : '.'}
          </Text>

          {!isNew && target && (
            <Pressable onPress={() => onDelete(target.id)} style={({ pressed }) => [sh.delete, pressed && { opacity: 0.7 }]}>
              <Text style={sh.deleteText}>Delete alert</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function LivePill({ live, label }: { live: boolean; label: string }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!live) { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.25, duration: 800, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [live]);
  const col = live ? C.green : C.dim;
  return (
    <View style={[s.pill, live && { borderColor: C.green + '55', backgroundColor: C.green + '14' }]}>
      <Animated.View style={[s.dot, { backgroundColor: col, opacity: pulse }]} />
      <Text style={[s.pillText, { color: col }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label.toUpperCase()}</Text>
      <Text style={s.statV}>{value}<Text style={s.statUnit}> {unit}</Text></Text>
    </View>
  );
}

const b = StyleSheet.create({
  wrap: { width: '100%', paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  body: {
    flex: 1, height: 132, borderRadius: 26, borderWidth: 3, borderColor: C.line, padding: 6,
    backgroundColor: C.card, overflow: 'visible',
    shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
  },
  fill: { height: '100%', borderRadius: 18, overflow: 'hidden', minWidth: 8 },
  shine: { position: 'absolute', top: 8, left: 10, right: 10, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF33' },
  seg: { position: 'absolute', top: 6, bottom: 6, width: 2, marginLeft: -1, backgroundColor: C.bg + '66' },
  bolt: { position: 'absolute', alignSelf: 'center', top: 36, fontSize: 48 },
  nub: { width: 10, height: 44, marginLeft: 4, borderTopRightRadius: 6, borderBottomRightRadius: 6, backgroundColor: C.line },
  markers: { height: 26, marginTop: 6, marginLeft: 9, marginRight: 23 },
  marker: { position: 'absolute', width: 28, marginLeft: -14, alignItems: 'center' },
  tick: { width: 2, height: 7, borderRadius: 1 },
  markerText: { color: C.dim, fontSize: 11, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
});

const sh = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000AA' },
  sheet: {
    backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 40,
    gap: 16, borderWidth: 1, borderColor: C.line,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.faint, marginTop: -8 },
  title: { color: C.text, fontSize: 17, fontWeight: '800' },
  cancel: { color: C.dim, fontSize: 16 },
  save: { color: C.blue, fontSize: 16, fontWeight: '800' },
  segment: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 12, padding: 4 },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segOn: { backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.line },
  segText: { color: C.dim, fontWeight: '700', fontSize: 14 },
  dial: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  stepBtn: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.line,
    alignItems: 'center', justifyContent: 'center',
  },
  stepText: { color: C.text, fontSize: 28, fontWeight: '600', marginTop: -2 },
  bigPct: { fontSize: 72, fontWeight: '900', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  bigPctSign: { fontSize: 28, fontWeight: '700' },
  hint: { color: C.faint, fontSize: 12, textAlign: 'center', marginTop: -12 },
  presets: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  preset: {
    flex: 1, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center',
  },
  presetText: { color: C.dim, fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] },
  fieldLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: -8 },
  input: {
    backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.line, color: C.text,
    fontSize: 16, paddingHorizontal: 14, paddingVertical: 12,
  },
  preview: { color: C.dim, fontSize: 13, marginTop: -6 },
  toggleTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  toggleSub: { color: C.dim, fontSize: 12, marginTop: 2 },
  delete: { paddingVertical: 14, borderRadius: 14, alignItems: 'center', backgroundColor: C.red + '18' },
  deleteText: { color: C.red, fontWeight: '800', fontSize: 15 },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingTop: 66, gap: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 190,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: C.line,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  nextPill: { marginTop: 4, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  nextText: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 8 },
  soc: { fontSize: 84, fontWeight: '900', letterSpacing: -3, marginTop: 4, fontVariant: ['tabular-nums'] },
  socPct: { fontSize: 32, fontWeight: '700' },
  headline: { color: C.text, fontSize: 19, fontWeight: '700', marginTop: -2 },
  subline: { color: C.dim, fontSize: 14, marginTop: 6 },
  btn: { backgroundColor: C.blue, borderRadius: 16, padding: 17, alignItems: 'center' },
  btnStop: { backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.line },
  btnText: { color: '#04121F', fontWeight: '800', fontSize: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: {
    flexBasis: '47%', flexGrow: 1, backgroundColor: C.card, borderRadius: 16, padding: 14, gap: 6,
    borderWidth: 1, borderColor: C.line,
  },
  statLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  statV: { color: C.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statUnit: { color: C.dim, fontSize: 14, fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 18, padding: 16, gap: 12, borderWidth: 1, borderColor: C.line },
  warnCard: { borderColor: C.red + '88', backgroundColor: C.red + '12' },
  warnText: { color: C.text, fontSize: 14 },
  cardTitle: { color: C.text, fontSize: 17, fontWeight: '800' },
  badge: { fontSize: 12, fontWeight: '700' },
  dim: { color: C.dim, fontSize: 11 },
  cells: { flexDirection: 'row', justifyContent: 'space-around' },
  cell: { alignItems: 'center', gap: 4 },
  cellTrack: {
    width: 30, height: 64, borderRadius: 8, backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.line,
    justifyContent: 'flex-end', padding: 3,
  },
  cellFill: { width: '100%', borderRadius: 5 },
  cellV: { color: C.text, fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'], marginTop: 2 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardSub: { color: C.dim, fontSize: 12, marginTop: 2 },
  outBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  outText: { fontWeight: '800', fontSize: 14 },
  addBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: C.blue + '22' },
  addText: { color: C.blue, fontWeight: '800', fontSize: 14 },
  empty: { color: C.dim, fontSize: 14, paddingVertical: 8 },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  editBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: C.line },
  editBtnOn: { backgroundColor: C.cardHi },
  editText: { color: C.dim, fontWeight: '800', fontSize: 14 },
  minus: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center',
  },
  minusText: { color: '#fff', fontSize: 20, fontWeight: '900', marginTop: -2 },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 },
  alertDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  alertBadge: {
    width: 54, height: 54, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  alertPct: { fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'], marginBottom: -2 },
  alertArrow: { fontSize: 9, fontWeight: '900' },
  alertTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  alertSub: { color: C.dim, fontSize: 13 },
  foot: { color: C.dim, fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 40, lineHeight: 17 },
});
