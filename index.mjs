// 插件主入口 —— 额度检查在这里自己跑，用户装上就生效。
//
// magpie 会加载 package.json 的 main，交给它自己的 bun 进程（常驻）。
// 所以这里能：
//   · 读 logins.json / providers.json / quotas.json / usage.jsonl
//   · 写 logins.json（关账号）、providers.json（下架渠道）
//   · 起 setInterval 定时检查
//
// 也就是说「按积分卡额度」不需要任何外部命令行、不需要计划任务、不需要
// 另外装一个看门狗。这是别人能直接用起来的前提。
//
// 实测（2026-10-27 magpie 1.4.4）：主入口与 middleware 可以并存，
// 有 node:fs / node:child_process / process / Bun，进程常驻。

import { appendFileSync, existsSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  paths, readOptions, enforce, exportAccounts,
} from "./lib/engine.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

// 日志放插件自己的目录，方便用户直接看
const LOG_FILE = join(HERE, "credit-limit.log")
const MAX_LOG_BYTES = 512 * 1024

function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19)
  try {
    // 超过 512KB 就轮转一次，避免无限长
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".1")
    }
    appendFileSync(LOG_FILE, `${stamp}  ${line}\n`, "utf8")
  } catch {}
}

// 一个进程只跑一个循环：magpie 重新加载插件时会再执行一次模块，若不防重
// 会出现多个定时器同时改 logins.json，互相打架。
const GUARD = Symbol.for("magpie-credit-limit.watchdog")
const alreadyRunning = Boolean(globalThis[GUARD])
if (!alreadyRunning) globalThis[GUARD] = { at: Date.now() }

let timer = null
let running = false
let lastAt = 0
let lastResult = null
let currentInterval = null

// 一次检查：执行 + 刷新账号名单（面板要看到最新启用状态）
async function tick(reason) {
  if (running) return   // 上一轮还没跑完，跳过（余额读取是异步的）
  running = true
  try {
    const p = paths()
    const r = await enforce({
      paths: p,
      pluginDir: HERE,
      quiet: true,          // 命令行才需要打印；这里一律进日志
      onSay: (m) => log(m),
    })
    // 每轮顺手刷新名单：账号开关会被停用/恢复改，面板要看到最新的
    const a = exportAccounts(p, HERE)
    lastAt = Date.now()
    lastResult = { acted: r.acted, skipped: r.skipped, accounts: a.ok ? a.accounts : null }
    if (r.acted > 0) log(`本轮有 ${r.acted} 处调整（${reason}）`)
    else if (reason === "start") log("启动检查完成：无需调整")
    return lastResult
  } catch (e) {
    log(`检查出错（${reason}）：${e && e.message ? e.message : String(e)}`)
    lastResult = { error: String(e && e.message ? e.message : e) }
    return lastResult
  } finally {
    running = false
  }
}

function schedule(intervalMin) {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  currentInterval = intervalMin
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
    log("自动检查已关闭（checkEveryMinutes <= 0）")
    return
  }
  // 最短 30 秒，避免有人填 0.001 把上游打爆
  const ms = Math.max(30_000, intervalMin * 60_000)
  timer = setInterval(() => { tick("timer") }, ms)
  // 不阻止进程退出：magpie 关掉时这个插件也该跟着走
  timer.unref?.()
  log(`自动检查已启动：每 ${(ms / 60_000).toFixed(1)} 分钟一次`)
}

export const BudgetPlugin = async () => {
  if (alreadyRunning) {
    log("主入口被再次加载，沿用已有的检查循环")
  } else {
    log("插件加载")
    // 首次检查推迟几秒：magpie 刚起来时 providers/logins 可能还在写
    setTimeout(() => { tick("start") }, 5_000).unref?.()
    schedule(readOptions(paths(), HERE).intervalMin)
  }

  return {
    id: "budget",
    config: async () => {
      // magpie 每次热加载都会调 config()。本插件不提供模型，只做额度闸门
      // 与面板；这里借这次调用重新读间隔，改了立即生效。
      const o = readOptions(paths(), HERE)
      if (o.intervalMin !== currentInterval) schedule(o.intervalMin)
    },
  }
}

// ⚠️ 这里不能导出 tick 之类的函数：magpie 的插件协议是「模块导出的每个函数
// 都当成一个 server 来调用」（源码：else every function it exports, each
// once）。曾经把 tick 导出成 runOnce，结果 `magpie plugin list` 这种只读
// 命令也会被调一次 tick，当场就把超额渠道下架了。要手动跑请用
// magpie-budget/watchdog.mjs，不要从这里导出。

export default BudgetPlugin
