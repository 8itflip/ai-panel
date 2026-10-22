"use strict";
// Teksty interfejsu. Język: ?lang=xx w adresie, inaczej pierwszy obsługiwany z ustawień systemu
// (Chrome bierze je z macOS), a w ostateczności angielski. Nowy język = nowy słownik poniżej.

const STRINGS = {
  en: {
    "tile.waiting": "waiting", "tile.working": "working", "tile.done": "done",
    "h.calendar": "Calendar", "h.prs": "Pull requests", "theme": "Theme",
    "headline.waiting": { one: "{n} session waiting for you", other: "{n} sessions waiting for you" },
    "headline.working": { one: "{n} session working", other: "{n} sessions working" },
    "headline.idle": "All done",
    "today": "Today", "sessions": { one: "{n} session", other: "{n} sessions" }, "tokens": "{n} tokens",
    "state.waiting": "Waiting for you", "state.question": "Question for you", "state.working": "Working",
    "state.done": "Done", "state.aborted": "Interrupted",
    "more.sessions": { one: "+{n} more session", other: "+{n} more sessions" },
    "more.prs": { one: "+{n} more PR", other: "+{n} more PRs" },
    "empty.sessions": "No active sessions",
    "limit.session": "5-hour limit", "limit.weekly": "Weekly limit", "trend.days": "{n} days",
    "limit.out.session": "5-hour limit reached · resets {until}",
    "limit.out.weekly": "Weekly limit reached · resets {until}",
    "forecast": "runs out ~{time}", "reset": "resets {until}",
    "cost": "today <b>{today}</b> · 30 days <b>{month}</b>", "multiple": " · <em>{x}×</em> subscription",
    "usage.none": "No usage data", "usage.openusage": "OpenUsage unavailable",
    "now": "now", "in": "in {t}", "ago.min": "{n} min", "ago.h": "{n} h", "ago.d": "{n} d",
    "dur.min": "{m} min", "dur.hmin": "{h} h {m} min", "dur.days": { one: "{n} day", other: "{n} days" },
    "day.today": "Today", "day.tomorrow": "Tomorrow",
    "cal.no_helper": "Calendar is not connected yet.",
    "cal.no_access": "No access to Calendar. Allow it in System Settings → Privacy & Security → Calendars.",
    "cal.stale": "Calendar is not refreshing. Check the helper.",
    "cal.none": "No meetings in the next 48 h", "cal.nothingElse": "Nothing else in the next 48 h",
    "cal.noneToday": "No meetings today", "cal.ongoing": "ongoing · until {time}",
    "meet.in": "In {n} min", "meet.now": "Now", "meet.since": "Started {n} min ago", "meet.join": "Join",
    "pr.review": "review requested", "pr.changes": "changes requested", "pr.approved": "approved",
    "pr.none": "No open pull requests", "pr.loading": "Loading…", "pr.error": "GitHub: {e}",
    "ci.success": "Checks passed", "ci.failure": "Checks failed", "ci.error": "CI error",
    "ci.pending": "Checks running", "ci.none": "No CI",
    "svc.ok": "All systems operational", "svc.minor": "Minor issues", "svc.major": "Major outage",
    "svc.critical": "Outage", "svc.maintenance": "Maintenance", "svc.unknown": "Status unavailable",
    "offline": "server unreachable",
    "num.k": "{n}K", "num.m": "{n}M", "num.b": "{n}B",
  },
  pl: {
    "tile.waiting": "czeka", "tile.working": "pracuje", "tile.done": "gotowe",
    "h.calendar": "Kalendarz", "h.prs": "Pull requesty", "theme": "Motyw",
    "headline.waiting": { one: "{n} sesja czeka na Ciebie", few: "{n} sesje czekają na Ciebie", other: "{n} sesji czeka na Ciebie" },
    "headline.working": { one: "{n} sesja pracuje", few: "{n} sesje pracują", other: "{n} sesji pracuje" },
    "headline.idle": "Wszystko gotowe",
    "today": "Dziś", "sessions": { one: "{n} sesja", few: "{n} sesje", other: "{n} sesji" }, "tokens": "{n} tokenów",
    "state.waiting": "Czeka na Ciebie", "state.question": "Pytanie do Ciebie", "state.working": "Pracuje",
    "state.done": "Gotowe", "state.aborted": "Przerwane",
    "more.sessions": { one: "+{n} sesja więcej", few: "+{n} sesje więcej", other: "+{n} sesji więcej" },
    "more.prs": { one: "+{n} PR więcej", few: "+{n} PR-y więcej", other: "+{n} PR-ów więcej" },
    "empty.sessions": "Brak aktywnych sesji",
    "limit.session": "Limit 5 h", "limit.weekly": "Limit tygodniowy", "trend.days": "{n} dni",
    "limit.out.session": "Limit 5 h wyczerpany · wróci {until}",
    "limit.out.weekly": "Limit tygodniowy wyczerpany · wróci {until}",
    "forecast": "skończy się ok. {time}", "reset": "reset {until}",
    "cost": "dziś <b>{today}</b> · 30 dni <b>{month}</b>", "multiple": " · <em>{x}×</em> abonamentu",
    "usage.none": "Brak danych o limitach", "usage.openusage": "OpenUsage niedostępny",
    "now": "teraz", "in": "za {t}", "ago.min": "{n} min", "ago.h": "{n} h", "ago.d": "{n} d",
    "dur.min": "{m} min", "dur.hmin": "{h} h {m} min", "dur.days": { one: "{n} dzień", other: "{n} dni" },
    "day.today": "Dziś", "day.tomorrow": "Jutro",
    "cal.no_helper": "Kalendarz nie jest jeszcze podłączony.",
    "cal.no_access": "Brak dostępu do Kalendarza. Zezwól w Ustawieniach → Prywatność → Kalendarze.",
    "cal.stale": "Kalendarz nie odświeża się — sprawdź helper.",
    "cal.none": "Brak spotkań w ciągu 48 h", "cal.nothingElse": "Nic więcej w ciągu 48 h",
    "cal.noneToday": "Dziś bez spotkań", "cal.ongoing": "trwa · do {time}",
    "meet.in": "Za {n} min", "meet.now": "Teraz", "meet.since": "Trwa od {n} min", "meet.join": "Dołącz",
    "pr.review": "Twoje review", "pr.changes": "zmiany", "pr.approved": "zatwierdzony",
    "pr.none": "Brak otwartych PR-ów", "pr.loading": "Wczytywanie…", "pr.error": "GitHub: {e}",
    "ci.success": "Testy przeszły", "ci.failure": "Testy nie przeszły", "ci.error": "Błąd CI",
    "ci.pending": "CI w toku", "ci.none": "Brak CI",
    "svc.ok": "Działa normalnie", "svc.minor": "Drobne problemy", "svc.major": "Poważna awaria",
    "svc.critical": "Awaria", "svc.maintenance": "Prace serwisowe", "svc.unknown": "Brak danych o statusie",
    "offline": "brak połączenia z serwerem",
    "num.k": "{n} tys.", "num.m": "{n} mln", "num.b": "{n} mld",
  },
};

const LANG = (() => {
  let wanted = [];
  try { wanted.push(new URLSearchParams(location.search).get("lang")); } catch (e) {}
  wanted = wanted.concat(navigator.languages || [navigator.language]);
  for (const l of wanted) {
    const base = String(l || "").toLowerCase().split("-")[0];
    if (STRINGS[base]) return base;
  }
  return "en";
})();
// Formaty dat i liczb wg pełnego ustawienia systemu (np. en-PL: 24 h, spacja w tysiącach), o ile pasuje do języka.
const LOCALE = (navigator.languages || []).find((l) => l.toLowerCase().startsWith(LANG)) || LANG;
const _plural = new Intl.PluralRules(LOCALE);

function t(key, vars = {}) {
  let s = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  if (typeof s === "object") s = s[_plural.select(vars.n ?? 0)] ?? s.other;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
}

function applyStaticTexts() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute("aria-label", el.title);
  });
}
