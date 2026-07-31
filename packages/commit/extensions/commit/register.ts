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
  changeTypeOptions,
  getCommitArgumentCompletions,
  parseCommitArguments,
  renderCustomFormatPolicy,
  type ChangeType,
  type CommitMode,
  type ResolvedCommitArguments
} from './command.ts'
import {
  DEFAULT_COMMIT_CONFIG,
  defaultConfigSource,
  getCommitConfigPaths,
  loadCommitConfig,
  writeCommitConfigFile,
  type ResolvedCommitConfig
} from './config.ts'

const MESSAGE_TYPE = 'noice-changelog-commit-result'
const PROMPT_MESSAGE_TYPE = 'noice-changelog-commit-worker-prompt'
const COMMIT_WORKER_WIDGET_KEY = 'noice-changelog-commit-worker'

type CommitDisplayStatus = 'ok' | 'cancelled' | 'failed'

interface CommitResultDetails {
  changeType?: ChangeType
  mode?: CommitMode
  userContext?: string
  workerLeafId?: string | null
  status?: CommitDisplayStatus
}

interface CommitRuntime {
  cachedConfig: ResolvedCommitConfig
  commitCommandPending: boolean
  commitWorkerRunning: boolean
  agentEndWaiter?: (messages: unknown[]) => void
  latestCommitWorkerMessages?: unknown[]
}

const RUNTIME_REGISTRY_KEY = Symbol.for('pi-commit.runtime.v1')
type RuntimeRegistry = WeakMap<object, CommitRuntime>

function getRuntimeRegistry(): RuntimeRegistry {
  const globals = globalThis as typeof globalThis & {
    [RUNTIME_REGISTRY_KEY]?: RuntimeRegistry
  }
  return (globals[RUNTIME_REGISTRY_KEY] ??= new WeakMap())
}

