import { completeSimple } from '@earendil-works/pi-ai/compat'
import type {
  ExtensionAPI,
  ExtensionCommandContext
} from '@earendil-works/pi-coding-agent'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHANGE_TYPES,
  executeCommitWorkflow,
  WorkflowFailure,
  type ChangeType,
  type ProseInput,
  type WorkflowResult
} from './commit-workflow.ts'

const CHANGE_TYPE_OPTIONS: Array<{ type: ChangeType; label: string }> = [
  { type: 'auto', label: 'auto - Infer from the description and diff' },
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
const COMMIT_WIDGET_KEY = 'noice-changelog-commit-worker'
type CommitDisplayStatus = 'ok' | 'cancelled' | 'failed'

interface CommitResultDetails {
  changeType?: ChangeType
  userContext?: string
  status?: CommitDisplayStatus
}

let commitCommandPending = false
let commitWorkflowRunning = false

export default function noiceChangelogExtension(pi: ExtensionAPI) {
  pi.on('context', (event) => ({
    messages: event.messages.filter(
      (message) =>
        (message as { customType?: string }).customType !== MESSAGE_TYPE
    )
  }))

  pi.registerMessageRenderer<CommitResultDetails>(
    MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details
      const content = typeof message.content === 'string' ? message.content : ''
      const displayStatus = getDisplayStatus(content, details?.status)
      const statusLabel =
        displayStatus === 'cancelled'
          ? theme.fg('warning', 'cancelled')
          : displayStatus === 'failed'
            ? theme.fg('error', 'failed')
            : theme.fg('success', 'ok')
      const container = new Container()
      container.addChild(
        new Text(
          `${statusLabel} ${theme.fg('toolTitle', theme.bold('commit'))}${details?.changeType ? ` ${theme.fg('accent', details.changeType)}` : ''}`,
          0,
          0
        )
      )
      if (details?.userContext) {
        container.addChild(
          new Text(theme.fg('dim', `Context: ${details.userContext}`), 0, 0)
        )
      }
      container.addChild(new Spacer(1))
      container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()))
      return container
    }
  )

  pi.registerCommand('commit', {
    description:
      'Commit changes and create/update PR. Usage: /commit <changeType> <what was done>',
    getArgumentCompletions: getCommitArgumentCompletions,
    handler: async (args, ctx) => {
      if (commitCommandPending || commitWorkflowRunning) {
        ctx.ui.notify('Commit command is already active', 'warning')
        return
      }

      commitCommandPending = true
      let parsed: { changeType: ChangeType; context: string } | null
      try {
        parsed = await resolveChangeTypeAndContext(args, ctx)
        if (!parsed) return
        if (!ctx.isIdle()) {
          ctx.ui.notify(
            'Commit queued; waiting for the current agent turn to finish',
            'info'
          )
        }
        await ctx.waitForIdle()
        // Keep the pending guard through every asynchronous startup step. This
        // prevents a duplicate invocation from entering before the running
        // guard becomes visible.
        commitWorkflowRunning = true
      } finally {
        commitCommandPending = false
      }
      if (!parsed) return

      showCommitBanner(ctx)
      ctx.ui.notify(`Starting commit workflow (${parsed.changeType})`, 'info')
      try {
        const workflow = await executeCommitWorkflow(
          { cwd: ctx.cwd, exec: pi.exec.bind(pi) },
          parsed.changeType,
          parsed.context,
          {
            generateProse: (input) => generateProse(pi, ctx, input)
          }
        )
        const summary = formatWorkflowResult(workflow)
        await sendResult(ctx, pi, summary, {
          changeType: parsed.changeType,
          userContext: parsed.context,
          status: workflow.status === 'failed' ? 'failed' : 'ok'
        })
        ctx.ui.notify(formatCommitNotification(summary, 'ok'), 'info')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const summary = formatWorkflowResult(
          error instanceof WorkflowFailure
            ? error.workflow
            : {
                status: 'failed',
                commit: null,
                pr: null,
                verification: 'Not run',
                notes: [message]
              }
        )
        await sendResult(ctx, pi, summary, {
          changeType: parsed.changeType,
          userContext: parsed.context,
          status: 'failed'
        })
        ctx.ui.notify(`Commit workflow failed:\n${message}`, 'error')
      } finally {
        ctx.ui.setWidget(COMMIT_WIDGET_KEY, undefined)
        commitWorkflowRunning = false
      }
    }
  })
}

