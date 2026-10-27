#!/usr/bin/env node
// 发布前脱敏检查：拿本机真实的凭据 / 身份 / 路径去比对要提交的文件，
// 而不是靠「我记得删了」或者写死的几个关键词。
//
// 用法：node tools/check-secrets.mjs [--all]
//   （默认）只查 git 暂存区
//   --all     查工作区全部受控 + 未忽略的新文件
//
// 退出码 1 = 有命中，不许发布。
//
// 为什么必须有这个：这个插件天天在读写 logins.json / quotas.json，里面全是
// 账号标识。写 README 或测试桩的时候顺手粘一段真实数据太容易了，而
// 「token」「cookie」这种关键词 grep 是抓不到的——真实的 token 往往就藏在
// 一段「比如返回这样」的示例文本里。
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

// ── 本机真实凭据 / 账号标识，用来比对 ──────────────────────────────────
// 只读；命中时只打印「是什么 + 前几位 + 长度」，不打印整串。
function realSecrets() {
  const dir = process.env.MAGPIE_CONFIG_DIR || join(homedir(), ".config", "magpie")
  const out = []
  // 渠道 id / 显示名不是秘密：它们来自插件自己的公开元数据，写进文档和
  // 测试桩天经地义。但有的渠道显示名恰好和某个账号名重合（比如 minimax
  // 的渠道就叫「MiniMax Code」），不排掉就会满屏假警报。
  const publicNames = new Set()
  try {
    const pf = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"))
    for (const p of pf?.providers || []) {
      if (p?.id) publicNames.add(String(p.id).toLowerCase())
      if (p?.name) publicNames.add(String(p.name).toLowerCase())
    }
  } catch {}
  try {
    const ls = JSON.parse(readFileSync(join(dir, "logins.json"), "utf8"))
    for (const e of Array.isArray(ls) ? ls : Object.values(ls)) {
      const user = String(e?.user || "").trim()
      if (user && user.length >= 6 && !publicNames.has(user.toLowerCase())) {
        out.push({ needle: user, what: "登录账号名" })
      }
      // 只把「长得像凭据」的字段当凭据。home 是渠道相关的目录名、
      // auth 多为 null，把它俩算进来只会制造成片误报，反而盖住真问题。
      for (const k of ["token", "cookie", "password", "secret", "apiKey"]) {
        const v = e?.[k]
        if (typeof v === "string" && v.length >= 8) {
          out.push({ needle: v, what: `logins.json 的 ${k}` })
        }
      }
    }
  } catch {}
  return out
}

// ── 结构性模式：不管本机有没有登录，都必须查 ───────────────────────────
const PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "邮箱地址"],
  [/\b[0-9]{3}\*{4}[0-9]{4}\b/g, "掩码手机号"],
  [/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"']+/g, "个人目录路径"],
  [/[A-Za-z]:[\\/](?!<)[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]{3,}/g, "绝对路径"],
  [/\/(?:home|Users)\/[a-z0-9_-]+\//gi, "Unix 个人目录"],
  [/\bAg[A-Za-z0-9_-]{20,}\b/g, "疑似 accessToken"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "疑似 JWT"],
  [/\bgh[opusr]_[A-Za-z0-9]{30,}\b/g, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "API key"],
]

// 公开的、必须保留的标识，不算泄漏
const ALLOW = [
  // 作者公开的 GitHub 句柄与 noreply 邮箱（仓库本人署名，本来就要公开）
  "R227BOUT",
  "@users.noreply.github.com",
  // RFC 2606 保留给示例用的域名
  "example.com",
  "you@example.com",
  // 通用英文词组，没有识别力（上游会把 API 账号显示成 "API key …2bcb"）
  "API key",
  // 渠道显示名与账号标签重合：minimax 的渠道就叫「MiniMax Code」，
  // 而它的账号标签是「minimax code (global)」——都不是个人信息。
  "MiniMax Code",
  // 文档 / 测试桩里的占位
  "<你的插件目录>",
  "<本目录路径>",
]

// 测试桩要看着像真实数据才有意义，所以会故意用「长得像掩码手机号」的假号。
// 这些是合成的占位值，不是任何人的真实账号——单独列出来，免得和真泄漏混在一起。
const SYNTHETIC = [
  "138****0001",
  "139****0002",
  "demo-acct-01",
  "demo-git-01",
  "demo-git-02",
  "demo-mm-01",
  "demo-raccoon-01",
]

const TEXT_EXT = new Set([".mjs", ".js", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ""])

function filesToCheck(all) {
  const run = (args) => {
    try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }) } catch { return "" }
  }
  if (all) {
    // 受控文件 + 未跟踪但没被 ignore 的新文件。
    // 只用 ls-files 会漏掉「刚创建还没 add」的文件，而新文件恰恰最容易
    // 带着调试用的真实路径或 token 一起提交。
    const set = new Set([
      ...run(["ls-files"]).split("\n"),
      ...run(["ls-files", "--others", "--exclude-standard"]).split("\n"),
    ])
    return [...set].map((s) => s.trim()).filter(Boolean)
  }
  const out = run(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
}

