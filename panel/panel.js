// The panel: one card per channel magpie knows, with a daily credit
// allowance and a live estimate of how many tokens that buys.
//
// What it can and cannot see:
//   providers:list  — every channel id and name. It does NOT carry accounts
//                     (magpie's own comment: "no key, no account, no
//                     address"), so this page cannot list them.
//   usage:summary   — totals and Top-20 models, no channel dimension.
// Accounts are the watchdog's business: it reads logins.json from disk,
// which a sandboxed panel cannot. That is why splitting a channel's
// allowance across its accounts is a switch here, applied there.
(async () => {
  const $ = (id) => document.getElementById(id)
  await magpie.ready

  // 1 积分 = N token。Lives in options.dailyCredits as `<ch>:tpc`.
  //
  // 数值来自 `LMR猎模人/开发版/data/usage.db` 的 logs 表（17,709 条真实调用）
  // 按渠道汇总 total_tokens / credit 的加权比，2026-10-27 复核。
  // 口径要点：只取 credit >= 1 的记录（积分精确到 0.01，小请求的比值是噪声）；
  // credit 为 NULL/0 是「没采集到」，不能当 0 放进分母。
  //
  // 没有样本的渠道用 10000 —— **那是猜的，不是测出来的**，UI 上会标「无来源」。
  // 与 magpie-budget/watchdog.mjs 的 DEFAULT_TPC 必须保持一致。
  const DEFAULT_TPC = {
    loomy: 9666, officeace: 39000, raccoon: 25700, autoclaw: 11373,
    workbuddy: 23804, "workbuddy-ai": 15338,
    "autoclaw-cn": 11373,
    zcode: 10000, qwenwork: 10000, "qwenwork-enterprise": 10000,
    teleagent: 10000, dumate: 10000, codearts: 10000, qoder: 10000,
    "qoder-cn": 10000, meituan: 10000, lobster: 10000, cline: 10000,
    "trae-cn": 10000, "trae-global": 10000, minimax: 10000,
    "minimax-code": 10000, "minimax-code-global": 10000,
    "opencode-zen-free": 10000, "cloudflare-workers-ai": 10000,
    qianfan: 10000,
  }
  const FALLBACK_TPC = 10000
  // 这些渠道的换算率是账本实测的；不在表里的只是占位
  const TPC_MEASURED = new Set([
    "loomy", "officeace", "raccoon", "autoclaw", "workbuddy", "workbuddy-ai",
  ])

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

  // Token 数用「万 / 亿」表示：这些量级下精确到个位没有意义
  const fmtTok = (n) => {
    const x = Number(n)
    if (!Number.isFinite(x) || x <= 0) return "0"
    if (x >= 1e8) return (x / 1e8).toFixed(2) + " 亿"
    if (x >= 1e4) return (x / 1e4).toFixed(x >= 1e6 ? 0 : 1) + " 万"
    return String(Math.round(x))
  }

  let options = {}
  let summary = null
  let providers = []
  const openSet = new Set()   // 展开着的渠道，重绘时保留

  const creditsMap = () =>
    options.dailyCredits && typeof options.dailyCredits === "object" ? options.dailyCredits : {}
  const tpcOf = (ch) => {
    const v = Number(creditsMap()[ch + ":tpc"])
    return Number.isFinite(v) && v > 0 ? v : (DEFAULT_TPC[ch] || FALLBACK_TPC)
  }
  const capOf = (ch) => {
    const v = Number(creditsMap()[ch])
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  // 预估列：填的分数 × 换算率
  const tokOf = (ch) => capOf(ch) * tpcOf(ch)

  // 账号级额度：键是 "渠道/账号"
  const acctCapOf = (ch, acct) => {
    const v = Number(creditsMap()[ch + "/" + acct])
    return Number.isFinite(v) && v > 0 ? v : 0
  }
  // 账号的换算率：自己配了用自己的，否则跟随渠道（同一渠道同一计费口径）
  const acctTpcOf = (ch, acct) => {
    const v = Number(creditsMap()[ch + "/" + acct + ":tpc"])
    return Number.isFinite(v) && v > 0 ? v : tpcOf(ch)
  }

  // 账号名单来自 options.accountsByChannel —— 由看门狗（能读 logins.json）
  // 写进插件 options。面板读不了文件、也碰不到网络（magpie 的 bridge 文档
  // 原话：the page can't reach the network or magpie's API itself），
  // options 是唯一能过墙的通道。
  let accountsByChannel = {}
  let accountsAt = ""
  function accountsOf(ch) {
    return Array.isArray(accountsByChannel[ch]) ? accountsByChannel[ch] : []
  }

  function accountRow(ch, a) {
    const key = ch + "/" + a.user
    const cap = acctCapOf(ch, a.user)
    const tpc = acctTpcOf(ch, a.user)
    const tok = cap * tpc
    const follow = cap > 0 ? "" : ' <span class="follow">跟随渠道</span>'
    return '<div class="acct' + (a.on === false ? " off" : "") + '" data-ch="' + esc(ch) + '" data-acct="' + esc(a.user) + '">'
      + '<div class="accthead">'
      + '<span class="acctname">' + esc(a.user) + "</span>"
      + (a.on === false ? '<span class="badge">已停用</span>' : "")
      + (a.plan ? '<span class="plan">' + esc(a.plan) + "</span>" : "")
      + follow
      + "</div>"
      + '<div class="editrow">'
      + '<label>该账号每日额度'
      + '<input type="number" min="0" data-f="cap" value="' + (cap || "") + '" placeholder="跟随渠道"></label>'
      + '<label>1 积分 = 多少 token'
      + '<input type="number" min="1" data-f="tpc" value="' + tpc + '"></label>'
      + '<label class="est">预估能跑'
      + '<output data-f="est">' + (tok > 0 ? fmtTok(tok) + " tok" : "—") + "</output></label>"
      + '<button class="save">保存</button>'
      + "</div></div>"
  }

  function channelCard(p) {
    const id = p.id
    const cap = capOf(id)
    const tpc = tpcOf(id)
    const tok = tokOf(id)
    // 换算率是实测的还是占位的，得让人一眼看出来——
    // 占位值算出来的「预估能跑」没有依据，不该被当成真数
    const measured = TPC_MEASURED.has(id)
    const badge = cap > 0
      ? '<span class="badge ok">' + fmtTok(tok) + ' tok/天</span>'
      : '<span class="badge">不限</span>'
    const src = measured
      ? '<span class="src ok" title="换算率来自 LMR 账本实测回归">实测</span>'
      : '<span class="src" title="该渠道没有任何积分样本，10000 是占位值，不是测出来的">无来源</span>'

    const accts = accountsOf(id)
    const open = openSet.has(id)
    const acctBadge = accts.length
      ? '<span class="badge">' + accts.length + " 个账号</span>"
      : ""

    let html = '<div class="card' + (cap > 0 ? " on" : "") + '" data-ch="' + esc(id) + '">'
      + '<div class="head">'
      + '<span class="name">' + esc(p.name || id) + "</span>"
      + src
      + '<span class="grow"></span>'
      + badge + acctBadge
      + (accts.length
        ? '<button class="toggle" data-act="toggle">' + (open ? "收起账号" : "按账号设额度") + "</button>"
        : "")
      + "</div>"
      + '<div class="ids">' + esc(id) + "</div>"
      + '<div class="editrow">'
      + '<label>渠道每日额度（积分，0 = 不限）'
      + '<input type="number" min="0" data-f="cap" value="' + (cap || "") + '" placeholder="0"></label>'
      + '<label>1 积分 = 多少 token'
      + '<input type="number" min="1" data-f="tpc" value="' + tpc + '"></label>'
      + '<label class="est">预估能跑'
      + '<output data-f="est">' + (tok > 0 ? fmtTok(tok) + " tok" : "—") + "</output></label>"
      + '<button class="save">保存</button>'
      + "</div>"

    if (accts.length && open) {
      html += '<div class="accts">'
        + '<div class="acctnote">下面的额度只算这一个账号；留空就跟渠道额度走。</div>'
        + accts.map((a) => accountRow(id, a)).join("")
        + "</div>"
    }
    return html + "</div>"
  }

  function paintGate() {
    const o = options || {}
    const put = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v ?? "" }
    put("maxRequestTokens", o.maxRequestTokens || 0)
    put("estimate", o.estimate ?? 3)
    put("ceiling", o.ceiling ?? 80)
    const sw = $("splitOn")
    if (sw) sw.checked = o.splitChannelBudget === true
    const en = $("enforceOn")
    if (en) en.checked = o.enforce === true
    put("everyMin", Number.isFinite(Number(o.checkEveryMinutes)) ? Number(o.checkEveryMinutes) : 5)
  }

  function paint() {
    if (summary) {
      const tot = (Number(summary.input) || 0) + (Number(summary.output) || 0)
      $("sub").textContent = "今日合计 " + fmtTok(tot) + " tok / "
        + (Number(summary.calls) || 0) + " 次"
        + (summary.errors ? "（" + summary.errors + " 次失败）" : "")
      const models = Array.isArray(summary.models) ? summary.models : []
      $("usage").innerHTML = models.length
        ? '<div class="models">今日 Top：' + models.slice(0, 6)
            .map((m) => esc(m.model) + " " + fmtTok((Number(m.input) || 0) + (Number(m.output) || 0)))
            .join(" · ") + "</div>"
        : ""
    } else {
      $("sub").textContent = providers.length ? "已读到 " + providers.length + " 个渠道" : "读取中…"
      $("usage").innerHTML = ""
    }

    if (!providers.length) {
      $("list").innerHTML = '<p class="empty">没有读到渠道。magpie 的 providers:list 只列出已经装了插件、且登录过的渠道。</p>'
      paintGate()
      return
    }
    const sorted = [...providers].sort((a, b) =>
      (capOf(a.id) > 0 ? 0 : 1) - (capOf(b.id) > 0 ? 0 : 1)
      || String(a.name || a.id).localeCompare(String(b.name || b.id), "zh"))
    $("list").innerHTML = sorted.map(channelCard).join("")

    // 账号名单是看门狗写进 options 的。它没跑过的时候名单是空的，
    // 界面得说清楚「为什么看不到账号、要等什么」，而不是让人自己猜。
    const hint = $("acctHint")
    if (hint) {
      const total = Object.values(accountsByChannel).reduce(
        (s, v) => s + (Array.isArray(v) ? v.length : 0), 0)
      const on = options.enforce === true
      const parts = []
      // 先说要紧的：enforce 没开，填了额度也不会有人执行。
      // 这里以前让人去另外跑外部看门狗，0.5.0 之后检查就在插件自己进程里，
      // 只要打开开关就行——提示写旧了会把人支到一条多余的路上去。
      if (!on) {
        parts.push('<b class="warn">额度现在是「只看不管」。</b>'
          + '下面填的数字会存下来，但插件不会真的去停——超了不会停渠道、也不会停账号。'
          + '要让它生效，把上面的<b>「真的执行」</b>开关打开即可；'
          + '检查由插件自带的定时器跑，不用开命令行、不用配计划任务。')
      }
      if (!total) {
        parts.push("<b>还没读到账号名单。</b>账号由看门狗从 magpie 的登录记录里导出，"
          + "它跑过一轮之后，这里才会显示每个渠道下的账号，也才能按账号分别设额度。")
      }
      hint.hidden = !parts.length
      hint.innerHTML = parts.join("<br>")
      hint.className = "sub hintbox" + (on ? "" : " warn")
    }
    paintGate()
  }

  // 输入时实时更新预估列（不落盘，也不重绘整个列表）。
  // 账号行是嵌在卡片里的，所以要找最近的「有 data-f=est 的那一行」，
  // 不能用 closest('.card')——那会一直取到外层渠道卡的数字。
  document.addEventListener("input", (e) => {
    const row = e.target.closest("[data-acct]") || e.target.closest(".card[data-ch]")
    if (!row) return
    const out = row.querySelector("[data-f=est]")
    if (!out) return
    const cap = Number(row.querySelector("[data-f=cap]")?.value)
    const tpc = Number(row.querySelector("[data-f=tpc]")?.value)
    const ok = Number.isFinite(cap) && cap > 0 && Number.isFinite(tpc) && tpc > 0
    out.textContent = ok ? fmtTok(cap * tpc) + " tok" : "—"
    out.classList.toggle("zero", !ok)
  })

  // 保存一律走这里：先拉一份最新的 options 再改。
  // 原因：看门狗会往 options 里写 accountsByChannel / accountsAt，
  // 如果面板拿着打开页面时那份旧 options 整份写回去，就把看门狗
  // 刚更新的账号名单覆盖掉了（连账号的 on 状态一起变旧）。
  async function patchOptions(changes) {
    let fresh = options
    try { fresh = (await magpie.options.get()) || options } catch {}
    options = await magpie.options.set({ ...fresh, ...changes })
    readAccountsFromOptions()
    return options
  }

  async function saveChannel(scope) {
    const ch = scope.dataset.ch
    const acct = scope.dataset.acct || ""
    // 账号行写 "渠道/账号"，渠道卡写 "渠道"
    const key = acct ? ch + "/" + acct : ch
    const capInput = scope.querySelector("[data-f=cap]")
    const tpcInput = scope.querySelector("[data-f=tpc]")
    if (!capInput || !tpcInput) return

    const map = { ...creditsMap() }
    const n = Number(capInput.value)
    if (Number.isFinite(n) && n > 0) map[key] = n
    else delete map[key]
    const t = Number(tpcInput.value)
    // 账号的换算率默认跟随渠道，所以和渠道值相同就不落盘
    const base = acct ? tpcOf(ch) : (DEFAULT_TPC[ch] || FALLBACK_TPC)
    if (Number.isFinite(t) && t > 0 && t !== base) map[key + ":tpc"] = t
    else delete map[key + ":tpc"]

    const b = scope.querySelector(".save")
    const was = b.textContent
    b.disabled = true
    b.textContent = "保存中…"
    try {
      await patchOptions({ dailyCredits: map })
      b.textContent = "已保存"
      paint()
    } catch (e) {
      // 空 catch 会把「保存静默失败」藏起来，至少留一行给控制台
      console.error("保存额度失败", e)
      b.textContent = "失败"
    }
    setTimeout(() => { b.textContent = was; b.disabled = false }, 1200)
  }

  async function saveEnforce() {
    const err = $("enforceErr")
    try {
      await patchOptions({ enforce: $("enforceOn").checked })
      err.hidden = false
      err.className = "err ok"
      err.textContent = $("enforceOn").checked
        ? "已打开：插件下一轮就会按额度停用超限的账号 / 下架超限的渠道"
        : "已关闭：只记账不拦，超了也不会有人动手"
      paint()
    } catch (e) {
      console.error("保存执行开关失败", e)
      err.hidden = false
      err.className = "err"
      err.textContent = "保存失败：" + (e?.message ?? e)
    }
    setTimeout(() => (err.hidden = true), 3000)
  }

  // 检查间隔：插件自己带定时器，改这里就是改它多久查一次。
  // 0 = 不自动查（只靠手动跑 watchdog.mjs）。
  async function saveEvery() {
    const err = $("enforceErr")
    const b = $("saveEvery")
    const raw = $("everyMin").value.trim()
    const n = raw === "" ? 5 : Number(raw)
    if (!Number.isFinite(n) || n < 0 || n > 1440) {
      err.hidden = false
      err.className = "err"
      err.textContent = "间隔要填 0~1440 之间的数字（分钟）"
      setTimeout(() => (err.hidden = true), 3000)
      return
    }
    const was = b.textContent
    b.disabled = true
    b.textContent = "保存中…"
    try {
      await patchOptions({ checkEveryMinutes: n })
      err.hidden = false
      err.className = "err ok"
      err.textContent = n === 0
        ? "已关闭自动检查：只能手动跑 watchdog.mjs"
        : `已保存：每 ${n} 分钟查一次，下一轮按新间隔走`
      b.textContent = "已保存"
      paint()
    } catch (e) {
      console.error("保存检查间隔失败", e)
      err.hidden = false
      err.className = "err"
      err.textContent = "保存失败：" + (e?.message ?? e)
      b.textContent = "失败"
    }
    setTimeout(() => { b.textContent = was; b.disabled = false; err.hidden = true }, 2000)
  }

  async function saveSwitch() {
    const err = $("splitErr")
    try {
      await patchOptions({ splitChannelBudget: $("splitOn").checked })
      err.hidden = false
      err.className = "err ok"
      err.textContent = $("splitOn").checked
        ? "已开启：渠道额度按账号数均分，看门狗下一轮生效"
        : "已关闭：渠道额度恢复成「所有账号合计」的上限"
    } catch (e) {
      console.error("保存平摊开关失败", e)
      err.hidden = false
      err.className = "err"
      err.textContent = "保存失败：" + (e?.message ?? e)
    }
    setTimeout(() => (err.hidden = true), 2600)
  }

  async function saveGate() {
    const err = $("gateErr")
    const n = (v, lo, hi, d) => {
      const x = Number(v)
      return Number.isFinite(x) && x >= lo && x <= hi ? x : d
    }
    try {
      await patchOptions({
        maxRequestTokens: n($("maxRequestTokens").value, 0, 1e9, 0),
        estimate: n($("estimate").value, 1, 10, 3),
        ceiling: n($("ceiling").value, 1, 100, 80),
      })
      err.hidden = false
      err.className = "err ok"
      err.textContent = "已保存，下一个请求就生效"
    } catch (e) {
      console.error("保存闸门失败", e)
      err.hidden = false
      err.className = "err"
      err.textContent = "保存失败：" + (e?.message ?? e)
    }
    setTimeout(() => (err.hidden = true), 2500)
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.save")
    if (b) {
      // 账号行优先：它嵌在卡片里，closest('.card') 会拿错层级
      saveChannel(b.closest("[data-acct]") || b.closest(".card"))
      return
    }
    const t = e.target.closest("button[data-act=toggle]")
    if (t) {
      const id = t.closest(".card").dataset.ch
      if (openSet.has(id)) openSet.delete(id)
      else openSet.add(id)
      paint()
    }
  })
  $("saveGate").addEventListener("click", saveGate)
  $("splitOn").addEventListener("change", saveSwitch)
  $("enforceOn").addEventListener("change", saveEnforce)
  $("saveEvery").addEventListener("click", saveEvery)

  // 账号名单就在 options 里，跟着 options 一起读，不需要额外请求
  function readAccountsFromOptions() {
    const ab = options?.accountsByChannel
    accountsByChannel = ab && typeof ab === "object" ? ab : {}
    accountsAt = String(options?.accountsAt || "")
  }

  async function load() {
    try { providers = (await magpie.read("providers:list")) || [] } catch (e) { providers = []; console.error("providers:list", e) }
    try { options = (await magpie.options.get()) || {} } catch (e) { options = {}; console.error("options.get", e) }
    readAccountsFromOptions()
    try { summary = await magpie.read("usage:summary", { period: "today" }) } catch (e) { summary = null; console.error("usage:summary", e) }
    paint()
  }

  await load()
  setInterval(async () => {
    try {
      summary = await magpie.read("usage:summary", { period: "today" })
      const tot = (Number(summary?.input) || 0) + (Number(summary?.output) || 0)
      $("sub").textContent = "今日合计 " + fmtTok(tot) + " tok / " + (Number(summary?.calls) || 0) + " 次"
    } catch (e) {
      // 空 catch 会把「读数一直失败」藏成「一直没变」，至少留一行
      console.error("刷新今日用量失败", e)
    }
  }, 60_000)
})()
