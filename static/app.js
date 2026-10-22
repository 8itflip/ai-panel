"use strict";

const POLL_MS = 3000;
const ORDER = { waiting: 0, working: 1, done: 2, aborted: 3 };
const LABEL = { waiting: "Czeka na Ciebie", working: "Pracuje", done: "Gotowe", aborted: "Przerwane" };
const ICON = {
  waiting: '<span class="dot"></span>',
  working: '<span class="spin"></span>',
  done: '<span class="check">✓</span>',
  aborted: '<span class="stop"></span>',
};

let last = null;
let lastOk = 0;
const sigs = {};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const hm = (ms) => { const d = new Date(ms); return `${d.getHours()}:${pad(d.getMinutes())}`; };

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "teraz";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function until(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `za ${m} min`;
  if (m < 24 * 60) return `za ${Math.floor(m / 60)} h ${m % 60} min`;
  const d = Math.round(m / 1440);
  return `za ${d} ${plural(d, "dzień", "dni", "dni")}`;
}

function chatCost(c) {
  // Orientacyjny koszt czatu po cenach API; „+” = część odpowiedzi bez znanej ceny modelu.
  if (!c) return "";
  const x = c.usd, digits = x < 10 ? 2 : x < 100 ? 1 : 0;
  const n = x.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `≈ $${n}${c.partial ? "+" : ""}`;
}

function usd(x) {
  return "$" + Math.round(x).toLocaleString("pl-PL");
}

/* ---------- zegar ---------- */

function tickClock() {
  const now = new Date();
  $("#time").textContent = `${now.getHours()}:${pad(now.getMinutes())}`;
  $("#date").textContent = now.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
  document.querySelectorAll("[data-ago]").forEach((el) => { el.textContent = ago(+el.dataset.ago); });
  document.querySelectorAll("[data-until]").forEach((el) => { el.textContent = "reset " + until(+el.dataset.until); });
}

/* ---------- kolumny narzędzi ---------- */

function meter(label, bar) {
  if (!bar) return "";
  const filled = Math.round(bar.pct / 5);
  const segs = Array.from({ length: 20 }, (_, i) => `<i${i < filled ? ' class="f"' : ""}></i>`).join("");
  return `<div class="meter${bar.pct >= 80 ? " hot" : ""}">
    <div class="row1"><span>${label}</span><span class="pct">${bar.pct}%</span></div>
    <div class="segs">${segs}</div>
    <div class="reset" ${bar.resetsAt ? `data-until="${bar.resetsAt}"` : ""}></div>
  </div>`;
}

function renderUsage(col, usage, error) {
  $(".plan", col).textContent = usage?.plan || "";
  const cost = $(".cost", col);
  if (usage && usage.month != null) {
    cost.innerHTML = `dziś <b>${usd(usage.today || 0)}</b> · 30 dni <b>${usd(usage.month)}</b>` +
      (usage.multiple ? ` · <em>${String(usage.multiple).replace(".", ",")}×</em> abonamentu` : "");
  } else {
    cost.textContent = "";
  }
  const bars = $(".bars", col);
  bars.innerHTML = usage
    ? meter("Limit 5 h", usage.session) + meter("Limit tygodniowy", usage.weekly)
    : `<div class="na">${esc(error || "Brak danych o limitach")}</div>`;
}

function sessionRow(s, tool) {
  const label = s.state === "waiting" && s.detail === "pytanie" ? "Pytanie do Ciebie" : LABEL[s.state] || s.state;
  const tip = s.detail && s.detail !== "pytanie" ? ` title="${esc(s.detail)}"` : "";
  const open = s.url ? ` data-tool="${tool}" data-id="${esc(s.id)}"` : "";
  return `<li class="s ${s.state}"${tip}${open}>
    <span class="ic">${ICON[s.state] || ""}</span>
    <div class="main">
      <div class="name"><span class="n">${esc(s.name)}</span><span class="proj">${esc(s.project)}</span></div>
      <div class="msg">${esc(s.message) || "&nbsp;"}</div>
    </div>
    <div class="right">
      <div class="lbl">${label}</div>
      <div class="when"><span class="usd" data-cost="${esc(s.id)}">${chatCost(s.cost)}</span><span data-ago="${s.time || Date.now()}"></span></div>
    </div>
  </li>`;
}

function fitList(ul) {
  // Ukryj nadmiar wierszy od dołu (najstarsze gotowe) i pokaż „+N”.
  let hidden = 0;
  let more = null;
  while (ul.scrollHeight > ul.clientHeight + 1) {
    const rows = ul.querySelectorAll(".s");
    if (rows.length <= 1) break;
    rows[rows.length - 1].remove();
    hidden++;
    if (!more) { more = document.createElement("li"); more.className = "more"; ul.appendChild(more); }
    more.textContent = `+${hidden} ${plural(hidden, "sesja", "sesje", "sesji")} więcej`;
  }
}

function updateCosts(col, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s.cost]));
  col.querySelectorAll("[data-cost]").forEach((el) => {
    const text = chatCost(byId.get(el.dataset.cost));
    if (el.textContent !== text) el.textContent = text;
  });
}

