"use strict";

// Unknown account costs must never turn into a zero-dollar total.
const API_COSTS = {
  total(accounts, period) {
    const known = accounts.map((a) => a.cost?.[period]).filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
    return { value: known.length ? known.reduce((sum, n) => sum + n, 0) : null,
      partial: known.length > 0 && (known.length < accounts.length || accounts.some(a => a.cost?.[period + "Partial"])) };
  },
};
