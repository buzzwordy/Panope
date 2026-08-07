import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AiEvent, AiUiContext } from '../../shared/types'
import { chat, type ProviderSettings, type Turn, type AiToolCallReq } from './provider'
import { ALL_TOOLS, isMutation, runReadTool, runMutation, callSummary, type ToolDeps } from './tools'
import { startMcpServer, type McpEndpoint } from './mcp'
import { findClaudeBinary, runClaudeCode, type ClaudeCodeRun } from './claudeCode'

/**
 * One conversation with the model. Reads execute as they arrive; a mutation
 * pauses the loop, surfaces a confirmation card in the renderer, and waits.
 * The transcript lives here so closing the panel does not lose the thread.
 */

const MAX_ROUNDS = 12
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000
const MAX_SAVED_EVENTS = 500
const MAX_SAVED_TURNS = 30

const SYSTEM = `You are the assistant inside Panope, a Kubernetes client. You investigate and fix problems in the cluster the user is connected to.

Rules:
- Use the tools. Never guess object names or states - look them up.
- Every call runs with the user's own identity; if RBAC denies you, say so.
- Mutations (scale, restart, delete, patch, apply, re-run, drain, trigger, rollback) show the user a confirmation card. Propose them when they fix the problem; never ask for approval in text, just call the tool.
- patch_resource is a merge patch and is the tool for stuck finalizers, cordoning, and any field edit that is not a dedicated tool. Do not tell the user to run kubectl for something a tool covers.
- If the user declines an action, respect it and offer alternatives.
- Be terse. Name objects exactly (namespace/name). Use \`\`\` fences for YAML and commands.
- If logs or events do not explain a failure, say what you checked and what is missing rather than inventing a cause.`

export class AiSession {
  private turns: Turn[] = []
  private pending = new Map<string, { resolve: (approve: boolean) => void; timer: NodeJS.Timeout }>()
  private confirmSeq = 0
  /** bumped by reset(); in-flight work from an older generation must not touch turns */
  private gen = 0
  private abort?: AbortController
  private running = false
  // claude-code provider: the CLI holds the conversation, we hold its id
  private mcp?: McpEndpoint
  private claudeSessionId?: string
  private claudeRun?: ClaudeCodeRun
  // everything the renderer has been shown, replayable after a restart
  private events: AiEvent[] = []
  private emit: (e: AiEvent) => void

  constructor(
    private deps: ToolDeps,
    send: (e: AiEvent) => void,
    private settings: () => ProviderSettings | null,
    private appVersion: string,
    private scratchCwd: string,
    private historyPath?: string
  ) {
    this.emit = (e) => {
      this.events.push(e)
      if (this.events.length > MAX_SAVED_EVENTS) this.events = this.events.slice(-MAX_SAVED_EVENTS)
      send(e)
    }
    this.load()
  }

  /** The transcript so far, for a renderer that (re)mounted after the events streamed. */
  history(): AiEvent[] {
    return this.events
  }

