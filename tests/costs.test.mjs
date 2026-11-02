import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../static/costs.js", import.meta.url), "utf8") + "\nglobalThis.costs = API_COSTS;", context);
const total = (accounts, period = "today") => JSON.parse(JSON.stringify(context.costs.total(accounts, period)));

test("the total sums the same period across subscriptions", () => {
  const accounts = [{ cost: { today: 10, month: 250 } }, { cost: { today: 5.5, month: 40 } }];
  assert.deepEqual(total(accounts), { value: 15.5, partial: false });
  assert.deepEqual(total(accounts, "month"), { value: 290, partial: false });
});

test("missing costs are unknown while a reported zero remains zero", () => {
  assert.deepEqual(total([{ cost: null }, {}]), { value: null, partial: false });
  assert.deepEqual(total([]), { value: null, partial: false });
  assert.deepEqual(total([{ cost: { today: 0 } }]), { value: 0, partial: false });
});

test("a total missing one subscription is explicitly partial", () => {
  assert.deepEqual(total([{ cost: { today: 10 } }, { cost: null }]), { value: 10, partial: true });
});


test("an account's incomplete native estimate makes the overall total partial", () => {
  assert.deepEqual(total([{ cost: { today: 10, todayPartial: true } }, { cost: { today: 5 } }]), { value: 15, partial: true });
});