function renderTool(key, data, usageError) {
  const col = $(`.col[data-tool="${key}"]`);
  renderUsage(col, data.usage, usageError);
  const sessions = [...data.sessions].sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.time - a.time));
  const sig = JSON.stringify([sessions.map((s) => [s.id, s.state, s.name, s.project, s.message, s.detail]), data.error]);
  if (sigs[key] === sig) return updateCosts(col, sessions); // bez zmian — nie restartujemy animacji
  sigs[key] = sig;
  const ul = $(".sessions", col);
  ul.innerHTML = sessions.length
    ? sessions.map((s) => sessionRow(s, key)).join("")
    : `<li class="col-empty">Brak aktywnych sesji</li>`;
  if (data.error) ul.insertAdjacentHTML("afterbegin", `<li class="col-err">${esc(data.error)}</li>`);
  fitList(ul);
}

/* ---------- podsumowanie ---------- */

function renderSummary(all) {
  const count = (st) => all.filter((s) => s.state === st).length;
  const w = count("waiting"), k = count("working"), d = count("done");
  for (const [id, n] of [["waiting", w], ["working", k], ["done", d]]) {
    const tile = $(`#tile-${id}`);
    $("b", tile).textContent = n;
    tile.classList.toggle("on", n > 0);
  }
  const h = $("#headline");
  h.classList.toggle("alert", w > 0);
  h.textContent = w > 0
    ? `${w} ${plural(w, "sesja czeka", "sesje czekają", "sesji czeka")} na Ciebie`
    : k > 0 ? `${k} ${plural(k, "sesja pracuje", "sesje pracują", "sesji pracuje")}` : "Wszystko gotowe";
}

/* ---------- kalendarz ---------- */

const CAL_ERR = {
  no_helper: "Kalendarz nie jest jeszcze podłączony.",
  no_access: "Brak dostępu do Kalendarza. Zezwól w Ustawieniach → Prywatność → Kalendarze.",
  stale: "Kalendarz nie odświeża się — sprawdź helper.",
};

function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  if (days === 0) return "Dziś";
  if (days === 1) return "Jutro";
  return d.toLocaleDateString("pl-PL", { weekday: "long" });
}

function renderCalendar(cal) {
  const ul = $("#events");
  const now = Date.now();
  const events = (cal.events || []).filter((e) => !e.allDay && e.end > now);
  if (!events.length) {
    ul.innerHTML = `<li class="empty">${esc(CAL_ERR[cal.error] || (cal.error ? cal.error : "Brak spotkań w ciągu 48 h"))}</li>`;
    return;
  }
  let html = "", lastDay = null;
  if (dayLabel(events[0].start) !== "Dziś" && events[0].start > now) html += `<li class="empty">Dziś bez spotkań</li>`;
  for (const e of events) {
    const day = e.start <= now ? "Dziś" : dayLabel(e.start);
    if (day !== lastDay) { if (lastDay !== null || day !== "Dziś") html += `<li class="day">${day}</li>`; lastDay = day; }
    const mins = (e.start - now) / 60000;
    let cls = "later", when = ""; // godzina jest już w opisie pod tytułem
    if (e.start <= now) { cls = "now"; when = `trwa · do ${hm(e.end)}`; }
    else if (mins <= 15) { cls = "soon"; when = `za ${Math.max(1, Math.round(mins))} min`; }
    else if (mins < 180) { cls = "next"; when = until(e.start); }
    const meta = [`${hm(e.start)}–${hm(e.end)}`, e.location && !/^https?:/.test(e.location) ? e.location : e.calendar].filter(Boolean).join(" · ");
    html += `<li class="ev ${cls}" style="--c:${esc(e.color || "")}">
      <span class="bar"></span>
      <div><div class="t">${esc(e.title)}</div><div class="m">${esc(meta)}</div></div>
      <span class="when">${when}</span>
    </li>`;
  }
  ul.innerHTML = html;
  while (ul.scrollHeight > ul.clientHeight + 1 && ul.lastElementChild) ul.lastElementChild.remove();
  if (ul.lastElementChild?.classList.contains("day")) ul.lastElementChild.remove();
}

/* ---------- pętla ---------- */

function render() {
  if (!last) return;
  renderTool("claude", last.claude, last.usageError);
  renderTool("codex", last.codex, last.usageError);
  renderSummary([...last.claude.sessions, ...last.codex.sessions]);
  renderCalendar(last.calendar || {});
  tickClock();
}

async function poll() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    last = await r.json();
    lastOk = Date.now();
    render();
  } catch (e) { /* zostaw ostatni stan */ }
  const conn = $("#conn");
  const stale = Date.now() - lastOk > POLL_MS * 4;
  conn.classList.toggle("bad", stale);
  conn.textContent = stale ? "brak połączenia z serwerem" : "";
}

/* ---------- otwieranie sesji w aplikacji ---------- */

document.addEventListener("click", async (ev) => {
  const row = ev.target.closest(".s[data-id]");
  if (!row) return;
  row.classList.add("opening");
  setTimeout(() => row.classList.remove("opening"), 900);
  try {
    await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: row.dataset.tool, id: row.dataset.id }),
    });
  } catch (e) { /* serwer niedostępny — nic nie robimy */ }
});

/* ---------- motyw ---------- */

const THEMES = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
function currentTheme() { return document.documentElement.dataset.theme || "auto"; }
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t); } catch (e) {}
  $("#theme").textContent = THEME_ICON[t];
}
$("#theme").addEventListener("click", () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % 3]));
applyTheme(currentTheme());

window.addEventListener("resize", () => { for (const k in sigs) delete sigs[k]; render(); });
setInterval(tickClock, 1000);
setInterval(poll, POLL_MS);
tickClock();
poll();
