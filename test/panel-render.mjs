// 真实渲染验证：用桩 magpie bridge + 真实 panel.html/panel.js，
// 在无头 Edge 里确认面板能画出渠道列表（而不是停在「读取中…」）。
//
// 桩数据取自本机真实 providers.json / usage 的形态：
//   25 个 provider，其中几个多账号 —— 正是截图里「无法对应添加」的场景。
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, "..")
const ROOT = PLUGIN_DIR
// Edge 的路径每台机器可能不同，允许用 EDGE_PATH 覆盖
const EDGE = process.env.EDGE_PATH
  || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const PORT = 18471

// ── 桩：25 个渠道，含多账号 ──────────────────────────────────────────
const PROVIDERS = [
  { id: "zcode", name: "ZCode" },
  { id: "qwenwork", name: "QwenWork" },
  { id: "officeace", name: "OfficeAce" },
  { id: "codearts", name: "CodeArts" },
  { id: "workbuddy-ai", name: "WorkBuddy AI", accounts: ["demo-git-01", "acc2", "acc3"] },
  { id: "workbuddy", name: "WorkBuddy", accounts: ["demo-acct-01", "alt"] },
  { id: "loomy", name: "Loomy", accounts: ["138****0001", "139****0002"] },
  { id: "raccoon", name: "商汤小浣熊", accounts: ["demo-raccoon-01", "b"] },
  { id: "minimax-code", name: "MiniMax Code", accounts: ["demo-mm-01", "x"] },
  { id: "cline", name: "Cline", accounts: ["demo1@example.com", "demo2@example.com"] },
  { id: "dumate", name: "百度搭子 DuMate" },
  { id: "meituan", name: "妙手 CatPaw" },
  { id: "teleagent", name: "TeleAgent", accounts: ["t1", "t2"] },
  { id: "lobster", name: "LobsterAI" },
  { id: "trae-cn", name: "Trae CN" },
  { id: "qoder", name: "Qoder" },
  { id: "autoclaw-cn", name: "AutoClaw 国内 (Zhipu)" },
  { id: "opencode-zen-free", name: "OpenCode Zen Free" },
]
const SUMMARY = {
  period: "today", calls: 412, errors: 3, input: 812340, output: 128900, cacheRead: 0, cost: 0,
  models: [
    { model: "claude-sonnet-5-5", calls: 120, input: 300000, output: 40000 },
    { model: "deepseek-v4-pro", calls: 90, input: 200000, output: 30000 },
    { model: "glm-5.3", calls: 60, input: 120000, output: 20000 },
  ],
}

// 桩 bridge：window.magpie
// 看门狗写进 options.accountsByChannel 的内容长这样。
// 面板碰不到网络，所以名单只能走 options，不是 HTTP。
const ACCOUNTS = {
  channels: {
    loomy: [
      { user: "138****0001", on: true, plan: "Loomy" },
      { user: "139****0002", on: true, plan: "Loomy" },
    ],
    "workbuddy-ai": [
      { user: "demo-git-02", on: true, plan: "Free plan" },
      { user: "demo-acct-02", on: true, plan: "Free plan" },
      { user: "demo-git-01", on: false, plan: "Free plan" },
    ],
  },
}

const STUB = `
window.magpie = {
  ready: Promise.resolve(),
  read(name, params) {
    if (name === "providers:list") return Promise.resolve(${JSON.stringify(PROVIDERS)});
    if (name === "usage:summary") return Promise.resolve(${JSON.stringify(SUMMARY)});
    return Promise.resolve(null);
  },
  options: {
    _o: { dailyCredits: { loomy: 100 }, estimate: 3, ceiling: 80, maxRequestTokens: 0,
          accountsAt: "2026-10-27T00:00:00Z",
          accountsByChannel: ${JSON.stringify(ACCOUNTS.channels)} },
    get() { return Promise.resolve(this._o); },
    set(o) {
      this._o = Object.assign({}, this._o, o);
      // 测试要看「开关真的写进了 options」，给它一个读得到的口子
      window.magpie.__opts = this._o;
      return Promise.resolve(this._o);
    },
  },
};
`

const html = readFileSync(join(ROOT, "panel", "panel.html"), "utf8")
  .replace('<script src="_magpie/bridge.js"></script>', `<script>${STUB}</script>`)
  .replace("</head>", "<style>:root{--magpie-fg:#2f2f2c;--magpie-fg-2:#6b6f63;--magpie-fg-6:#e4e2da}</style></head>")

const panelJs = readFileSync(join(ROOT, "panel", "panel.js"), "utf8")

const srv = createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    return res.end(html)
  }
  if (req.url.startsWith("/panel.js")) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
    return res.end(panelJs)
  }
  res.writeHead(404); res.end()
})

await new Promise((r) => srv.listen(PORT, "127.0.0.1", r))
console.log(`桩页面 http://127.0.0.1:${PORT}/`)

