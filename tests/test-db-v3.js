// Test IndexedDB draft persistence + crash-restore flow for gps-accel-tester-v3.html.
// Uses an in-memory fake IndexedDB shared across two simulated page loads.
"use strict";

const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("/home/user/MetroBooming/gps-accel-tester-v3.html", "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---------- fake IndexedDB (shared between contexts) ----------
function FakeRequest(result) {
  this.result = result;
  this.onsuccess = null;
  this.onerror = null;
  this.onupgradeneeded = null;
}
function FakeDB() {
  const stores = {}; // name -> Map(key -> record)
  this.open = (name) => {
    const req = new FakeRequest();
    setTimeout(() => {
      const db = {
        createObjectStore(storeName) {
          if (!stores[storeName]) stores[storeName] = new Map();
          db._storeName = storeName;
        },
        transaction(storeName) {
          const store = stores[storeName];
          const t = {
            objectStore() {
              return {
                put(rec) { store.set(rec.key, rec); return new FakeRequest(rec.key); },
                getAll() { return new FakeRequest([...store.values()]); },
                delete(k) { store.delete(k); return new FakeRequest(k); },
              };
            },
          };
          setTimeout(() => t.oncomplete && t.oncomplete(), 0);
          return t;
        },
      };
      req.result = db;
      req.onupgradeneeded && req.onupgradeneeded({ result: db });
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  };
  this.dump = (name) => (stores[name] ? [...stores[name].values()] : []);
}
const sharedDB = new FakeDB();

// ---------- sandbox factory ----------
const ctxStub = new Proxy(
  { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {} },
  { get(t, k) { return k in t ? t[k] : () => {}; }, set(t, k, v) { t[k] = v; return true; } }
);
function makeSandbox() {
  const elements = {};
  function makeEl(id) {
    const el = {
      id, className: "", style: {}, dataset: {}, disabled: false, checked: false, listeners: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (f) { this._s.add(c); } else { this._s.delete(c); } },
        contains(c) { return this._s.has(c); },
      },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      querySelectorAll() { return []; }, closest() { return null; },
      getContext() { return ctxStub; }, click() {},
    };
    let _tc = "";
    Object.defineProperty(el, "textContent", { get() { return _tc; }, set(v) { _tc = String(v); } });
    return el;
  }
  const g = {
    console, Date, Math, JSON, String, Number, Array, Object, Promise, Set, Map, Error,
    Uint8Array, parseFloat, isNaN,
    Blob: function (parts) { this.parts = parts; g.__lastBlob = this; },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    confirm: () => true,
    isSecureContext: true, // secure so no https banner interference
    indexedDB: sharedDB,
    document: {
      getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
      addEventListener() {}, createElement(t) { return makeEl(t); },
      hidden: false, visibilityState: "visible",
    },
    navigator: { geolocation: undefined, wakeLock: undefined },
    DeviceMotionEvent: undefined, // keep motion inactive for this test
  };
  g.window = g; g.self = g;
  g.addEventListener = function (ev, fn) { (g.__handlers = g.__handlers || {})[ev] = fn; };
  g.removeEventListener = function (ev) { if (g.__handlers) delete g.__handlers[ev]; };
  let tickCb = null;
  g.setInterval = (fn) => { tickCb = fn; return 1; };
  g.clearInterval = () => {};
  g.setTimeout = (fn) => { g.__timeout = fn; return 1; };
  g.clearTimeout = () => {};
  g.fire = (id, ev) => {
    for (const fn of (elements[id] || {}).listeners?.[ev] || []) fn({ target: elements[id] });
  };
  g.tick = () => tickCb && tickCb();
  g.getEl = (id) => elements[id];
  // banners start hidden in the HTML markup; mirror that in the shim
  const mk = (id) => elements[id] || (elements[id] = makeEl(id));
  mk("httpsWarn").classList.add("hidden");
  mk("draftBanner").classList.add("hidden");
  return { sandbox: vm.createContext(g), g };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

(async () => {
  // ============ PAGE LOAD 1 ============
  const s1 = makeSandbox();
  vm.runInContext(js, s1.sandbox);
  await sleep(20);
  assert(s1.g.getEl("draftBanner").classList.contains("hidden"), "no draft banner on fresh load");

  // record a session: 45 ticks (batch flush at 40, then stop flushes the rest)
  s1.g.fire("toggle", "click"); // begin
  await sleep(5);
  for (let i = 0; i < 45; i++) s1.g.tick();
  await sleep(20);
  assert(s1.g.getEl("count").textContent === "45", "45 rows recorded: got " + s1.g.getEl("count").textContent);
  s1.g.fire("toggle", "click"); // stop -> flushes remaining 5 rows
  await sleep(20); // let async IndexedDB writes settle
  const parts = sharedDB.dump("parts");
  const meta = parts.filter((p) => p.type === "meta");
  const dataParts = parts.filter((p) => Array.isArray(p.rows));
  assert(meta.length === 1, "one meta record saved");
  assert(dataParts.length === 2, "2 parts saved (40 batch + 5 at stop): got " + dataParts.length);
  const totalRows = dataParts.reduce((s, p) => s + p.rows.length, 0);
  assert(totalRows === 45, "45 rows persisted in draft: got " + totalRows);
  assert(s1.g.getEl("draftInfo").textContent.includes("已自动保存"), "draft info shown");

  // simulate crash: no export, just leave

  // ============ PAGE LOAD 2 (fresh context, same IndexedDB) ============
  const s2 = makeSandbox();
  vm.runInContext(js, s2.sandbox);
  await sleep(20);
  assert(!s2.g.getEl("draftBanner").classList.contains("hidden"), "draft banner appears after reload");
  assert(s2.g.getEl("draftCount").textContent === "45", "banner shows 45 rows: got " + s2.g.getEl("draftCount").textContent);

  // restore
  s2.g.fire("restoreDraftBtn", "click");
  assert(s2.g.getEl("count").textContent === "45", "count restored to 45: got " + s2.g.getEl("count").textContent);
  assert(s2.g.getEl("export").disabled === false, "export enabled after restore");
  await sleep(20); // let async clearDraft settle
  assert(sharedDB.dump("parts").length === 0, "draft cleared after restore");

  // export the restored data
  s2.g.fire("export", "click");
  const csv = s2.g.__lastBlob.parts[0];
  const lines = csv.split("\n");
  assert(lines.length === 46, "header + 45 rows: got " + (lines.length - 1));

  // ============ discard path ============
  const s3 = makeSandbox();
  vm.runInContext(js, s3.sandbox);
  await sleep(20);
  // simulate a fresh session with one part saved then discarded
  s3.g.fire("toggle", "click");
  await sleep(5);
  for (let i = 0; i < 5; i++) s3.g.tick();
  await sleep(20);
  s3.g.fire("toggle", "click"); // stop (doesn't clear draft)
  await sleep(20);
  assert(sharedDB.dump("parts").length > 0, "draft exists after stop without export");

  const s4 = makeSandbox();
  vm.runInContext(js, s4.sandbox);
  await sleep(20);
  assert(!s4.g.getEl("draftBanner").classList.contains("hidden"), "banner appears again");
  s4.g.fire("discardDraftBtn", "click");
  assert(s4.g.getEl("draftBanner").classList.contains("hidden"), "banner hidden after discard");
  await sleep(20); // let async clearDraft settle
  assert(sharedDB.dump("parts").length === 0, "draft cleared after discard");

  console.log("ALL DB PERSISTENCE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e); process.exit(1); });
