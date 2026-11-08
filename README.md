# Battery Watch

Battery Watch is a small monitor for LiFePO4 batteries that use a **JBD BMS** (battery management system). It connects to the battery over Bluetooth, shows its live state, and sends you a notification when the charge crosses levels you choose, such as "30%, start winding down" or "100%, unplug the charger".

It was built for the JBD BMS inside an Ilzsolar LiFePO4 battery (`JBD-DP04S007-L4S100A`), but it should work with most JBD / "Xiaoxiang" BMS boards, since they share the same Bluetooth protocol.

The project has two clients that share the same protocol code:

| Client | Folder | Runs on |
| --- | --- | --- |
| **iPhone app** | project root (`App.tsx`, `src/`) | iOS, built with Expo + React Native |
| **Chrome extension** | [`extension/`](extension/) | Chrome or Edge on macOS, Windows, Linux |

---

## Why it exists

The official BMS app shows the numbers but won't tell you when something happens. If you're running appliances off the battery, you have to keep checking it. Battery Watch watches it for you and only interrupts when the charge reaches a level you care about.

## Features

- **Live readings**: state of charge (%), pack voltage, current, power draw or charge rate, stored Ah, and temperature.
- **Per-cell voltages**: each cell shown as a bar, with the spread between highest and lowest cell highlighted when it gets large (a sign the pack is out of balance).
- **Time estimates**: how long until the battery reaches each alert level while discharging, and how long until full while charging. Current is smoothed so a brief load spike doesn't make the estimate jump.
- **Custom alerts**: pick a percentage, a direction (▼ while discharging or ▲ while charging) and a label. Default alerts are 50%, 30%, 20% going down, and 100% going up.
- **No notification spam**: each alert fires once when the level is crossed, and re-arms only after the charge moves 3% back the other way.
- **Breaks through Focus** (iPhone): alerts are sent as time-sensitive notifications.
- **Protection warnings**: shows when the BMS has cut power because of over/under voltage, temperature, overcurrent, or a short circuit.
- **Auto-reconnect**: reconnects on its own if the Bluetooth link drops, and remembers your battery for quicker connections next time.
- **Background monitoring** (iPhone): keeps reading the battery while the app is in the background or the phone is locked.

---

## iPhone app

### Requirements

- A Mac with Xcode and Node.js 18 or newer
- An iPhone (Bluetooth does not work in the iOS Simulator)
- An Apple developer account (a free one is fine) for signing

### Install and run

```bash
git clone https://github.com/Crane04/battery-watch.git
cd battery-watch
npm install

# Generate the native iOS project
npx expo prebuild --platform ios

# Build and install on a connected iPhone
npx expo run:ios --device
```

Pick your iPhone from the list. The first time, open `ios/BatteryWatch.xcworkspace` in Xcode, choose your team under **Signing & Capabilities**, then run the last command again.

> If you're building under your own Apple account, change `ios.bundleIdentifier` and `ios.appleTeamId` in [`app.json`](app.json) to your own values first.

After the first install you can start the dev server with `npm start` and the app will reload as you edit code.

### Using it

1. **Close the official BMS app.** The battery only accepts one Bluetooth connection at a time.
2. Open Battery Watch and allow Bluetooth and notifications.
3. Tap **Connect & watch**. The app scans for the battery, connects, and starts polling every few seconds.
4. Under **Alerts**, tap **+ New** to add an alert, **Edit** to remove one, or use the switch to turn one off.
5. Leave the app open or send it to the background. Alerts arrive as normal notifications.

### First-run checks

- **The scan doesn't find the battery.** The app matches devices that advertise the JBD service (`FF00`) or whose name starts with `JBD` or `DP04`. If your battery uses a different name, log `dev.name` inside `scan()` in [`src/ble.ts`](src/ble.ts) and add its prefix to the match.
- **Background readings stop.** Lock the phone for 10+ minutes, then open the app and check the readings are current and alerts arrived. iOS can still suspend apps in some conditions.

---

## Chrome extension

The extension gives you the same view in a browser tab, plus the live percentage on the toolbar icon and desktop notifications for alerts. It uses Web Bluetooth, so it needs Chrome or Edge.

