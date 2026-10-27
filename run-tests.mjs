#!/usr/bin/env node
// 发布闸门：全量测试 + 脱敏检查，任一不通过就退出非零。
//
//   node run-tests.mjs
//
// 为什么要有这个：这个插件整天读写 logins.json / quotas.json，里面全是
// 账号标识。写文档和测试桩的时候顺手粘一段真实数据太容易了，而关键词
// grep 抓不到 —— 真实 token 往往就藏在一段「比如返回这样」的示例里。
// 所以脱敏检查必须跑真实凭据比对，而不是关键词。
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ["路由策略 / 请求闸门", "test/run.mjs"],
  ["面板", "test/panel.mjs"],
  ["积分判定回归", "test/credits-daily.mjs"],
]

// 真实浏览器渲染另跑（要 Edge + CDP，CI 上不一定有）
const OPTIONAL = [
  ["面板真实渲染（需要 Edge）", "test/panel-render.mjs"],
]

function run(file) {
  return spawnSync(process.execPath, [join(HERE, file)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function verdict(r) {
  const m = /^# (pass|fail)\s+(\d+)$/m
  let pass = 0, fail = 0
  for (const line of (r.stdout || "").split("\n")) {
    let x = m.exec(line.trim())
    if (x && x[1] === "pass") pass = Number(x[2])
    else if (x && x[1] === "fail") fail = Number(x[2])
  }
  return { pass, fail, ok: r.status === 0 && fail === 0 }
}

let totalPass = 0
let bad = 0

console.log("=== 必跑 ===")
for (const [name, file] of SUITES) {
  const r = run(file)
  const v = verdict(r)
  totalPass += v.pass
  if (v.ok) {
    console.log(`  PASS  ${name}  (${v.pass})`)
  } else {
    console.log(`  FAIL  ${name}  (pass ${v.pass} / fail ${v.fail})`)
    if (r.stdout) console.log(r.stdout.split("\n").filter((l) => /^not ok/.test(l)).join("\n"))
    if (r.stderr) console.log(r.stderr)
    bad++
  }
}

console.log("\n=== 可选（失败不阻塞）===")
for (const [name, file] of OPTIONAL) {
  const r = run(file)
  const v = verdict(r)
  console.log(`  ${v.ok ? "PASS" : "SKIP"}  ${name}  (${v.pass})`)
}

console.log("\n=== 脱敏检查 ===")
const sec = spawnSync(process.execPath, [join(HERE, "tools", "check-secrets.mjs"), "--all"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
})
if (sec.status === 0) {
  console.log("  PASS  无本机凭据 / 个人路径泄漏")
} else {
  console.log("  FAIL")
  console.log((sec.stdout || "") + (sec.stderr || ""))
  bad++
}

console.log(`\n总通过断言 ${totalPass} 项`)
if (bad) {
  console.error(`有 ${bad} 项未通过 —— 不要发布。`)
  process.exit(1)
}
console.log("全部通过。")
