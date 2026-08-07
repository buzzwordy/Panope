import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiConfig, AiUiContext, McpServerSpec, McpServerState } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { AssistantMarkdown } from './AssistantMarkdown'
import {
  assistantClear,
  assistantSend,
  assistantSnapshot,
  assistantStop,
  subscribeAssistant
} from '../state/assistant'

interface Props {
  uiCtx: AiUiContext
  onClose: () => void
}

export function AssistantPanel({ uiCtx, onClose }: Props): React.ReactElement {
  const { blocks, busy } = useSyncExternalStore(subscribeAssistant, assistantSnapshot)
  const [input, setInput] = useState('')
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // settings form
  const [provider, setProvider] = useState<'anthropic' | 'openai' | 'claude-code'>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [servers, setServers] = useState<McpServerSpec[]>([])
  const [mcpState, setMcpState] = useState<McpServerState[]>([])
  const [unrestricted, setUnrestricted] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])
  const [newServer, setNewServer] = useState({ name: '', command: '', url: '' })
  const [models, setModels] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsErr, setModelsErr] = useState('')

  const ready = !!config && (config.provider === 'claude-code' || !!config.model)
  // The open object rides along with the next question unless dismissed;
  // opening a different object re-attaches automatically.
  const [detached, setDetached] = useState(false)
  useEffect(() => setDetached(false), [uiCtx.kind, uiCtx.name, uiCtx.objNamespace])
  const scrollRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef(uiCtx)
  ctxRef.current = uiCtx

  useEffect(() => {
    void api.aiGetConfig().then((c) => {
      setConfig(c)
      if (c) {
        setProvider(c.provider)
        setBaseUrl(c.baseUrl ?? '')
        setModel(c.model)
        setServers(c.mcpServers ?? [])
        setUnrestricted(c.unrestricted === true)
        setAllowed(c.allowedExternalTools ?? [])
      }
      if (!c || (c.provider !== 'claude-code' && !c.model)) setShowSettings(true)
    })
  }, [])

  // follow the stream only while the user is already at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [blocks])

  // refresh external-server connection state whenever the settings pane opens
  useEffect(() => {
    if (!showSettings) return
    void api.aiMcpStatus().then(setMcpState).catch(() => undefined)
  }, [showSettings])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const ctx = ctxRef.current
    assistantSend(text, detached ? { ...ctx, kind: undefined, name: undefined, objNamespace: undefined } : ctx)
  }, [input, busy, detached])

  // the card flips to Approved/Declined when main confirms it actually settled
  const confirm = (id: string, approve: boolean, alwaysTool?: string): void => {
    void api.aiConfirm(id, approve, alwaysTool)
  }

  const saveSettings = (): void => {
    void api
      .aiSetConfig({
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        mcpServers: servers,
        unrestricted,
        allowedExternalTools: allowed
      })
      .then(() => api.aiGetConfig())
      .then((c) => {
        setConfig(c)
        setApiKey('')
        setShowSettings(false)
      })
  }

  return (
    <aside className="assistant">
      <div className="assistant__header">
        <Icon name="sparkles" size={15} />
        <span className="assistant__title">Assistant</span>
        {config?.model && <span className="assistant__model">{config.model}</span>}
        <span className="spacer" />
        <button
          className={`icon-btn${showSettings ? ' is-active' : ''}`}
          title={showSettings ? 'Close settings' : 'Settings'}
          onClick={() => setShowSettings((v) => !v)}
        >
          <Icon name="sliders" size={14} />
        </button>
        <button
          className="icon-btn"
          title="Clear conversation"
          onClick={assistantClear}
        >
          <Icon name="trash" size={14} />
        </button>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {showSettings && (
        <div className="assistant__settings">
          <div className="assistant__settings-head">
            <Icon name="sliders" size={14} />
            <span>Settings</span>
            <span className="spacer" />
            <button className="btn btn--primary btn--xs" onClick={saveSettings} disabled={provider !== 'claude-code' && !model.trim()}>
              Save
            </button>
            <button className="icon-btn" title="Close settings" onClick={() => setShowSettings(false)}>
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="assistant__settings-body">
          <div className="field">
            <label>Provider</label>
            <select
              className="input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as 'anthropic' | 'openai' | 'claude-code')
                setModels([])
                setModelsErr('')
              }}
            >
              <option value="claude-code">Claude Code (your claude login, plan billing)</option>
              <option value="openai">OpenAI-compatible (Ollama, vLLM, OpenRouter, OpenAI...)</option>
              <option value="anthropic">Anthropic API (key + credits)</option>
            </select>
          </div>
          {provider === 'openai' && (
            <div className="field">
              <label>Base URL</label>
              <input
                className="input"
                placeholder="http://localhost:11434/v1 (empty = api.openai.com)"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
          )}
          {provider === 'claude-code' && (
            <div className="field">
              <label>claude binary (optional)</label>
              <input
                className="input"
                placeholder="found automatically when empty"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
          )}
          <div className="field">
            <label>Model{provider === 'claude-code' ? ' (optional)' : ''}</label>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                list="assistant-models"
                placeholder={
                  provider === 'anthropic'
                    ? 'claude-sonnet-5'
                    : provider === 'claude-code'
                      ? 'empty = your claude default (or: sonnet, opus, haiku)'
                      : 'qwen3:14b, gpt-5.2, ...'
                }
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <button
                className="btn btn--secondary btn--xs"
                title="Fetch the model list from the endpoint"
                disabled={modelsBusy}
                onClick={() => {
                  setModelsBusy(true)
                  setModelsErr('')
                  void api
                    .aiListModels({ provider, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
                    .then((list) => {
                      setModels(list)
                      if (!list.length) setModelsErr('endpoint returned no models')
                    })
                    .catch((e: Error) => setModelsErr(e.message))
                    .finally(() => setModelsBusy(false))
                }}
              >
                {modelsBusy ? '...' : 'Load'}
              </button>
            </div>
            <datalist id="assistant-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {models.length > 0 && (
              <select
                className="input"
                value={models.includes(model) ? model : ''}
                onChange={(e) => e.target.value && setModel(e.target.value)}
              >
                <option value="">pick from {models.length} models...</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {modelsErr && <span className="confirm-text">{modelsErr}</span>}
          </div>
          {provider !== 'claude-code' && (
            <div className="field">
              <label>API key {config?.hasKey ? '(stored - leave empty to keep)' : ''}</label>
              <input
                className="input"
                type="password"
                placeholder={config?.hasKey ? 'unchanged' : 'not needed for local endpoints'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}
          <div className="field">
            <label>External tools (MCP)</label>
            {servers.length === 0 && (
              <span className="confirm-text">
                None. Add an MCP server to give the assistant tools beyond Panope. Every external call
                stops at a confirmation card.
              </span>
            )}
            {servers.map((sv) => {
              const st = mcpState.find((x) => x.name === sv.name)
              return (
                <div key={sv.name} className="assistant__server">
                  <span className={`assistant__dot${st ? (st.connected ? ' is-ok' : ' is-bad') : ''}`} />
                  <span className="assistant__server-name">{sv.name}</span>
                  <span className="confirm-text">
                    {st ? (st.connected ? `${st.toolCount} tools` : (st.error ?? 'not connected')) : sv.command || sv.url}
                  </span>
                  <button
                    className="icon-btn"
                    title="Remove"
                    onClick={() => setServers((v) => v.filter((x) => x.name !== sv.name))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )
            })}
            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
              <input
                className="input"
                style={{ flex: '0 0 30%' }}
                placeholder="name"
                value={newServer.name}
                onChange={(e) => setNewServer((v) => ({ ...v, name: e.target.value }))}
              />
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="command, or https:// url"
                value={newServer.command}
                onChange={(e) => setNewServer((v) => ({ ...v, command: e.target.value }))}
              />
              <button
                className="btn btn--secondary btn--xs"
                disabled={!newServer.name.trim() || !newServer.command.trim()}
                onClick={() => {
                  const name = newServer.name.trim()
                  const raw = newServer.command.trim()
                  const isUrl = /^https?:\/\//i.test(raw)
                  // "npx -y pkg" is the shape every MCP readme uses, so split it
                  const parts = raw.split(/\s+/)
                  setServers((v) => [
                    ...v.filter((x) => x.name !== name),
                    isUrl ? { name, url: raw } : { name, command: parts[0], args: parts.slice(1) }
                  ])
                  setNewServer({ name: '', command: '', url: '' })
                }}
              >
                Add
              </button>
            </div>
            <span className="confirm-text">
              Tools appear as {'ext_<server>_<tool>'} and are namespaced, so an external server cannot
              shadow a Panope tool.
            </span>
          </div>
          {allowed.length > 0 && (
            <div className="field">
              <label>Tools you stopped being asked about</label>
              {allowed.map((t) => (
                <div key={t} className="assistant__server">
                  <span className="assistant__server-name">{t}</span>
                  <button
                    className="icon-btn"
                    title="Ask me again for this tool"
                    onClick={() => setAllowed((v) => v.filter((x) => x !== t))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              <span className="confirm-text">Removing one brings its confirmation card back.</span>
            </div>
          )}
          {provider === 'claude-code' && (
            <div className="field">
              <label>Unrestricted mode</label>
              <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                <button
                  className={`btn ${unrestricted ? 'btn--danger' : 'btn--secondary'}`}
                  onClick={() => setUnrestricted((v) => !v)}
                >
                  <Icon name={unrestricted ? 'unlock' : 'lock'} size={13} />
                  {unrestricted ? 'Shell and files: ON' : 'Shell and files: OFF'}
                </button>
              </div>
              <span className="confirm-text">
                Lets Claude Code use its own shell, file and web tools, so it can run kubectl, git or
                anything else on this machine. Those calls happen inside the CLI, so they do <b>not</b>{' '}
                stop at a confirmation card and do <b>not</b> appear in the audit log. Leave off unless
                you want that.
              </span>
            </div>
          )}
          <span className="confirm-text">
            {provider === 'claude-code'
              ? 'Uses your logged-in Claude Code CLI, so usage bills to your Claude plan. No key is stored. Reads run with your kubeconfig identity; anything that changes the cluster stops at a confirmation card here first.'
              : 'The key is stored on this machine and used only from the main process. Reads run with your kubeconfig identity; anything that changes the cluster stops at a confirmation card here first.'}
          </span>
          </div>
        </div>
      )}

      <div className="assistant__scroll" ref={scrollRef} style={{ display: showSettings ? 'none' : undefined }}>
        {blocks.length === 0 && !showSettings && (
          <div className="assistant__empty">
            Ask about anything in this cluster: "why is this pod crashlooping", "what changed in the last
            hour", "scale the api deployment down". Actions wait for your approval.
          </div>
        )}
        {blocks.map((b, i) => {
          const prev = blocks[i - 1]
          switch (b.kind) {
            case 'user':
              return (
                <div key={i} className="assistant__row">
                  <div className="assistant__author">
                    <Icon name="sa" size={13} /> You
                  </div>
                  <button
                    className="assistant__copy"
                    title="Copy message"
                    onClick={() => void navigator.clipboard.writeText(b.text)}
                  >
                    <Icon name="copy" size={11} /> Copy
                  </button>
                  <div className="assistant__msg assistant__msg--user">{b.text}</div>
                </div>
              )
            case 'text':
              return (
                <div key={i} className="assistant__row">
                  {prev?.kind !== 'text' && prev?.kind !== 'tool' && prev?.kind !== 'confirm' && (
                    <div className="assistant__author">
                      <Icon name="sparkles" size={13} /> Assistant
                    </div>
                  )}
                  <button
                    className="assistant__copy"
                    title="Copy message"
                    onClick={() => void navigator.clipboard.writeText(b.text)}
                  >
                    <Icon name="copy" size={11} /> Copy
                  </button>
                  <div className="assistant__msg">
                    <AssistantMarkdown text={b.text} />
                  </div>
                </div>
              )
            case 'tool':
              return (
                <div key={i} className="assistant__step" title={b.name}>
                  <Icon name="check" size={12} />
                  <span>{b.summary}</span>
                </div>
              )
            case 'confirm':
              return (
                <div
                  key={i}
                  className={`assistant__confirm${b.resolved ? ' is-resolved' : ''}${b.external ? ' is-external' : ''}`}
                >
                  <div className="assistant__confirm-head">
                    <Icon name={b.external ? 'layers' : 'unlock'} size={13} />
                    <span>{b.summary}</span>
                    {b.external && <span className="assistant__extbadge">external tool</span>}
                  </div>
                  <pre className="assistant__code">{JSON.stringify(b.args, null, 2)}</pre>
                  {b.external && !b.resolved && (
                    <span className="confirm-text">
                      Not a Panope tool. It runs outside the cluster and Panope cannot check what it does.
                    </span>
                  )}
                  {b.resolved ? (
                    <span className="confirm-text">{b.resolved === 'yes' ? 'Approved' : 'Declined'}</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                      <button
                        className={`btn btn--xs ${b.name === 'delete_resource' || b.name === 'apply_yaml' ? 'btn--danger' : 'btn--primary'}`}
                        onClick={() => confirm(b.id, true)}
                      >
                        Run it
                      </button>
                      {b.external && (
                        <button
                          className="btn btn--secondary btn--xs"
                          title="Run it and stop asking about this tool"
                          onClick={() => confirm(b.id, true, b.name)}
                        >
                          Always allow
                        </button>
                      )}
                      <button className="btn btn--secondary btn--xs" onClick={() => confirm(b.id, false)}>
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              )
            case 'error':
              return (
                <div key={i} className="assistant__msg assistant__msg--error">
                  {b.text}
                </div>
              )
          }
        })}
        {busy && <div className="assistant__busy">working...</div>}
      </div>

      {uiCtx.kind && uiCtx.name && !detached && !showSettings && (
        <div className="assistant__ctxchip" title="This object is included with your next question">
          <Icon name="box" size={12} />
          <span className="assistant__ctxchip-text">
            {uiCtx.kind} {uiCtx.objNamespace ? `${uiCtx.objNamespace}/` : ''}
            {uiCtx.name}
          </span>
          <button className="icon-btn" title="Ask without this object" onClick={() => setDetached(true)}>
            <Icon name="close" size={11} />
          </button>
        </div>
      )}
      <div className="assistant__inputrow" style={{ display: showSettings ? 'none' : undefined }}>
        <textarea
          className="assistant__input"
          rows={2}
          placeholder={ready ? 'Ask about this cluster...' : 'Configure a model first (settings icon above)'}
          value={input}
          disabled={!ready}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !busy) {
              e.preventDefault()
              send()
            }
          }}
        />
        {busy ? (
          <button
            className="btn btn--secondary"
            title="Stop"
            onClick={assistantStop}
          >
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" title="Send" onClick={send} disabled={!input.trim() || !ready}>
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </div>
    </aside>
  )
}
