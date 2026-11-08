import { AppState } from 'react-native';
import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import {
  SERVICE_UUID, NOTIFY_UUID, WRITE_UUID, CMD_BASIC, CMD_CELLS,
  FrameAssembler, BasicInfo, buildRead, parseBasic, parseCells, b64ToBytes, bytesToB64,
} from './jbd';

export type Reading = { info: BasicInfo; cells: number[]; at: number };
type Listener = (r: Reading) => void;
type StatusListener = (s: string) => void;

// Poll gap between cycles. We chain off responses (not setInterval) so the
// loop keeps running while iOS has the app backgrounded with bluetooth-central.
const POLL_GAP_MS = 3000;
const TIMEOUT_MS = 6000;

class JbdClient {
  manager = new BleManager({
    restoreStateIdentifier: 'battery-watch',
    restoreStateFunction: () => {},
  });
  device: Device | null = null;
  private sub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;
  private asm = new FrameAssembler();
  private pending: { cmd: number; resolve: (d: number[]) => void } | null = null;
  private running = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();

  onReading(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onStatus(l: StatusListener) { this.statusListeners.add(l); return () => this.statusListeners.delete(l); }
  private status(s: string) { this.statusListeners.forEach((l) => l(s)); }

  // Finds the BMS by advertised service, or by saved id for instant reconnect.
  async scan(savedId?: string): Promise<Device> {
    this.status('Scanning…');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.manager.stopDeviceScan();
        reject(new Error('Battery not found. Is it on and nearby?'));
      }, 15000);
      this.manager.startDeviceScan(null, { allowDuplicates: false }, (err, dev) => {
        if (err) { clearTimeout(timer); return reject(err); }
        if (!dev) return;
        const isJbd =
          (savedId && dev.id === savedId) ||
          dev.serviceUUIDs?.some((u) => u.toLowerCase().includes('ff00')) ||
          dev.name?.toUpperCase().startsWith('JBD') ||
          dev.name?.toUpperCase().startsWith('DP04');
        if (isJbd) {
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          resolve(dev);
        }
      });
    });
  }

  // On a cold launch the manager reports 'Unknown' briefly; scanning then fails.
  private waitPoweredOn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { sub.remove(); reject(new Error('Bluetooth is off')); }, 5000);
      const sub = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') { clearTimeout(timer); sub.remove(); resolve(); }
      }, true);
    });
  }

  // iOS keeps the link to the BMS open after the app is closed (state restoration),
  // and the BMS stops advertising while connected, so a scan alone never finds it.
  // Reuse that system-level connection first, then try the saved id directly, then scan.
  private async find(savedId?: string): Promise<Device> {
    const attached = await this.manager.connectedDevices([SERVICE_UUID]).catch(() => [] as Device[]);
    if (attached.length) return attached.find((d) => d.id === savedId) ?? attached[0];
    if (savedId) {
      const [known] = await this.manager.devices([savedId]).catch(() => [] as Device[]);
      if (known) return known;
    }
    return this.scan(savedId);
  }

  async connect(savedId?: string) {
    await this.waitPoweredOn();
    this.status('Looking for battery…');
    let found = await this.find(savedId);
    this.status('Connecting…');
    let dev: Device;
    try {
      dev = await found.connect({ timeout: 10000 });
    } catch {
      // Stale link or out of range: drop whatever iOS is holding and scan fresh.
      await this.manager.cancelDeviceConnection(found.id).catch(() => {});
      found = await this.scan(savedId);
      this.status('Connecting…');
      dev = await found.connect({ timeout: 10000 });
    }
    await dev.discoverAllServicesAndCharacteristics();
    this.device = dev;
    this.asm.reset();

    this.sub = dev.monitorCharacteristicForService(SERVICE_UUID, NOTIFY_UUID, (err, ch) => {
      if (err || !ch?.value) return;
      for (const f of this.asm.push(b64ToBytes(ch.value))) {
        if (this.pending && this.pending.cmd === f.cmd) {
          const p = this.pending;
          this.pending = null;
          p.resolve(f.data);
        }
      }
    });

    this.disconnectSub = dev.onDisconnected(() => {
      this.status('Disconnected, retrying…');
      this.cleanup();
      if (this.running) setTimeout(() => this.connect(dev.id).then(() => this.loop()).catch(() => {}), 2000);
    });

    this.status('Connected');
    return dev.id;
  }

  private request(cmd: number): Promise<number[]> {
    return new Promise(async (resolve, reject) => {
      if (!this.device) return reject(new Error('Not connected'));
      const t = setTimeout(() => { this.pending = null; reject(new Error('timeout')); }, TIMEOUT_MS);
      this.pending = { cmd, resolve: (d) => { clearTimeout(t); resolve(d); } };
      try {
        await this.device.writeCharacteristicWithoutResponseForService(
          SERVICE_UUID, WRITE_UUID, bytesToB64(buildRead(cmd)),
        );
      } catch (e) { clearTimeout(t); this.pending = null; reject(e); }
    });
  }

  async start(savedId?: string) {
    this.running = true;
    const id = await this.connect(savedId);
    this.loop();
    return id;
  }

  stop() {
    this.running = false;
    this.device?.cancelConnection().catch(() => {});
    this.cleanup();
    this.status('Stopped');
  }

  private cleanup() {
    this.sub?.remove();
    this.sub = null;
    this.disconnectSub?.remove();
    this.disconnectSub = null;
    this.device = null;
    this.pending = null;
  }

  private async loop() {
    while (this.running && this.device) {
      try {
        const info = parseBasic(await this.request(CMD_BASIC));
        const cells = parseCells(await this.request(CMD_CELLS));
        const r = { info, cells, at: Date.now() };
        this.listeners.forEach((l) => l(r));
      } catch {
        // one missed poll is fine; disconnect handler covers real drops
      }
      // JS timers can freeze in the background, so there we skip the gap and
      // let each BLE reply drive the next write.
      if (AppState.currentState === 'active') {
        await new Promise((res) => setTimeout(res, POLL_GAP_MS));
      }
    }
  }
}

export const jbd = new JbdClient();
