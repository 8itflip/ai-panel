// AI Panel Desk: Stream Deck keys that show AI Panel data, plus a few desk toggles.
// Plain Node, no dependencies. Stream Deck starts it with -port, -pluginUUID, -registerEvent and -info.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PANEL = process.env.AI_PANEL_URL || "http://localhost:7319";
const PREFIX = "local.ai-panel.desk.";
const MEETING_LEAD = 10 * 60000; // same join window as the panel: 10 min before until 10 min after the start

/* ---------- text ---------- */

const STRINGS = {
  en: {
    waiting: "waiting", working: "working", idle: "all quiet", offline: "AI Panel", offlineSub: "offline",
    meeting: "meeting", noMeetings: "none today", in: "in {n} min", now: "now", since: "{n} min ago", join: "JOIN",
    micOn: "mic on", micOff: "muted", reset: "reset {t}", week: "week {n}%",
    awake: "awake", sleepOk: "can sleep", amphetamine: "Amphetamine",
  },
  pl: {
    waiting: "czeka", working: "pracuje", idle: "cisza", offline: "AI Panel", offlineSub: "offline",
    meeting: "spotkanie", noMeetings: "brak dziś", in: "za {n} min", now: "teraz", since: "{n} min temu", join: "DOŁĄCZ",
    micOn: "mikrofon", micOff: "wyciszony", reset: "reset {t}", week: "tydz. {n}%",
    awake: "nie śpi", sleepOk: "może spać", amphetamine: "Amphetamine",
  },
};
let LANG = "en";
const t = (k, v = {}) => (STRINGS[LANG][k] || k).replace(/\{(\w+)\}/g, (_, x) => v[x]);

/* ---------- key images ---------- */

const C = { idle: "#1c1f26", alert: "#c62828", warn: "#a85d00", ok: "#2e7d32", info: "#1f3a5f", off: "#3a3d44" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fit = (s, n) => (s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s;

// Splits text into at most `max` lines of about `width` characters, breaking on spaces and name separators.
function wrap(text, width, max) {
  const words = String(text ?? "").trim().split(/(?<=[\s\-_/:.])/).filter(Boolean)
    .flatMap((w) => w.match(new RegExp(`.{1,${width}}`, "g"))); // a word longer than a line is cut into pieces
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + w).trim().length > width && line) { lines.push(line.trim()); line = ""; }
    line += w;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > max) { lines.length = max; lines[max - 1] = fit(lines[max - 1] + " …", width); }
  return lines.map((l) => fit(l, width));
}

const GLYPHS = {
  mic: '<rect x="58" y="22" width="28" height="48" rx="14" fill="#fff"/>' +
    '<path d="M46 58a26 26 0 0 0 52 0M72 84v14M58 98h28" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>',
  micOff: '<line x1="40" y1="24" x2="104" y2="96" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
  cup: '<path d="M44 44h48v26a22 22 0 0 1-22 22h-4a22 22 0 0 1-22-22z" fill="#fff"/>' +
    '<path d="M92 52h6a10 10 0 0 1 0 20h-6" stroke="#fff" stroke-width="6" fill="none"/>' +
    '<path d="M58 22q6 6 0 12M72 22q6 6 0 12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/>',
};

