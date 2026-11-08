import {
  SERVICE_UUID, NOTIFY_UUID, WRITE_UUID, CMD_BASIC, CMD_CELLS,
  FrameAssembler, buildRead, parseBasic, parseCells,
} from './jbd.js';

// Same polling scheme as the app: ask for basic info, then cells, wait, repeat.
const POLL_GAP_MS = 3000;
const TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 10000;

// Sleep via a worker so polling keeps its pace while the tab is in the background.
const ticker = new Worker(new URL('./ticker.js', import.meta.url));
const wakeups = new Map();
let nextWake = 0;
ticker.onmessage = (e) => { wakeups.get(e.data)?.(); wakeups.delete(e.data); };
const sleep = (ms) => new Promise((r) => {
  const id = ++nextWake;
  wakeups.set(id, r);
  ticker.postMessage({ id, ms });
});

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

class JbdClient {
  device = null;
  notifyChar = null;
  writeChar = null;
  asm = new FrameAssembler();
  pending = null;
  running = false;
  loopToken = 0;
  listeners = new Set();
  statusListeners = new Set();

  constructor() {
    this.onValue = this.onValue.bind(this);
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  onReading(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onStatus(l) { this.statusListeners.add(l); return () => this.statusListeners.delete(l); }
  status(s) { this.statusListeners.forEach((l) => l(s)); }

  get supported() { return !!navigator.bluetooth; }

  // Must be called straight from a click: Chrome only shows its device picker
  // in response to a user gesture.
  pick(showAll = false) {
    return navigator.bluetooth.requestDevice(showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : {
        filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'JBD' }, { namePrefix: 'DP04' }],
        optionalServices: [SERVICE_UUID],
      });
  }

  // A battery chosen on an earlier visit, if Chrome still remembers the permission.
  async known(id) {
    if (!id || !navigator.bluetooth?.getDevices) return null;
    const devices = await navigator.bluetooth.getDevices().catch(() => []);
    return devices.find((d) => d.id === id) ?? null;
  }

  async start(device) {
    this.stop(true);
    this.running = true;
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      await this.connect();
    } catch (e) {
      this.stop(true);
      throw e;
    }
    this.loop();
    return device.id;
  }

  async connect() {
    this.status('Connecting…');
    const server = await withTimeout(this.device.gatt.connect(), CONNECT_TIMEOUT_MS,
      'Battery not reachable. Is it on and nearby?');
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    this.writeChar = await service.getCharacteristic(WRITE_UUID);
    this.asm.reset();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
    await this.notifyChar.startNotifications();
    this.status('Connected');
  }

  onValue(e) {
    const v = e.target.value;
    const bytes = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    for (const f of this.asm.push(bytes)) {
      if (this.pending && this.pending.cmd === f.cmd) {
        const p = this.pending;
        this.pending = null;
        p.resolve(f.data);
      }
    }
  }

  onDisconnected() {
    this.cleanup();
    if (!this.running) return;
    this.status('Disconnected, retrying…');
    this.reconnect();
  }

  async reconnect() {
    let delay = 2000;
    while (this.running && !this.device?.gatt.connected) {
      await sleep(delay);
      if (!this.running) return;
      try {
        await this.connect();
        this.loop();
        return;
      } catch {
        this.status('Battery out of reach, retrying…');
        delay = Math.min(delay * 1.5, 15000);
      }
    }
  }

  request(cmd) {
    return new Promise(async (resolve, reject) => {
      if (!this.writeChar) return reject(new Error('Not connected'));
      const t = setTimeout(() => { this.pending = null; reject(new Error('timeout')); }, TIMEOUT_MS);
      this.pending = { cmd, resolve: (d) => { clearTimeout(t); resolve(d); } };
      try {
        const bytes = new Uint8Array(buildRead(cmd));
        if (this.writeChar.properties.writeWithoutResponse) {
          await this.writeChar.writeValueWithoutResponse(bytes);
        } else {
          await this.writeChar.writeValueWithResponse(bytes);
        }
      } catch (e) { clearTimeout(t); this.pending = null; reject(e); }
    });
  }

  stop(silent = false) {
    this.running = false;
    this.loopToken++;
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    }
    this.cleanup();
    this.device = null;
    if (!silent) this.status('Stopped');
  }

  cleanup() {
    this.notifyChar?.removeEventListener('characteristicvaluechanged', this.onValue);
    this.notifyChar = null;
    this.writeChar = null;
    this.pending = null;
  }

  async loop() {
    // Only one poll loop at a time, even across reconnects.
    const token = ++this.loopToken;
    while (this.running && this.writeChar && token === this.loopToken) {
      try {
        const info = parseBasic(await this.request(CMD_BASIC));
        const cells = parseCells(await this.request(CMD_CELLS));
        const r = { info, cells, at: Date.now() };
        this.listeners.forEach((l) => l(r));
      } catch {
        // one missed poll is fine; the disconnect handler covers real drops
      }
      await sleep(POLL_GAP_MS);
    }
  }
}

export const jbd = new JbdClient();
