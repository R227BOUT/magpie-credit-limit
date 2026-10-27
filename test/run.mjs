// Runs the plugin's cases the way magpie's gateway calls it: one ctx per
// request (so ctx.state carries over), the body a fresh copy of its JSON, and
// a strategy given the pool's name, its seats with every field, and the
// plugin's options. The same cases.json and strategies.json can run in
// moejs (magpie's own engine) — nothing here is Node-only.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"

import * as mod from "../budget.middleware.js"
import cases from "./cases.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const m = mod.default ?? mod
const copy = (v) => JSON.parse(JSON.stringify(v))
const read = (name) => JSON.parse(readFileSync(join(here, name), "utf8"))

// ── the hook ────────────────────────────────────────────────────────────────

async function runCase(c) {
  let rejected
  const ctx = {
    protocol: "anthropic",
    model: "",
    stream: false,
    path: "",
    ...c.ctx,
    options: c.options ?? {},
    state: {},
    reject(status, message) {
      rejected ??= { status, message }
    },
  }
  const out = m.onRequest ? await m.onRequest(copy(c.request), ctx) : undefined
  return { rejected, out, request: out === undefined ? c.request : copy(out) }
}

for (const c of cases) {
  test("onRequest · " + c.name, async () => {
    const got = await runCase(c)
    if (c.reject) {
      assert.ok(got.rejected, "expected the request to be turned away, but it went on")
      assert.equal(got.rejected.status, c.reject.status)
      assert.match(got.rejected.message, new RegExp(c.reject.message))
      // a turned-away request is not rewritten on its way out
      assert.deepEqual(got.request, c.request)
      return
    }
    assert.equal(got.rejected, undefined, "expected the request to go on, but it was turned away: " + (got.rejected && got.rejected.message))
    assert.deepEqual(got.request, c.request, "a request that goes on is returned as it came")
  })
}

test("onRequest · a hook that cannot read the body still lets it through", async () => {
  let rejected
  const ctx = { options: { maxRequestTokens: 10 }, reject: (s) => (rejected = s) }
  assert.equal(await m.onRequest("", ctx), undefined)
  assert.equal(rejected, undefined)
  assert.equal(await m.onRequest(null, ctx), undefined)
  assert.equal(rejected, undefined)
})

// ── the strategies ──────────────────────────────────────────────────────────

function order(strategy, pool, seats, options) {
  const s = m.strategies[strategy]
  const fn = typeof s === "function" ? s : s && s.order
  assert.equal(typeof fn, "function", "no strategy " + strategy)
  const full = seats.map((x, i) => ({
    key: "seat-" + i,
    account: false,
    known: false,
    learns: false,
    used: 0,
    soon: [],
    pace: 0,
    weight: 1,
    resting: false,
    tokens: 0,
    ...x,
  }))
  const got = fn(pool, copy(full), options)
  assert.ok(Array.isArray(got), strategy + " returned " + JSON.stringify(got) + ", not an order")
  assert.equal(got.length, full.length, "an order names every seat once")
  assert.deepEqual([...got].sort((a, b) => a - b), full.map((_, i) => i), "an order is a permutation of the seats")
  return { got, full }
}

for (const c of read("strategies.json")) {
  test("strategies · " + c.name, () => {
    const { got, full } = order(c.strategy, c.pool ?? "test-pool", c.seats, c.options ?? {})
    assert.deepEqual(got.map((i) => full[i].key), c.expect)
  })
}

test("strategies · every strategy answers every pool with a usable order", () => {
  for (const name of Object.keys(m.strategies)) {
    for (let n = 1; n <= 6; n++) {
      for (let round = 0; round < 40; round++) {
        const seats = Array.from({ length: n }, () => ({
          key: "k" + Math.random(),
          account: Math.random() < 0.5,
          known: Math.random() < 0.5,
          learns: false,
          used: Math.random() * 120 - 10,
          soon: Math.random() < 0.5 ? [] : [Math.random() * 1e13],
          pace: Math.random() * 10 - 5,
          weight: 1 + Math.floor(Math.random() * 3),
          resting: Math.random() < 0.3,
          tokens: Math.random() * 1e6,
        }))
        order(name, "pool-" + n, seats, {})
        order(name, "pool-" + n, seats, { ceiling: 1 })
        order(name, "pool-" + n, seats, { ceiling: 100 })
        order(name, "pool-" + n, seats, null)
      }
    }
  }
})

test("strategies · names are what magpie accepts for a routing", () => {
  assert.ok(Object.keys(m.strategies).length > 0, "the plugin serves no strategy")
  for (const name of Object.keys(m.strategies)) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, name + " is not a routing name magpie takes")
  }
})
