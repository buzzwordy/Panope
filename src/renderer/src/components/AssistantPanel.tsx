import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AiConfig, AiUiContext } from '@shared/types'
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
  const [models, setModels] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsErr, setModelsErr] = useState('')

  const ready = !!config && (config.provider === 'claude-code' || !!config.model)
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

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    assistantSend(text, ctxRef.current)
  }, [input, busy])

  // the card flips to Approved/Declined when main confirms it actually settled
  const confirm = (id: string, approve: boolean): void => {
    void api.aiConfirm(id, approve)
  }

  const saveSettings = (): void => {
    void api
      .aiSetConfig({ provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() || undefined })
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
        <button className="icon-btn" title="Model settings" onClick={() => setShowSettings((v) => !v)}>
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
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <button
              className="btn btn--primary btn--xs"
              onClick={saveSettings}
              disabled={provider !== 'claude-code' && !model.trim()}
            >
              Save
            </button>
            <button className="btn btn--secondary btn--xs" onClick={() => setShowSettings(false)}>
              Cancel
            </button>
          </div>
          <span className="confirm-text">
            {provider === 'claude-code'
              ? 'Uses your logged-in Claude Code CLI, so usage bills to your Claude plan. No key is stored. Reads run with your kubeconfig identity; anything that changes the cluster stops at a confirmation card here first.'
              : 'The key is stored on this machine and used only from the main process. Reads run with your kubeconfig identity; anything that changes the cluster stops at a confirmation card here first.'}
          </span>
        </div>
      )}

      <div className="assistant__scroll" ref={scrollRef}>
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
                <div key={i} className={`assistant__confirm${b.resolved ? ' is-resolved' : ''}`}>
                  <div className="assistant__confirm-head">
                    <Icon name="unlock" size={13} />
                    <span>{b.summary}</span>
                  </div>
                  <pre className="assistant__code">{JSON.stringify(b.args, null, 2)}</pre>
                  {b.resolved ? (
                    <span className="confirm-text">{b.resolved === 'yes' ? 'Approved' : 'Declined'}</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                      <button
                        className={`btn btn--xs ${b.name === 'delete_resource' || b.name === 'apply_yaml' ? 'btn--danger' : 'btn--primary'}`}
                        onClick={() => confirm(b.id, true)}
                      >
                        Run it
                      </button>
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

      <div className="assistant__inputrow">
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
