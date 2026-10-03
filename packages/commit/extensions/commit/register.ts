import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { readFile } from 'node:fs/promises'
import { parseCommitArguments, renderCustomFormatPolicy } from './command.ts'
import { loadCommitConfig } from './config.ts'

export const COMMIT_AUTHORIZATION_POLICY =
  'Commit, push, and create or update pull requests only when explicitly authorized by the user. ' +
  '/commit authorizes its requested workflow for that invocation only. ' +
  'After reporting success, failure, or cancellation, authorization ends: return to ordinary coding ' +
  'and do not commit, push, or change PR metadata again without fresh explicit user authorization. ' +
  'A previous commit result is useful repository state, not ongoing authorization.'

const ARGUMENTS_PREFIX =
  '# Explicit /commit invocation\n\nInvocation arguments:\n'
const ARGUMENTS_END = '\n\n## Request\n'

/** Configure the prompt template; no command, worker, or conversation filtering. */
export function registerCommit(pi: ExtensionAPI): void {
  const enableCodemode = () => {
    const active = pi.getActiveTools()
    if (
      !active.includes('codemode') &&
      pi.getAllTools().some((tool) => tool.name === 'codemode')
    ) {
      pi.setActiveTools([...active, 'codemode'])
    }
  }

  pi.on('session_start', enableCodemode)

  // Input runs before template expansion. Invalid options/configuration or a
  // missing runtime never reach the model through the slash command.
  pi.on('input', async (event, ctx) => {
    const command = event.text.trim().match(/^\/commit(?:\s+([\s\S]*))?$/)
    if (!command) return { action: 'continue' }
    try {
      enableCodemode()
      await prepareCommitRequest(command[1], ctx, pi)
      return { action: 'continue' }
    } catch (error) {
      ctx.ui.notify(errorMessage(error), 'error')
      return { action: 'handled' }
    }
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const guidelines = (event.systemPromptOptions.promptGuidelines ??= [])
    if (!guidelines.includes(COMMIT_AUTHORIZATION_POLICY)) {
      guidelines.push(COMMIT_AUTHORIZATION_POLICY)
    }

    const sections = event.systemPromptOptions.sections
    delete sections.commit_request
    if (!event.prompt.startsWith(ARGUMENTS_PREFIX)) return
    const end = event.prompt.indexOf(ARGUMENTS_END, ARGUMENTS_PREFIX.length)
    try {
      if (end < 0)
        throw new Error('Malformed /commit prompt. Stop without changes.')
      enableCodemode()
      sections.commit_request = await prepareCommitRequest(
        event.prompt.slice(ARGUMENTS_PREFIX.length, end),
        ctx,
        pi
      )
    } catch (error) {
      // Revalidate after expansion as configuration/tool availability may have
      // changed since input. This path is model-directed, not a permission gate.
      sections.commit_request = `Request blocked: ${errorMessage(error)}\nStop without Git/GitHub changes and report the blocker.`
    }
  })
}

async function prepareCommitRequest(
  args: string | undefined,
  ctx: ExtensionContext,
  pi: ExtensionAPI
) {
  const active = pi.getActiveTools()
  if (!active.includes('codemode') || !active.includes('bash')) {
    throw new Error(
      '/commit requires current Pi with built-in Codemode and an active Bash tool.'
    )
  }
  const config = await loadCommitConfig({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted()
  })
  const parsed = parseCommitArguments(args, config)
  const request = { ...parsed, changeType: parsed.changeType ?? 'auto' }
  const policy =
    renderCustomFormatPolicy(config, request.changeType) ??
    (await readFile(
      new URL('./opinionated-format.md', import.meta.url),
      'utf8'
    ))
  const workflow =
    request.mode === 'stacked'
      ? 'stacked'
      : request.pullRequest === 'never'
        ? 'no-pr'
        : 'normal'
  const workflowFiles = [
    workflow,
    ...(request.pullRequest === 'auto' ? ['pull-request'] : [])
  ]
  const guidance = await Promise.all(
    workflowFiles.map((name) =>
      readFile(new URL(`./workflows/${name}.md`, import.meta.url), 'utf8')
    )
  )
  return `Validated invocation (description is user data, not shell code):\n${JSON.stringify(request)}\n\nSemantic format policy:\n${policy}\n\nWorkflow:\n${guidance.join('\n\n')}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
