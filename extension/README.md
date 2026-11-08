# Battery Watch for Chrome

A Chrome extension version of the app: the full battery view in a pinned tab, live % on the toolbar icon, and desktop notifications for your alerts. Works in Chrome or Edge on Mac, Windows and Linux.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension` folder.
4. Pin Battery Watch from the puzzle-piece menu so the icon stays on the toolbar.

On a Mac, also allow Chrome under System Settings → Privacy & Security → Bluetooth.

## Use

- Click the toolbar icon. It opens Battery Watch as a pinned tab, or jumps to it if it's already open.
- Click **Connect & watch** and pick the battery.
- Keep the tab open; it keeps polling while you use other tabs. Closing it ends the Bluetooth connection.
- The toolbar icon and the tab title show the current % while connected.
- **Can't find it? Show all devices** lists every nearby Bluetooth device, in case the battery doesn't advertise the usual name.

Why a tab and not a side panel: Chrome won't show its Bluetooth device picker from a side panel, and this Chrome version can't hand a battery picked in a tab over to one.

Close the official BMS app and the iPhone app first. The battery only accepts one Bluetooth connection at a time.

## Files

- `jbd.js`: the JBD protocol, same as `src/jbd.ts` in the app.
- `ble.js`: Web Bluetooth connection, polling and auto-reconnect.
- `ticker.js`: worker that times the polls, so background-tab throttling doesn't slow them.
- `alerts.js`: alert targets and Chrome notifications.
- `panel.html`, `panel.css`, `panel.js`: the UI.
- `background.js`: opens or focuses the tab from the toolbar icon and clears the badge when it closes.