function scan(file, text, secrets) {
  const hits = []
  const allowed = (s) =>
    ALLOW.some((a) => s.includes(a)) || SYNTHETIC.some((a) => s.includes(a))
  const lineOf = (i) => text.slice(0, i).split("\n").length

  // 1) 本机真实凭据：整串 + 各长度前缀（只贴了前 8 位当示例也能抓到）
  for (const { needle, what } of secrets) {
    if (allowed(needle)) continue
    const i = text.indexOf(needle)
    if (i >= 0) hits.push({ file, line: lineOf(i), what, sample: `${needle.slice(0, 6)}…(${needle.length} 字)` })
    for (const n of [40, 24, 16, 12, 10, 8]) {
      if (needle.length < n) continue
      const p = needle.slice(0, n)
      if (allowed(p)) continue
      const j = text.indexOf(p)
      if (j >= 0) hits.push({ file, line: lineOf(j), what: `${what} 前 ${n} 位`, sample: `${p.slice(0, 6)}…(${p.length} 字)` })
    }
  }

  // 2) 结构性模式
  for (const [re, what] of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const s = m[0]
      if (allowed(s)) continue
      hits.push({ file, line: lineOf(m.index), what, sample: s.length > 26 ? s.slice(0, 12) + "…" : s })
      if (hits.length > 60) return hits
    }
  }
  return hits
}

// ── 跑 ────────────────────────────────────────────────────────────────
const all = process.argv.includes("--all")
const secrets = realSecrets()
// 扫描器自己的源码里必然写着这些标签词，跳过它自己
const SELF_PATH = join(HERE, "check-secrets.mjs")
const files = filesToCheck(all)
  .filter((f) => TEXT_EXT.has(extname(f).toLowerCase()))
  .filter((f) => !f.startsWith("node_modules/"))
  .filter((f) => join(ROOT, f) !== SELF_PATH)

console.log(`脱敏检查 · ${all ? "工作区全部文件" : "暂存区"} · ${files.length} 个文件`)
console.log(`比对基准：本机 logins.json 里的 ${secrets.length} 个账号标识 / 凭据`)

let total = 0
for (const f of files) {
  const p = join(ROOT, f)
  let text
  try {
    if (!existsSync(p) || statSync(p).size > 4 << 20) continue
    text = readFileSync(p, "utf8")
  } catch { continue }
  // package.json 里的图标是 base64 内嵌图，本来就要公开，不参与扫描
  const scanText = f.endsWith("package.json")
    ? text.replace(/"icon"\s*:\s*"data:image\/[^"]*"/g, '"icon":"<inline-image>"')
    : text
  for (const h of scan(f, scanText, secrets)) {
    console.log(`  x ${h.file}:${h.line}  ${h.what}  ${h.sample}`)
    total++
  }
}

if (total) {
  console.error(`\n发现 ${total} 处疑似泄漏，不要发布。确认是误报的话，加进 ALLOW。`)
  process.exit(1)
}
console.log("\n干净：没有本机凭据、个人路径、邮箱或密钥泄漏。")
