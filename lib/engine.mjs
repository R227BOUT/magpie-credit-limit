// 额度执行引擎 —— 在插件进程里跑，不需要任何外部命令行。
//
// 为什么放在插件里：magpie 的插件主入口（package.json 的 main）由 magpie
// 自己的 bun 进程加载并常驻，能读文件、能写文件、能起定时器。所以「看门狗」
// 这件事完全可以由插件自己做，用户装上就生效，不用去开命令行、不用配计划任务。
//
// 实测确认的能力（2026-10-27，magpie 1.4.4 bun）：
//   · 有 node:fs、有 node:child_process、有 process/Bun
//   · 进程常驻（setInterval 会一直跑）
//   · cwd 就是 magpie 配置目录
//
// 判定优先级：能算出真实积分的渠道用真实积分（余额差值）；算不出来的退回
// token 折算，并明确标注是折算的。绝不把「读不到」当成「花了 0」。

import {
  existsSync, readFileSync, writeFileSync, renameSync,
  openSync, closeSync, unlinkSync, mkdirSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readQuotas, readCreditsDaily, usedToday, dayKey, rollBase, findConfigDir,
} from "./balance.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根目录（lib/ 的上一层）
export const PLUGIN_DIR = dirname(HERE)

// 默认换算率（1 积分 = N token）。
//
// 数据源：`LMR猎模人/开发版/data/usage.db` 的 logs 表（17,709 条真实调用），
// 按渠道汇总 total_tokens 与 credit 求加权比。2026-10-27 复核结果：
//
//   渠道            样本      total_tokens    credit    加权 tok/分
//   loomy          8,088   1,639,219,379   169,585       9,666
//   autoclaw       1,101     262,071,874    23,043      11,373
//   officeace        765     131,690,489     3,376      39,005
//   raccoon          323      28,681,409     1,116      25,700
//   workbuddy          9       3,676,567       154      23,804
//   workbuddyai        4         558,458        36      15,338
//
// 两条统计口径上的坑，复核时才看清：
//
//  1. **必须只取 credit >= 1 的记录**。积分上报精确到 0.01，小请求会被四舍
//     五入成 0.01 甚至 0，于是 40 tok / 0.01 分 = 4,000 这种噪声会把均值
//     彻底带偏。同一渠道「含 credit<1」与「只含 >=1」能差 20 倍。
//  2. **credit 留空（NULL）或为 0 的记录是“没采集到”，不是“免费”**。早期
//     把它们当 0 放进分母，会得到明显偏低的换算率——autoclaw 曾经因此被算成
//     1,900，只有真实值的六分之一。
//
// 没有样本的渠道一律 10000 占位（面板上标「无来源」）。这个 10000 是**猜的**，
// 不是测出来的：它约等于 loomy 的实测值，纯属让界面有个能算的数。
export const DEFAULT_TPC = {
  // —— 有实测来源（见上表）——
  loomy: 9666, officeace: 39000, raccoon: 25700, autoclaw: 11373,
  workbuddy: 23804, "workbuddy-ai": 15338,
  // —— 无样本，占位值，非实测 ——
  "autoclaw-cn": 11373,   // 与 autoclaw 同一家，借用
  zcode: 10000, qwenwork: 10000, "qwenwork-enterprise": 10000,
  teleagent: 10000, dumate: 10000, codearts: 10000, qoder: 10000,
  "qoder-cn": 10000, meituan: 10000, lobster: 10000, cline: 10000,
  "trae-cn": 10000, "trae-global": 10000, minimax: 10000,
  "minimax-code": 10000, "minimax-code-global": 10000,
  "opencode-zen-free": 10000, "cloudflare-workers-ai": 10000,
  qianfan: 10000,
}

// 哪些渠道的换算率是实测的（面板要据此标「无来源」）
export const TPC_MEASURED = new Set([
  "loomy", "officeace", "raccoon", "autoclaw", "workbuddy", "workbuddy-ai",
])

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function readJson(path, dflt) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return dflt
  }
}

function writeJson(path, v) {
  const tmp = path + ".tmp"
  writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8")
  renameSync(tmp, path)
}