  private load(): void {
    if (!this.historyPath) return
    try {
      const raw = JSON.parse(readFileSync(this.historyPath, 'utf8')) as {
        events?: AiEvent[]
        turns?: Turn[]
        claudeSessionId?: string
      }
      this.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_SAVED_EVENTS) : []
      this.claudeSessionId = typeof raw.claudeSessionId === 'string' ? raw.claudeSessionId : undefined
      // Trim old turns at a user boundary: an orphaned tool-result message
      // (without the assistant call that produced it) is a 400 on both APIs.
      let turns = Array.isArray(raw.turns) ? raw.turns : []
      if (turns.length > MAX_SAVED_TURNS) {
        turns = turns.slice(-MAX_SAVED_TURNS)
        const firstUser = turns.findIndex((t) => t.role === 'user')
        turns = firstUser >= 0 ? turns.slice(firstUser) : []
      }
      this.turns = turns
      // A confirm that never settled died with the previous process.
      const settled = new Set(this.events.filter((e) => e.type === 'confirmed').map((e) => e.id))
      for (const e of this.events) {
        if (e.type === 'confirm' && !settled.has(e.id)) {
          this.events.push({ type: 'confirmed', id: e.id, approve: false })
        }
      }
    } catch {
      /* no history yet, or unreadable - start clean */
    }
  }

  private save(): void {
    if (!this.historyPath) return
    try {
      const tmp = this.historyPath + '.tmp'
      writeFileSync(
        tmp,
        JSON.stringify({
          events: this.events.slice(-MAX_SAVED_EVENTS),
          turns: this.turns.slice(-MAX_SAVED_TURNS),
          claudeSessionId: this.claudeSessionId
        })
      )
      renameSync(tmp, this.historyPath)
    } catch (e) {
      // best-effort, but say why in the console rather than hiding it
      console.error('[ai] failed to persist history:', e)
    }
  }

  get busy(): boolean {
    return this.running
  }

  async send(text: string, ctx?: AiUiContext): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', error: 'Still working on the previous message.' })
      return
    }
    // Echoed from here, not added optimistically in the renderer, so the
    // question is part of the persisted transcript like everything else.
    this.emit({ type: 'user', text })
    const cfg = this.settings()
    if (!cfg) {
      this.emit({ type: 'error', error: 'No model configured. Open the assistant settings.' })
      return
    }
    if (cfg.provider === 'claude-code') {
      return this.sendViaClaudeCode(String(text), cfg, ctx)
    }
    if (!cfg.model) {
      this.emit({ type: 'error', error: 'No model configured. Open the assistant settings.' })
      return
    }
    const where = ctx
      ? `[user is viewing: context=${ctx.context ?? '?'} namespace=${ctx.namespace ?? 'All'} view=${ctx.view ?? '?'}]\n`
      : ''
    const gen = ++this.gen
    this.turns.push({ role: 'user', text: where + text })
    this.running = true
    this.abort = new AbortController()
    try {
      let round = 0
      for (; round < MAX_ROUNDS; round++) {
        const res = await chat(cfg, SYSTEM, this.turns, ALL_TOOLS, (t) => this.emit({ type: 'text', text: t }), this.abort.signal)
        if (gen !== this.gen) return
        this.turns.push({ role: 'assistant', text: res.text, calls: res.calls })
        if (!res.calls.length) break
        const results: Array<{ id: string; name: string; content: string }> = []
        for (const call of res.calls) {
          const content = await this.runCall(call)
          if (gen !== this.gen) return
          results.push({ id: call.id, name: call.name, content })
        }
        this.turns.push({ role: 'tools', results })
      }
      if (round === MAX_ROUNDS) {
        this.emit({ type: 'text', text: '\n(stopped after ' + MAX_ROUNDS + ' tool rounds - say "continue" to keep going)' })
      }
      this.emit({ type: 'done' })
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.emit({ type: 'done' })
      } else {
        this.emit({ type: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      this.running = false
      this.save()
    }
  }

  /** Tokens bill to the user's Claude subscription; tools come back to us over loopback MCP. */
  private async sendViaClaudeCode(text: string, cfg: ProviderSettings, ctx?: AiUiContext): Promise<void> {
    const binary = findClaudeBinary(cfg.baseUrl)
    if (!binary) {
      this.emit({
        type: 'error',
        error: 'Claude Code CLI not found. Install it (or set its path in the assistant settings) and log in with "claude" first.'
      })
      return
    }
    this.running = true
    try {
      // Fresh server and token per run, torn down in the finally, so no
      // loopback listener with a live token outlives the request.
      this.mcp = await startMcpServer({ runCall: (c) => this.runCall(c) }, this.appVersion)
      const where = ctx
        ? `[user is viewing: context=${ctx.context ?? '?'} namespace=${ctx.namespace ?? 'All'} view=${ctx.view ?? '?'}]\n`
        : ''
      this.claudeRun = runClaudeCode({
        binary,
        prompt: where + text,
        system: SYSTEM + '\nUse only the mcp__panope__* tools; the filesystem and shell are off limits.',
        model: cfg.model || undefined,
        resumeSessionId: this.claudeSessionId,
        mcpUrl: this.mcp.url,
        mcpToken: this.mcp.token,
        cwd: this.scratchCwd,
        onText: (t) => this.emit({ type: 'text', text: t })
      })
      const res = await this.claudeRun.wait
      if (res.sessionId) this.claudeSessionId = res.sessionId
      if (res.error) this.emit({ type: 'error', error: res.error })
      else this.emit({ type: 'done' })
    } catch (e) {
      this.emit({ type: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.claudeRun = undefined
      this.mcp?.close()
      this.mcp = undefined
      this.running = false
      this.save()
    }
  }

  private async runCall(call: AiToolCallReq): Promise<string> {
    if (!isMutation(call.name)) {
      this.emit({ type: 'tool', name: call.name, summary: callSummary(call) })
      return runReadTool(call, this.deps)
    }
    // Our own key, never the model-chosen call id: ids from the model can
    // collide across rounds, and a collision could approve the wrong action.
    const key = `confirm_${++this.confirmSeq}`
    this.emit({ type: 'confirm', id: key, name: call.name, summary: callSummary(call), args: call.args })
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(key, false), CONFIRM_TIMEOUT_MS)
      this.pending.set(key, { resolve, timer })
      this.abort?.signal.addEventListener('abort', () => this.settle(key, false), { once: true })
    })
    if (!approved) return 'The user declined this action. Do not retry it unasked.'
    const res = await runMutation(call, this.deps)
    return JSON.stringify(res)
  }

  private settle(key: string, approve: boolean): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    clearTimeout(entry.timer)
    this.emit({ type: 'confirmed', id: key, approve })
    entry.resolve(approve)
  }

  confirm(id: string, approve: boolean): void {
    this.settle(id, approve)
  }

  stop(): void {
    this.abort?.abort()
    this.claudeRun?.kill()
    for (const key of [...this.pending.keys()]) this.settle(key, false)
  }

  reset(): void {
    this.gen++
    this.stop()
    this.turns = []
    this.claudeSessionId = undefined
    this.events = []
    this.save()
  }
}
