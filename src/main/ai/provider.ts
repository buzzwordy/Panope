/**
 * Streaming chat clients for the two wire protocols that cover practically
 * every model endpoint: Anthropic's messages API, and the OpenAI
 * chat-completions shape that Ollama, vLLM, LM Studio, llama.cpp, OpenRouter,
 * Groq and OpenAI itself all speak. Plain fetch + SSE, no SDK dependency.
 */

export interface AiToolCallReq {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ChatTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Provider-neutral transcript; converted to each wire format on the way out. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: AiToolCallReq[] }
  | { role: 'tools'; results: Array<{ id: string; name: string; content: string }> }

export interface ProviderSettings {
  provider: 'anthropic' | 'openai' | 'claude-code'
  /** openai: endpoint base; claude-code: optional path to the claude binary */
  baseUrl?: string
  model: string
  apiKey?: string
  mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string }>
  /** claude-code: allow the CLI's own shell/file tools (ungated by Panope) */
  unrestricted?: boolean
  allowedExternalTools?: string[]
}

export interface ChatResult {
  text: string
  calls: AiToolCallReq[]
}

const MAX_TOKENS = 8192

async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error('empty response from the model endpoint')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
    // some servers end the stream without a trailing newline
    const rest = buf.replace(/\r$/, '')
    if (rest.startsWith('data:')) yield rest.slice(5).trim()
  } finally {
    reader.releaseLock()
  }
}

async function throwHttpError(res: Response, provider: string): Promise<never> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string }; message?: string }
    detail = body?.error?.message ?? body?.message ?? ''
  } catch {
    /* non-JSON error body */
  }
  throw new Error(`${provider} returned ${res.status}${detail ? `: ${detail}` : ''}`)
}

// ---------------- OpenAI-compatible ----------------

function toOpenAiMessages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.text })
    } else if (t.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.calls.length
          ? {
              tool_calls: t.calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) }
              }))
            }
          : {})
      })
    } else {
      for (const r of t.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content })
    }
  }
  return out
}

async function chatOpenAi(
  cfg: ProviderSettings,
  system: string,
  turns: Turn[],
  tools: ChatTool[],
  onText: (t: string) => void,
  signal: AbortSignal
): Promise<ChatResult> {
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: cfg.model,
      stream: true,
      messages: toOpenAiMessages(system, turns),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    })
  })
  if (!res.ok) await throwHttpError(res, 'The model endpoint')

  let text = ''
  let truncated = false
  // tool-call deltas arrive keyed by index; arguments stream as JSON fragments
  const partial = new Map<number, { id: string; name: string; args: string }>()
  let nextKey = 0
  let lastKey = 0
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break
    let msg: {
      error?: { message?: string }
      choices?: Array<{
        finish_reason?: string
        delta?: {
          content?: string
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        }
      }>
    }
    try {
      msg = JSON.parse(data)
    } catch {
      continue
    }
    // vLLM and some proxies report failures as an error object in the stream
    if (msg.error) throw new Error(msg.error.message ?? 'model stream error')
    const choice = msg.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason === 'length') truncated = true
    const delta = choice.delta
    if (!delta) continue
    if (delta.content) {
      text += delta.content
      onText(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      // index is optional in the wild: a delta with an id starts a new call
      const key = tc.index ?? (tc.id ? nextKey++ : lastKey)
      lastKey = key
      if (tc.index !== undefined) nextKey = Math.max(nextKey, tc.index + 1)
      const cur = partial.get(key) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      partial.set(key, cur)
    }
  }

  const calls: AiToolCallReq[] = []
  for (const [i, c] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      calls.push({ id: c.id || `call_${i}`, name: c.name, args: c.args ? JSON.parse(c.args) : {} })
    } catch {
      // truncated or malformed arguments: skipping beats a confirm card with
      // empty args that would run a mutation with defaults
      onText(`\n(a ${c.name || 'tool'} call arrived malformed and was skipped)`)
    }
  }
  if (truncated) onText('\n(response hit the token limit)')
  return { text, calls }
}

// ---------------- Anthropic ----------------

function toAnthropicMessages(turns: Turn[]): unknown[] {
  const out: unknown[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.text })
    } else if (t.role === 'assistant') {
      const content: unknown[] = []
      if (t.text) content.push({ type: 'text', text: t.text })
      for (const c of t.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      out.push({ role: 'assistant', content })
    } else {
      out.push({
        role: 'user',
        content: t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content }))
      })
    }
  }
  return out
}

async function chatAnthropic(
  cfg: ProviderSettings,
  system: string,
  turns: Turn[],
  tools: ChatTool[],
  onText: (t: string) => void,
  signal: AbortSignal
): Promise<ChatResult> {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey ?? '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      system,
      messages: toAnthropicMessages(turns),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    })
  })
  if (!res.ok) await throwHttpError(res, 'Anthropic')

  let text = ''
  let truncated = false
  const calls: AiToolCallReq[] = []
  let openCall: { id: string; name: string; json: string } | null = null
  for await (const data of sseData(res)) {
    let ev: {
      type?: string
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
      error?: { message?: string }
    }
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          openCall = { id: ev.content_block.id ?? `call_${calls.length}`, name: ev.content_block.name ?? '', json: '' }
        }
        break
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          text += ev.delta.text
          onText(ev.delta.text)
        } else if (ev.delta?.type === 'input_json_delta' && openCall) {
          openCall.json += ev.delta.partial_json ?? ''
        }
        break
      case 'content_block_stop':
        if (openCall) {
          try {
            calls.push({ id: openCall.id, name: openCall.name, args: openCall.json ? JSON.parse(openCall.json) : {} })
          } catch {
            onText(`\n(a ${openCall.name || 'tool'} call arrived malformed and was skipped)`)
          }
          openCall = null
        }
        break
      case 'message_delta':
        if (ev.delta?.stop_reason === 'max_tokens') truncated = true
        break
      case 'error':
        throw new Error(ev.error?.message ?? 'model stream error')
    }
  }
  if (truncated) onText('\n(response hit the token limit)')
  return { text, calls }
}

export function chat(
  cfg: ProviderSettings,
  system: string,
  turns: Turn[],
  tools: ChatTool[],
  onText: (t: string) => void,
  signal: AbortSignal
): Promise<ChatResult> {
  return cfg.provider === 'anthropic'
    ? chatAnthropic(cfg, system, turns, tools, onText, signal)
    : chatOpenAi(cfg, system, turns, tools, onText, signal)
}

/** Model ids the endpoint offers; claude-code has a fixed alias set. */
export async function listModels(cfg: ProviderSettings): Promise<string[]> {
  if (cfg.provider === 'claude-code') return ['sonnet', 'opus', 'haiku']
  const headers: Record<string, string> =
    cfg.provider === 'anthropic'
      ? { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : cfg.apiKey
        ? { authorization: `Bearer ${cfg.apiKey}` }
        : {}
  const base =
    cfg.provider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10000) })
  } catch {
    throw new Error(`could not reach ${base} - is the endpoint running?`)
  }
  if (!res.ok) await throwHttpError(res, 'The model endpoint')
  const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
  const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => !!x)
  return ids.sort()
}
