import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Drives the locally installed Claude Code CLI headlessly, so the tokens bill
 * to the user's Claude subscription instead of API credits. Panope's tools
 * reach the model through the loopback MCP endpoint; Claude Code's own
 * built-in tools are disabled and the process runs in an empty directory, so
 * the only thing it can touch is what our MCP server offers.
 */

/** PATH first, then the usual install spots, newest first. */
export function findClaudeBinary(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const candidates: string[] = []
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir) candidates.push(join(dir, 'claude'))
  }
  const home = homedir()
  candidates.push(join(home, '.local/bin/claude'), join(home, '.claude/local/claude'))
  try {
    const ext = join(home, '.vscode/extensions')
    const dirs = readdirSync(ext)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
    for (const d of dirs) candidates.push(join(ext, d, 'resources/native-binary/claude'))
  } catch {
    /* no vscode */
  }
  try {
    const nvm = join(home, '.nvm/versions/node')
    const vers = readdirSync(nvm).sort().reverse()
    for (const v of vers) candidates.push(join(nvm, v, 'bin/claude'))
  } catch {
    /* no nvm */
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

// Belt and braces: -p mode denies unlisted tools anyway, and cwd is empty.
const BUILTIN_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit'

export interface ClaudeCodeRun {
  wait: Promise<{ sessionId?: string; error?: string }>
  kill(): void
}

export function runClaudeCode(opts: {
  binary: string
  prompt: string
  system: string
  model?: string
  resumeSessionId?: string
  mcpUrl: string
  mcpToken: string
  cwd: string
  onText: (t: string) => void
}): ClaudeCodeRun {
  // The config carries the MCP bearer token. Passed as an argv value it would
  // sit in /proc/<pid>/cmdline for any same-user process to read, so write it
  // to a 0600 file and hand the CLI the path instead. Removed when the run ends.
  const mcpConfigPath = join(opts.cwd, `.mcp-${randomBytes(6).toString('hex')}.json`)
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        panope: { type: 'http', url: opts.mcpUrl, headers: { Authorization: `Bearer ${opts.mcpToken}` } }
      }
    }),
    { mode: 0o600 }
  )
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    opts.system,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__panope__*',
    '--disallowedTools',
    BUILTIN_TOOLS,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : [])
  ]
  const env = { ...process.env }
  // This var makes any spawned Electron binary run as plain node; it also
  // confuses Claude Code's own process handling. Never inherit it.
  delete env.ELECTRON_RUN_AS_NODE
  // Mutations can sit at the confirmation card for a while.
  env.MCP_TIMEOUT = '600000'
  env.MCP_TOOL_TIMEOUT = '600000'

  const child = spawn(opts.binary, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

  const wait = new Promise<{ sessionId?: string; error?: string }>((resolve) => {
    let sessionId: string | undefined
    let resultError: string | undefined
    let buf = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev: {
          type?: string
          subtype?: string
          session_id?: string
          result?: string
          is_error?: boolean
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.session_id) sessionId = ev.session_id
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'text' && block.text) opts.onText(block.text)
          }
        } else if (ev.type === 'result' && ev.is_error) {
          resultError = ev.result || `claude exited with ${ev.subtype}`
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4096) stderr += c
    })
    child.on('error', (e) => {
      resolve({ error: `could not start claude: ${e.message}` })
    })
    child.on('close', (code) => {
      rmSync(mcpConfigPath, { force: true })
      if (resultError) resolve({ sessionId, error: resultError })
      else if (code !== 0) resolve({ sessionId, error: `claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}` })
      else resolve({ sessionId })
    })
  })

  return {
    wait,
    kill: () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
}