Quick install:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Pin Battery Watch to the toolbar, click it, then click **Connect & watch**.

See [`extension/README.md`](extension/README.md) for full details.

---

## How it works

### The JBD protocol

The BMS exposes one Bluetooth LE service with two characteristics:

| UUID | Purpose |
| --- | --- |
| `0000ff00-…` | Service |
| `0000ff02-…` | Write: send commands here |
| `0000ff01-…` | Notify: responses arrive here |

Every request is a short frame:

```
DD A5 <cmd> 00 <checksum_hi> <checksum_lo> 77
```

The app uses two commands:

- `0x03` **basic info**: voltage, current, remaining and nominal capacity, cycles, SOC, MOSFET state, balancing, protection flags, cell count, temperatures.
- `0x04` **cell voltages**: one 16-bit value per cell, in millivolts.

Responses come back as:

```
DD <cmd> <status> <len> <data...> <checksum_hi> <checksum_lo> 77
```

The checksum is `0x10000 − sum(status, len, data)`. Bluetooth delivers responses in chunks of about 20 bytes, so a `FrameAssembler` joins the chunks, finds frame boundaries, checks the end byte and checksum, and throws away anything corrupt.

### Polling and background mode

The app sends basic info, waits for the reply, sends cell voltages, waits for the reply, then waits about 3 seconds and repeats. Each request is sent from the previous reply instead of from a timer. This matters on iOS: when the app is in the background, iOS pauses JavaScript timers but still delivers Bluetooth events to apps with the `bluetooth-central` background mode. Chaining off replies keeps the loop running.

If a reply doesn't arrive within 6 seconds, the client treats the link as dead and reconnects. To find the battery again it first reuses any connection iOS is still holding (the BMS stops advertising while connected, so a scan alone wouldn't find it), then tries the saved device ID, and only then scans.

### Alerts

Each alert has a percentage and a direction. On every reading:

- A **▼ down** alert fires when the battery is discharging and SOC is at or below the target.
- An **▲ up** alert fires when the battery is charging and SOC is at or above the target.
- Once fired, it stays quiet until SOC moves 3% back past the target, then it re-arms.

Alerts and their fired state are saved on the device, so they survive restarts.

---

## Project structure

```
battery-watch/
├── App.tsx           # iPhone UI: charge display, stats, cells, alerts, alert editor
├── index.ts          # Expo entry point
├── app.json          # Expo config: Bluetooth background mode, permissions, plugins
├── src/
│   ├── jbd.ts        # JBD protocol: build commands, reassemble frames, parse data
│   ├── ble.ts        # Bluetooth client: find, connect, poll, reconnect
│   └── alerts.ts     # Alert storage, crossing detection, notifications
└── extension/        # Chrome / Edge extension (see extension/README.md)
    ├── manifest.json
    ├── background.js # Opens or focuses the tab, manages the toolbar badge
    ├── panel.html/.css/.js  # UI
    ├── jbd.js        # Same protocol as src/jbd.ts
    ├── ble.js        # Web Bluetooth connection and polling
    ├── ticker.js     # Worker timer so background tabs aren't throttled
    └── alerts.js     # Alerts and desktop notifications
```

The `ios/` folder is generated by `npx expo prebuild` and isn't committed.

## Tech stack

- [Expo](https://expo.dev) (SDK 55) and React Native 0.83 with TypeScript
- [react-native-ble-plx](https://github.com/dotintent/react-native-ble-plx) for Bluetooth LE
- [expo-notifications](https://docs.expo.dev/versions/latest/sdk/notifications/) for local alerts
- [AsyncStorage](https://react-native-async-storage.github.io/async-storage/) for saved alerts and the remembered device
- Web Bluetooth and the Chrome Extensions API (Manifest V3) for the browser version

## Limitations

- Only one device can connect to the BMS at a time. Close the official app (and the other Battery Watch client) before connecting.
- The SOC comes from the BMS's own estimate. If the BMS capacity setting is wrong, the percentage and time estimates will be too.
- The iPhone app is iOS only for now. The code is mostly cross-platform, but Android permissions and background behaviour haven't been set up.
