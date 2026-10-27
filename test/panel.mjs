// 面板的结构检查：不真开 magpie 的窗口（那是 Electron/WebView），只验证
// 面板代码在无 bridge 环境下不会炸加载期、声明的文件都在、package.json
// 的声明和文件对得上。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

test("package.json 声明的面板文件都存在", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const panels = pkg.magpie?.panels || []
  assert.equal(panels.length, 1, "一个 settings 面板")
  assert.equal(panels[0].slot, "settings", "槽位是 settings")
  for (const p of panels) {
    assert.ok(existsSync(join(ROOT, p.file)), p.file + " 不存在")
  }
})

test("面板声明的读取权限 magpie 真的发（PageReads 白名单）", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  // magpie 的 PageReads 白名单（internal/plugin/page.go）：只这两个。
  // 声明白名单之外的读取会被窗口侧直接拒绝。
  const ALLOWED = ["usage:summary", "providers:list"]
  for (const p of pkg.magpie?.permissions || []) {
    assert.ok(ALLOWED.includes(p), p + " 不在 magpie 的 PageReads 白名单里，页面会读不到")
  }
})

test("panel.js 引用的数据面与 options 结构，和中间件消费端一致", () => {
  const js = readFileSync(join(ROOT, "panel", "panel.js"), "utf8")
  const mw = readFileSync(join(ROOT, "budget.middleware.js"), "utf8")
  // 面板把额度写进 options.dailyCredits；中间件消费的闸门字段也在这份 options 里
  assert.match(js, /dailyCredits/, "面板要写 options.dailyCredits")
  assert.match(js, /magpie\.options\.set/, "面板要经 bridge 的 options.set 落盘")
  assert.match(js, /magpie\.read\("usage:summary"/, "面板要经 bridge 读 usage:summary")
  assert.match(js, /magpie\.read\("providers:list"/, "面板要经 bridge 读 providers:list")
  // 中间件闸门的字段名不能和面板的输入框对不上
  for (const k of ["maxRequestTokens", "estimate", "ceiling"]) {
    assert.match(js, new RegExp("\\b" + k + "\\b"), "面板缺闸门字段 " + k)
    assert.match(mw, new RegExp("\\b" + k + "\\b"), "中间件缺闸门字段 " + k)
  }
})

test("panel.html 引用的本地文件都齐，没有网络依赖", () => {
  const html = readFileSync(join(ROOT, "panel", "panel.html"), "utf8")
  assert.match(html, /_magpie\/bridge\.js/, "要加载 bridge")
  // 沙盒里页面无网络：不许引外部脚本/样式
  assert.doesNotMatch(html, /src="https?:/, "不许外链脚本")
  assert.doesNotMatch(html, /href="https?:/, "不许外链样式")
  const m = html.match(/src="(panel\.js)"/)
  assert.ok(m, "要引 panel.js")
  assert.ok(existsSync(join(ROOT, "panel", m[1])), "panel.js 要在")
})

test("panel.js 是无模块依赖的单文件（沙盒页面跑不了 import）", () => {
  const js = readFileSync(join(ROOT, "panel", "panel.js"), "utf8")
  assert.doesNotMatch(js, /^\s*import\s/m, "不许静态 import")
  assert.doesNotMatch(js, /require\(/, "不许 require")
})

// 这一条是补的：paint() 曾被调用却从未定义（重写时把定义弄丢了），
// 抛出的 ReferenceError 又被 load() 的空 catch 吞掉，面板永远停在
// 「读取中…」。语法检查抓不到这个，因为它语法合法。
test("panel.js 调用的每个本地函数都真的定义了", () => {
  // 顺序要紧：先剥字符串（里面的 // 和 /* 不是注释），再剥注释。
  // 反过来会把 "https://…" 之后的半行源码全删掉，于是什么都「没定义」。
  const strip = (s) => s
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  const js = strip(readFileSync(join(ROOT, "panel", "panel.js"), "utf8"))

  assert.ok(js.includes("function paint"), "剥注释后 paint 的定义应还在（否则是剥离逻辑坏了）")

  const called = new Set()
  for (const m of js.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2]
    if (["if", "for", "while", "switch", "catch", "return", "typeof", "function",
      "await", "new", "of", "in", "void", "delete", "async", "else", "do"].includes(name)) continue
    called.add(name)
  }

  const defined = new Set()
  for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
  for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1])
  // 对象字面量里的方法简写
  for (const m of js.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1])

  // 形参不算未定义
  const params = new Set()
  for (const m of js.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split("=")[0].trim().replace(/^\.\.\./, "")
      if (/^[A-Za-z_$][\w$]*$/.test(t)) params.add(t)
    }
  }
  for (const m of js.matchAll(/(?:async\s+)?function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const t = p.trim().split("=")[0].trim().replace(/^\.\.\./, "")
      if (/^[A-Za-z_$][\w$]*$/.test(t)) params.add(t)
    }
  }

  const builtins = new Set([
    "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Set", "Map",
    "Promise", "Error", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
    "decodeURIComponent", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "fetch", "console", "RegExp", "document", "window", "magpie",
  ])
  const missing = [...called].filter((n) => !defined.has(n) && !builtins.has(n) && !params.has(n))
  assert.deepEqual(missing, [], "这些函数被调用但没有定义：" + missing.join(", "))
})

