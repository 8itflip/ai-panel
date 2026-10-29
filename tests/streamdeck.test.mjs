// Stream Deck plugin tests. Run with: node --test tests/streamdeck.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const deck = require("../streamdeck/local.ai-panel.desk.sdPlugin/plugin.js");
deck.setLang("en");

const svg = (image) => Buffer.from(image.split(",")[1], "base64").toString();
const NOW = Date.parse("2026-10-29T12:00:00");
const MIN = 60000;

test("the session that has waited longest is opened first", () => {
  const st = {
    claude: { sessions: [{ id: "a", state: "waiting", time: 300 }, { id: "b", state: "working", time: 100 }] },
    codex: { sessions: [{ id: "c", state: "waiting", time: 200, name: "Fix CI" }] },
  };
  assert.deepEqual([deck.oldestWaiting(st).id, deck.oldestWaiting(st).tool], ["c", "codex"]);
  assert.match(svg(deck.drawWaiting(st)), />2<.*>Fix CI</s);
  assert.equal(deck.oldestWaiting({ claude: { sessions: [] } }), null);
});

test("working sessions show when nothing waits", () => {
  const image = svg(deck.drawWaiting({ claude: { sessions: [{ state: "working" }] }, codex: { sessions: [] } }));
  assert.match(image, />working</);
});

test("limits cycle through Claude accounts and Codex", () => {
  const st = {
    claude: { usage: { label: "Personal", session: { pct: 42, resetsAt: NOW + 134 * MIN }, weekly: { pct: 12 } },
      accounts: [{ label: "Team", session: { pct: 90 } }] },
    codex: { usage: { session: { pct: 10 } } },
  };
  assert.deepEqual(deck.accounts(st).map((a) => a.label), ["Personal", "Team", "Codex"]);
  const first = svg(deck.drawLimits(st, {}, NOW));
  assert.match(first, />Personal<.*>42%<.*>reset 2h14<.*>week 12%</s);
  assert.match(svg(deck.drawLimits(st, { account: 1 }, NOW)), /fill="#c62828"/); // 90% is tight
  assert.match(svg(deck.drawLimits(st, { account: 5 }, NOW)), />Codex</); // wraps around
});

test("the meeting key turns into a join button inside the panel's window", () => {
  const event = (start, extra = {}) => ({ start, end: start + 30 * MIN, title: "Daily standup", ...extra });
  const soon = { calendar: { events: [event(NOW + 8 * MIN, { link: "https://teams.microsoft.com/x" })] } };
  assert.match(svg(deck.drawMeeting(soon, NOW)), />in 8 min<.*JOIN/s);
  const later = { calendar: { events: [event(NOW + 40 * MIN, { link: "https://teams.microsoft.com/x" })] } };
  assert.doesNotMatch(svg(deck.drawMeeting(later, NOW)), /JOIN/);
  const allDayFirst = { calendar: { events: [{ allDay: true, start: NOW - MIN, end: NOW + 600 * MIN, title: "Trip" }, event(NOW + 5 * MIN)] } };
  assert.equal(deck.nextMeeting(allDayFirst, NOW).title, "Daily standup");
  assert.match(svg(deck.drawMeeting({ calendar: { events: [] } }, NOW)), /none today/);
});

test("kube favourites cycle and production contexts stand out", () => {
  const list = deck.contextList({ contexts: "homelab, lab-admin\nmgmt" });
  assert.deepEqual(list, ["homelab", "lab-admin", "mgmt"]);
  assert.equal(deck.nextContext("lab-admin", list), "mgmt");
  assert.equal(deck.nextContext("mgmt", list), "homelab");
  assert.equal(deck.nextContext("somewhere-else", list), "homelab");
  assert.equal(deck.nextContext("homelab", []), null);
  assert.ok(deck.isProduction("cluster2prd-admin") && !deck.isProduction("homelab"));
});

test("text is wrapped, shortened and escaped", () => {
  assert.deepEqual(deck.wrap("cluster2nonprd-admin", 11, 3), ["cluster2non", "prd-admin"]);
  assert.deepEqual(deck.wrap("Weekly sync with the platform team", 12, 2), ["Weekly sync", "with the …"]);
  assert.equal(deck.duration(59 * MIN), "59m");
  assert.match(svg(deck.key({ top: "<b>&" })), /&lt;b&gt;&amp;/);
});
