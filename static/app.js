"use strict";

const POLL_MS = 3000;
const MEETING_LEAD_MIN = 10; // od kiedy pokazać pasek „Za X min — Dołącz”
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

function dayTime(ms) {
  // „17:42” dziś, „pt 9:15” w inne dni
  const d = new Date(ms), t = new Date();
  return d.toDateString() === t.toDateString() ? hm(ms) : `${d.toLocaleDateString("pl-PL", { weekday: "short" })} ${hm(ms)}`;
}

function chatCost(c) {
  // Koszt czatu po cenach API; „+” = część odpowiedzi bez znanej ceny modelu.
  if (!c) return "";
  const x = c.usd, digits = x < 10 ? 2 : x < 100 ? 1 : 0;
  const n = x.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `$${n}${c.partial ? "+" : ""}`;
}

function usd(x) {
  return "$" + Math.round(x).toLocaleString("pl-PL");
}

function tokensLabel(n) {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} mld`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} mln`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} tys.`;
  return String(Math.round(n));
}

/* ---------- zegar i odliczania ---------- */

function tickClock() {
  const now = new Date();
  $("#time").textContent = `${now.getHours()}:${pad(now.getMinutes())}`;
  $("#date").textContent = now.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
  document.querySelectorAll("[data-ago]").forEach((el) => { el.textContent = ago(+el.dataset.ago); });
  document.querySelectorAll("[data-until]").forEach((el) => {
    el.textContent = (el.dataset.prefix ?? "reset ") + until(+el.dataset.until);
  });
}

/* ---------- nagłówki kolumn: limity, prognoza, trend, status ---------- */

function forecastNote(bar) {
  // Tylko gdy przy obecnym tempie limit skończy się przed resetem — inaczej to szum.
  const f = bar.forecast;
  return f?.beforeReset ? `<div class="fc">skończy się ok. ${dayTime(f.eta)}</div>` : "";
}

function meter(label, bar) {
  if (!bar) return "";
  const out = bar.forecast?.exhausted;
  const warn = bar.forecast?.beforeReset;
  const filled = Math.round(bar.pct / 5);
  const segs = Array.from({ length: 20 }, (_, i) => `<i${i < filled ? ' class="f"' : ""}></i>`).join("");
  const reset = bar.resetsAt ? `<span data-until="${bar.resetsAt}"></span>` : "";
  return `<div class="meter${bar.pct >= 80 || warn ? " hot" : ""}${out ? " out" : ""}">
    <div class="row1"><span>${label}</span><span class="pct">${bar.pct}%</span></div>
    <div class="segs">${segs}</div>
    <div class="reset">${reset}</div>${forecastNote(bar)}
  </div>`;
}

function trend(points) {
  if (!points?.length) return "";
  const max = Math.max(...points.map((p) => p.value), 1);
  const bars = points.map((p, i) => {
    const h = Math.max(4, Math.round((p.value / max) * 100));
    const tip = `${p.label}: ${tokensLabel(p.value)} tokenów`;
    return `<i style="height:${h}%"${i === points.length - 1 ? ' class="today"' : ""} title="${esc(tip)}"></i>`;
  }).join("");
  return `<div class="trend"><div class="row1"><span>${points.length} dni</span></div><div class="tbars">${bars}</div></div>`;
}

function limitBanner(usage) {
  // Wyczerpany limit to najważniejsza informacja w kolumnie — pasek nad listą sesji.
  for (const [label, bar] of [["5 h", usage?.session], ["tygodniowy", usage?.weekly]]) {
    if (bar?.forecast?.exhausted) {
      return `<div class="limit-out">Limit ${label} wyczerpany · wróci <span data-prefix="" data-until="${bar.resetsAt}"></span></div>`;
    }
  }
  return "";
}

const SVC = {
  none: ["ok", "Działa normalnie"],
  minor: ["minor", "Drobne problemy"],
  major: ["major", "Poważna awaria"],
  critical: ["major", "Awaria"],
  maintenance: ["minor", "Prace serwisowe"],
  unknown: ["unknown", "Brak danych o statusie"],
};

function renderStatus(col, st) {
  const el = $(".svc", col);
  if (!st) { el.innerHTML = ""; return; }
  const [cls, text] = SVC[st.indicator] || SVC.unknown;
  const detail = st.incident || st.description || text;
  el.className = `svc ${cls}`;
  el.title = detail;
  el.innerHTML = `<i></i>${cls === "ok" || cls === "unknown" ? "" : `<span>${esc(st.incident || text)}</span>`}`;
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
  $(".bars", col).innerHTML = usage
    ? meter("Limit 5 h", usage.session) + meter("Limit tygodniowy", usage.weekly) + trend(usage.trend)
    : `<div class="na">${esc(error || "Brak danych o limitach")}</div>`;
  $(".banner", col).innerHTML = limitBanner(usage);
}

/* ---------- listy sesji ---------- */

function sessionRow(s, tool) {
  const label = s.state === "waiting" && s.detail === "pytanie" ? "Pytanie do Ciebie" : LABEL[s.state] || s.state;
  const tip = s.detail && s.detail !== "pytanie" ? ` title="${esc(s.detail)}"` : "";
  const open = s.url ? ` data-open="session" data-tool="${tool}" data-id="${esc(s.id)}"` : "";
  const inst = s.instance ? `<span class="inst">${esc(s.instance)}</span>` : "";
  return `<li class="s ${s.state}"${tip}${open}>
    <span class="ic">${ICON[s.state] || ""}</span>
    <div class="main">
      <div class="name"><span class="n">${esc(s.name)}</span>${inst}<span class="proj">${esc(s.project)}</span></div>
      <div class="msg">${esc(s.message) || "&nbsp;"}</div>
    </div>
    <div class="right">
      <div class="lbl">${label}</div>
      <div class="when"><span class="usd" data-cost="${esc(s.id)}">${chatCost(s.cost)}</span><span data-ago="${s.time || Date.now()}"></span></div>
    </div>
  </li>`;
}

function fitList(ul, rowSel, noun) {
  // Ukryj nadmiar wierszy od dołu i pokaż „+N”.
  let hidden = 0;
  let more = null;
  while (ul.scrollHeight > ul.clientHeight + 1) {
    const rows = ul.querySelectorAll(rowSel);
    if (rows.length <= 1) break;
    rows[rows.length - 1].remove();
    hidden++;
    if (!more) { more = document.createElement("li"); more.className = "more"; ul.appendChild(more); }
    more.textContent = `+${hidden} ${noun(hidden)} więcej`;
  }
}

function updateCosts(col, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s.cost]));
  col.querySelectorAll("[data-cost]").forEach((el) => {
    const text = chatCost(byId.get(el.dataset.cost));
    if (el.textContent !== text) el.textContent = text;
  });
}

function renderTool(key, data, usageError, status) {
  const col = $(`.col[data-tool="${key}"]`);
  renderUsage(col, data.usage, usageError);
  renderStatus(col, status);
  const sessions = [...data.sessions].sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.time - a.time));
  const sig = JSON.stringify([sessions.map((s) => [s.id, s.state, s.name, s.project, s.message, s.detail, s.instance]), data.error]);
  if (sigs[key] === sig) return updateCosts(col, sessions); // bez zmian — nie restartujemy animacji
  sigs[key] = sig;
  const ul = $(".sessions", col);
  ul.innerHTML = sessions.length
    ? sessions.map((s) => sessionRow(s, key)).join("")
    : `<li class="col-empty">Brak aktywnych sesji</li>`;
  if (data.error) ul.insertAdjacentHTML("afterbegin", `<li class="col-err">${esc(data.error)}</li>`);
  fitList(ul, ".s", (n) => plural(n, "sesja", "sesje", "sesji"));
}

/* ---------- podsumowanie ---------- */

function renderSummary(all, claudeUsage, codexUsage) {
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

  // Dziś: sesje z ruchem od północy + koszt i tokeny z OpenUsage (oba narzędzia).
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = all.filter((s) => s.time >= midnight).length;
  const cost = (claudeUsage?.today || 0) + (codexUsage?.today || 0);
  const tok = (claudeUsage?.todayTokens || 0) + (codexUsage?.todayTokens || 0);
  const parts = [`<b>${today}</b> ${plural(today, "sesja", "sesje", "sesji")}`];
  if (claudeUsage || codexUsage) parts.push(`<b>${usd(cost)}</b>`, `${tokensLabel(tok)} tokenów`);
  $("#today").innerHTML = `<span>Dziś</span> ${parts.join(" · ")}`;
}

/* ---------- kalendarz i najbliższe spotkanie ---------- */

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

const eventAttrs = (e) => e.link ? ` data-open="event" data-start="${e.start}" data-title="${esc(e.title)}"` : "";

function renderMeeting(events) {
  const now = Date.now();
  const e = events.find((x) => x.start - now <= MEETING_LEAD_MIN * 60000 && now - x.start <= MEETING_LEAD_MIN * 60000);
  const box = $("#meeting");
  if (!e) { box.innerHTML = ""; box.hidden = true; return null; }
  const mins = Math.round((e.start - now) / 60000);
  const when = mins > 0 ? `Za ${mins} min` : mins === 0 ? "Teraz" : `Trwa od ${-mins} min`;
  box.hidden = false;
  box.className = `meeting${mins <= 2 ? " now" : ""}`;
  box.innerHTML = `<div class="mt"><span class="mw">${when} · ${hm(e.start)}–${hm(e.end)}</span><b>${esc(e.title)}</b></div>` +
    (e.link ? `<button type="button"${eventAttrs(e)}>Dołącz</button>` : "");
  return e;
}

function renderCalendar(cal) {
  const ul = $("#events");
  const now = Date.now();
  const events = (cal.events || []).filter((e) => !e.allDay && e.end > now);
  const featured = renderMeeting(events);
  const rest = events.filter((e) => e !== featured);
  if (!rest.length) {
    ul.innerHTML = `<li class="empty">${esc(CAL_ERR[cal.error] || (cal.error ? cal.error : featured ? "Nic więcej w ciągu 48 h" : "Brak spotkań w ciągu 48 h"))}</li>`;
    return;
  }
  let html = "", lastDay = null;
  if (dayLabel(rest[0].start) !== "Dziś" && rest[0].start > now) html += `<li class="empty">Dziś bez spotkań</li>`;
  for (const e of rest) {
    const day = e.start <= now ? "Dziś" : dayLabel(e.start);
    if (day !== lastDay) { if (lastDay !== null || day !== "Dziś") html += `<li class="day">${day}</li>`; lastDay = day; }
    const mins = (e.start - now) / 60000;
    let cls = "later", when = ""; // godzina jest już w opisie pod tytułem
    if (e.start <= now) { cls = "now"; when = `trwa · do ${hm(e.end)}`; }
    else if (mins <= 15) { cls = "soon"; when = `za ${Math.max(1, Math.round(mins))} min`; }
    else if (mins < 180) { cls = "next"; when = until(e.start); }
    const meta = [`${hm(e.start)}–${hm(e.end)}`, e.location && !/^https?:/.test(e.location) ? e.location : e.calendar].filter(Boolean).join(" · ");
    html += `<li class="ev ${cls}${e.link ? " link" : ""}" style="--c:${esc(e.color || "")}"${eventAttrs(e)}>
      <span class="bar"></span>
      <div><div class="t">${esc(e.title)}</div><div class="m">${esc(meta)}</div></div>
      <span class="when">${when}</span>
    </li>`;
  }
  ul.innerHTML = html;
  while (ul.scrollHeight > ul.clientHeight + 1 && ul.lastElementChild) ul.lastElementChild.remove();
  if (ul.lastElementChild?.classList.contains("day")) ul.lastElementChild.remove();
}

/* ---------- pull requesty ---------- */

const CI = { success: "Testy przeszły", failure: "Testy nie przeszły", error: "Błąd CI", pending: "CI w toku", expected: "CI w toku" };

function prRank(p) {
  if (p.review) return 0; // ktoś czeka na Twoje review
  if (p.ci === "failure" || p.ci === "error" || p.decision === "CHANGES_REQUESTED") return 1;
  if (p.decision === "APPROVED") return 2;
  return p.draft ? 4 : 3;
}

function renderPRs(gh) {
  const ul = $("#prs");
  const prs = [...(gh?.data || [])].sort((a, b) => (prRank(a) - prRank(b)) || (b.updated - a.updated));
  $("#pr-count").textContent = prs.length ? prs.length : "";
  const sig = JSON.stringify([prs, gh?.error]);
  if (sigs.prs === sig) return;
  sigs.prs = sig;
  if (!prs.length) {
    ul.innerHTML = `<li class="empty">${esc(gh?.error ? `GitHub: ${gh.error}` : gh?.data ? "Brak otwartych PR-ów" : "Wczytywanie…")}</li>`;
    return;
  }
  ul.innerHTML = prs.map((p) => {
    const tags = [
      p.review && '<span class="tag review">Twoje review</span>',
      p.decision === "CHANGES_REQUESTED" && '<span class="tag bad">zmiany</span>',
      p.decision === "APPROVED" && '<span class="tag good">zatwierdzony</span>',
      p.draft && '<span class="tag">draft</span>',
    ].filter(Boolean).join("");
    return `<li class="pr" data-open="pr" data-url="${esc(p.url)}">
      <span class="ci ${esc(p.ci || "none")}" title="${esc(CI[p.ci] || "Brak CI")}"></span>
      <div><div class="t">${esc(p.title)}</div><div class="m">${esc(p.repo)} #${p.number} ${tags}</div></div>
    </li>`;
  }).join("");
  fitList(ul, ".pr", (n) => plural(n, "PR", "PR-y", "PR-ów"));
}

/* ---------- pętla ---------- */

function render() {
  if (!last) return;
  const st = last.status || {};
  renderTool("claude", last.claude, last.usageError, st.claude);
  renderTool("codex", last.codex, last.usageError, st.codex);
  renderSummary([...last.claude.sessions, ...last.codex.sessions], last.claude.usage, last.codex.usage);
  renderCalendar(last.calendar || {});
  renderPRs(last.github);
  tickClock();
}

async function poll() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (last && data.version !== last.version) return location.reload(); // nowa wersja strony
    last = data;
    lastOk = Date.now();
    render();
  } catch (e) { /* zostaw ostatni stan */ }
  const conn = $("#conn");
  const stale = Date.now() - lastOk > POLL_MS * 4;
  conn.classList.toggle("bad", stale);
  conn.textContent = stale ? "brak połączenia z serwerem" : "";
}

/* ---------- otwieranie: sesje w aplikacji, PR-y i spotkania w przeglądarce ---------- */

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-open]");
  if (!el) return;
  const d = el.dataset;
  const body = d.open === "session" ? { kind: "session", tool: d.tool, id: d.id }
    : d.open === "pr" ? { kind: "pr", url: d.url }
    : { kind: "event", start: +d.start, title: d.title };
  el.classList.add("opening");
  setTimeout(() => el.classList.remove("opening"), 900);
  try {
    await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
