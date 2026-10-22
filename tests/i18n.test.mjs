// Translation tests. Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../static/", import.meta.url);
const i18nSource = readFileSync(new URL("i18n.js", root), "utf8");
const appSource = readFileSync(new URL("app.js", root), "utf8");

// Loads i18n.js as the browser would, with the given system languages and URL query.
function load(languages, search = "") {
  const context = vm.createContext({ navigator: { languages, language: languages[0] }, location: { search }, URLSearchParams, Intl });
  vm.runInContext(`${i18nSource}\nglobalThis.out = { t, LANG, LOCALE, STRINGS };`, context);
  return context.out;
}

test("picks the first supported system language, falling back to English", () => {
  assert.equal(load(["pl-PL", "en-US"]).LANG, "pl");
  assert.equal(load(["de-DE", "en-GB"]).LANG, "en");
  assert.equal(load(["ja-JP"]).LANG, "en");
});

test("?lang= in the URL overrides the system language", () => {
  assert.equal(load(["en-US"], "?lang=pl").LANG, "pl");
});

test("Polish plurals", () => {
  const { t } = load(["pl-PL"]);
  assert.equal(t("sessions", { n: 1 }), "1 sesja");
  assert.equal(t("sessions", { n: 3 }), "3 sesje");
  assert.equal(t("sessions", { n: 5 }), "5 sesji");
  assert.equal(t("sessions", { n: 12 }), "12 sesji");
  assert.equal(t("sessions", { n: 22 }), "22 sesje");
  assert.equal(t("more.prs", { n: 9 }), "+9 PR-ów więcej");
});

test("English plurals and placeholders", () => {
  const { t } = load(["en-US"]);
  assert.equal(t("sessions", { n: 1 }), "1 session");
  assert.equal(t("sessions", { n: 2 }), "2 sessions");
  assert.equal(t("headline.waiting", { n: 3 }), "3 sessions waiting for you");
  assert.equal(t("in", { t: "5 min" }), "in 5 min");
});

test("English and Polish dictionaries have the same keys", () => {
  const { STRINGS } = load(["en-US"]);
  assert.deepEqual(Object.keys(STRINGS.pl).sort(), Object.keys(STRINGS.en).sort());
  for (const [lang, dict] of Object.entries(STRINGS)) {
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value === "object") assert.ok(value.other, `${lang}.${key} has no "other" form`);
    }
  }
});

test("every key used in app.js exists", () => {
  const { STRINGS } = load(["en-US"]);
  const literal = [...appSource.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]);
  // Keys built at runtime from known values.
  const dynamic = [
    ...["waiting", "question", "working", "done", "aborted"].map((s) => `state.${s}`),
    ...["no_helper", "no_access", "stale", "none", "nothingElse", "noneToday"].map((s) => `cal.${s}`),
    ...["ok", "minor", "major", "critical", "maintenance", "unknown"].map((s) => `svc.${s}`),
    ...["glab_missing", "glab_auth"].map((s) => `pr.${s}`),
    "usage.openusage", "limit.out.session", "limit.out.weekly", "more.sessions", "more.prs",
    "ci.success", "ci.failure", "ci.error", "ci.pending", "ci.none",
  ];
  const missing = [...new Set([...literal, ...dynamic])].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});