export async function generateProse(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: ProseInput
) {
  if (!ctx.model) throw new Error('/commit requires an active model')
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
  if (!auth.ok) throw new Error(auth.error)

  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const [template, rules] = await Promise.all([
    readFile(join(extensionDir, 'prose-prompt.md'), 'utf8'),
    readFile(join(extensionDir, 'rules.md'), 'utf8')
  ])
  const prompt = template
    .replace('{{rules}}', rules)
    .replace('{{input}}', JSON.stringify(input, null, 2))
  const thinkingLevel = pi.getThinkingLevel()
  const response = await completeSimple(
    ctx.model,
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          timestamp: Date.now()
        }
      ]
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel
    }
  )
  if (response.stopReason !== 'stop') {
    const detail =
      response.stopReason === 'error' && response.errorMessage
        ? `: ${response.errorMessage}`
        : ''
    throw new Error(
      `The model did not finish generating commit prose (stopReason: ${response.stopReason})${detail}`
    )
  }
  const text = extractText(response.content).trim()
  if (!text) throw new Error('The model returned no commit prose')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('The model response was not strict JSON')
  }
}

async function sendResult(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  content: string,
  details: CommitResultDetails
) {
  if (!ctx.isIdle()) await ctx.waitForIdle()
  pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, details })
}

function showCommitBanner(ctx: ExtensionCommandContext) {
  const message = 'Commit workflow running deterministically…'
  if (ctx.mode !== 'tui') {
    ctx.ui.setWidget(COMMIT_WIDGET_KEY, [message])
    return
  }
  ctx.ui.setWidget(
    COMMIT_WIDGET_KEY,
    (_tui, theme) => new Text(theme.fg('warning', message), 1, 0)
  )
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
    return matches.length
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
        : 'Say what was done — rough wording is fine; leave blank to infer from the diff'
    }
  ]
}

async function resolveChangeTypeAndContext(
  args: string | undefined,
  ctx: ExtensionCommandContext
) {
  const trimmedArgs = args?.trim() ?? ''
  const [firstWord = '', ...rest] = trimmedArgs.split(/\s+/)
  if (isChangeType(firstWord))
    return { changeType: firstWord, context: rest.join(' ').trim() }

  const selected = await ctx.ui.select(
    'Change type',
    CHANGE_TYPE_OPTIONS.map((option) => option.label)
  )
  if (!selected) return null
  const option = CHANGE_TYPE_OPTIONS.find((item) =>
    selected.startsWith(item.type)
  )
  return option ? { changeType: option.type, context: trimmedArgs } : null
}

function isChangeType(value: string): value is ChangeType {
  return CHANGE_TYPES.includes(value as ChangeType)
}

export function formatWorkflowResult(workflow: WorkflowResult) {
  const pr = workflow.pr
    ? `#${workflow.pr.number} ${workflow.pr.title} ${workflow.pr.url}`
    : 'none'
  return [
    `status: ${workflow.status}`,
    `commit: ${workflow.commit ?? 'none'}`,
    `pr: ${pr}`,
    `verification: ${workflow.verification}`,
    `notes: ${workflow.notes.length ? workflow.notes.join('; ') : 'none'}`
  ].join('\n')
}

function getDisplayStatus(
  content: string,
  explicit?: CommitDisplayStatus
): CommitDisplayStatus {
  if (explicit) return explicit
  const firstStatus = content.match(/^status:\s*(\S+)/im)?.[1]?.toLowerCase()
  if (firstStatus === 'failed') return 'failed'
  if (firstStatus === 'cancelled' || firstStatus === 'canceled')
    return 'cancelled'
  return 'ok'
}

function formatCommitNotification(
  summary: string,
  status: CommitDisplayStatus
) {
  const title =
    status === 'failed'
      ? 'Commit workflow failed'
      : status === 'cancelled'
        ? 'Commit command cancelled'
        : 'Commit workflow finished'
  return summary.trim() ? `${title}:\n${summary.trim()}` : title
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : ''
    )
    .filter(Boolean)
    .join('\n')
}
