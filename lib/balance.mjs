// 读各渠道的真实积分余额，用「当天首见余额 − 当前余额」算今天花了多少分。
//
// 数据来源：magpie 自己的 `<配置目录>/quotas.json`。
//
// 一开始是自己逐个渠道去请求上游余额接口的，那是绕远路——magpie 的用量面板
// 本来就显示每个渠道的余额，说明它已经采集好了并且落了盘。这份文件的 key 是
// `<provider>/<账号>`，正好带账号维度，比自己实现还全。
//
// 好处：
//   1. 覆盖全部已登录渠道，不用为每个渠道写一套接口适配
//   2. 带账号维度，可以直接做「按账号卡积分」
//   3. 不额外打上游接口，不吃限流
//
// 代价是数据有延迟（magpie 什么时候刷新就什么时候新），所以每条都带 `at`，
// 太旧的要如实说"数据旧了"，不能当成实时值用。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// 配置目录不能靠 cwd 猜：插件宿主进程的 cwd 恰好是配置目录，但命令行调用时
// 不是。所以按「环境变量 → 家目录 → cwd」挨个试，取第一个真有 plugins.json 的。
export function findConfigDir() {
  const cands = []
  if (process.env.MAGPIE_CONFIG_DIR) cands.push(process.env.MAGPIE_CONFIG_DIR)
  cands.push(join(homedir(), ".config", "magpie"))
  try {
    if (process.cwd()) cands.push(process.cwd())
  } catch {}
  for (const d of cands) {
    try {
      if (existsSync(join(d, "plugins.json"))) return d
    } catch {}
  }
  return cands[0]
}

// 配置目录在模块加载时定一次；但路径本身每次调用时再拼，这样测试可以传
// 一个临时目录进来，不用去动真实的 ~/.config/magpie（以前只能靠起子进程
// 注入环境变量，测起来又慢又脏）。
const CONFIG_DIR = findConfigDir()

export function quotasPath(configDir) {
  return join(configDir || CONFIG_DIR, "quotas.json")
}

export function creditsDailyPath(configDir) {
  return join(configDir || CONFIG_DIR, "credits-daily.json")
}

// magpie 的余额数据超过这个时间就当"不新鲜"：默认 2 小时。
// 额度判断是每天的量级，2 小时前的余额差一点点不影响"今天花了多少"。
const STALE_MS = Number(process.env.BUDGET_QUOTA_STALE_MS || 2 * 3600_000)