// One 144×144 key: a small label on top, a big value, then up to three short lines (or a glyph instead of the value).
function key({ bg = C.idle, top = "", big = "", lines = [], glyph = "" }) {
  const text = (s, y, size, weight = 500, opacity = 1) =>
    `<text x="72" y="${y}" font-size="${size}" font-weight="${weight}" fill="#fff" fill-opacity="${opacity}" text-anchor="middle">${esc(s)}</text>`;
  let body = top ? text(fit(top, 12), 28, 19, 600, 0.8) : "";
  if (glyph) {
    body = glyph + (top ? text(fit(top, 12), 128, 19, 600, 0.9) : "");
  } else if (big !== "") {
    const s = String(big);
    body += text(s, 82, s.length > 4 ? 38 : 56, 700);
    lines.slice(0, 2).forEach((l, i) => { body += text(fit(l, 13), 110 + i * 22, 18, 500, 0.85); });
  } else {
    const start = lines.length > 2 ? 58 : 70;
    lines.slice(0, 4).forEach((l, i) => { body += text(fit(l, 12), start + i * 24, 20, i === 0 ? 700 : 500); });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect width="144" height="144" fill="${bg}"/><g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">${body}</g></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

const offline = () => key({ bg: C.off, top: t("offline"), lines: [t("offlineSub")] });

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
}

/* ---------- AI Panel keys ---------- */

function sessions(st) {
  return [...(st.claude?.sessions || []).map((s) => ({ ...s, tool: "claude" })),
    ...(st.codex?.sessions || []).map((s) => ({ ...s, tool: "codex" }))];
}

// The session that has waited longest is the one to answer first.
function oldestWaiting(st) {
  return sessions(st).filter((s) => s.state === "waiting").sort((a, b) => a.time - b.time)[0] || null;
}

function drawWaiting(st) {
  const all = sessions(st);
  const waiting = all.filter((s) => s.state === "waiting");
  const working = all.filter((s) => s.state === "working").length;
  if (waiting.length) {
    const s = oldestWaiting(st);
    return key({ bg: C.alert, top: t("waiting"), big: waiting.length, lines: [s.name || s.project || ""] });
  }
  if (working) return key({ bg: C.info, top: t("working"), big: working });
  return key({ top: t("idle"), big: "0" });
}

function accounts(st) {
  const list = [];
  const c = st.claude || {};
  if (c.usage) list.push({ label: c.usage.label || "Claude", u: c.usage });
  for (const a of c.accounts || []) list.push({ label: a.label || "Claude", u: a });
  if (st.codex?.usage) list.push({ label: "Codex", u: st.codex.usage });
  return list;
}

function drawLimits(st, settings, now = Date.now()) {
  const list = accounts(st);
  if (!list.length) return offline();
  const { label, u } = list[(settings.account || 0) % list.length];
  const s = u.session || {};
  if (typeof s.pct !== "number") return key({ bg: C.off, top: label, big: "–" });
  const tight = s.pct >= 85 || s.forecast?.beforeReset;
  const bg = tight ? C.alert : s.pct >= 60 ? C.warn : C.ok;
  const lines = [s.resetsAt ? t("reset", { t: duration(s.resetsAt - now) }) : "",
    typeof u.weekly?.pct === "number" ? t("week", { n: u.weekly.pct }) : ""].filter(Boolean);
  return key({ bg, top: label, big: `${s.pct}%`, lines });
}

function nextMeeting(st, now = Date.now()) {
  return (st.calendar?.events || []).filter((e) => !e.allDay && e.end > now).sort((a, b) => a.start - b.start)[0] || null;
}

function when(e, now) {
  const mins = Math.round((e.start - now) / 60000);
  if (mins > 60) {
    const sameDay = new Date(e.start).toDateString() === new Date(now).toDateString();
    return new Date(e.start).toLocaleString(LANG === "pl" ? "pl-PL" : "en-GB",
      sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (e.start <= now && e.end > now && mins < 0) return t("since", { n: -mins });
  return mins > 0 ? t("in", { n: mins }) : t("now");
}

function drawMeeting(st, now = Date.now()) {
  const e = nextMeeting(st, now);
  if (!e) return key({ top: t("meeting"), lines: [t("noMeetings")] });
  const inWindow = e.start - now <= MEETING_LEAD && now - e.start <= MEETING_LEAD;
  const title = wrap(e.title, 12, inWindow && e.link ? 2 : 3);
  if (inWindow && e.link) return key({ bg: C.ok, top: when(e, now), lines: [...title, `▶ ${t("join")}`] });
  return key({ bg: inWindow ? C.info : C.idle, top: when(e, now), lines: title });
}

async function panelState() {
  const r = await fetch(`${PANEL}/api/state`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`AI Panel: HTTP ${r.status}`);
  return r.json();
}

// The panel only accepts opens from its own origin; it looks the address up in its own data.
async function panelOpen(body) {
  const r = await fetch(`${PANEL}/api/open`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: PANEL },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return r.ok;
}

/* ---------- desk keys ---------- */

function run(file, args, opts = {}) {
  return new Promise((resolve) => execFile(file, args, { timeout: 15000, ...opts },
    (err, stdout) => resolve({ ok: !err, out: String(stdout || "").trim() })));
}
const osa = (script) => run("/usr/bin/osascript", ["-e", script]);

async function micVolume() {
  const r = await osa("input volume of (get volume settings)");
  const v = Number(r.out);
  if (!r.ok || Number.isNaN(v)) throw new Error("no input device");
  return v;
}

function drawMic(volume) {
  return volume === 0
    ? key({ bg: C.alert, glyph: GLYPHS.mic + GLYPHS.micOff, top: t("micOff") })
    : key({ glyph: GLYPHS.mic, top: t("micOn") });
}

// kubectl writes the current context to the first file of KUBECONFIG, so use the same list as the login shell.
let kubeEnv = null;
async function kubeconfig() {
  if (kubeEnv !== null) return kubeEnv;
  const r = await run("/bin/zsh", ["-lic", 'print -r -- "@@KC@@${KUBECONFIG}@@"']);
  kubeEnv = (r.out.match(/@@KC@@([^@]*)@@/) || [])[1] || process.env.KUBECONFIG || "";
  return kubeEnv;
}
const KUBECTL = ["/opt/homebrew/bin/kubectl", "/usr/local/bin/kubectl"].find((p) => fs.existsSync(p)) || "kubectl";
async function kubectl(args) {
  const env = { ...process.env };
  const kc = await kubeconfig();
  if (kc) env.KUBECONFIG = kc;
  return run(KUBECTL, args, { env });
}

async function kubeContext() {
  const r = await kubectl(["config", "current-context"]);
  if (!r.ok) throw new Error("no kube context");
  return r.out;
}

const contextList = (settings) => String(settings.contexts || "").split(/[\s,]+/).filter(Boolean);

// The next favourite after the current one; from outside the list, the first one.
function nextContext(current, list) {
  if (!list.length) return null;
  return list[(list.indexOf(current) + 1) % list.length];
}

const isProduction = (name) => /prd|prod/i.test(name);

function drawKube(name) {
  const short = name.split("/").pop(); // EKS ARNs and OpenShift user contexts end in the useful part
  return key({ bg: isProduction(name) ? C.alert : C.info, top: "kube", lines: wrap(short, 11, 3) });
}

async function amphetamineActive() {
  if (!(await run("/usr/bin/pgrep", ["-x", "Amphetamine"])).ok) return null; // asking would launch it
  return (await osa('tell application "Amphetamine" to session is active')).out === "true";
}

function drawAmphetamine(active) {
  if (active === null) return key({ bg: C.off, glyph: GLYPHS.cup, top: t("amphetamine") });
  return active ? key({ bg: C.warn, glyph: GLYPHS.cup, top: t("awake") }) : key({ glyph: GLYPHS.cup, top: t("sleepOk") });
}

function terminal(command) {
  const shell = `${command}; exec /bin/zsh -l`;
  if (fs.existsSync("/Applications/Ghostty.app")) {
    return run("/usr/bin/open", ["-na", "Ghostty.app", "--args", "-e", "/bin/zsh", "-lic", shell]);
  }
  return osa(`tell application "Terminal" to do script ${JSON.stringify(command)}`);
}

/* ---------- actions ---------- */

const SOURCES = {
  panel: { every: 5000, load: panelState },
  mic: { every: 3000, load: micVolume },
  kube: { every: 5000, load: kubeContext },
  amphetamine: { every: 10000, load: amphetamineActive },
};

const ACTIONS = {
  waiting: {
    source: "panel", draw: (st) => drawWaiting(st),
    async press(k, st) {
      const s = st && oldestWaiting(st);
      return !!s && panelOpen({ kind: "session", tool: s.tool, id: s.id });
    },
  },
  limits: {
    source: "panel", draw: (st, settings) => drawLimits(st, settings),
    async press(k, st, ctx) {
      const n = st ? accounts(st).length : 0;
      if (!n) return false;
      k.settings = { ...k.settings, account: ((k.settings.account || 0) + 1) % n };
      send("setSettings", ctx, k.settings);
      return "quiet";
    },
  },
  meeting: {
    source: "panel", draw: (st) => drawMeeting(st),
    async press(k, st) {
      const e = st && nextMeeting(st);
      return !!e?.link && panelOpen({ kind: "event", start: e.start, title: e.title });
    },
  },
  mic: {
    source: "mic", draw: drawMic,
    async press(k, volume, ctx) {
      if (typeof volume !== "number") return false;
      if (volume > 0) {
        k.settings = { ...k.settings, restore: volume };
        send("setSettings", ctx, k.settings);
      }
      return (await osa(`set volume input volume ${volume > 0 ? 0 : k.settings.restore || 75}`)).ok && "quiet";
    },
  },
  kube: {
    source: "kube", draw: drawKube,
    async press(k, current) {
      const next = nextContext(current, contextList(k.settings));
      return !!next && (await kubectl(["config", "use-context", next])).ok;
    },
  },
  amphetamine: {
    source: "amphetamine", draw: drawAmphetamine,
    async press(k, active) {
      if (active === null || active === undefined) return false;
      return (await osa(`tell application "Amphetamine" to ${active ? "end session" : "start new session"}`)).ok && "quiet";
    },
  },
  run: {
    async press(k) {
      return !!k.settings.command && (await run("/bin/zsh", ["-lc", k.settings.command])).ok;
    },
  },
  terminal: {
    async press(k) {
      return !!k.settings.command && (await terminal(k.settings.command)).ok;
    },
  },
};

/* ---------- Stream Deck connection ---------- */

const keys = new Map(); // context → { name, settings }
const data = {}; // source → { value } or { error }
let ws = null;

function send(event, context, payload) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ event, context, payload }));
}