// 运行环境：配置目录、状态目录都由调用方给，默认取 magpie 的
export function paths(opts = {}) {
  // BUDGET_HOME 是老命令行/测试用的覆盖（配置与状态同目录）。保留它，
  // 免得把已有的 .bat 和测试全改一遍。
  const home = opts.stateDir || process.env.BUDGET_HOME
  const configDir = opts.configDir || process.env.MAGPIE_CONFIG_DIR || home || findConfigDir()
  const stateDir = opts.stateDir || home || configDir
  return {
    configDir,
    usage: join(configDir, "usage.jsonl"),
    providers: join(configDir, "providers.json"),
    plugins: join(configDir, "plugins.json"),
    logins: join(configDir, "logins.json"),
    state: join(stateDir, "budget-state.json"),
  }
}

// ── 插件 options（唯一配置源）──────────────────────────────────────────────

// 在 plugins.json 里找到本插件那条 entry。spec 可能是绝对路径、npm 名、
// github:owner/repo，所以按几种归一化形式都比一遍。
export function findEntry(plugins, pluginDir = PLUGIN_DIR) {
  const norm = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
  const hereN = norm(pluginDir)
  for (const e of plugins || []) {
    if (typeof e?.spec !== "string") continue
    const s = norm(e.spec)
    if (s === hereN || s.endsWith("\\magpie-credit-limit")) return e
  }
  for (const e of plugins || []) {
    if (typeof e?.spec !== "string") continue
    if (e.spec === "magpie-credit-limit" || e.spec === "github:R227BOUT/magpie-credit-limit") return e
  }
  return null
}

export function readOptions(p = paths(), pluginDir = PLUGIN_DIR) {
  if (!existsSync(p.plugins)) return { enforce: false, daily: {}, split: false, intervalMin: 5 }
  const j = readJson(p.plugins, null)
  if (!j) return { enforce: false, daily: {}, split: false, intervalMin: 5, why: "plugins.json 读不了" }
  const entry = findEntry(j.plugins, pluginDir)
  if (!entry) return { enforce: false, daily: {}, split: false, intervalMin: 5, why: "plugins.json 里没有本插件" }
  if (entry.off) return { enforce: false, daily: {}, split: false, intervalMin: 5, why: "插件被停用了" }
  const o = entry.options && typeof entry.options === "object" ? entry.options : {}
  const iv = Number(o.checkEveryMinutes)
  return {
    enforce: o.enforce === true,
    daily: o.dailyCredits && typeof o.dailyCredits === "object" ? o.dailyCredits : {},
    split: o.splitChannelBudget === true,
    // 插件自己跑的时候多久查一次。0 或负数 → 不自动跑
    intervalMin: Number.isFinite(iv) ? iv : 5,
    raw: o,
  }
}

// confOf parses the flat dailyCredits map:
//   "loomy" → channel cap，"loomy:tpc" → channel tpc，
//   "loomy/138****0001" → account cap，"loomy/138****0001:tpc" → account tpc
//
// split 打开时，渠道级额度被当作「该渠道所有账号加起来的总额度」，每个
// 账号的实际上限 = 渠道额度 / 该渠道启用的账号数。
// 账号级显式填了的（dailyCredits 里有 "loomy/xxx"）优先，不再平摊。
export function confOf(daily, split, logins = []) {
  const channels = new Map()
  const accounts = new Map()
  for (const [k, v] of Object.entries(daily || {})) {
    if (k.endsWith(":tpc")) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) {
      if (k.includes("/")) accounts.set(k, { dailyCredits: n })
      else channels.set(k, { dailyCredits: n })
    }
  }
  for (const [k, v] of Object.entries(daily || {})) {
    if (!k.endsWith(":tpc")) continue
    const n = Number(v)
    if (!(Number.isFinite(n) && n > 0)) continue
    const base = k.slice(0, -4)
    const target = base.includes("/") ? accounts : channels
    if (target.has(base)) target.get(base).tokensPerCredit = n
  }
  const tpcOf = (map, id) => Number(map.get(id)?.tokensPerCredit) || DEFAULT_TPC[id] || 10000

  // 每个渠道启用的账号名单，平摊时要用
  const accountsOn = new Map()
  for (const e of Array.isArray(logins) ? logins : []) {
    const ch = String(e?.agent || "").replace(/^plugin:/, "")
    if (!ch) continue
    if (e?.on === false) continue
    const user = String(e?.user || "")
    if (!user) continue
    if (!accountsOn.has(ch)) accountsOn.set(ch, [])
    accountsOn.get(ch).push(user)
  }
  const enabledAccounts = (id) => accountsOn.get(id) || []

  // share：渠道额度分到这个账号头上是多少；0 表示这个渠道不做账号级管
  const share = (id, acct) => {
    const cap = Number(channels.get(id)?.dailyCredits) || 0
    if (cap <= 0 || !split) return 0
    const list = enabledAccounts(id)
    if (list.length < 2) return 0        // 只有一个账号就没有"分摊"可言
    if (!list.includes(acct)) return 0
    return cap / list.length
  }

  return {
    channels,
    accounts,
    channelCap: (id) => Number(channels.get(id)?.dailyCredits) || 0,
    channelTpc: (id) => tpcOf(channels, id),
    accountCap: (id, acct) => Number(accounts.get(id + "/" + acct)?.dailyCredits) || 0,
    // 账号自己的换算率；没配时，平摊模式下沿用渠道的（同一个渠道同一个
    // 计费口径），最后才回落默认值。不这样做，渠道设了 tpc 而账号没设，
    // 账号会用 10000 去折算，分数被压成百分之一，怎么算都不到上限。
    accountTpc: (id, acct) => {
      const own = Number(accounts.get(id + "/" + acct)?.tokensPerCredit)
      if (own > 0) return own
      if (split) {
        const ch = Number(channels.get(id)?.tokensPerCredit)
        if (ch > 0) return ch
      }
      return DEFAULT_TPC[id] || 10000
    },
    enabledAccounts,
    share,
  }
}

