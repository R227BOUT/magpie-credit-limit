// 积分判定回归 —— 这次修的三处缺陷各留一条断言，防止改回去。
//
//   1. 只配「账号级」额度（渠道没配）时拿不到真实积分，退回折算
//   2. 进程/插件当天重启一次，已经消耗的部分会被清零，额度被悄悄放宽
//   3. 一个渠道有多个积分包时，「总包」和子包被一起相加 → 双倍计算
//
// 全部在临时目录里造数据，不碰真实 ~/.config/magpie。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rollBase, usedToday, readCreditsDaily, dayKey } from "../lib/balance.mjs"

// ⚠️ 日期必须运行时算，不能写死。曾经写死 "2026-10-27"，零点一过测试就
// 失败了——而失败的样子和「功能坏了」一模一样，白白浪费一轮排查。
const T = dayKey()
const Y = dayKey(Date.now() - 24 * 3600_000)

function tmp() {
  return mkdtempSync(join(tmpdir(), "cl-"))
}

// ── 1. 跨天基准接续（rollBase）───────────────────────────────────────────

test("跨天后用昨天最后一次读数当今天的起点，而不是重新取基准", () => {
  // 昨天：起始 2000，最后读到 1900（说明昨天花了 100）
  const prev = { day: Y, base: 2000, remaining: 1900 }
  const rolled = rollBase(prev, T)
  assert.equal(rolled.day, T)
  assert.equal(rolled.base, 1900, "今天应该从 1900 起步")

  // 今天花到 1850 → 算 50 分，不是 150，也不是 0
  const u = usedToday(rolled, 1850, T)
  assert.equal(u.known, true)
  assert.equal(u.used, 50)
})

test("没有 rollBase 会怎样：重启一次就把已消耗清零（这正是要防的）", () => {
  const prev = { day: Y, base: 2000, remaining: 1900 }
  // 旧行为：直接把 prev 丢给 usedToday，因为 day 不同 → 重新取基准，used=0
  const buggy = usedToday(prev, 1850, T)
  assert.equal(buggy.used, 0, "旧逻辑下重启会显示「今天一分没花」")
  assert.notEqual(rollBase(prev, T).base, buggy.base)
})

test("隔了好几天没跑就不续基准（中间发生了什么无从判断）", () => {
  const prev = { day: "2026-10-20", base: 2000, remaining: 1200 }
  assert.equal(rollBase(prev, T), null)
})

test("同一天不动基准", () => {
  const prev = { day: T, base: 2000, remaining: 1900 }
  assert.equal(rollBase(prev, T), prev)
})

test("上次没留下 remaining 也没法续", () => {
  assert.equal(rollBase({ day: Y, base: 2000 }, T), null)
})

// ── 2. 每日积分账本（credits-daily.json）─────────────────────────────────

function writeDaily(dir, obj) {
  writeFileSync(join(dir, "credits-daily.json"), JSON.stringify(obj))
}

test("有 days[今天] 就直接用，不靠差值推算", () => {
  const d = tmp()
  writeDaily(d, {
    "meituan|999000111|积分": {
      since: "2026-10-20",
      days: { "2026-10-26": 30, [T]: 42.5 },
      last: { used: 42.5, total: 2000, at: new Date().toISOString() },
    },
  })
  const r = readCreditsDaily(T, d)
  assert.equal(r.ok, true)
  const e = r.entries["meituan\u0000999000111"]
  assert.equal(e.used, 42.5)
  assert.equal(e.from, "days")
})

test("窗口恰好等于今天时，用 last.used", () => {
  const d = tmp()
  writeDaily(d, {
    "loomy|138****0001|积分": {
      since: T,
      last: { used: 88, total: 1000, at: new Date().toISOString() },
    },
  })
  const r = readCreditsDaily(T, d)
  const e = r.entries["loomy\u0000138****0001"]
  assert.equal(e.used, 88)
  assert.equal(e.from, "window")
})

test("窗口跨天又没有按天数据 → 不算（不能当成花了 0）", () => {
  const d = tmp()
  writeDaily(d, {
    "workbuddy|r13159|Credits": {
      since: "2026-10-25",
      last: { used: 500, total: 3800, at: new Date().toISOString() },
    },
  })
  const r = readCreditsDaily(T, d)
  assert.equal(r.ok, true)
  assert.equal(Object.keys(r.entries).length, 0, "算不出今天的就一条都不该给")
})

test("多积分包：有「总」包时只用总包，不能把子包一起加上（否则双倍）", () => {
  const d = tmp()
  // 真实数据：总积分 73.07 = 基础积分包 0 + 赠送积分包 73.07
  writeDaily(d, {
    "codearts|signed in|总积分": {
      since: T, last: { used: 73.07, total: 17500, at: new Date().toISOString() },
    },
    "codearts|signed in|基础积分包": {
      since: T, last: { used: 0, total: 500, at: new Date().toISOString() },
    },
    "codearts|signed in|赠送积分包": {
      since: T, last: { used: 73.07, total: 17000, at: new Date().toISOString() },
    },
  })
  const r = readCreditsDaily(T, d)
  const e = r.entries["codearts\u0000signed in"]
  assert.equal(e.used, 73.07, "三个包全加会变成 146.14 —— 双倍计算")
  assert.equal(e.packs.length, 1)
})