function draw(context) {
  const k = keys.get(context);
  const a = k && ACTIONS[k.name];
  if (!a?.source || !data[a.source]) return;
  const d = data[a.source];
  let image;
  try {
    image = "error" in d ? (a.source === "panel" ? offline() : key({ bg: C.off, top: k.name, lines: ["–"] })) : a.draw(d.value, k.settings);
  } catch (err) {
    console.error(k.name, err);
    image = key({ bg: C.off, top: k.name, lines: ["?"] });
  }
  if (image !== k.image) { k.image = image; send("setImage", context, { image, target: 0 }); }
}

async function refresh(source) {
  try {
    data[source] = { value: await SOURCES[source].load() };
  } catch (err) {
    data[source] = { error: String(err.message || err) };
  }
  for (const [context, k] of keys) if (ACTIONS[k.name]?.source === source) draw(context);
}

const visible = (source) => [...keys.values()].some((k) => ACTIONS[k.name]?.source === source);

async function handle({ event, action, context, payload }) {
  const name = action?.startsWith(PREFIX) ? action.slice(PREFIX.length) : null;
  if (event === "willAppear" && ACTIONS[name]) {
    keys.set(context, { name, settings: payload?.settings || {} });
    const source = ACTIONS[name].source;
    if (source) data[source] ? draw(context) : refresh(source);
  } else if (event === "willDisappear") {
    keys.delete(context);
  } else if (event === "didReceiveSettings" && keys.has(context)) {
    keys.get(context).settings = payload?.settings || {};
    draw(context);
  } else if (event === "keyDown" && keys.has(context)) {
    const k = keys.get(context);
    const a = ACTIONS[k.name];
    const result = await a.press(k, data[a.source]?.value, context).catch((err) => { console.error(err); return false; });
    if (result !== "quiet") send(result ? "showOk" : "showAlert", context);
    if (a.source) setTimeout(() => refresh(a.source), 300);
  }
}

async function start() {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const langs = await run("/usr/bin/defaults", ["read", "-g", "AppleLanguages"]);
  if (/^\s*"?pl\b/m.test(langs.out.split("\n")[1] || "")) LANG = "pl";
  for (const [source, s] of Object.entries(SOURCES)) {
    setInterval(() => { if (visible(source)) refresh(source); }, s.every);
  }
  ws = new WebSocket(`ws://127.0.0.1:${arg("-port")}`);
  ws.onopen = () => ws.send(JSON.stringify({ event: arg("-registerEvent"), uuid: arg("-pluginUUID") }));
  ws.onmessage = (m) => handle(JSON.parse(m.data)).catch((err) => console.error(err));
  ws.onclose = () => process.exit(0);
}

if (require.main === module) start();
else module.exports = { key, wrap, duration, drawWaiting, drawLimits, drawMeeting, nextMeeting, oldestWaiting,
  accounts, nextContext, contextList, isProduction, setLang: (l) => { LANG = l; } };