// 从 "12600 积分" / "1078.43 积分" / "400 credits" 里取出数字。
// magpie 的 balance 是给人看的字符串，格式随渠道变，所以要有这个。
export function parseAmount(s) {
  if (typeof s === "number") return Number.isFinite(s) ? s : null
  if (typeof s !== "string") return null
  // 取第一个数字（允许千分位逗号、小数点）
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

// readQuotas 把 quotas.json 解析成 { "provider\0账号": {...} }
export function readQuotas(configDir) {
  const file = quotasPath(configDir)
  if (!existsSync(file)) return { ok: false, why: "没有 quotas.json（magpie 还没采集过余额）", entries: {} }
  let j
  try {
    j = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    return { ok: false, why: "quotas.json 读不了：" + e.message, entries: {} }
  }
  if (!j || typeof j !== "object") return { ok: false, why: "quotas.json 结构不对", entries: {} }

  const entries = {}
  let stale = 0
  const now = Date.now()
  for (const [key, v] of Object.entries(j)) {
    const q = v?.quota
    if (!q || typeof q !== "object") continue
    const provider = String(q.provider || key.split("/")[0] || "")
    const user = String(q.user || key.slice(provider.length + 1) || "")
    if (!provider) continue
    const at = String(v?.at || q.readAt || "")
    const atMs = Date.parse(at)
    const bal = parseAmount(q.balance)
    const windows = Array.isArray(q.windows) ? q.windows : []
    const entry = {
      key,
      provider,
      user,
      balance: bal,
      balanceText: String(q.balance || ""),
      plan: String(q.plan || ""),
      at,
      atMs: Number.isFinite(atMs) ? atMs : 0,
      ageMs: Number.isFinite(atMs) ? now - atMs : Infinity,
      windows,
    }

    // ⚠️ 同一个账号可能有多条 key：magpie 按「登录方式」存，比如
    // `minimax-code-global/r227bout` 和 `minimax-code-global/minimax code (global)`
    // 指向同一个 R227BOUT，余额一个 400 一个 800。按 key 各存一份基准的话，
    // 这两条会互相把对方当成"今天花了 400 分"。
    //
    // 所以按 `provider/user` 归一化，同一个账号只留**最新且余额能读出来**的那条。
    const canon = provider + "\u0000" + user
    const prev = entries[canon]
    if (!prev) {
      entries[canon] = entry
      continue
    }
    const better =
      (entry.balance !== null && prev.balance === null) ||
      (entry.balance !== null && prev.balance !== null && entry.atMs > prev.atMs)
    if (better) entries[canon] = entry
  }

  const list = Object.values(entries)
  for (const e of list) {
    if (e.atMs && now - e.atMs > STALE_MS) stale++
  }
  return { ok: true, entries, stale, total: list.length }
}

// 按渠道汇总余额（一个渠道多个账号时加起来）
export function balanceByChannel(entries) {
  const out = new Map()
  for (const e of Object.values(entries)) {
    if (e.balance === null) continue
    const cur = out.get(e.provider)
    if (cur) {
      cur.balance += e.balance
      cur.accounts.push(e.user)
      cur.atMs = Math.max(cur.atMs, e.atMs)
    } else {
      out.set(e.provider, { balance: e.balance, accounts: [e.user], atMs: e.atMs, plan: e.plan })
    }
  }
  return out
}

// readCreditsDaily 读 magpie 的每日积分消耗账本（credits-daily.json）。
//
// 这比「余额差值」直接得多：magpie 自己按天记了每个账号每个积分包花了多少
// 分，key 是 `<provider>|<账号>|<积分包名>`。能拿到就直接拿，不用自己存基准、
// 也不用猜是重置还是充值。
//
// 三种情况：
//   1. days[today] 有值  → 就是今天的消耗，最准
//   2. since === today   → 窗口恰好就是今天，last.used 即今日消耗
//   3. 都不是            → 窗口跨了好几天且没有按天数据，说不出「今天」是多少，
//                          返回 known:false，交给上层退回落差/折算算法
//
// ⚠️ 多积分包不能无脑相加：有的渠道会同时给一个「总」包和它的子包，三个加
// 起来就是双倍（codearts 的「总积分」=「基础积分包」+「赠送积分包」，
// 各 73.07，全加会算成 146.14）。所以名字带「总/total/合计」的包优先，
// 有它就只用它，没有才相加。这是启发式，不是上游保证的口径。
export function readCreditsDaily(today = dayKey(), configDir) {
  const file = creditsDailyPath(configDir)
  if (!existsSync(file)) {
    return { ok: false, why: "没有 credits-daily.json（magpie 还没按天记过积分）", entries: {} }
  }
  let j
  try {
    j = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    return { ok: false, why: "credits-daily.json 读不了：" + e.message, entries: {} }
  }
  if (!j || typeof j !== "object") {
    return { ok: false, why: "credits-daily.json 结构不对", entries: {} }
  }

  // 先按 provider|user 归拢，注意账号名里可能带 "|"？不会，但包名一定在最后一段
  const groups = new Map()
  for (const [key, v] of Object.entries(j)) {
    if (!v || typeof v !== "object") continue
    const parts = String(key).split("|")
    if (parts.length < 3) continue
    const provider = parts[0]
    const pack = parts[parts.length - 1]
    const user = parts.slice(1, parts.length - 1).join("|")
    if (!provider || !user) continue

    const last = v.last && typeof v.last === "object" ? v.last : {}
    const days = v.days && typeof v.days === "object" ? v.days : {}
    const perDay = Number(days[today])
    let used = null
    let from = null
    if (Number.isFinite(perDay)) {
      used = perDay
      from = "days"
    } else if (String(v.since || "") === today) {
      const u = Number(last.used)
      if (Number.isFinite(u)) {
        used = u
        from = "window"
      }
    }
    const at = String(last.at || "")
    const atMs = Date.parse(at)
    if (used === null) continue   // 这条算不出「今天」
    const g = groups.get(provider + "\u0000" + user) || []
    g.push({ pack, used, from, at, atMs: Number.isFinite(atMs) ? atMs : 0 })
    groups.set(provider + "\u0000" + user, g)
  }

  const AGG = /总|total|合计|总计|overall/i
  const entries = {}
  for (const [key, packs] of groups) {
    const agg = packs.filter((p) => AGG.test(p.pack))
    const use = agg.length ? agg : packs
    const used = use.reduce((s, p) => s + p.used, 0)
    const [provider, user] = key.split("\u0000")
    const newest = use.reduce((a, b) => (b.atMs > a.atMs ? b : a), use[0])
    entries[key] = {
      key,
      provider,
      user,
      used,
      from: use.length === 1 ? use[0].from : "sum",
      packs: use.map((p) => p.pack),
      at: newest.at,
      atMs: newest.atMs,
    }
  }
  return { ok: true, entries, total: Object.keys(entries).length }
}

// ── 基准与消耗 ─────────────────────────────────────────────────────────
//
// state 结构（budget-state.json 的 balanceBase 段）：
//   { "meituan/花月轩": { day: "2026-10-27", base: 1078.43, at: "..." } }
//
// 按「渠道/账号」存基准：账号级额度要用到，只按渠道存的话多账号没法分开算。

export function dayKey(at = Date.now()) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// usedToday 用一次余额读数算「今天花了多少分」。
// 返回 { known, used, base, reset }：known=false 表示算不出来（不能当 0）。
export function usedToday(prev, remaining, today) {
  if (remaining === null || !Number.isFinite(Number(remaining))) {
    return { known: false, used: 0, base: prev?.base, reset: false }
  }
  // 今天还没有基准：这一次读数就是起点
  if (!prev || prev.day !== today || !Number.isFinite(Number(prev.base))) {
    return { known: true, used: 0, base: remaining, reset: false }
  }
  const base = Number(prev.base)
  const used = base - remaining
  // 余额变高 = 套餐重置或自己充值。挪基准，消耗归零，不能记成负消耗。
  if (used < -0.005) {
    return { known: true, used: 0, base: remaining, reset: true }
  }
  return { known: true, used: Math.max(0, used), base, reset: false }
}

// rollBase 跨天时把「昨天最后一次读到的余额」当成今天的起点。
//
// 没有它的话，只要插件/进程在当天中途重启一次，基准就会被重置成「重启那一刻
// 的余额」，于是前面已经花掉的那部分凭空消失、当天额度被放宽一份——重启
// 越多次，实际能超得越多。用昨天最后一次读数接上就不存在这个口子。
//
// 不是昨天的（隔了几天没跑）就不接了：中间发生了什么已经无从判断，
// 宁可用今天第一次读数起步。
export function rollBase(prev, today) {
  if (!prev || prev.day === today) return prev
  const last = Number(prev.remaining)
  if (!Number.isFinite(last)) return null
  const gapDays = (dayIndex(today) - dayIndex(prev.day))
  if (!Number.isFinite(gapDays) || gapDays !== 1) return null
  return { day: today, base: last }
}

// 把 "YYYY-MM-DD" 折算成天序号，用来判断两个日期是不是相邻的两天。
// 自己算而不用 Date 相减，是为了避开夏令时那种「一天不是 24 小时」的坑。
function dayIndex(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""))
  if (!m) return NaN
  const [, y, mo, d] = m
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86400000)
}
