import type {
  ExtensionAPI,
  ExtensionCommandContext
} from '@earendil-works/pi-coding-agent'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import {
  Container,
  Loader,
  Markdown,
  Spacer,
  Text
} from '@earendil-works/pi-tui'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHANGE_TYPES = ['auto', 'feat', 'fix', 'improve', 'internal'] as const
type ChangeType = (typeof CHANGE_TYPES)[number]

const CHANGE_TYPE_OPTIONS: Array<{ type: ChangeType; label: string }> = [
  {
    type: 'auto',
    label: 'auto - Let commit worker infer from session and diff'
  },
  { type: 'feat', label: 'feat - New user-facing capability' },
  { type: 'fix', label: 'fix - User-facing bug fix' },
  {
    type: 'improve',
    label: 'improve - User-facing refinement/performance/reliability'
  },
  {
    type: 'internal',
    label: 'internal - Infra/tooling/tests/refactor/deps/logging'
  }
]

const MESSAGE_TYPE = 'noice-changelog-commit-result'
const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'
const COMMIT_WORKER_WIDGET_KEY = 'noice-changelog-commit-worker'

type CommitDisplayStatus = 'ok' | 'cancelled' | 'failed'

interface CommitResultDetails {
  changeType?: ChangeType
  userContext?: string
  workerLeafId?: string | null
  status?: CommitDisplayStatus
}

let commitWorkerRunning = false
let agentEndWaiter: ((messages: unknown[]) => void) | undefined
let latestCommitWorkerMessages: unknown[] | undefined

