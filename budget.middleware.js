// Budget-aware routings and a per-request gate.
//
// Runs in magpie's gateway on moejs: one file, no imports. A strategy has
// 20 ms, a hook 250 ms, and both fail open — a throw leaves the seating or
// the request as it was.
//
// Strategies, offered as `<plugin>/<name>` in every routing picker while the
// plugin is on:
//
//   quota-first   Spend an allowance before its window renews, and hand the
//                 request to the next seat once one is at the ceiling. A
//                 seat whose window renews soonest goes first: an allowance
//                 that renews on Thursday and is still half full on
//                 Wednesday is wasted. With one seat in the pool this is the
//                 same order as listed — nothing to hand over to.
//   token-spread  Send to the seat magpie has used least in the last hour
//                 (its `tokens`, decayed by an hour's half-life), so one
//                 account is not hammered while the others idle.
//
// Hook:
//
//   onRequest   Turns away a request for a blocked model, from a blocked
//               agent, or one whose text is longer than `maxRequestTokens`
//               allows — before it is routed, sent and paid for.
//
// What this plugin does NOT do, and cannot: stop a provider once a running
// total of tokens or money crosses a daily budget. A gateway middleware
// sees each request in a runtime of its own, has no filesystem, and the only
// counters it shares with `onUsage` live in a runtime that cannot reject. See
// the README's "What a gateway plugin cannot enforce".

// number reads v as a number inside [lo, hi], or dflt.
function number(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return n < lo ? lo : n > hi ? hi : n
}

// ceilOf is the share of an allowance past which a seat waits for the
// others: the options' ceiling, 80 when none is set.
function ceilOf(options) {
  const o = options && typeof options === "object" ? options : {}
  return number(o.ceiling, 1, 100, 80)
}

// maxTokensOf is the longest request allowed, in estimated tokens; 0 for no
// limit.
function maxTokensOf(options) {
  return number(options && options.maxRequestTokens, 0, 1e9, 0)
}

// charsPerToken is the divisor that turns characters into tokens; 3, which
// is about right for Chinese and conservative for English (a 4-character
// rule would let a request through that is longer than the limit says).
function charsPerTokenOf(options) {
  return number(options && options.estimate, 1, 10, 3)
}

// globToRegExp turns "*" wildcards into a matcher; a name without one is
// matched as written.
function globToRegExp(pattern) {
  const escaped = String(pattern).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  try {
    return new RegExp("^" + escaped.join(".*") + "$", "i")
  } catch {
    return null
  }
}

// listed says whether name is in list, by wildcard or in full.
function listed(name, list) {
  if (!name || !Array.isArray(list)) return false
  for (const p of list) {
    if (typeof p !== "string" || !p) continue
    if (p === name) return true
    const re = globToRegExp(p)
    if (re && re.test(name)) return true
  }
  return false
}

// byTier sorts the indexes by tier, then by more, keeping the listed order
// among those alike.
function byTier(seats, tier, more) {
  return seats
    .map((_, i) => i)
    .sort((a, b) => tier(seats[a]) - tier(seats[b]) || (more ? more(seats[a], seats[b]) : 0) || a - b)
}

// renewsAt is when a seat's allowance comes back: the renewal of its widest
// window, 0 when magpie doesn't know (an API key, an account not read yet).
function renewsAt(seat) {
  const soon = seat && Array.isArray(seat.soon) ? seat.soon : []
  for (const t of soon) {
    const n = Number(t)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

export const strategies = {
  // Fill in the order listed, each seat up to `ceiling` percent of its
  // allowance, the one renewing soonest first: what a window would otherwise
  // reset unspent goes first. Once every seat is past the ceiling the one
  // renewing soonest goes first, then the least used. A resting seat goes
  // last. A seat whose allowance isn't known counts as below the ceiling and
  // as renewing last.
  "quota-first"(pool, seats, options) {
    const c = ceilOf(options)
    const over = (s) => s.known && s.used >= c
    return byTier(
      seats,
      (s) => (s.resting ? 2 : over(s) ? 1 : 0),
      (a, b) => {
        const ra = renewsAt(a)
        const rb = renewsAt(b)
        // an unknown renewal sorts after every known one
        if (ra !== rb) {
          if (!ra) return 1
          if (!rb) return -1
          return ra - rb
        }
        // the least of what the ceiling leaves goes first
        return (a.known ? a.used : 0) - (b.known ? b.used : 0)
      },
    )
  },

  // Spread the load: the seat magpie sent least lately goes first, so one
  // account is not hammered while the others idle. A resting seat goes last,
  // and so does one already past `ceiling` percent.
  "token-spread"(pool, seats, options) {
    const c = ceilOf(options)
    const over = (s) => s.known && s.used >= c
    return byTier(
      seats,
      (s) => (s.resting ? 2 : over(s) ? 1 : 0),
      (a, b) => (a.tokens || 0) - (b.tokens || 0),
    )
  },
}

// textLength is how many characters of text a request carries, in any of the
// four APIs magpie serves. Tool schemas count too: they are sent with the
// request and billed with the prompt.
function textLength(v, depth) {
  if (depth > 12) return 0
  if (typeof v === "string") return v.length
  if (!v || typeof v !== "object") return 0
  let n = 0
  if (Array.isArray(v)) {
    for (const x of v) n += textLength(x, depth + 1)
    return n
  }
  for (const k in v) {
    if (Object.prototype.hasOwnProperty.call(v, k)) n += textLength(v[k], depth + 1)
  }
  return n
}

// onRequest turns away a request this plugin is asked to refuse. Anything it
// cannot read is sent on: a gate that guesses is worse than none.
export function onRequest(body, ctx) {
  const o = ctx && ctx.options
  if (!o || typeof o !== "object") return

  const agent = ctx.agent || ""
  const model = ctx.model || ""
  const block = o.block && typeof o.block === "object" ? o.block : {}

  if (listed(model, block.models)) {
    ctx.reject(403, `model "${model}" is blocked by magpie-plugin-credit-limit (block.models)`)
    return
  }
  if (listed(agent, block.agents)) {
    ctx.reject(403, `agent "${agent}" is blocked by magpie-plugin-credit-limit (block.agents)`)
    return
  }

  const limit = maxTokensOf(o)
  if (limit > 0 && body && typeof body === "object") {
    const chars = textLength(body, 0)
    const tokens = chars / charsPerTokenOf(o)
    if (tokens > limit) {
      const round = (n) => Math.round(n / 1000) * 1000 || Math.round(n)
      ctx.reject(
        413,
        `this request carries about ${round(tokens)} tokens, past the ${round(limit)} magpie-plugin-credit-limit allows per request (maxRequestTokens); shorten it, or raise the limit in the plugin's options`,
      )
      return
    }
  }
}