const profile = mkdtempSync(join(tmpdir(), "edge-panel-"))
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=9333`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=1100,1400`,
  `http://127.0.0.1:${PORT}/`,
], { stdio: "ignore" })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等 CDP 起来
let target = null
for (let i = 0; i < 60; i++) {
  await sleep(300)
  try {
    const list = await (await fetch("http://127.0.0.1:9333/json/list")).json()
    target = list.find((t) => t.type === "page" && t.url.includes(String(PORT)))
    if (target) break
  } catch {}
}
if (!target) { console.error("FAIL: CDP 没起来"); edge.kill(); srv.close(); process.exit(1) }

// ws 是本仓库之外的一个依赖（不在 package.json 里，CDP 客户端要用）。
// 以前这里写死了作者本机的绝对路径，换台机器必然找不到——现在改成按顺序
// 试几个常见位置，找不到就给一条能照着做的提示，而不是抛个莫名其妙的错。
// 也可以用 WS_MODULE_PATH 直接指定。ESM 不认 NODE_PATH，所以只能绝对路径。
const WS_CANDIDATES = [
  process.env.WS_MODULE_PATH,
  join(homedir(), ".workbuddy", "binaries", "node", "workspace", "node_modules", "ws", "index.js"),
  join(PLUGIN_DIR, "node_modules", "ws", "index.js"),
  join(PLUGIN_DIR, "..", "node_modules", "ws", "index.js"),
].filter(Boolean)
const WS_PATH = WS_CANDIDATES.find((p) => existsSync(p))
if (!WS_PATH) {
  console.error("FAIL: 找不到 ws 模块（CDP 客户端需要）。")
  console.error("  在本仓库下执行：npm i ws")
  console.error("  或者：set WS_MODULE_PATH=<ws/index.js 的完整路径>")
  edge.kill(); srv.close(); process.exit(1)
}
// ws 是 CJS 包，构造器挂在 default 上
const wsMod = await import(pathToFileURL(WS_PATH).href)
const WebSocket = wsMod.WebSocket || wsMod.default || wsMod
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.on("message", (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.on("open", r))
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
})

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await sleep(2000)   // 等 panel.js 跑完