export default function noiceChangelogExtension(pi: ExtensionAPI) {
  pi.on('agent_end', (event) => {
    if (commitWorkerRunning) {
      latestCommitWorkerMessages = event.messages
    }
    agentEndWaiter?.(event.messages)
    agentEndWaiter = undefined
  })

  pi.on('context', (event) => {
    return {
      messages: event.messages.filter((message) => {
        const customType = (message as { customType?: string }).customType
        if (customType === MESSAGE_TYPE) return false
        if (customType === PROMPT_MESSAGE_TYPE && !commitWorkerRunning)
          return false
        return true
      })
    }
  })

  async function sendResultAtSourceLeaf(
    ctx: ExtensionCommandContext,
    sourceLeafId: string | null | undefined,
    message: {
      customType: string
      content: string
      display: boolean
      details?: CommitResultDetails
    }
  ) {
    // `agent_end` fires before the session has fully left streaming mode. If we
    // send while streaming, pi treats this as steering/follow-up input instead
    // of appending a visible custom message, so it may only show on the next
    // user turn. Wait until idle before writing the result entry.
    if (!ctx.isIdle()) {
      await ctx.waitForIdle()
    }

    pi.sendMessage(message)

    // Keep the result attached to the source point, but leave the active leaf
    // at the original source so the next user message branches from there.
    const currentLeafId = ctx.sessionManager.getLeafId()
    if (sourceLeafId && currentLeafId && currentLeafId !== sourceLeafId) {
      await ctx.navigateTree(sourceLeafId, { summarize: false })
    }
  }

  pi.registerMessageRenderer<CommitResultDetails>(
    MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details
      const c = new Container()
      const displayStatus = getDisplayStatus(
        typeof message.content === 'string' ? message.content : '',
        details?.status
      )
      const statusLabel =
        displayStatus === 'cancelled'
          ? theme.fg('warning', 'cancelled')
          : displayStatus === 'failed'
            ? theme.fg('error', 'failed')
            : theme.fg('success', 'ok')

      c.addChild(
        new Text(
          `${statusLabel} ${theme.fg('toolTitle', theme.bold('commit'))}${details?.changeType ? ` ${theme.fg('accent', details.changeType)}` : ''}`,
          0,
          0
        )
      )

      if (details?.userContext) {
        c.addChild(
          new Text(theme.fg('dim', `Context: ${details.userContext}`), 0, 0)
        )
      }

      c.addChild(new Spacer(1))
      c.addChild(
        new Markdown(
          typeof message.content === 'string' ? message.content : '',
          0,
          0,
          getMarkdownTheme()
        )
      )

      if (details?.workerLeafId) {
        c.addChild(new Spacer(1))
        c.addChild(
          new Text(
            theme.fg('dim', `Worker branch: ${details.workerLeafId}`),
            0,
            0
          )
        )
      }

      return c
    }
  )

  pi.registerCommand('commit', {
    description:
      'Commit changes and create/update PR. Usage: /commit <changeType> <what was done>',
    getArgumentCompletions: getCommitArgumentCompletions,
    handler: async (args, ctx) => {
      if (commitWorkerRunning) {
        ctx.ui.notify('Commit worker is already running', 'warning')
        return
      }

      await ctx.waitForIdle()

      const parsed = await resolveChangeTypeAndContext(args, ctx)
      if (!parsed) {
        return
      }

      const startLeafId = ctx.sessionManager.getLeafId()
      const prompt = await buildWorkerPrompt(parsed.changeType, parsed.context)
      const previousThinkingLevel = pi.getThinkingLevel()

      commitWorkerRunning = true

      try {
        showCommitWorkerIndicator(ctx)
        ctx.ui.notify(`Starting commit worker (${parsed.changeType})`, 'info')
        pi.setThinkingLevel('low')

        const agentEnd = waitForNextAgentEndAfterIdle(ctx)
        latestCommitWorkerMessages = undefined
        pi.sendMessage(
          {
            customType: PROMPT_MESSAGE_TYPE,
            content: prompt,
            display: false,
            details: {
              changeType: parsed.changeType,
              userContext: parsed.context
            }
          },
          { triggerTurn: true, deliverAs: 'followUp' }
        )
        const messages = await agentEnd

        const workerLeafId = ctx.sessionManager.getLeafId()
        const workerPromptIndex = findLastCustomMessageIndex(
          messages,
          PROMPT_MESSAGE_TYPE
        )
        const summary =
          workerPromptIndex >= 0
            ? extractLastAssistantText(messages, workerPromptIndex)
            : ''
        const assistantError =
          workerPromptIndex >= 0
            ? extractLastAssistantError(messages, workerPromptIndex)
            : undefined

        if (assistantError) {
          if (startLeafId && workerLeafId && workerLeafId !== startLeafId) {
            await ctx.navigateTree(startLeafId, { summarize: false })
          }
          await sendResultAtSourceLeaf(ctx, startLeafId, {
            customType: MESSAGE_TYPE,
            content: formatWorkerErrorResult(assistantError, summary),
            display: true,
            details: {
              changeType: parsed.changeType,
              userContext: parsed.context,
              workerLeafId,
              status: 'failed'
            }
          })
          ctx.ui.notify(`Commit worker failed:\n${assistantError}`, 'error')
          return
        }

        if (!summary) {
          if (startLeafId && workerLeafId && workerLeafId !== startLeafId) {
            await ctx.navigateTree(startLeafId, { summarize: false })
          }
          await sendResultAtSourceLeaf(ctx, startLeafId, {
            customType: MESSAGE_TYPE,
            content:
              'status: cancelled\nnotes: Commit command was cancelled before the worker produced a result.',
            display: true,
            details: {
              changeType: parsed.changeType,
              userContext: parsed.context,
              workerLeafId,
              status: 'cancelled'
            }
          })
          ctx.ui.notify('Commit command cancelled', 'warning')
          return
        }

        if (startLeafId && workerLeafId && workerLeafId !== startLeafId) {
          const nav = await ctx.navigateTree(startLeafId, { summarize: false })
          if (nav.cancelled) {
            pi.sendMessage({
              customType: MESSAGE_TYPE,
              content:
                'status: cancelled\nnotes: Commit worker finished, but returning to the original branch was cancelled.',
              display: true,
              details: {
                changeType: parsed.changeType,
                userContext: parsed.context,
                workerLeafId,
                status: 'cancelled'
              }
            })
            ctx.ui.notify(
              'Commit finished, but tree navigation was cancelled',
              'warning'
            )
            return
          }
        }

        const displayStatus = getDisplayStatus(summary)
        await sendResultAtSourceLeaf(ctx, startLeafId, {
          customType: MESSAGE_TYPE,
          content: summary,
          display: true,
          details: {
            changeType: parsed.changeType,
            userContext: parsed.context,
            workerLeafId,
            status: displayStatus
          }
        })
        ctx.ui.notify(
          formatCommitNotification(summary, displayStatus),
          displayStatus === 'failed'
            ? 'error'
            : displayStatus === 'cancelled'
              ? 'warning'
              : 'info'
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (startLeafId)
          await ctx.navigateTree(startLeafId, { summarize: false })
        await sendResultAtSourceLeaf(ctx, startLeafId, {
          customType: MESSAGE_TYPE,
          content: `Commit worker failed: ${message}`,
          display: true,
          details: {
            changeType: parsed.changeType,
            userContext: parsed.context,
            status: 'failed'
          }
        })
        ctx.ui.notify(`Commit worker failed:\n${message}`, 'error')
      } finally {
        pi.setThinkingLevel(previousThinkingLevel)
        ctx.ui.setWidget(COMMIT_WORKER_WIDGET_KEY, undefined)
        commitWorkerRunning = false
        latestCommitWorkerMessages = undefined
      }
    }
  })
}

function showCommitWorkerIndicator(ctx: ExtensionCommandContext) {
  const message = 'Commit worker running on a side branch of this session…'

  if (ctx.mode !== 'tui') {
    ctx.ui.setWidget(COMMIT_WORKER_WIDGET_KEY, [message])
    return
  }

  ctx.ui.setWidget(COMMIT_WORKER_WIDGET_KEY, (tui, theme) => {
    const loader = new Loader(
      tui,
      (text) => theme.fg('warning', text),
      (text) => theme.fg('warning', text),
      message
    )

    return {
      render: (width: number) => loader.render(width),
      invalidate: () => loader.invalidate(),
      dispose: () => loader.stop()
    }
  })
}

