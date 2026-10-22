"use strict";

const POLL_MS = 10000;
const MEETING_LEAD_MIN = 10; // minutes before a meeting to show the "In X min · Join" bar
const ORDER = { waiting: 0, working: 1, done: 2, aborted: 3 };
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

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("now");
  if (s < 3600) return t("ago.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("ago.h", { n: Math.floor(s / 3600) });
  return t("ago.d", { n: Math.floor(s / 86400) });
}

function duration(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return t("dur.min", { m });
  if (m < 24 * 60) return t("dur.hmin", { h: Math.floor(m / 60), m: m % 60 });
  return t("dur.days", { n: Math.round(m / 1440) });
}

const until = (ms) => t("in", { t: duration(ms) });

function dayTime(ms) {
  // "17:42" today, "Fri 9:15" on other days
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? hm(ms) : `${d.toLocaleDateString(LOCALE, { weekday: "short" })} ${hm(ms)}`;
}

function chatCost(c) {
  // Chat cost at API prices; "+" means some responses used a model without a known price.
  if (!c) return "";
  const x = c.usd, digits = x < 10 ? 2 : x < 100 ? 1 : 0;
  const n = x.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `$${n}${c.partial ? "+" : ""}`;
}

function usd(x) {
  return "$" + Math.round(x).toLocaleString(LOCALE);
}