test("panel.js 能画渠道列表、能预估 token、不假装看得见账号", () => {
  const js = readFileSync(join(ROOT, "panel", "panel.js"), "utf8")
  assert.match(js, /function\s+paint\s*\(/, "paint 必须定义")
  assert.match(js, /providers:list/, "要靠 providers:list 拿渠道清单")
  assert.match(js, /:tpc/, "换算率键是 <key>:tpc")

  // 预估列：额度 × 换算率。这是用户要的「填完积分告诉我能跑多少 token」
  assert.match(js, /data-f="est"|data-f=est/, "要有预估列")
  assert.match(js, /tokOf/, "要按额度×换算率算 token")
  assert.match(js, /addEventListener\("input"/, "预估列要随输入实时更新，不必先保存")

  // 账号维度：providers:list 不返回 accounts（源码注释 no account），
  // 所以不许按 p.accounts 展开——那永远拿到空数组。
  // 账号名单走看门狗导出的 accounts.json，面板从自己目录 fetch 它。
  assert.doesNotMatch(js, /p\.accounts/, "providers:list 不返回 accounts，别按它展开")
  // 面板碰不到网络（magpie bridge 文档原话），所以不许用 fetch 读文件；
  // 账号名单只能走 options —— 看门狗写进去，面板 options.get() 读出来
  assert.doesNotMatch(js, /fetch\s*\(/, "面板碰不到网络，不能用 fetch")
  assert.match(js, /accountsByChannel/, "账号名单要从 options.accountsByChannel 读")
  assert.match(js, /data-acct/, "要能画出账号行（data-acct）")
  assert.match(js, /ch\s*\+\s*"\/"\s*\+\s*acct/, "账号额度键是 渠道/账号")
  assert.match(js, /splitChannelBudget/, "平摊开关仍然保留（作为整渠道均分的快捷方式）")

  // 不能假装 usage:summary 有渠道维度
  assert.match(js, /no channel|没有渠道|不含渠道/i, "要说明 usage:summary 没有渠道维度")
})

test("panel.html 有平摊开关，且每个渠道卡片有预估列的位置", () => {
  const html = readFileSync(join(ROOT, "panel", "panel.html"), "utf8")
  assert.match(html, /id="splitOn"/, "要有平摊开关")
  // 平摊是「插件自己」执行的（主入口有 fs/定时器），不是外部看门狗。
  // 这条断言以前要求页面提到 watchdog.mjs，那个说法已经过期了。
  assert.match(html, /检查由插件自己跑|插件自己的定时器|「真的执行」/, "要说明平摊由插件自己执行")
  assert.doesNotMatch(html, /magpie-budget\/watchdog\.mjs/, "不该再让人去跑外部看门狗")
})


// ── 主入口的陷阱（2026-10-27 真踩过）──────────────────────────────────
//
// magpie 的插件协议：模块导出的**每个函数**都会被当成一个 server 调一次
// （源码注释 "else every function it exports, each once"）。
// 曾经把 tick 导出成 runOnce，结果 `magpie plugin list` 这种只读命令也执行
// 了一次 enforce，当场把超额渠道下架了。
test("主入口只导出默认函数，别的不许导出可调用函数", async () => {
  const src = readFileSync(join(ROOT, "index.mjs"), "utf8")
  // 允许：export default、export const BudgetPlugin（它本身就是那个 server）
  // 禁止：其它 export const/function 出来的函数
  const bad = []
  const re = /^export\s+(?:const|function|let|var)\s+(\w+)/gm
  let m
  while ((m = re.exec(src))) {
    if (m[1] !== "BudgetPlugin") bad.push(m[1])
  }
  assert.deepEqual(bad, [], "index.mjs 只许导出 BudgetPlugin，否则 magpie 会把它当 server 调：" + bad.join(","))
  assert.match(src, /export default BudgetPlugin/, "要有默认导出")
})

test("插件主入口真的有定时器（不靠外部命令行也能跑）", async () => {
  const src = readFileSync(join(ROOT, "index.mjs"), "utf8")
  assert.match(src, /setInterval/, "主入口要自己起定时器")
  assert.match(src, /enforce/, "定时器里要真的执行额度判定")
  assert.match(src, /exportAccounts/, "每轮要刷新账号名单，面板才看得到")
  // 防止有人把定时器改成只打日志
  assert.doesNotMatch(src, /setInterval\(\(\)\s*=>\s*\{\s*\}\s*\)/, "定时器不能是空的")
})
