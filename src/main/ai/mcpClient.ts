import { spawn, type ChildProcess } from 'node:child_process'
import type { ChatTool } from './provider'

/**
 * MCP client: connects to servers the user configured and offers their tools to
 * the assistant alongside Panope's own.
 *
 * Everything these servers expose is treated as untrusted. Panope does not know
 * what a third-party tool does, so the session gates every external call at the
 * confirmation card rather than trusting a server's own read-only hints. Names
 * are namespaced so an external server can never shadow a Panope tool.
 *
 * Transports: stdio (newline-delimited JSON-RPC on a spawned process) and
 * streamable HTTP (JSON-RPC over POST), which covers what servers ship today.
 */

export interface McpServerConfig {
  name: string
  /** stdio: the program to run */
  command?: string
  args?: string[]
  /** http: the endpoint */
  url?: string
  headers?: Record<string, string>
}

export interface McpServerStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

const CALL_TIMEOUT_MS = 60_000
const INIT_TIMEOUT_MS = 20_000
const PROTOCOL_VERSION = '2025-06-18'
const MAX_LINE_BYTES = 8 * 1024 * 1024

/** Tool ids must survive both wire formats: [a-zA-Z0-9_-] only. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

export function externalToolName(server: string, tool: string): string {
  return `ext_${slug(server)}_${slug(tool)}`
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** One connected server. Owns its transport and its own request ids. */
class Connection {
  private seq = 0
  private pending = new Map<number, Pending>()
  private child?: ChildProcess
  private buf = ''
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []
  error?: string

  constructor(private cfg: McpServerConfig) {}

  private settle(id: number, err: Error | null, result?: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(result)
  }

  private failAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, new Error(reason))
  }

  private handleLine(line: string): void {
    const t = line.trim()
    if (!t) return
    let msg: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(t)
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return // notification from the server
    if (msg.error) this.settle(msg.id, new Error(msg.error.message ?? 'server error'))
    else this.settle(msg.id, null, msg.result)
  }

  private async rpc(method: string, params?: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.seq
    const body = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }

    if (this.cfg.url) {
      const res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.cfg.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) throw new Error(`${this.cfg.name} returned ${res.status}`)
      const text = await res.text()
      if (!text) return {}
      const msg = JSON.parse(text) as { result?: unknown; error?: { message?: string } }
      if (msg.error) throw new Error(msg.error.message ?? 'server error')
      return msg.result
    }

    const child = this.child
    if (!child?.stdin?.writable) throw new Error(`${this.cfg.name} is not running`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new Error(`${this.cfg.name}: ${method} timed out`)), timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin!.write(JSON.stringify(body) + '\n')
    })
  }

  private notify(method: string): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method }) + '\n'
    if (this.cfg.url) {
      void fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.headers ?? {}) },
        body
      }).catch(() => undefined)
      return
    }
    this.child?.stdin?.write(body)
  }

  async connect(): Promise<void> {
    if (this.cfg.command) {
      const env = { ...process.env }
      // Would make a spawned Electron binary run as plain node.
      delete env.ELECTRON_RUN_AS_NODE
      // No shell: the command and its args are passed through as given, so a
      // server name or argument cannot turn into shell syntax.
      const child = spawn(this.cfg.command, this.cfg.args ?? [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
      this.child = child
      child.on('error', (e) => {
        this.error = e.message
        this.failAll(`${this.cfg.name}: ${e.message}`)
      })
      child.on('exit', (code) => {
        this.error = this.error ?? `exited with code ${code}`
        this.failAll(`${this.cfg.name} exited`)
      })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        this.buf += chunk
        if (this.buf.length > MAX_LINE_BYTES) {
          this.buf = ''
          this.error = 'server sent an oversized message'
          return
        }
        let i: number
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i)
          this.buf = this.buf.slice(i + 1)
          this.handleLine(line)
        }
      })
      // stderr is where MCP servers log; keep the tail for the status line only.
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (c: string) => {
        if (!this.error && c.trim()) this.error = c.trim().slice(0, 200)
      })
    } else if (!this.cfg.url) {
      throw new Error('server needs either a command or a url')
    }

    await this.rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'panope', version: '1' }
      },
      INIT_TIMEOUT_MS
    )
    this.notify('notifications/initialized')

    const listed = (await this.rpc('tools/list', undefined, INIT_TIMEOUT_MS)) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>
    }
    this.tools = (listed?.tools ?? [])
      .filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } => !!t.name)
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} }
      }))
    // A successful listing clears any stderr noise captured during startup.
    this.error = undefined
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc('tools/call', { name: tool, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
    const text = (res?.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type ?? 'content'}]`))
      .join('\n')
    return res?.isError ? `Error: ${text}` : text || '(no output)'
  }

  close(): void {
    this.failAll('closed')
    try {
      this.child?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.child = undefined
  }
}

/** Holds the connections for one assistant session. */
export class McpClient {
  private conns = new Map<string, Connection>()
  /** external tool name -> where to send it */
  private route = new Map<string, { server: string; tool: string }>()

  /** Connect (or reconnect) to every configured server. Never throws. */
  async start(configs: McpServerConfig[]): Promise<void> {
    this.close()
    for (const cfg of configs) {
      if (!cfg.name?.trim()) continue
      const conn = new Connection(cfg)
      this.conns.set(cfg.name, conn)
      try {
        await conn.connect()
        for (const t of conn.tools) {
          this.route.set(externalToolName(cfg.name, t.name), { server: cfg.name, tool: t.name })
        }
      } catch (e) {
        conn.error = e instanceof Error ? e.message : String(e)
      }
    }
  }

  /** Tool definitions to hand the model, namespaced and labelled. */
  tools(): ChatTool[] {
    const out: ChatTool[] = []
    for (const [name, conn] of this.conns) {
      if (conn.error) continue
      for (const t of conn.tools) {
        out.push({
          name: externalToolName(name, t.name),
          description: `[external: ${name}] ${t.description}`.trim(),
          parameters: t.parameters
        })
      }
    }
    return out
  }

  isExternal(name: string): boolean {
    return this.route.has(name)
  }

  status(): McpServerStatus[] {
    return [...this.conns.entries()].map(([name, c]) => ({
      name,
      connected: !c.error,
      toolCount: c.error ? 0 : c.tools.length,
      error: c.error
    }))
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const target = this.route.get(name)
    if (!target) return `Error: unknown external tool ${name}`
    const conn = this.conns.get(target.server)
    if (!conn) return `Error: ${target.server} is not connected`
    try {
      return await conn.call(target.tool, args)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  close(): void {
    for (const c of this.conns.values()) c.close()
    this.conns.clear()
    this.route.clear()
  }
}