const cents = (x) => "$" + x.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function bytes(n) {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function tokensLabel(n) {
  const f = (x) => x.toLocaleString(LOCALE, { maximumFractionDigits: x < 10 ? 1 : 0 });
  if (n >= 1e9) return t("num.b", { n: f(n / 1e9) });
  if (n >= 1e6) return t("num.m", { n: f(n / 1e6) });
  if (n >= 1e3) return t("num.k", { n: f(n / 1e3) });
  return String(Math.round(n));
}

/* ---------- clock and countdowns ---------- */

function fillTimes(root = document) {
  // Filled in while rendering: empty fields would change height later and break the list fitting.
  // Only touch text that changed: every write invalidates layout, and this runs every second.
  const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  root.querySelectorAll("[data-ago]").forEach((el) => set(el, ago(+el.dataset.ago)));
  root.querySelectorAll("[data-until]").forEach((el) => {
    set(el, t(el.dataset.fmt || "reset", { until: until(+el.dataset.until) }));
  });
}

function tickClock() {
  const now = new Date();
  $("#time").textContent = `${now.getHours()}:${pad(now.getMinutes())}`;
  $("#date").textContent = now.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
  fillTimes();
}

/* ---------- column headers: limits, forecast, trend, status ---------- */

function forecastNote(bar) {
  // Only when the current pace runs out before the reset; otherwise it is noise.
  const f = bar.forecast;
  return f?.beforeReset ? `<div class="fc">${esc(t("forecast", { time: dayTime(f.eta) }))}</div>` : "";
}

function meter(label, bar) {
  if (!bar) return "";
  // Shows what is LEFT: the number and the filled bar shrink as usage grows.
  const left = Math.max(0, 100 - bar.pct);
  const out = bar.forecast?.exhausted || left === 0;
  const warn = bar.forecast?.beforeReset;
  const filled = Math.round(left / 5);
  const segs = Array.from({ length: 20 }, (_, i) => `<i${i < filled ? ' class="f"' : ""}></i>`).join("");
  const reset = bar.resetsAt ? `<span data-until="${bar.resetsAt}"></span>` : "";
  return `<div class="meter${left <= 20 || warn ? " hot" : ""}${out ? " out" : ""}">
    <div class="row1"><span>${label}</span><span class="pct">${t("pct.left", { n: left })}</span></div>
    <div class="segs">${segs}</div>
    <div class="reset">${reset}</div>${forecastNote(bar)}
  </div>`;
}

function trend(points) {
  if (!points?.length) return "";
  const max = Math.max(...points.map((p) => p.value), 1);
  const bars = points.map((p, i) => {
    const h = Math.max(4, Math.round((p.value / max) * 100));
    const tip = `${p.label}: ${t("tokens", { n: tokensLabel(p.value) })}`;
    return `<i style="height:${h}%"${i === points.length - 1 ? ' class="today"' : ""} title="${esc(tip)}"></i>`;
  }).join("");
  return `<div class="trend"><div class="row1"><span>${t("trend.days", { n: points.length })}</span></div><div class="tbars">${bars}</div></div>`;
}

function limitBanner(usage) {
  // An exhausted limit is the most important fact in the column: a bar above the sessions.
  for (const kind of ["session", "weekly"]) {
    const bar = usage?.[kind];
    if (bar?.forecast?.exhausted) {
      return `<div class="limit-out" data-fmt="limit.out.${kind}" data-until="${bar.resetsAt}"></div>`;
    }
  }
  return "";
}

const SVC = { none: "ok", minor: "minor", major: "major", critical: "major", maintenance: "minor", unknown: "unknown" };

function renderStatus(col, st) {
  const el = $(".svc", col);
  if (!st) { el.innerHTML = ""; return; }
  const cls = SVC[st.indicator] || "unknown";
  const text = t(`svc.${SVC[st.indicator] ? (st.indicator === "none" ? "ok" : st.indicator) : "unknown"}`);
  const detail = st.incident || st.description || text;
  el.className = `svc ${cls}`;
  el.title = detail;
  el.innerHTML = `<i></i>${cls === "ok" || cls === "unknown" ? "" : `<span>${esc(st.incident || text)}</span>`}`;
}

function renderUsage(col, usage, error) {
  // Rebuilding the header every poll forces a layout of the whole column; skip it when unchanged.
  const sig = JSON.stringify([usage, error]), key = `usage:${col.dataset.tool}`;
  if (sigs[key] === sig) return;
  sigs[key] = sig;
  $(".plan", col).textContent = usage?.plan || "";
  const cost = $(".cost", col);
  if (usage && usage.month != null) {
    cost.innerHTML = t("cost", { today: usd(usage.today || 0), month: usd(usage.month) }) +
      (usage.multiple ? t("multiple", { x: usage.multiple.toLocaleString(LOCALE) }) : "");
  } else {
    cost.textContent = "";
  }
  // Real money on top of the subscription; warn at 80% of the extra usage limit or a balance under $5.
  const spend = $(".spend", col);
  const extra = usage?.extra, credits = usage?.credits;
  if (extra) {
    spend.innerHTML = t("spend.extra", { used: cents(extra.used), limit: usd(extra.limit) });
    spend.classList.toggle("warn", !!extra.limit && extra.used / extra.limit >= 0.8);
  } else if (credits != null) {
    spend.innerHTML = t("spend.credits", { balance: cents(credits) });
    spend.classList.toggle("warn", credits < 5);
  } else {
    spend.textContent = "";
  }
  $(".bars", col).innerHTML = usage
    ? meter(t("limit.session"), usage.session) + meter(t("limit.weekly"), usage.weekly) + trend(usage.trend)
    : `<div class="na">${esc(error ? t(`usage.${error}`) : t("usage.none"))}</div>`;
  $(".banner", col).innerHTML = limitBanner(usage);
  fillTimes(col.querySelector(".col-head"));
  fillTimes(col.querySelector(".banner"));
}

/* ---------- session lists ---------- */

function sessionRow(s, tool) {
  const label = t(s.state === "waiting" && s.detail === "question" ? "state.question" : `state.${s.state}`);
  const tip = s.detail && s.detail !== "question" ? ` title="${esc(s.detail)}"` : "";
  const open = s.url ? ` data-open="session" data-tool="${tool}" data-id="${esc(s.id)}"` : "";
  const inst = s.instance ? `<span class="inst">${esc(s.instance)}</span>` : "";
  return `<li class="s ${s.state}${s.stale ? " stale" : ""}"${tip}${open}>
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

function fitList(ul, rowSel, moreKey) {
  // Hide overflowing rows from the bottom and show "+N".
  let hidden = 0;
  let more = null;
  while (ul.scrollHeight > ul.clientHeight + 1) {
    const rows = ul.querySelectorAll(rowSel);
    if (rows.length <= 1) break;
    rows[rows.length - 1].remove();
    hidden++;
    if (!more) { more = document.createElement("li"); more.className = "more"; ul.appendChild(more); }
    more.textContent = t(moreKey, { n: hidden });
  }
}

function updateCosts(col, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s.cost]));
  col.querySelectorAll("[data-cost]").forEach((el) => {
    const text = chatCost(byId.get(el.dataset.cost));
    if (el.textContent !== text) el.textContent = text;
  });
}

function renderHealth(col, key, health) {
  // The data format of Claude Code, Codex or OpenUsage changed: warn instead of quietly showing nothing.
  const detail = health?.[key] || health?.[`openusage:${key}`];
  const el = $(".health", col);
  el.textContent = detail ? `⚠ ${t("health.chip")}` : "";
  el.title = detail ? `${detail}. ${t("health.hint")}` : "";
}

function renderTool(key, data, usageError, status, health) {
  const col = $(`.col[data-tool="${key}"]`);
  renderUsage(col, data.usage, usageError);
  renderStatus(col, status);
  renderHealth(col, key, health);
  const sessions = [...data.sessions].sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.time - a.time));
  const stale = sessions.filter((s) => s.stale);
  $(".col-foot", col).textContent = stale.length
    ? t("stale", { n: stale.length, mem: bytes(stale.reduce((m, s) => m + (s.memory || 0), 0)) }) : "";
  const sig = JSON.stringify([sessions.map((s) => [s.id, s.state, s.name, s.project, s.message, s.detail, s.instance, s.stale]), data.error]);
  const ul = $(".sessions", col);
  // Unchanged and still fits: keep the list as is so animations do not restart.
  if (sigs[key] === sig && ul.dataset.h === String(ul.clientHeight)) return updateCosts(col, sessions);
  sigs[key] = sig;
  ul.innerHTML = sessions.length
    ? sessions.map((s) => sessionRow(s, key)).join("")
    : `<li class="col-empty">${t("empty.sessions")}</li>`;
  if (data.error) ul.insertAdjacentHTML("afterbegin", `<li class="col-err">${esc(data.error)}</li>`);
  fillTimes(ul);
  fitList(ul, ".s", "more.sessions");
  ul.dataset.h = String(ul.clientHeight);
}

/* ---------- summary ---------- */

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
  h.textContent = w > 0 ? t("headline.waiting", { n: w }) : k > 0 ? t("headline.working", { n: k }) : t("headline.idle");

  // Today: sessions active since midnight plus cost and tokens from OpenUsage (both tools).
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = all.filter((s) => s.time >= midnight).length;
  const cost = (claudeUsage?.today || 0) + (codexUsage?.today || 0);
  const tok = (claudeUsage?.todayTokens || 0) + (codexUsage?.todayTokens || 0);
  const parts = [t("sessions", { n: today }).replace(String(today), `<b>${today}</b>`)];
  if (claudeUsage || codexUsage) parts.push(`<b>${usd(cost)}</b>`, esc(t("tokens", { n: tokensLabel(tok) })));
  $("#today").innerHTML = `<span>${t("today")}</span> ${parts.join(" · ")}`;
}

/* ---------- calendar and next meeting ---------- */

const CAL_ERRORS = ["no_helper", "no_access", "stale"];

function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days === 0) return t("day.today");
  if (days === 1) return t("day.tomorrow");
  return d.toLocaleDateString(LOCALE, { weekday: "long" });
}

const eventAttrs = (e) => e.link ? ` data-open="event" data-start="${e.start}" data-title="${esc(e.title)}"` : "";

function renderMeeting(events) {
  const now = Date.now();
  const e = events.find((x) => x.start - now <= MEETING_LEAD_MIN * 60000 && now - x.start <= MEETING_LEAD_MIN * 60000);
  const box = $("#meeting");
  if (!e) { box.innerHTML = ""; box.hidden = true; return null; }
  const mins = Math.round((e.start - now) / 60000);
  const when = mins > 0 ? t("meet.in", { n: mins }) : mins === 0 ? t("meet.now") : t("meet.since", { n: -mins });
  box.hidden = false;
  box.className = `meeting${mins <= 2 ? " now" : ""}`;
  box.innerHTML = `<div class="mt"><span class="mw">${when} · ${hm(e.start)}–${hm(e.end)}</span><b>${esc(e.title)}</b></div>` +
    (e.link ? `<button type="button"${eventAttrs(e)}>${t("meet.join")}</button>` : "");
  return e;
}

function renderCalendar(cal) {
  const ul = $("#events");
  const now = Date.now();
  // Relative times ("in 5 min") change once a minute, so rebuild at most that often.
  const sig = JSON.stringify([cal, Math.floor(now / 60000), ul.clientHeight]);
  if (sigs.calendar === sig) return;
  sigs.calendar = sig;
  const events = (cal.events || []).filter((e) => !e.allDay && e.end > now);
  const featured = renderMeeting(events);
  const rest = events.filter((e) => e !== featured);
  if (!rest.length) {
    const msg = CAL_ERRORS.includes(cal.error) ? t(`cal.${cal.error}`) : cal.error || t(featured ? "cal.nothingElse" : "cal.none");
    ul.innerHTML = `<li class="empty">${esc(msg)}</li>`;
    return;
  }
  let html = "", lastDay = null;
  const today = t("day.today");
  if (dayLabel(rest[0].start) !== today && rest[0].start > now) html += `<li class="empty">${t("cal.noneToday")}</li>`;
  for (const e of rest) {
    const day = e.start <= now ? today : dayLabel(e.start);
    if (day !== lastDay) { if (lastDay !== null || day !== today) html += `<li class="day">${esc(day)}</li>`; lastDay = day; }
    const mins = (e.start - now) / 60000;
    let cls = "later", when = ""; // the time is already in the line under the title
    if (e.start <= now) { cls = "now"; when = t("cal.ongoing"); } // the end time is already under the title
    else if (mins <= 15) { cls = "soon"; when = t("in", { t: t("dur.min", { m: Math.max(1, Math.round(mins)) }) }); }
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

/* ---------- pull requests ---------- */

const CI = { success: "ci.success", failure: "ci.failure", error: "ci.error", pending: "ci.pending", expected: "ci.pending" };

function prRank(p) {
  if (p.review) return 0; // someone is waiting for your review
  if (p.ci === "failure" || p.ci === "error" || p.decision === "CHANGES_REQUESTED") return 1;
  if (p.decision === "APPROVED") return 2;
  return p.draft ? 4 : 3;
}

function prRow(p, group) {
  const tags = [
    p.review && `<span class="tag review">${t("pr.review")}</span>`,
    p.decision === "CHANGES_REQUESTED" && `<span class="tag bad">${t("pr.changes")}</span>`,
    p.decision === "APPROVED" && `<span class="tag good">${t("pr.approved")}</span>`,
    p.draft && '<span class="tag">draft</span>',
  ].filter(Boolean).join("");
  return `<li class="pr" data-g="${group}" data-open="pr" data-url="${esc(p.url)}">
    <span class="ci ${esc(p.ci || "none")}" title="${esc(t(CI[p.ci] || "ci.none"))}"></span>
    <div><div class="t">${esc(p.title)}</div><div class="m">${esc(p.repo)} ${esc(p.ref)} ${tags}</div></div>
  </li>`;
}

function prGroupMessage(g) {
  if (g.error === "glab_missing" || g.error === "glab_auth") return t(`pr.${g.error}`, { host: g.host });
  if (g.error) return t("pr.error", { e: g.error });
  return t(g.loading ? "pr.loading" : "pr.none");
}

function fitGroups(ul) {
  // Not enough room: trim the group with the most visible rows. If even one row per group does not
  // fit, a group keeps only its "+N more" line, so nothing is cut in half.
  const hidden = {};
  while (ul.scrollHeight > ul.clientHeight + 1) {
    const counts = {};
    ul.querySelectorAll(".pr").forEach((r) => { counts[r.dataset.g] = (counts[r.dataset.g] || 0) + 1; });
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const g = keys.find((k) => counts[k] > 1) ?? keys[keys.length - 1];
    if (g === undefined) break;
    const rows = ul.querySelectorAll(`.pr[data-g="${g}"]`);
    rows[rows.length - 1].remove();
    hidden[g] = (hidden[g] || 0) + 1;
    const more = ul.querySelector(`[data-more="${g}"]`);
    more.hidden = false;
    more.textContent = t("more.prs", { n: hidden[g] });
  }
}

/* Expanded PR groups: the choice saved in localStorage, otherwise only groups that need attention
   (a review requested from you or failing CI). */
let prOpen = {};
try { prOpen = JSON.parse(localStorage.getItem("prOpen") || "{}"); } catch (e) {}

const groupKey = (g) => (g.other ? "__other" : g.name || "__all");
const needsAttention = (g) => g.items.some((p) => p.review || p.ci === "failure" || p.ci === "error");
const isOpen = (g) => (groupKey(g) in prOpen ? prOpen[groupKey(g)] : needsAttention(g));

function toggleGroup(key, open) {
  prOpen[key] = open;
  try { localStorage.setItem("prOpen", JSON.stringify(prOpen)); } catch (e) {}
  delete sigs.prs;
  delete sigs.local;
  render();
}

function groupSummary(g) {
  if (!g.items.length) {
    if (g.error) return `<span class="warn">${esc(t(g.error.startsWith("glab_") ? "pr.notConnected" : "pr.failed"))}</span>`;
    return esc(t(g.loading ? "pr.loading" : "pr.none"));
  }
  const n = (f) => g.items.filter(f).length;
  const ci = [["success", n((p) => p.ci === "success")], ["failure", n((p) => p.ci === "failure" || p.ci === "error")],
    ["pending", n((p) => p.ci === "pending" || p.ci === "expected")]]
    .filter(([, c]) => c).map(([k, c]) => `<span class="cn" title="${esc(t(CI[k]))}"><i class="ci ${k}"></i>${c}</span>`).join("");
  const review = n((p) => p.review);
  return `<b>${g.items.length}</b>${ci}${review ? `<span class="tag review">${esc(t("pr.toReview", { n: review }))}</span>` : ""}`;
}

function renderPRs(groups) {
  const ul = $("#prs");
  groups = groups || [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  $("#pr-count").textContent = total || "";
  const sig = JSON.stringify([groups, groups.map(isOpen)]);
  if (sigs.prs === sig) return;
  sigs.prs = sig;
  const named = groups.length > 1 || groups[0]?.name;
  let html = "";
  groups.forEach((g, gi) => {
    const items = [...g.items].sort((a, b) => (prRank(a) - prRank(b)) || (b.updated - a.updated));
    const open = !named || isOpen(g);
    if (named) {
      const name = g.other ? t("pr.other") : g.name;
      html += `<li class="pr-group${open ? " open" : ""}" data-toggle="${esc(groupKey(g))}" data-state="${open ? 1 : 0}">
        <span class="chev"></span><span class="gn">${esc(name)}</span><span class="sum">${groupSummary(g)}</span></li>`;
    }
    if (!open) return;
    if (!items.length) html += `<li class="empty">${esc(prGroupMessage(g))}</li>`;
    else if (g.error) html += `<li class="empty warn">${esc(prGroupMessage(g))}</li>`;
    html += items.map((p) => prRow(p, gi)).join("") + `<li class="more" data-more="${gi}" hidden></li>`;
  });
  ul.innerHTML = html || `<li class="empty">${t("pr.loading")}</li>`;
  fitGroups(ul);
}

/* ---------- local changes in session repositories ---------- */

function renderLocal(local) {
  const ul = $("#local");
  const repos = local?.data || [];
  const sig = JSON.stringify([repos, prOpen.__local]);
  if (sigs.local === sig) return;
  sigs.local = sig;
  if (!repos.length) { ul.innerHTML = ""; return; } // nothing to show, so the section disappears
  const open = !!prOpen.__local;
  const files = repos.reduce((n, r) => n + r.files, 0), ahead = repos.reduce((n, r) => n + (r.ahead || 0), 0);
  const sum = [`<b>${esc(t("local.repos", { n: repos.length }))}</b>`, files && esc(t("local.files", { n: files })),
    ahead && `<span class="warn">${esc(t("local.ahead", { n: ahead }))}</span>`].filter(Boolean).join("<span class=\"sep\">·</span>");
  let html = `<li class="pr-group${open ? " open" : ""}" data-toggle="__local" data-state="${open ? 1 : 0}">
    <span class="chev"></span><span class="gn">${t("local.title")}</span><span class="sum">${sum}</span></li>`;
  if (open) {
    html += repos.map((r) => {
      const bits = [r.files && t("local.files", { n: r.files }), r.ahead && t("local.ahead", { n: r.ahead }),
        r.noRemote && t("local.noRemote")].filter(Boolean).join(" · ");
      return `<li class="lr"><span class="t">${esc(r.repo)}</span><span class="m">${esc(r.branch)}</span><span class="n">${esc(bits)}</span></li>`;
    }).join("");
  }
  ul.innerHTML = html;
}

/* ---------- main loop ---------- */

function render() {
  if (!last) return;
  const st = last.status || {};
  renderTool("claude", last.claude, last.usageError, st.claude, last.health);
  renderTool("codex", last.codex, last.usageError, st.codex, last.health);
  renderSummary([...last.claude.sessions, ...last.codex.sessions], last.claude.usage, last.codex.usage);
  renderLocal(last.local);
  renderPRs(last.prs); // PRs and changes first: the calendar fits into whatever space is left
  renderCalendar(last.calendar || {});
  tickClock();
}

async function poll() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (last && data.version !== last.version) return location.reload(); // a new version of the page
    last = data;
    lastOk = Date.now();
    render();
  } catch (e) { /* keep the last state */ }
  const conn = $("#conn");
  const stale = Date.now() - lastOk > POLL_MS * 4;
  conn.classList.toggle("bad", stale);
  conn.textContent = stale ? t("offline") : "";
}

/* ---------- opening: sessions in their app, PRs and meetings in the browser ---------- */

document.addEventListener("click", (ev) => {
  const group = ev.target.closest("[data-toggle]");
  if (group) toggleGroup(group.dataset.toggle, group.dataset.state !== "1");
});

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
  } catch (e) { /* server unreachable, do nothing */ }
});

/* ---------- hover inside the kiosk window ---------- */

// WebKit ignores mouse movement while its app is inactive, and the kiosk app always is, so :hover
// only caught up on the next layout. The kiosk window passes the cursor position here instead and
// the elements under the cursor get a "hover" class that mirrors :hover in the stylesheet.
let hoverChain = [];
window.__pointer = (x, y) => {
  const top = x < 0 ? null : document.elementFromPoint(x, y);
  if (top === hoverChain[0]) return;
  const chain = [];
  for (let el = top; el && el !== document.body; el = el.parentElement) chain.push(el);
  for (const el of hoverChain) if (!chain.includes(el)) el.classList.remove("hover");
  for (const el of chain) el.classList.add("hover");
  hoverChain = chain;
};

/* ---------- theme ---------- */

const THEMES = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
function currentTheme() { return document.documentElement.dataset.theme || "auto"; }
function applyTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try { theme === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", theme); } catch (e) {}
  $("#theme").textContent = THEME_ICON[theme];
}
$("#theme").addEventListener("click", () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % 3]));
applyTheme(currentTheme());

applyStaticTexts();
window.addEventListener("resize", () => { for (const k in sigs) delete sigs[k]; render(); });
setInterval(tickClock, 1000);
setInterval(poll, POLL_MS);
tickClock();
poll();
