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
  type CommitMode,
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
const PROSE_PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-prose-prompt'
const PROSE_CHECKPOINT_TYPE = 'noice-changelog-commit-prose-checkpoint'
const COMMIT_WIDGET_KEY = 'noice-changelog-commit-worker'
type CommitDisplayStatus = 'ok' | 'cancelled' | 'failed'

interface CommitResultDetails {
  changeType?: ChangeType
  mode?: CommitMode
  userContext?: string
  status?: CommitDisplayStatus
}

let commitCommandPending = false
let commitWorkflowRunning = false
let commitProseRunning = false
let proseAgentSettledWaiter: (() => void) | undefined
let proseStreamText = new Map<number, string>()
let proseStreamResponse:
  | { text: string; stopReason?: string; errorMessage?: string }
  | undefined

export default function noiceChangelogExtension(pi: ExtensionAPI) {
  pi.on('agent_settled', () => {
    proseAgentSettledWaiter?.()
    proseAgentSettledWaiter = undefined
  })

  pi.on('message_start', (event) => {
    if (!commitProseRunning || event.message.role !== 'assistant') return
    proseStreamText = new Map()
    proseStreamResponse = undefined
  })

  pi.on('message_update', (event) => {
    if (!commitProseRunning || event.message.role !== 'assistant') return
    const update = event.assistantMessageEvent
    if (update.type === 'start') {
      proseStreamText = new Map()
      proseStreamResponse = undefined
    } else if (update.type === 'text_delta') {
      proseStreamText.set(
        update.contentIndex,
        `${proseStreamText.get(update.contentIndex) ?? ''}${update.delta}`
      )
    } else if (update.type === 'text_end') {
      proseStreamText.set(update.contentIndex, update.content)
    } else if (update.type === 'done') {
      proseStreamResponse = {
        text: joinedProseStreamText(),
        stopReason: update.message.stopReason,
        errorMessage: update.message.errorMessage
      }
    } else if (update.type === 'error') {
      proseStreamResponse = {
        text: joinedProseStreamText(),
        stopReason: update.error.stopReason,
        errorMessage: update.error.errorMessage
      }
    }

    // The hidden turn exists only to obtain structured prose. Keep its streamed
    // JSON out of the chat while preserving the active conversation/model call.
    hideStreamingProse(event.message.content)
  })

  pi.on('message_end', (event) => {
    if (!commitProseRunning || event.message.role !== 'assistant') return
    proseStreamResponse = {
      text: joinedProseStreamText(),
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage
    }
  })

  pi.on('tool_call', () => {
    if (!commitProseRunning) return
    return {
      block: true,
      reason:
        '/commit is requesting prose only; repository tools and mutations are owned by the extension'
    }
  })

  pi.on('context', (event) => ({
    messages: event.messages.filter((message) => {
      const customType = (message as { customType?: string }).customType
      if (customType === MESSAGE_TYPE) return false
      if (customType === PROSE_PROMPT_MESSAGE_TYPE && !commitProseRunning)
        return false
      return true
    })
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
          `${statusLabel} ${theme.fg('toolTitle', theme.bold('commit'))}${details?.mode === 'stacked' ? ` ${theme.fg('accent', 'stacked')}` : ''}${details?.changeType ? ` ${theme.fg('accent', details.changeType)}` : ''}`,
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
      'Commit changes and create/update PR. Use /commit stacked to add a PR above the current PR.',
    getArgumentCompletions: getCommitArgumentCompletions,
    handler: async (args, ctx) => {
      if (commitCommandPending || commitWorkflowRunning) {
        ctx.ui.notify('Commit command is already active', 'warning')
        return
      }

      commitCommandPending = true
      let parsed: {
        mode: CommitMode
        changeType: ChangeType
        context: string
      } | null
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

      const progress = createCommitProgress(ctx, parsed.changeType, parsed.mode)
      ctx.ui.notify(
        `Starting /commit${parsed.mode === 'stacked' ? ' stacked' : ''} (${parsed.changeType})`,
        'info'
      )
      try {
        const workflow = await executeCommitWorkflow(
          { cwd: ctx.cwd, exec: pi.exec.bind(pi) },
          parsed.changeType,
          parsed.context,
          {
            generateProse: (input) =>
              generateProse(
                pi,
                ctx,
                input,
                createConversationCheckpoint(pi, ctx)
              ),
            onProgress: progress.update
          },
          parsed.mode
        )
        progress.finish()
        const summary = formatWorkflowResult(workflow)
        await sendResult(ctx, pi, summary, {
          changeType: parsed.changeType,
          mode: parsed.mode,
          userContext: parsed.context,
          status: workflow.status === 'failed' ? 'failed' : 'ok'
        })
        ctx.ui.notify(
          formatCommitNotification(formatWorkflowResult(workflow), 'ok'),
          'info'
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progress.fail(message)
        const failedWorkflow =
          error instanceof WorkflowFailure
            ? error.workflow
            : {
                status: 'failed' as const,
                commit: null,
                pr: null,
                verification: 'Not run',
                notes: [message]
              }
        const summary = formatWorkflowResult(failedWorkflow)
        await sendResult(ctx, pi, summary, {
          changeType: parsed.changeType,
          mode: parsed.mode,
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
  input: ProseInput,
  sourceLeafId: string
) {
  if (!ctx.model) throw new Error('/commit requires an active model')

  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const [template, rules] = await Promise.all([
    readFile(join(extensionDir, 'prose-prompt.md'), 'utf8'),
    readFile(join(extensionDir, 'rules.md'), 'utf8')
  ])
  const prompt = template
    .replace('{{rules}}', rules)
    .replace('{{input}}', JSON.stringify(input, null, 2))

  proseStreamText = new Map()
  proseStreamResponse = undefined
  commitProseRunning = true
  try {
    const agentSettled = waitForProseAgentSettled()
    pi.sendMessage(
      {
        customType: PROSE_PROMPT_MESSAGE_TYPE,
        content: prompt,
        display: false,
        details: { purpose: 'commit-prose' }
      },
      { triggerTurn: true, deliverAs: 'followUp' }
    )
    await agentSettled

    // Read the durable hidden branch after the complete run settles. Individual
    // agent_end payloads contain only one low-level retry/continuation and can
    // omit either the original prompt or the final successful response.
    const branch = ctx.sessionManager.getBranch() as ProseBranchEntry[]
    const promptIndex = findLastProsePromptIndex(branch)
    if (promptIndex < 0)
      throw new Error('The commit prose prompt was missing from the model turn')
    const assistant = findLastBranchAssistant(branch, promptIndex)
    if (!assistant) throw new Error('The model returned no commit prose')
    const streamedResponse = getProseStreamResponse()
    const stopReason = streamedResponse?.stopReason ?? assistant.stopReason
    const errorMessage =
      streamedResponse?.errorMessage ?? assistant.errorMessage
    if (stopReason !== 'stop') {
      const detail = errorMessage ? `: ${errorMessage.trim()}` : ''
      throw new Error(
        `The model did not finish generating commit prose (stopReason: ${stopReason ?? 'unknown'})${detail}`
      )
    }
    const text = (
      streamedResponse?.text || extractText(assistant.content)
    ).trim()
    if (!text) throw new Error('The model returned no commit prose')
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('The model response was not strict JSON')
    }
  } finally {
    proseAgentSettledWaiter = undefined
    try {
      await restoreConversationLeaf(ctx, sourceLeafId)
    } finally {
      // Never leave global tool blocking enabled when waiting or navigation
      // fails. The workflow will fail before any Git mutation if restoration
      // itself cannot be proven.
      commitProseRunning = false
      proseStreamText = new Map()
      proseStreamResponse = undefined
    }
  }
}

interface ProseBranchEntry {
  id: string
  type: string
  customType?: string
  message?: {
    role?: string
    content?: unknown
    stopReason?: string
    errorMessage?: string
  }
}

function waitForProseAgentSettled() {
  return new Promise<void>((resolve) => {
    proseAgentSettledWaiter = resolve
  })
}

export function createConversationCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
) {
  // Plain custom entries do not participate in model context, so this preserves
  // the provider's exact cached prefix while giving navigateTree a target that
  // restores every preceding durable entry. User and custom_message entries
  // are unsafe targets because Pi intentionally navigates to their parent.
  pi.appendEntry(PROSE_CHECKPOINT_TYPE)
  const checkpoint = ctx.sessionManager.getLeafId()
  if (!checkpoint) {
    throw new Error('Could not checkpoint the conversation before /commit')
  }
  const entry = ctx.sessionManager.getEntry(checkpoint) as
    | { type?: string; customType?: string }
    | undefined
  if (entry?.type !== 'custom' || entry.customType !== PROSE_CHECKPOINT_TYPE) {
    throw new Error('The /commit conversation checkpoint was not persisted')
  }
  return checkpoint
}

async function restoreConversationLeaf(
  ctx: ExtensionCommandContext,
  sourceLeafId: string
) {
  if (!ctx.isIdle()) await ctx.waitForIdle()
  if (ctx.sessionManager.getLeafId() === sourceLeafId) return
  const navigation = await ctx.navigateTree(sourceLeafId, { summarize: false })
  if (navigation.cancelled) {
    throw new Error(
      'Could not restore the conversation after generating commit prose'
    )
  }
  if (ctx.sessionManager.getLeafId() !== sourceLeafId) {
    throw new Error(
      'Conversation restoration reached an unexpected session leaf; refusing to mutate Git'
    )
  }
}

function findLastProsePromptIndex(entries: ProseBranchEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry.type === 'custom_message' &&
      entry.customType === PROSE_PROMPT_MESSAGE_TYPE
    ) {
      return index
    }
  }
  return -1
}

function findLastBranchAssistant(
  entries: ProseBranchEntry[],
  afterIndex: number
) {
  for (let index = entries.length - 1; index > afterIndex; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'message' && entry.message?.role === 'assistant')
      return entry.message
  }
  return undefined
}

async function sendResult(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  content: string,
  details: CommitResultDetails
) {
  if (!ctx.isIdle()) await ctx.waitForIdle()
  pi.sendMessage({ customType: MESSAGE_TYPE, content, display: false, details })
}

interface ProgressEntry {
  message: string
  startedAt: number
  finishedAt?: number
}

function createCommitProgress(
  ctx: ExtensionCommandContext,
  changeType: ChangeType,
  mode: CommitMode
) {
  const entries: ProgressEntry[] = []

  const render = () => {
    const visible = entries.slice(-8)
    const plainLines = [
      `/commit${mode === 'stacked' ? ' stacked' : ''} ${changeType}`,
      ...visible.map((entry, index) => {
        const active = index === visible.length - 1 && !entry.finishedAt
        const elapsed = formatElapsed(
          (entry.finishedAt ?? Date.now()) - entry.startedAt
        )
        return `${active ? '›' : '✓'} ${entry.message} ${elapsed}`
      })
    ]
    if (ctx.mode !== 'tui') {
      ctx.ui.setWidget(COMMIT_WIDGET_KEY, plainLines)
      return
    }
    ctx.ui.setWidget(
      COMMIT_WIDGET_KEY,
      (_tui, theme) =>
        new Text(
          [
            theme.fg(
              'toolTitle',
              theme.bold(
                `/commit${mode === 'stacked' ? ' stacked' : ''} ${changeType}`
              )
            ),
            ...visible.map((entry, index) => {
              const active = index === visible.length - 1 && !entry.finishedAt
              const elapsed = theme.fg(
                'dim',
                formatElapsed(
                  (entry.finishedAt ?? Date.now()) - entry.startedAt
                )
              )
              return active
                ? `${theme.fg('accent', '›')} ${entry.message} ${elapsed}`
                : `${theme.fg('success', '✓')} ${theme.fg('dim', entry.message)} ${elapsed}`
            })
          ].join('\n'),
          1,
          0
        )
    )
  }

  const finishCurrent = () => {
    const current = entries.at(-1)
    if (current && !current.finishedAt) current.finishedAt = Date.now()
  }

  const update = (message: string) => {
    if (entries.at(-1)?.message === message) return
    finishCurrent()
    entries.push({ message, startedAt: Date.now() })
    render()
  }

  return {
    update,
    finish() {
      finishCurrent()
      render()
    },
    fail(message: string) {
      update(`Failed: ${message.split('\n', 1)[0]}`)
      finishCurrent()
      render()
    }
  }
}

function formatElapsed(milliseconds: number) {
  return milliseconds < 1_000
    ? `(${milliseconds}ms)`
    : `(${(milliseconds / 1_000).toFixed(1)}s)`
}

function getCommitArgumentCompletions(prefix: string) {
  const trimmedStart = prefix.trimStart()
  const leadingWhitespace = prefix.slice(0, prefix.length - trimmedStart.length)
  const [firstWord = ''] = trimmedStart.split(/\s+/)
  const hasFirstSeparator = /^\S+\s/.test(trimmedStart)
  if (!hasFirstSeparator) {
    const modes = [
      ...CHANGE_TYPE_OPTIONS.map((option) => ({
        value: option.type,
        label: option.label
      })),
      {
        value: 'stacked',
        label: 'stacked - Add selected changes above the current pull request'
      }
    ].filter((option) => option.value.startsWith(firstWord))
    return modes.length
      ? modes.map((option) => ({
          value: `${leadingWhitespace}${option.value} `,
          label: option.label
        }))
      : null
  }

  if (firstWord === 'stacked') {
    const remainder = trimmedStart.slice('stacked'.length).trimStart()
    const [type = ''] = remainder.split(/\s+/)
    if (!/^\S+\s/.test(remainder)) {
      const matches = CHANGE_TYPE_OPTIONS.filter((option) =>
        option.type.startsWith(type)
      )
      return matches.length
        ? matches.map((option) => ({
            value: `${leadingWhitespace}stacked ${option.type} `,
            label: option.label
          }))
        : null
    }
    if (!isChangeType(type)) return null
    return contextCompletion(prefix, remainder.slice(type.length).trim())
  }

  if (!isChangeType(firstWord)) return null
  return contextCompletion(prefix, trimmedStart.slice(firstWord.length).trim())
}

function contextCompletion(prefix: string, context: string) {
  return [
    {
      value: prefix,
      label: context
        ? `What was done: "${context}"`
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
  const mode: CommitMode = firstWord === 'stacked' ? 'stacked' : 'normal'
  const modeArgs = mode === 'stacked' ? rest : [firstWord, ...rest]
  const [possibleType = '', ...contextWords] = modeArgs
  if (isChangeType(possibleType)) {
    return {
      mode,
      changeType: possibleType,
      context: contextWords.join(' ').trim()
    }
  }

  const selected = await ctx.ui.select(
    'Change type',
    CHANGE_TYPE_OPTIONS.map((option) => option.label)
  )
  if (!selected) return null
  const option = CHANGE_TYPE_OPTIONS.find((item) =>
    selected.startsWith(item.type)
  )
  return option
    ? {
        mode,
        changeType: option.type,
        context: modeArgs.join(' ').trim()
      }
    : null
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

function getProseStreamResponse() {
  if (proseStreamResponse) return proseStreamResponse
  const text = joinedProseStreamText()
  return text ? { text } : undefined
}

function joinedProseStreamText() {
  return [...proseStreamText.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join('')
}

function hideStreamingProse(content: unknown) {
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!part || typeof part !== 'object' || !('type' in part)) continue
    if (part.type === 'text' && 'text' in part) part.text = ''
    if (part.type === 'thinking' && 'thinking' in part) part.thinking = ''
  }
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
