import React, { useState } from 'react'
import { Icon } from './Icon'

/**
 * Markdown-lite for assistant replies: fenced code with a copy bar, inline
 * code, bold, and headings. Everything is built as React nodes - no HTML
 * injection surface, which matters because this text quotes cluster data.
 */

function CodeBlock({ lang, code }: { lang: string; code: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{lang || 'text'}</span>
        <button
          className="md-code__copy"
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-code__body">{code}</pre>
    </div>
  )
}

/** Inline pass: `code`, **bold**. Line pass: #-headings become strong lines. */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // split on inline code first so bold inside code is left alone
  const parts = text.split(/(`[^`\n]+`)/)
  parts.forEach((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(
        <code key={`${keyBase}-c${i}`} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      )
      return
    }
    const boldParts = part.split(/(\*\*[^*\n]+\*\*)/)
    boldParts.forEach((b, j) => {
      if (b.startsWith('**') && b.endsWith('**') && b.length > 4) {
        out.push(<strong key={`${keyBase}-b${i}-${j}`}>{b.slice(2, -2)}</strong>)
      } else if (b) {
        out.push(b)
      }
    })
  })
  return out
}

function textBlock(text: string, keyBase: string): React.ReactNode[] {
  return text.split('\n').flatMap((line, i) => {
    const nodes: React.ReactNode[] = []
    if (i > 0) nodes.push('\n')
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      nodes.push(
        <strong key={`${keyBase}-h${i}`} className="md-heading">
          {inline(h[2], `${keyBase}-h${i}`)}
        </strong>
      )
    } else {
      nodes.push(...inline(line, `${keyBase}-l${i}`))
    }
    return nodes
  })
}

function AssistantMarkdownImpl({ text }: { text: string }): React.ReactElement {
  const nodes: React.ReactNode[] = []
  const parts = text.split(/^```/m).length > 1 ? text.split('```') : [text]
  parts.forEach((part, i) => {
    if (i % 2) {
      const nl = part.indexOf('\n')
      const lang = nl > 0 ? part.slice(0, nl).trim() : ''
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '')
      nodes.push(<CodeBlock key={i} lang={lang} code={code} />)
    } else if (part) {
      nodes.push(<span key={i}>{textBlock(part, `t${i}`)}</span>)
    }
  })
  return <>{nodes}</>
}

// The transcript re-renders on every streamed token and on the 15s clock tick;
// memo keeps already-settled blocks from re-parsing their whole text each time.
export const AssistantMarkdown = React.memo(AssistantMarkdownImpl)