export function registerCommit(pi: ExtensionAPI): void {
  const registry = getRuntimeRegistry()
  // Pi creates a distinct ExtensionAPI wrapper for each extension, but every
  // wrapper in one runtime shares the event bus. Keying by that bus deduplicates
  // direct and bundled copies while preserving independent Pi runtimes.
  const runtimeKey = pi.events ?? pi
  if (registry.has(runtimeKey)) return

  const runtime: CommitRuntime = {
    cachedConfig: DEFAULT_COMMIT_CONFIG,
    commitCommandPending: false,
    commitWorkerRunning: false
  }
  registry.set(runtimeKey, runtime)

  pi.on('agent_end', (event) => {
    if (runtime.commitWorkerRunning) {
      runtime.latestCommitWorkerMessages = event.messages
    }
    runtime.agentEndWaiter?.(event.messages)
    runtime.agentEndWaiter = undefined
  })

  pi.on('context', (event) => {
    return {
      messages: event.messages.filter((message) => {
        const customType = (message as { customType?: string }).customType
        if (customType === MESSAGE_TYPE) return false
        if (
          customType === PROMPT_MESSAGE_TYPE &&
          !runtime.commitWorkerRunning
        ) {
          return false
        }
        return true
      })
    }
  })

  pi.on('session_start', async (_event, ctx) => {
    try {
      runtime.cachedConfig = await loadConfigForContext(ctx)
    } catch (error) {
      runtime.cachedConfig = DEFAULT_COMMIT_CONFIG
      ctx.ui.notify(errorMessage(error), 'warning')
    }
  })

  pi.on('session_shutdown', () => {
    if (registry.get(runtimeKey) === runtime) registry.delete(runtimeKey)
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
          `${statusLabel} ${theme.fg('toolTitle', theme.bold('commit'))}${details?.mode === 'stacked' ? ` ${theme.fg('accent', 'stacked')}` : ''}${details?.changeType ? ` ${theme.fg('accent', details.changeType)}` : ''}`,
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

  pi.registerCommand('commit-config', {
    description: 'Configure pi-commit defaults for this user or project.',
    handler: async (_args, ctx) => {
      await configureCommit(ctx, runtime)
    }
  })

  pi.registerCommand('commit', {
    description:
      'Commit on an isolated context branch, then push and optionally manage a PR.',
    getArgumentCompletions: (prefix) =>
      getCommitArgumentCompletions(prefix, runtime.cachedConfig),
    handler: async (args, ctx) => {
      if (runtime.commitCommandPending || runtime.commitWorkerRunning) {
        ctx.ui.notify('Commit command is already active', 'warning')
        return
      }

      runtime.commitCommandPending = true
      let prepared: Awaited<ReturnType<typeof prepareCommit>>
      try {
        prepared = await prepareCommit(args, ctx, runtime)
      } catch (error) {
        runtime.commitCommandPending = false
        ctx.ui.notify(errorMessage(error), 'error')
        return
      }

      if (!prepared) {
        runtime.commitCommandPending = false
        return
      }

      const { parsed, prompt } = prepared
      const startLeafId = ctx.sessionManager.getLeafId()

      // Establish the running guard before releasing the pending guard. Keeping
      // this transition synchronous prevents a re-entrant command from starting
      // a second worker and overwriting the singleton agent-end waiter.
      runtime.commitWorkerRunning = true
      runtime.commitCommandPending = false

      try {
        showCommitWorkerBanner(ctx)
        ctx.ui.notify(
          `Starting commit worker (${parsed.mode === 'stacked' ? 'stacked ' : ''}${parsed.changeType}${parsed.pullRequest === 'never' ? ', no PR' : ''})`,
          'info'
        )

        const agentEnd = waitForNextAgentEndAfterIdle(ctx, runtime)
        runtime.latestCommitWorkerMessages = undefined
        pi.sendMessage(
          {
            customType: PROMPT_MESSAGE_TYPE,
            content: prompt,
            display: false,
            details: {
              changeType: parsed.changeType,
              mode: parsed.mode,
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
              mode: parsed.mode,
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
              mode: parsed.mode,
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
                mode: parsed.mode,
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
            mode: parsed.mode,
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
        const message = errorMessage(error)
        if (startLeafId) {
          await ctx.navigateTree(startLeafId, { summarize: false })
        }
        await sendResultAtSourceLeaf(ctx, startLeafId, {
          customType: MESSAGE_TYPE,
          content: `Commit worker failed: ${message}`,
          display: true,
          details: {
            changeType: parsed.changeType,
            mode: parsed.mode,
            userContext: parsed.context,
            status: 'failed'
          }
        })
        ctx.ui.notify(`Commit worker failed:\n${message}`, 'error')
      } finally {
        ctx.ui.setWidget(COMMIT_WORKER_WIDGET_KEY, undefined)
        runtime.commitWorkerRunning = false
        runtime.latestCommitWorkerMessages = undefined
      }
    }
  })
}

function showCommitWorkerBanner(ctx: ExtensionCommandContext) {
  const message = 'Commit worker running on a side branch of this session…'

  if (ctx.mode !== 'tui') {
    ctx.ui.setWidget(COMMIT_WORKER_WIDGET_KEY, [message])
    return
  }

  ctx.ui.setWidget(
    COMMIT_WORKER_WIDGET_KEY,
    (_tui, theme) => new Text(theme.fg('warning', message), 1, 0)
  )
}

async function prepareCommit(
  args: string | undefined,
  ctx: ExtensionCommandContext,
  runtime: CommitRuntime
) {
  const config = await loadConfigForContext(ctx)
  runtime.cachedConfig = config
  const unresolved = parseCommitArguments(args, config)
  const parsed = await resolveChangeTypeAndContext(unresolved, config, ctx)
  if (!parsed) return null

  if (!ctx.isIdle()) {
    ctx.ui.notify(
      'Commit queued; waiting for the current agent turn to finish',
      'info'
    )
  }

  await ctx.waitForIdle()
  const prompt = await buildWorkerPrompt(parsed, config)
  // Prompt loading is asynchronous. Re-check idle so another user turn cannot
  // slip in between the original wait and worker startup.
  await ctx.waitForIdle()

  return { parsed, prompt }
}

async function resolveChangeTypeAndContext(
  parsed: ReturnType<typeof parseCommitArguments>,
  config: ResolvedCommitConfig,
  ctx: ExtensionCommandContext
): Promise<ResolvedCommitArguments | null> {
  if (parsed.changeType) {
    return { ...parsed, changeType: parsed.changeType }
  }

  const options = changeTypeOptions(config)
  const selected = await ctx.ui.select(
    'Change type',
    options.map((option) => option.label)
  )
  if (!selected) return null

  const option = options.find(
    (item) => selected === item.label || selected.startsWith(`${item.type} -`)
  )
  if (!option) return null

  return { ...parsed, changeType: option.type }
}

async function buildWorkerPrompt(
  parsed: ResolvedCommitArguments,
  config: ResolvedCommitConfig
) {
  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const customPolicy = renderCustomFormatPolicy(config, parsed.changeType)
  const [template, opinionatedPolicy] = await Promise.all([
    readFile(join(extensionDir, 'worker-prompt.md'), 'utf8'),
    customPolicy
      ? Promise.resolve('')
      : readFile(join(extensionDir, 'opinionated-format.md'), 'utf8')
  ])
  const formatPolicy = customPolicy ?? opinionatedPolicy

  return template
    .replaceAll('{{mode}}', parsed.mode)
    .replaceAll('{{pullRequestBehavior}}', parsed.pullRequest)
    .replaceAll('{{changeType}}', parsed.changeType)
    .replaceAll('{{userContext}}', parsed.context || '(none)')
    .replaceAll('{{formatPolicy}}', formatPolicy)
    .replaceAll('{{rules}}', formatPolicy)
}

function waitForNextAgentEndAfterIdle(
  ctx: ExtensionCommandContext,
  runtime: CommitRuntime
) {
  return new Promise<unknown[]>((resolve) => {
    runtime.agentEndWaiter = (messages) => {
      void (async () => {
        // `agent_end` also fires for transient provider failures that Pi may
        // auto-retry. Wait until the whole agent run is idle, then use the
        // latest worker messages captured by the global `agent_end` listener.
        if (!ctx.isIdle()) {
          await ctx.waitForIdle()
        }
        resolve(runtime.latestCommitWorkerMessages ?? messages)
      })()
    }
  })
}

async function loadConfigForContext(
  ctx: Pick<ExtensionCommandContext, 'cwd' | 'isProjectTrusted'>
): Promise<ResolvedCommitConfig> {
  const adaptable = ctx as {
    cwd?: string
    isProjectTrusted?: () => boolean
  }
  if (!adaptable.cwd) return DEFAULT_COMMIT_CONFIG

  return loadCommitConfig({
    cwd: adaptable.cwd,
    projectTrusted: adaptable.isProjectTrusted?.() ?? false
  })
}

async function configureCommit(
  ctx: ExtensionCommandContext,
  runtime: CommitRuntime
) {
  const adaptable = ctx as ExtensionCommandContext & {
    cwd?: string
    isProjectTrusted?: () => boolean
  }
  const cwd = adaptable.cwd ?? process.cwd()
  const paths = getCommitConfigPaths(cwd)

  if (ctx.mode !== 'tui') {
    ctx.ui.notify(
      `Edit pi-commit configuration manually.\nUser: ${paths.user}\nProject: ${paths.project}\n\n${defaultConfigSource()}`,
      'info'
    )
    return
  }

  const userLabel = `User — ${paths.user}`
  const projectLabel = `Project — ${paths.project}`
  const selectedScope = await ctx.ui.select('Configure pi-commit', [
    userLabel,
    projectLabel
  ])
  if (!selectedScope) return

  const project = selectedScope === projectLabel
  if (project && !(adaptable.isProjectTrusted?.() ?? false)) {
    ctx.ui.notify(
      'Project configuration is available only after trusting this project',
      'error'
    )
    return
  }

  const path = project ? paths.project : paths.user
  let draft: string
  try {
    draft = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.ui.notify(`Could not read ${path}: ${errorMessage(error)}`, 'error')
      return
    }
    draft = defaultConfigSource()
  }

  while (true) {
    const edited = await ctx.ui.editor(`Edit ${path}`, draft)
    if (edited === undefined) return
    draft = edited

    try {
      await writeCommitConfigFile(path, draft)
    } catch (error) {
      const retry = await ctx.ui.select(
        `Invalid pi-commit configuration: ${errorMessage(error)}`,
        ['Edit again', 'Cancel']
      )
      if (retry !== 'Edit again') return
      continue
    }

    try {
      runtime.cachedConfig = await loadConfigForContext(ctx)
    } catch (error) {
      ctx.ui.notify(
        `Saved ${path}, but another configuration file is invalid: ${errorMessage(error)}`,
        'error'
      )
      return
    }

    const format =
      runtime.cachedConfig.format === 'opinionated'
        ? 'opinionated'
        : `custom (${runtime.cachedConfig.format.changeTypes.map(({ name }) => name).join(', ')})`
    ctx.ui.notify(
      `Saved ${path}\nPull requests: ${runtime.cachedConfig.pullRequest}\nFormat: ${format}`,
      'info'
    )
    return
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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