const report = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('#list .card')];
  const names = cards.map(c => c.querySelector('.name')?.textContent?.trim());
  const sub = document.getElementById('sub')?.textContent || '';
  const blanks = cards.filter(c => !c.querySelector('[data-f=cap]')).length;
  const ests = [...document.querySelectorAll('[data-f=est]')].map(e => e.textContent.trim());
  return {
    cardCount: cards.length,
    first5: names.slice(0, 5),
    hasMeituan: names.includes('妙手 CatPaw'),
    hasLoomy: names.includes('Loomy'),
    sub,
    cardsMissingInput: blanks,
    estCount: ests.length,
    estFirst3: ests.slice(0, 3),
    estAllDash: ests.every(t => t === '—'),
    hasSplitSwitch: !!document.getElementById('splitOn'),
    docHeight: document.body.scrollHeight,
  };
})()`)
console.log("渲染结果:", JSON.stringify(report, null, 2))

// 预估列要真的随输入变：改一个已经配了额度的渠道的积分数，看数字跟不跟
const live = await evalJs(`(() => {
  const card = [...document.querySelectorAll('#list .card')]
    .find(c => Number(c.querySelector('[data-f=cap]')?.value) > 0);
  if (!card) return { error: '没有已配额度的卡片' };
  const capEl = card.querySelector('[data-f=cap]');
  const tpcEl = card.querySelector('[data-f=tpc]');
  const out = card.querySelector('[data-f=est]');
  const before = out.textContent.trim();
  // 额度 ×10，预估应跟着变（不必保存）
  capEl.value = String(Number(capEl.value) * 10);
  capEl.dispatchEvent(new Event('input', { bubbles: true }));
  const after = out.textContent.trim();
  return { channel: card.dataset.ch, cap: capEl.value, tpc: tpcEl.value, before, after, changed: before !== after };
})()`)
console.log("预估实时更新:", JSON.stringify(live, null, 2))

// 账号行：展开一个多账号渠道，确认每个账号能单独填额度
const acct = await evalJs(`(() => {
  // paint() 会重建整个列表，所以每轮重新查「还写着『按账号设额度』的按钮」。
  // 点过之后按钮文字变成「收起账号」，自然就不会被再选中，也不会来回切。
  for (let i = 0; i < 60; i++) {
    const btn = [...document.querySelectorAll('button[data-act=toggle]')]
      .find(b => b.textContent === '按账号设额度');
    if (!btn) break;
    btn.click();
  }
  const rows = [...document.querySelectorAll('.acct')];
  const loomy = rows.filter(r => r.dataset.ch === 'loomy');
  const off = rows.filter(r => r.classList.contains('off'));
  return {
    btnLabel: '按账号设额度',
    rowCount: rows.length,
    loomyUsers: loomy.map(r => r.querySelector('.acctname')?.textContent),
    eachHasCap: rows.every(r => !!r.querySelector('[data-f=cap]')),
    eachHasEst: rows.every(r => !!r.querySelector('[data-f=est]')),
    offMarked: off.length,
  };
})()`)
console.log("账号行:", JSON.stringify(acct, null, 2))

// 给某个账号单独存一个额度，确认写进的是 渠道/账号 这个键
const acctSave = await evalJs(`(async () => {
  const row = document.querySelector('.acct[data-ch=loomy]');
  if (!row) return { error: '没有 loomy 的账号行' };
  const capEl = row.querySelector('[data-f=cap]');
  capEl.value = '77';
  capEl.dispatchEvent(new Event('input', { bubbles: true }));
  const estAfter = row.querySelector('[data-f=est]').textContent.trim();
  row.querySelector('button.save').click();
  await new Promise(r => setTimeout(r, 400));
  const dc = window.magpie.__opts?.dailyCredits || {};
  return { estAfter, keys: Object.keys(dc), loomyAcctCap: dc['loomy/' + row.dataset.acct] };
})()`)
console.log("账号级保存:", JSON.stringify(acctSave, null, 2))

// 执行开关：enforce 默认关着，面板必须明确警告「只看不管」
const enf = await evalJs(`(async () => {
  const el = document.getElementById('enforceOn');
  if (!el) return { error: '没有执行开关' };
  const hint = document.getElementById('acctHint');
  const warned = hint && !hint.hidden && /只看不管/.test(hint.textContent);
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return { initiallyOff: !el.checked ? false : true, warned, saved: window.magpie.__opts?.enforce === true };
})()`)
console.log("执行开关:", JSON.stringify(enf, null, 2))

// 平摊开关能点、能落盘
const sw = await evalJs(`(async () => {
  const el = document.getElementById('splitOn');
  if (!el) return { error: 'no switch' };
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return { checked: el.checked, saved: window.magpie.__opts?.splitChannelBudget === true };
})()`)
console.log("平摊开关:", JSON.stringify(sw, null, 2))

// 截图
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
const out = join(ROOT, "panel-render-check.png")
writeFileSync(out, Buffer.from(shot.result.data, "base64"))
console.log("截图:", out)

// ── 判定 ────────────────────────────────────────────────────────────
const problems = []
if (report.cardCount !== PROVIDERS.length) problems.push(`卡片数 ${report.cardCount} != ${PROVIDERS.length}`)
if (report.cardsMissingInput > 0) problems.push(`${report.cardsMissingInput} 张卡片没有额度输入框`)
if (!report.hasMeituan) problems.push("没画出妙手")
if (!report.hasLoomy) problems.push("没画出 Loomy")
if (!/今日合计/.test(report.sub)) problems.push(`用量摘要没画出来（sub="${report.sub}"）`)

// 预估列：每个渠道一张，且已配额度的那些不能全是「—」
if (report.estCount !== report.cardCount) problems.push(`预估列 ${report.estCount} 个 != 卡片 ${report.cardCount} 张`)
if (report.estAllDash) problems.push("所有预估都是「—」，已配额度的渠道没算出 token")
if (live.error) problems.push("预估实时更新测不了：" + live.error)
else if (!live.changed) problems.push(`改额度后预估没变（${live.before} -> ${live.after}）`)

// 平摊开关
if (!report.hasSplitSwitch) problems.push("没有平摊开关")
if (acct.error) problems.push("账号行画不出来：" + acct.error)
else {
  if (acct.rowCount !== 5) problems.push(`账号行 ${acct.rowCount} 条 != 5（loomy 2 + workbuddy-ai 3）`)
  if (!acct.eachHasCap) problems.push("有账号行没有额度输入框")
  if (!acct.eachHasEst) problems.push("有账号行没有预估列")
  if (acct.offMarked !== 1) problems.push(`停用账号标记 ${acct.offMarked} 个 != 1`)
}
if (acctSave.error) problems.push("账号级保存测不了：" + acctSave.error)
else if (acctSave.loomyAcctCap !== 77) problems.push(`账号额度没写成 渠道/账号 键（得到 ${acctSave.loomyAcctCap}）`)
else if (!/77/.test(acctSave.estAfter) && acctSave.estAfter === "—") problems.push("账号行预估没跟着变")

if (enf.error) problems.push("执行开关缺失：" + enf.error)
else if (!enf.warned) problems.push("enforce 关着时没警告「只看不管」")
else if (!enf.saved) problems.push("执行开关没写进 options")

if (sw.error) problems.push("平摊开关点不了：" + sw.error)
else if (!sw.checked) problems.push("平摊开关点不上")
else if (!sw.saved) problems.push("平摊开关没写进 options")

ws.close(); edge.kill(); srv.close()

if (problems.length) {
  console.error("\nFAIL")
  for (const p of problems) console.error("  · " + p)
  process.exit(1)
}
console.log("\nPASS — 渠道卡片带 token 预估列（随输入实时变），平摊开关可保存")
process.exit(0)