function getCommitArgumentCompletions(prefix: string) {
  const trimmedStart = prefix.trimStart()
  const leadingWhitespace = prefix.slice(0, prefix.length - trimmedStart.length)
  const [firstWord = ''] = trimmedStart.split(/\s+/)
  const isTypingDescription = /^\S+\s/.test(trimmedStart)

  if (!isTypingDescription) {
    const matches = CHANGE_TYPE_OPTIONS.filter((option) =>
      option.type.startsWith(firstWord)
    )
    return matches.length > 0
      ? matches.map((option) => ({
          value: `${leadingWhitespace}${option.type} `,
          label: option.label
        }))
      : null
  }

  if (!isChangeType(firstWord)) return null

  const whatWasDone = trimmedStart.slice(firstWord.length).trim()
  return [
    {
      value: prefix,
      label: whatWasDone
        ? `What was done: "${whatWasDone}"`
        : 'Say what was done — rough wording is fine; leave blank to infer from session/diff'
    }
  ]
}

async function resolveChangeTypeAndContext(
  args: string | undefined,
  ctx: ExtensionCommandContext
): Promise<{ changeType: ChangeType; context: string } | null> {
  const trimmedArgs = args?.trim() ?? ''
  const [firstWord = '', ...rest] = trimmedArgs.split(/\s+/)

  if (isChangeType(firstWord)) {
    return { changeType: firstWord, context: rest.join(' ').trim() }
  }

  const selected = await ctx.ui.select(
    'Change type',
    CHANGE_TYPE_OPTIONS.map((option) => option.label)
  )
  if (!selected) return null

  const option = CHANGE_TYPE_OPTIONS.find((item) =>
    selected.startsWith(item.type)
  )
  if (!option) return null

  return { changeType: option.type, context: trimmedArgs }
}

function isChangeType(value: string): value is ChangeType {
  return CHANGE_TYPES.includes(value as ChangeType)
}

async function buildWorkerPrompt(changeType: ChangeType, userContext: string) {
  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const [template, rules] = await Promise.all([
    readFile(join(extensionDir, 'worker-prompt.md'), 'utf-8'),
    readFile(join(extensionDir, 'rules.md'), 'utf-8')
  ])

  return template
    .replaceAll('{{changeType}}', changeType)
    .replaceAll('{{userContext}}', userContext || '(none)')
    .replaceAll('{{rules}}', rules)
}

function waitForNextAgentEndAfterIdle(ctx: ExtensionCommandContext) {
  return new Promise<unknown[]>((resolve) => {
    agentEndWaiter = (messages) => {
      void (async () => {
        // `agent_end` also fires for transient provider failures that Pi may
        // auto-retry. Wait until the whole agent run is idle, then use the
        // latest worker messages captured by the global `agent_end` listener.
        if (!ctx.isIdle()) {
          await ctx.waitForIdle()
        }
        resolve(latestCommitWorkerMessages ?? messages)
      })()
    }
  })
}

function getDisplayStatus(
  content: string,
  explicit?: CommitDisplayStatus
): CommitDisplayStatus {
  if (explicit) return explicit

  const firstStatus = content.match(/^status:\s*(\S+)/im)?.[1]?.toLowerCase()
  if (firstStatus === 'failed') return 'failed'
  if (firstStatus === 'cancelled' || firstStatus === 'canceled') {
    return 'cancelled'
  }

  return 'ok'
}

function formatWorkerErrorResult(error: string, partialSummary: string) {
  const partial = partialSummary.trim()
  return [
    'status: failed',
    `notes: Commit worker errored${partial ? ' after a partial response' : ' before producing a result'}.`,
    `error: ${error}`,
    partial ? `\nPartial response:\n${partial}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function formatCommitNotification(
  summary: string,
  status: CommitDisplayStatus
): string {
  const title =
    status === 'failed'
      ? 'Commit worker failed'
      : status === 'cancelled'
        ? 'Commit command cancelled'
        : 'Commit worker finished'
  const trimmedSummary = summary.trim()
  return trimmedSummary ? `${title}:\n${trimmedSummary}` : title
}

function findLastCustomMessageIndex(messages: unknown[], customType: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { customType?: string }
    if (message.customType === customType) return index
  }

  return -1
}

function extractLastAssistantText(messages: unknown[], afterIndex = -1) {
  const message = findLastAssistantMessage(messages, afterIndex)
  return message ? extractTextFromContent(message.content).trim() : ''
}

function extractLastAssistantError(messages: unknown[], afterIndex = -1) {
  const message = findLastAssistantMessage(messages, afterIndex)
  if (message?.stopReason !== 'error') return undefined

  return message.errorMessage?.trim() || 'Unknown provider error'
}

function findLastAssistantMessage(messages: unknown[], afterIndex = -1) {
  for (let index = messages.length - 1; index > afterIndex; index--) {
    const message = messages[index] as {
      role?: string
      content?: unknown
      stopReason?: string
      errorMessage?: string
    }
    if (message.role === 'assistant') return message
  }

  return undefined
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