test("没有「总」包时，各包相加", () => {
  const d = tmp()
  writeDaily(d, {
    "foo|acc|Credit pack A": { since: T, last: { used: 10, total: 100, at: new Date().toISOString() } },
    "foo|acc|Credit pack B": { since: T, last: { used: 5, total: 50, at: new Date().toISOString() } },
  })
  const r = readCreditsDaily(T, d)
  assert.equal(r.entries["foo\u0000acc"].used, 15)
})

test("账号名里带分隔符也能正确切开", () => {
  const d = tmp()
  writeDaily(d, {
    "codearts|iam::abc:user:hid_x|总积分": {
      since: T, last: { used: 7, total: 100, at: new Date().toISOString() },
    },
  })
  const r = readCreditsDaily(T, d)
  const e = r.entries["codearts\u0000iam::abc:user:hid_x"]
  assert.ok(e, "provider/user 要分开，不能把包名混进来")
  assert.equal(e.used, 7)
})

test("文件不存在 → 如实说读不到，不返回空数据冒充成功", () => {
  const d = tmp()
  const r = readCreditsDaily(T, d)
  assert.equal(r.ok, false)
  assert.match(r.why, /credits-daily/)
})

// ── 3. 引擎层：只配账号级额度也要用上真实积分 ──────────────────────────────

const { enforce, paths } = await import("../lib/engine.mjs")

function writeJson(p, v) {
  writeFileSync(p, JSON.stringify(v, null, 2), "utf8")
}

// 造一个完整环境：configDir 里 providers/logins/plugins，stateDir 里状态
function scaffold(daily, { accounts = ["a1", "a2"], usage = "" } = {}) {
  const config = tmp()
  const state = tmp()
  writeJson(join(config, "providers.json"), {
    providers: [
      { id: "loomy", name: "Loomy", models: ["loomy-m1", "loomy-m2"], pickedFrom: ["loomy-m1", "loomy-m2"] },
    ],
  })
  writeJson(join(config, "logins.json"), accounts.map((u) => ({
    agent: "plugin:loomy", user: u, on: true, plan: "free",
  })))
  writeJson(join(config, "plugins.json"), {
    plugins: [{ spec: config + "-unused", options: {} }],
  })
  if (usage) writeFileSync(join(config, "usage.jsonl"), usage)
  return { config, state }
}

// 让 engine 能找到「本插件」的 options：findEntry 用 pluginDir 匹配，
// 测试里直接把 pluginDir 指到一个临时目录，spec 填它
function entryFor(pluginDir, options) {
  return { spec: pluginDir, options }
}

test("只配账号级额度（渠道不配）→ 用真实积分判定，不是折算", async () => {
  const pluginDir = tmp()
  const { config, state } = scaffold({}, {
    accounts: ["138****0001", "139****0002"],
    usage: JSON.stringify({
      t: new Date().toISOString(), provider: "loomy",
      providerAccount: "138****0001", model: "m", in: 300, out: 300,
    }) + "\n",
  })
  // 只有账号级额度，渠道级不填
  writeJson(join(config, "plugins.json"), {
    plugins: [entryFor(pluginDir, {
      enforce: true,
      dailyCredits: { "loomy/138****0001": 10 },
      checkEveryMinutes: 5,
    })],
  })
  // 每日账本：这个账号今天花了 12 分 → 超了 10 分的额度
  writeFileSync(join(config, "credits-daily.json"), JSON.stringify({
    "loomy|138****0001|积分": {
      since: T,
      days: { [T]: 12 },
      last: { used: 12, total: 1000, at: new Date().toISOString() },
    },
  }))

  const p = paths({ configDir: config, stateDir: state })
  const r = await enforce({ paths: p, pluginDir, quiet: true })
  assert.equal(r.acted, 1, "超了就该停一个账号")
  const joined = r.log.join("\n")
  assert.match(joined, /停用账号 loomy\/138\*\*\*\*0001/)
  // 关键：必须写明是「今日读数」，而不是 token 折算
  assert.match(joined, /今日读数/, "只配账号级额度时也必须拿到真实积分")
  assert.doesNotMatch(joined, /token 折算（上游没给积分数据）/)
})

test("额度够 → 什么都不动", async () => {
  const pluginDir = tmp()
  const { config, state } = scaffold({}, {
    accounts: ["138****0001"],
    usage: JSON.stringify({
      t: new Date().toISOString(), provider: "loomy",
      providerAccount: "138****0001", model: "m", in: 300, out: 300,
    }) + "\n",
  })
  writeJson(join(config, "plugins.json"), {
    plugins: [entryFor(pluginDir, {
      enforce: true,
      dailyCredits: { "loomy/138****0001": 9999 },
    })],
  })
  writeFileSync(join(config, "credits-daily.json"), JSON.stringify({
    "loomy|138****0001|积分": {
      since: T, days: { [T]: 1 }, last: { used: 1, total: 1000, at: new Date().toISOString() },
    },
  }))
  const r = await enforce({ paths: paths({ configDir: config, stateDir: state }), pluginDir, quiet: true })
  assert.equal(r.acted, 0)
})
