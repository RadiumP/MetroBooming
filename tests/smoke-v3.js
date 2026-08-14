// Smoke test for gps-accel-tester-v3.html using a minimal DOM shim.
// Verifies: load, https banner, begin->recording, GPS fix, devicemotion,
// tick rows, labeling, stop, CSV export.
"use strict";

const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("/home/user/MetroBooming/gps-accel-tester-v3.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const js = m[1];

// ---------- DOM shim ----------
const elements = {};
function makeEl(id) {
  const el = {
    id,
    className: "",
    style: {},
    dataset: {},
    disabled: false,
    checked: false,
    listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, force) {
        if (force === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (force) { this._s.add(c); } else { this._s.delete(c); }
      },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getContext() { return ctxStub; },
    click() {},
  };
  let _tc = "";
  Object.defineProperty(el, "textContent", {
    get() { return _tc; },
    set(v) { _tc = String(v); },
  });
  return el;
}
const ctxStub = new Proxy(
  { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {} },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; } }
);

const globals = {
  console,
  Date,
  Math,
  JSON,
  String,
  Number,
  Array,
  Object,
  Promise,
  Set,
  Map,
  Error,
  Uint8Array,
  Intl,
  parseFloat,
  isNaN,
  Blob: function (parts, opts) { this.parts = parts; globals.__lastBlob = this; },
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  confirm: () => true,
  isSecureContext: false,
};
globals.window = globals;
globals.self = globals;
globals.document = {
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  addEventListener() {},
  createElement(tag) { return makeEl(tag); },
  hidden: false,
  visibilityState: "visible",
};
globals.navigator = {
  geolocation: {
    watchPosition(cb) { globals.__gpsCb = cb; return 7; },
    clearWatch() {},
  },
  wakeLock: undefined,
};
globals.DeviceMotionEvent = {
  requestPermission: async () => "granted",
};
globals.addEventListener = function (ev, fn) { (globals.__handlers = globals.__handlers || {})[ev] = fn; };
globals.removeEventListener = function (ev) { if (globals.__handlers) delete globals.__handlers[ev]; };
let tickCb = null;
let timeoutCb = null;
globals.setInterval = (fn) => { tickCb = fn; return 1; };
globals.clearInterval = () => {};
globals.setTimeout = (fn) => { timeoutCb = fn; return 1; };
globals.clearTimeout = () => {};

const sandbox = vm.createContext(globals);
vm.runInContext(js, sandbox);

// dispatch helpers
function fire(id, ev) {
  for (const fn of (elements[id] || {}).listeners?.[ev] || []) fn({ target: elements[id] });
}
function fireMotion(coords) {
  if (!globals.__handlers?.devicemotion) throw new Error("devicemotion listener not attached");
  globals.__handlers.devicemotion({ acceleration: coords, interval: 16 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

(async () => {
  await sleep(10); // let async init() settle

  // 1. https banner shown (not secure context)
  assert(
    !elements["httpsWarn"].classList.contains("hidden"),
    "https banner should be visible in non-secure context"
  );

  // 2. begin
  fire("toggle", "click");
  await sleep(10); // let allSettled -> finishStart settle
  assert(globals.__handlers?.devicemotion, "devicemotion listener should be attached");
  assert(tickCb, "tick timer should be started immediately (even before sensors ready)");

  // 3. GPS fix (status updates immediately; value display updates on tick)
  globals.__gpsCb({ coords: { latitude: 30.0, longitude: 120.0, speed: 10, accuracy: 30 } });
  globals.__gpsCb({ coords: { latitude: 30.0, longitude: 120.001, speed: 12, accuracy: 25 } });
  assert(elements["gs"].textContent === "可靠", "GPS status ok: got " + elements["gs"].textContent);

  // 4. devicemotion events (linear path)
  for (let i = 0; i < 30; i++) fireMotion({ x: 0.1 + i * 0.01, y: 0.2, z: 9.7 });

  // 5. ticks -> rows
  for (let i = 0; i < 3; i++) tickCb();
  assert(parseInt(elements["count"].textContent, 10) === 3, "3 rows recorded: got " + elements["count"].textContent);
  assert(elements["gv"].textContent === "39.6", "GPS median speed display: got " + elements["gv"].textContent);

  // 6. labeling
  const btn = { dataset: { label: "停站" }, classList: makeEl("x").classList };
  const labelBtn = elements["labels"].listeners["click"][0];
  labelBtn({ target: { closest: () => btn } });
  assert(elements["currentLabel"].textContent === "停站", "label set: got " + elements["currentLabel"].textContent);
  assert(elements["segmentId"].textContent === "1", "segment id incremented: got " + elements["segmentId"].textContent);
  tickCb();
  assert(parseInt(elements["count"].textContent, 10) === 4, "4 rows after label tick");

  // 7. stop
  fire("toggle", "click");
  assert(elements["export"].disabled === false, "export enabled after stop");
  assert(elements["toggle"].textContent === "开始测试", "toggle text reset");

  // 8. export CSV
  fire("export", "click");
  const blob = globals.__lastBlob;
  assert(blob && blob.parts && blob.parts.length === 1, "blob created");
  const csv = blob.parts[0];
  assert(csv.startsWith("\ufeffts,elapsed_ms"), "CSV header ok: " + csv.slice(0, 30));
  assert(csv.includes('"停站"'), "mark column written");
  assert(csv.includes("gps_speed_smooth_kmh"), "smooth speed column present");
  const lineCount = csv.split("\n").length;
  assert(lineCount === 5, "1 header + 4 rows expected: got " + (lineCount - 1) + " rows");

  // 9. post-calibration classification (time travel past 20s)
  fire("toggle", "click"); // begin again
  await sleep(10);
  const realNow = Date.now;
  let timeOffset = 30000; // simulate 30s elapsed at start, then advance 250ms/tick
  globals.Date.now = () => realNow() + timeOffset;
  for (let i = 0; i < 50; i++) {
    timeOffset += 250;
    fireMotion({ x: 0.1 + (i % 5) * 0.01, y: 0.2, z: 9.7 });
    tickCb();
  }
  globals.Date.now = realNow;
  assert(
    elements["trainState"].textContent !== "校准中",
    "classifier should exit calibration: got " + elements["trainState"].textContent
  );
  assert(
    !elements["trainState"].textContent.startsWith("校准中"),
    "trainState text: got " + elements["trainState"].textContent
  );
  assert(
    parseFloat(elements["conf"].style.width) > 50,
    "confidence bar should be >50%: got " + elements["conf"].style.width
  );

  console.log("ALL SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
