// The hook's cases: what a request is made of, the options in force, and
// what the gateway is owed for it — a reject with a status and a piece of its
// message, or nothing at all, which is the request going on untouched.
//
// A module rather than JSON so a long body can be written as a repeat.

const CJK = "字"

export default [
  {
    name: "no options: a request goes on untouched",
    options: null,
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: "你好" }] },
  },
  {
    name: "empty options: a request goes on untouched",
    options: {},
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: "你好" }] },
  },
  {
    name: "options that are not an object are ignored, not thrown",
    options: "ceiling=80",
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: "你好" }] },
  },
  {
    name: "a model in block.models is turned away",
    options: { block: { models: ["gpt-6-astra"] } },
    ctx: { model: "gpt-6-astra", agent: "workbuddy" },
    request: { messages: [{ role: "user", content: "hi" }] },
    reject: { status: 403, message: "block\\.models" },
  },
  {
    name: "a model matched by a wildcard is turned away",
    options: { block: { models: ["gpt-6-*"] } },
    ctx: { model: "gpt-6-astra", agent: "workbuddy" },
    request: { messages: [{ role: "user", content: "hi" }] },
    reject: { status: 403, message: "gpt-6-astra" },
  },
  {
    name: "another model is not turned away by the same list",
    options: { block: { models: ["gpt-6-*"] } },
    ctx: { model: "hy3", agent: "workbuddy" },
    request: { messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "a model name is matched whatever its case",
    options: { block: { models: ["GPT-6-*"] } },
    ctx: { model: "gpt-6-astra", agent: "workbuddy" },
    request: { messages: [{ role: "user", content: "hi" }] },
    reject: { status: 403, message: "gpt-6-astra" },
  },
  {
    name: "a dot in a pattern is literal, not a regular expression",
    options: { block: { models: ["a.b"] } },
    ctx: { model: "axb", agent: "x" },
    request: { messages: [] },
  },
  {
    name: "an agent in block.agents is turned away",
    options: { block: { agents: ["claude"] } },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: "hi" }] },
    reject: { status: 403, message: "block\\.agents" },
  },
  {
    name: "a request past maxRequestTokens is turned away before it is sent",
    options: { maxRequestTokens: 100, estimate: 3 },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(900) }] },
    reject: { status: 413, message: "maxRequestTokens" },
  },
  {
    name: "a request under maxRequestTokens goes on",
    options: { maxRequestTokens: 100, estimate: 3 },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(90) }] },
  },
  {
    name: "maxRequestTokens 0 is no limit at all",
    options: { maxRequestTokens: 0 },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(200000) }] },
  },
  {
    name: "a bigger estimate lets the same body through",
    options: { maxRequestTokens: 100, estimate: 10 },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(900) }] },
  },
  {
    name: "text in Gemini parts counts too",
    options: { maxRequestTokens: 100, estimate: 3 },
    ctx: { model: "hy3", agent: "gemini" },
    request: {
      systemInstruction: { parts: [{ text: CJK.repeat(400) }] },
      contents: [{ role: "user", parts: [{ text: CJK.repeat(400) }] }],
    },
    reject: { status: 413, message: "maxRequestTokens" },
  },
  {
    name: "text in an Anthropic block counts too",
    options: { maxRequestTokens: 100, estimate: 3 },
    ctx: { model: "hy3", agent: "claude" },
    request: {
      system: "you are terse",
      messages: [{ role: "user", content: [{ type: "text", text: CJK.repeat(600) }] }],
    },
    reject: { status: 413, message: "maxRequestTokens" },
  },
  {
    name: "a tool schema counts with the prompt it is sent beside",
    options: { maxRequestTokens: 100, estimate: 3 },
    ctx: { model: "hy3", agent: "claude" },
    request: {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: CJK.repeat(600), input_schema: { type: "object" } }],
    },
    reject: { status: 413, message: "maxRequestTokens" },
  },
  {
    name: "a block and a size limit together: the block is named first",
    options: { maxRequestTokens: 10, block: { models: ["hy3"] } },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(900) }] },
    reject: { status: 403, message: "block\\.models" },
  },
  {
    name: "an empty block list blocks nothing",
    options: { block: { models: [], agents: [] } },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "a negative maxRequestTokens is no limit",
    options: { maxRequestTokens: -5 },
    ctx: { model: "hy3", agent: "claude" },
    request: { messages: [{ role: "user", content: CJK.repeat(5000) }] },
  },
]
