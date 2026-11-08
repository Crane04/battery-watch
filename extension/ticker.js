// Timers in a background tab get throttled to about once a minute; timers in a
// dedicated worker don't. ble.js asks this worker to wake it between polls.
self.onmessage = (e) => {
  const { id, ms } = e.data;
  setTimeout(() => self.postMessage(id), ms);
};