// ── 账本 ────────────────────────────────────────────────────────────────────

export function readRows(usagePath) {
  if (!existsSync(usagePath)) return { rows: [], broken: 0 }
  const out = []
  let broken = 0
  for (const line of readFileSync(usagePath, "utf8").split("\n")) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      broken++
      continue
    }
    const at = Date.parse(r.t)
    if (!Number.isFinite(at)) {
      broken++
      continue
    }
    out.push({ at, provider: String(r.provider || "?"), account: String(r.providerAccount || ""), row: r })
  }
  return { rows: out, broken }
}

export function usageBy(rows, since) {
  // token 口径固定 in+out（与面板的说明一致）。cache_read 不算：
  // zcode 缓存读占 95% 的量，算进去会让额度形同虚设。
  const byChannel = new Map()
  const byAccount = new Map()
  for (const { at, provider, account, row } of rows) {
    if (at < since) continue
    const t = (Number(row.in) || 0) + (Number(row.out) || 0)
    byChannel.set(provider, (byChannel.get(provider) || 0) + t)
    if (account) {
      const k = provider + "/" + account
      byAccount.set(k, (byAccount.get(k) || 0) + t)
    }
  }
  return { byChannel, byAccount }
}

export const dayStart = (at) => {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ── logins.json：账号开关（与 magpie 界面同一份数据）────────────────────────

export function readLogins(loginsPath) {
  try {
    const ls = JSON.parse(readFileSync(loginsPath, "utf8"))
    return Array.isArray(ls) ? ls : Object.values(ls)
  } catch {
    return null
  }
}

// writeLoginsSafe 写前拿 magpie 的锁文件（logins.json.lock，magpie 的
// filelock.Mutex 用同一个路径），写完（temp + rename 原子替换）再放。
// 锁只保护这一刻的读-改-写竞态；拿不到就等，等不到就放弃这一轮。
function writeLoginsSafe(loginsPath, ls) {
  const lock = loginsPath + ".lock"
  let got = false
  for (let i = 0; i < 10 && !got; i++) {
    try {
      const fd = openSync(lock, "wx")
      closeSync(fd)
      got = true
    } catch {
      sleepSync(300)
    }
  }
  if (!got) return { ok: false, why: "logins.json 被占用，这轮放弃（下轮再试）" }
  try {
    const tmp = loginsPath + ".budget-tmp"
    writeFileSync(tmp, JSON.stringify(ls, null, 2), "utf8")
    renameSync(tmp, loginsPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, why: "写失败：" + e.message }
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

// ── 账号名单导出（给面板用）──────────────────────────────────────────────
//
// 面板的 providers:list 只给渠道 id 和名字，usage:summary 明确不给账号，
// 而且面板**连网络都碰不到**（magpie 的 bridge 文档原话：the page can't
// reach the network or magpie's API itself）。所以「按账号设额度」这件事，
// 面板自己永远列不出账号。
//
// 唯一能过墙的通道是**插件自己的 options**：面板能 magpie.options.get()，
// 插件主入口能直接写 plugins.json 里这条 entry 的 Options。于是每轮把名单
// 写进 options.accountsByChannel，面板读 options 就看到了。
//
// 只写能用来认人的字段：渠道 id、账号显示名、是否启用、套餐。不写 token、
// 不写 cookie、不写 home —— 面板用不上，写出去只是多一个泄漏面。
export function exportAccounts(p = paths(), pluginDir = PLUGIN_DIR) {
  const ls = readLogins(p.logins)
  if (!Array.isArray(ls)) return { ok: false, why: "logins.json 读不了" }

  const byChannel = {}
  for (const e of ls) {
    const ch = String(e?.agent || "").replace(/^plugin:/, "")
    const user = String(e?.user || "").trim()
    if (!ch || !user) continue
    ;(byChannel[ch] ||= []).push({
      user,
      on: e?.on !== false,
      plan: String(e?.plan || ""),
    })
  }
  for (const ch of Object.keys(byChannel)) {
    byChannel[ch].sort((a, b) => a.user.localeCompare(b.user, "zh"))
  }

  const j = readJson(p.plugins, null)
  if (!j) return { ok: false, why: "plugins.json 读不了" }
  const entry = findEntry(j.plugins || [], pluginDir)
  if (!entry) return { ok: false, why: "plugins.json 里没有本插件这条" }
  entry.options = entry.options && typeof entry.options === "object" ? entry.options : {}

  // 内容没变就不写盘：plugins.json 是 magpie 热加载的，无谓地重写
  // 会让界面一闪
  const next = JSON.stringify(byChannel)
  const prev = JSON.stringify(entry.options.accountsByChannel || {})
  if (next === prev && entry.options.accountsAt) {
    return { ok: true, unchanged: true, channels: Object.keys(byChannel).length }
  }

  entry.options.accountsByChannel = byChannel
  entry.options.accountsAt = new Date().toISOString()

  // 原子写：plugins.json 被 magpie 盯着，写一半会被读成坏 JSON
  const tmp = p.plugins + ".budget-tmp"
  try {
    writeFileSync(tmp, JSON.stringify(j, null, 2), "utf8")
    renameSync(tmp, p.plugins)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    return { ok: false, why: "写 plugins.json 失败：" + e.message }
  }
  const n = Object.values(byChannel).reduce((s, v) => s + v.length, 0)
  return { ok: true, channels: Object.keys(byChannel).length, accounts: n }
}

// ── 状态与执行 ──────────────────────────────────────────────────────────────

export function readState(p = paths()) {
  return readJson(p.state, { parked: {}, parkedAccounts: {} })
}

function park(p, channel, state) {
  const f = readJson(p.providers, null)
  if (!f || !Array.isArray(f.providers)) return { ok: false, why: "providers.json 读不了" }
  const prov = f.providers.find((x) => x.id === channel)
  if (!prov) return { ok: false, why: "providers.json 里没有这个渠道" }
  if (state.parked[channel]) return { ok: true, why: "已经摘掉了" }
  const models = Array.isArray(prov.models) ? prov.models : []
  if (!Array.isArray(prov.pickedFrom)) return { ok: false, why: "这个渠道没有 pickedFrom，拒绝执行" }
  // ⚠️ 快照可能是空的：如果这个渠道之前已经被摘过、或者用户自己手动清空了
  // models，那 models 就是 []。存空快照的话恢复时"装回 0 个模型"等于没恢复
  // （真踩过：workbuddy-ai 被摘掉后一直恢复不回来）。
  // 所以快照为空时退回 pickedFrom —— 那才是这个渠道本来能用的模型全集。
  const snapshot = models.length > 0 ? models : prov.pickedFrom.slice()
  if (snapshot.length === 0) return { ok: false, why: "这个渠道既没有 models 也没有 pickedFrom，拒绝执行" }
  state.parked[channel] = { models: snapshot, at: new Date().toISOString() }
  writeJson(p.state, state)
  prov.models = []
  writeJson(p.providers, f)
  // models 为空时快照来自 pickedFrom，两个数字不一样。只报「摘掉 0 个」
  // 会让人以为什么都没做，得把恢复时按哪个数装回也说清楚。
  return {
    ok: true,
    why: models.length === snapshot.length
      ? `摘掉 ${models.length} 个模型`
      : `摘掉 ${models.length} 个模型（models 本来就是空的，按 pickedFrom 记了 ${snapshot.length} 个，恢复时按快照装回）`,
  }
}

function unpark(p, channel, state) {
  const kept = state.parked[channel]
  if (!kept) return { ok: false, why: "没摘过" }
  const f = readJson(p.providers, null)
  if (!f || !Array.isArray(f.providers)) return { ok: false, why: "providers.json 读不了" }
  const prov = f.providers.find((x) => x.id === channel)
  if (!prov) {
    delete state.parked[channel]
    writeJson(p.state, state)
    return { ok: false, why: "providers.json 里已经没有这个渠道了，只清掉记录" }
  }
  prov.models = kept.models
  writeJson(p.providers, f)
  delete state.parked[channel]
  writeJson(p.state, state)
  return { ok: true, why: `装回 ${kept.models.length} 个模型` }
}

// parkAccount flips one account's on off in logins.json（渠道其他账号不受
// 影响）。我们停过的都记在 state 里，恢复只恢复自己停的。
function parkAccount(p, agent, user, state) {
  const ls = readLogins(p.logins)
  if (!ls) return { ok: false, why: "logins.json 读不了" }
  const key = agent + "/" + user
  if (state.parkedAccounts[key]) return { ok: true, why: "已经停用了" }
  const rec = ls.find((l) => l.agent === agent && l.user === user)
  if (!rec) return { ok: false, why: "logins.json 里没有这个账号" }
  if (rec.on === false) return { ok: true, why: "本来就是关的" }
  rec.on = false
  const w = writeLoginsSafe(p.logins, ls)
  if (!w.ok) return { ok: false, why: w.why }
  state.parkedAccounts[key] = { at: new Date().toISOString() }
  writeJson(p.state, state)
  return { ok: true, why: "已停用该账号（渠道其他账号继续）" }
}

function unparkAccount(p, agent, user, state) {
  const key = agent + "/" + user
  if (!state.parkedAccounts[key]) return { ok: false, why: "没停用过" }
  const ls = readLogins(p.logins)
  if (!ls) return { ok: false, why: "logins.json 读不了" }
  const rec = ls.find((l) => l.agent === agent && l.user === user)
  if (!rec) {
    delete state.parkedAccounts[key]
    writeJson(p.state, state)
    return { ok: false, why: "logins.json 里已经没有这个账号了，只清记录" }
  }
  rec.on = true
  const w = writeLoginsSafe(p.logins, ls)
  if (!w.ok) return { ok: false, why: w.why }
  delete state.parkedAccounts[key]
  writeJson(p.state, state)
  return { ok: true, why: "已重新启用该账号" }
}

// enforce：账号级先判（超限只停那一个账号），渠道级再判（合计超限才摘渠道）。
//
// 返回 { acted, log }，log 是给人看的每一条动作。插件里跑的时候把这些
// 写进日志文件，命令行跑的时候直接打印。
export async function enforce(opts = {}) {
  const p = opts.paths || paths(opts)
  const quiet = opts.quiet === true
  const log = []
  const say = (msg) => { log.push(msg); if (!quiet && opts.onSay) opts.onSay(msg) }

  const { enforce: on, daily, split } = readOptions(p, opts.pluginDir)
  if (!on) {
    say("额度执行没开（options.enforce 不是 true）—— 只记账，不拦")
    return { acted: 0, log, skipped: "enforce-off" }
  }
  const logins = readLogins(p.logins)
  const conf = confOf(daily, split, logins)
  const { rows } = readRows(p.usage)
  const since = dayStart(Date.now())
  const { byChannel, byAccount } = usageBy(rows, since)
  const state = readState(p)
  let acted = 0

  // 平摊模式下，渠道额度分给每个启用账号的部分也要作为账号上限参与判定。
  // 两层取小的：显式账号额度（若有）与平摊份额。
  const effCap = (channel, account) => {
    const own = conf.accountCap(channel, account)
    const sh = conf.share(channel, account)
    if (own > 0 && sh > 0) return Math.min(own, sh)
    return own > 0 ? own : sh
  }

  // ── 真实积分：用 magpie 采到的余额，算「今天花了多少分」──────────────
  //
  // magpie 的用量面板本来就显示每个渠道的余额，说明它已经采集并落盘到
  // quotas.json（key 是 `<provider>/<账号>`）。所以不必自己逐个渠道打上游
  // 接口——直接读它，覆盖全、带账号维度、还不吃限流。
  //
  // 判定优先级：能算出真实积分的渠道用真实积分；算不出来（没采集到、
  // 数据太旧、余额不是数字）的渠道退回 token 折算，并且明确说是折算的。
  // 绝不能把「读不到」当成「花了 0」——那等于额度从没生效。
  const today = dayKey()
  state.balanceBase = state.balanceBase && typeof state.balanceBase === "object" ? state.balanceBase : {}
  // "channel/account" → 今日已用积分
  const creditsByAccount = new Map()
  // 这个数是「怎么来的」——日志里必须写清楚，否则用户没法判断可不可信
  const creditHow = new Map()
  // channel → 今日已用积分（该渠道所有账号相加）
  const creditsByBalance = new Map()
  const seen = new Set()

  // ── 第一优先：magpie 按天记的积分账本（credits-daily.json）────────────
  //
  // 上游直接给了「今天花了多少分」，不需要我们存基准、也不需要分辨是
  // 重置还是充值。有它就用它。
  const cd = readCreditsDaily(today, p.configDir)
  if (!cd.ok) {
    say(`读不到每日积分账本（${cd.why}）→ 退回余额差值 / token 折算`)
  } else {
    for (const e of Object.values(cd.entries)) {
      if (conf.channelCap(e.provider) <= 0 && conf.accountCap(e.provider, e.user) <= 0) continue
      const k = e.provider + "/" + e.user
      creditsByAccount.set(k, e.used)
      creditHow.set(k, "今日读数")
      creditsByBalance.set(e.provider, (creditsByBalance.get(e.provider) || 0) + e.used)
      seen.add(k)
    }
  }

  // ── 第二优先：余额差值（账本没覆盖到的渠道）──────────────────────────
  const quotaInfo = readQuotas(p.configDir)
  if (!quotaInfo.ok) {
    say(`读不到余额数据（${quotaInfo.why}）→ 这些渠道按 token 折算判断`)
  } else {
    if (quotaInfo.stale > 0) {
      say(`提示：${quotaInfo.stale}/${quotaInfo.total} 条余额数据超过 2 小时没更新，判断可能滞后`)
    }
    for (const e of Object.values(quotaInfo.entries)) {
      // ⚠️ 判空条件必须同时看渠道级和账号级。
      // 以前只看渠道级，于是「只给某一个账号填了额度、渠道没填」这种情况
      // 会被整条跳过，退回 token 折算——明明 magpie 采到了真实余额，却按
      // 估算值判，正好把最需要准的场景丢掉了。
      if (conf.channelCap(e.provider) <= 0 && conf.accountCap(e.provider, e.user) <= 0) continue
      const k = e.provider + "/" + e.user
      // 跨天时先把基准接上昨天最后一次读数（见 rollBase）。少了这一步，
      // 进程当天重启一次，已经消耗的部分就会归零，额度等于被放宽一份。
      seen.add(k)
      // 第一优先已经拿到今日读数了，别用估算把它盖掉
      if (creditsByAccount.has(k)) continue
      const prev = rollBase(state.balanceBase[k], today)
      const u = usedToday(prev, e.balance, today)
      if (!u.known) continue   // 余额不是数字，这条算不出真实积分
      state.balanceBase[k] = { day: today, base: u.base, at: new Date().toISOString(), remaining: e.balance }

      creditsByAccount.set(k, u.used)
      creditHow.set(k, "余额差值")
      creditsByBalance.set(e.provider, (creditsByBalance.get(e.provider) || 0) + u.used)

      if (u.reset) {
        say(`${e.provider}/${e.user} 余额变高（${prev?.base} → ${e.balance}），按重置/充值处理，今日消耗归零`)
      }
    }
    // 账号删掉或换号之后，它的基准会一直留在 state 里越攒越多。清掉这次
    // 已经看不到的——但只在真的读到余额时清，读不到就清等于把记忆全删了。
    for (const k of Object.keys(state.balanceBase)) {
      if (!seen.has(k)) delete state.balanceBase[k]
    }
  }
  writeJson(p.state, state)

  // 平摊模式下，渠道额度也要覆盖到「账本里没出现过的账号」：
  // 某个账号今天一次没调用，byAccount 里就没有它，但它的份额仍然占着，
  // 不能因为「没记录」就放过判定。
  if (split) {
    for (const channel of conf.channels.keys()) {
      for (const account of conf.enabledAccounts(channel)) {
        const k = channel + "/" + account
        if (!byAccount.has(k)) byAccount.set(k, 0)
      }
    }
  }

  // 能读到余额的渠道，即使账本里一条记录都没有，也要参与渠道级判定：
  // 余额是上游给的，与 magpie 有没有记这笔账无关。
  for (const channel of creditsByBalance.keys()) {
    if (!byChannel.has(channel)) byChannel.set(channel, 0)
  }

  // 上游记了消耗、但 magpie 账本里今天一条都没有（比如这个账号同时在别的
  // 客户端上用）——这种也要参与账号级判定，否则额度形同虚设。
  for (const k of creditsByAccount.keys()) {
    if (!byAccount.has(k)) byAccount.set(k, 0)
  }

  // ---- 账号级 ----
  for (const [key, tokens] of byAccount) {
    if (!key.includes("/")) continue
    const slash = key.indexOf("/")
    const channel = key.slice(0, slash)
    const account = key.slice(slash + 1)
    const cap = effCap(channel, account)
    if (cap <= 0) continue
    // 有真实积分就用真实积分，否则 token 折算
    const real = creditsByAccount.get(channel + "/" + account)
    const credits = real !== undefined ? real : tokens / conf.accountTpc(channel, account)
    if (credits < cap) continue
    const agent = "plugin:" + channel
    if (!state.parkedAccounts[agent + "/" + account]) {
      const r = parkAccount(p, agent, account, state)
      const how = creditHow.get(channel + "/" + account) || "token 折算（上游没给积分数据）"
      // 说清这个额度是怎么来的：账号自己填的、平摊分的、还是两者取小。
      // 不然用户看到「额度 100」会以为是自己填的 500 没生效。
      const ownCap = conf.accountCap(channel, account)
      const sh = conf.share(channel, account)
      const src = ownCap > 0 && sh > 0
        ? "（账号额度与平摊份额取小）"
        : (sh > 0 ? "（渠道额度平摊）" : "")
      say(`停用账号 ${channel}/${account}：今天 ${credits.toFixed(1)} 分 / 额度 ${cap.toFixed(1)} 分（${how}）${src} → ${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`)
      if (r.ok) acted++
    }
  }
  for (const key of Object.keys(state.parkedAccounts || {})) {
    const slash = key.indexOf("/")
    const agent = key.slice(0, slash)
    const user = key.slice(slash + 1)
    const channel = agent.replace(/^plugin:/, "")
    const tokens = byAccount.get(channel + "/" + user) || 0
    const cap = effCap(channel, user)
    const real = creditsByAccount.get(channel + "/" + user)
    const credits = cap > 0 ? (real !== undefined ? real : tokens / conf.accountTpc(channel, user)) : 0
    if (cap > 0 && credits >= cap) continue
    const r = unparkAccount(p, agent, user, state)
    say(`启用账号 ${channel}/${user}：${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`)
    if (r.ok) acted++
  }

  // ---- 渠道级 ----
  // 平摊模式下，账号级判定已经把每个账号卡在 cap/n，合计一定 ≤ cap，
  // 所以渠道级不该再因为「合计到 cap」就摘整个渠道 —— 那等于把平摊废掉。
  // 此时渠道级只在「合计超过 cap 且账号级没能拦住」时兜底（例如账本里
  // 出现了 logins.json 里没有的账号）。判据用 1.02 的余量，避免刚好
  // 卡在边界上来回抖。
  //
  // 能读到余额的渠道，这里的 credits 是**真实积分**（余额差值），不是折算值。
  const channelCredits = (channel, tokens) =>
    creditsByBalance.has(channel)
      ? creditsByBalance.get(channel)
      : tokens / conf.channelTpc(channel)

  for (const [channel, tokens] of byChannel) {
    const cap = conf.channelCap(channel)
    if (cap <= 0) continue
    const credits = channelCredits(channel, tokens)
    if (credits < cap) continue
    if (split && credits < cap * 1.02) continue   // 平摊内的正常到达，不摘渠道
    if (!state.parked[channel]) {
      const r = park(p, channel, state)
      const how = creditsByBalance.has(channel) ? "真实积分" : "token 折算"
      say(`下架渠道 ${channel}：今天 ${credits.toFixed(2)} 分 / 额度 ${cap} 分（${how}） → ${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`
        + (split ? "（平摊模式下仍超总额度，兜底）" : ""))
      if (r.ok) acted++
    }
  }
  for (const channel of Object.keys(state.parked || {})) {
    const tokens = byChannel.get(channel) || 0
    const cap = conf.channelCap(channel)
    const credits = cap > 0 ? channelCredits(channel, tokens) : 0
    // 与上面同一套阈值：平摊模式下合计到达 cap 不算超，不保留"下架"状态
    const overAt = split ? cap * 1.02 : cap
    if (cap > 0 && credits >= overAt) continue
    const r = unpark(p, channel, state)
    say(`装回渠道 ${channel}：${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`)
    if (r.ok) acted++
  }

  if (!acted && !quiet) say("没有需要执行的调整")
  return { acted, log }
}

export function restoreAll(opts = {}) {
  const p = opts.paths || paths(opts)
  const state = readState(p)
  const log = []
  let n = 0
  for (const key of Object.keys(state.parkedAccounts || {})) {
    const slash = key.indexOf("/")
    const r = unparkAccount(p, key.slice(0, slash), key.slice(slash + 1), state)
    log.push(`启用账号 ${key}：${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`)
    if (r.ok) n++
  }
  for (const channel of Object.keys(state.parked || {})) {
    const r = unpark(p, channel, state)
    log.push(`装回渠道 ${channel}：${r.ok ? "" : "没"}${r.ok ? r.why : "成功：" + r.why}`)
    if (r.ok) n++
  }
  if (!n) log.push("没有摘掉或停用过任何东西")
  return { restored: n, log }
}

// 看一眼各渠道的真实余额和今日消耗，不动任何配置。
// 余额来源是 magpie 采到的 quotas.json —— 用量面板里能看到的，这里就有。
export function balanceReport(opts = {}) {
  const p = opts.paths || paths(opts)
  const { daily, split } = readOptions(p, opts.pluginDir)
  const logins = readLogins(p.logins)
  const conf = confOf(daily, split, logins)
  const state = readState(p)
  const today = dayKey()
  state.balanceBase = state.balanceBase && typeof state.balanceBase === "object" ? state.balanceBase : {}
  const q = readQuotas(p.configDir)
  if (!q.ok) return { ok: false, why: q.why, rows: [] }
  // 上游按天记的消耗（有就用它，比自己算差值准）
  const cd = readCreditsDaily(today, p.configDir)
  const dailyUsed = new Map()
  if (cd.ok) {
    for (const e of Object.values(cd.entries)) dailyUsed.set(e.provider + "/" + e.user, e.used)
  }
  const rowsOut = []
  const entries = Object.values(q.entries).sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.user.localeCompare(b.user, "zh"))
  for (const e of entries) {
    const k = e.provider + "/" + e.user
    const prev = rollBase(state.balanceBase[k], today)
    const u = usedToday(prev, e.balance, today)
    if (u.known) {
      state.balanceBase[k] = { day: today, base: u.base, at: new Date().toISOString(), remaining: e.balance }
    }
    const du = dailyUsed.get(k)
    const used = du !== undefined ? du : (u.known ? u.used : null)
    const how = du !== undefined ? "今日读数" : (u.known ? "余额差值" : "算不出")
    const capA = conf.accountCap(e.provider, e.user)
    const capC = conf.channelCap(e.provider)
    const cap = capA > 0 ? capA : capC
    rowsOut.push({
      key: k,
      provider: e.provider,
      user: e.user,
      balance: e.balance,
      balanceText: e.balanceText,
      used,
      how,
      reset: u.reset,
      cap,
      capFrom: capA > 0 ? "account" : (capC > 0 ? "channel" : ""),
      stale: e.atMs ? Date.now() - e.atMs > 2 * 3600_000 : true,
    })
  }
  writeJson(p.state, state)
  return { ok: true, stale: q.stale, total: q.total, rows: rowsOut }
}
