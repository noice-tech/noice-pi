import { after } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import piCommitExtension from '../extensions/commit/index.ts'

// Keep personal Pi configuration out of tests (each test file has its own process).
const agentDir = await mkdtemp(join(tmpdir(), 'pi-commit-agent-'))
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = agentDir
const roots = [agentDir]
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true }))
  )
})

export async function createHarness({
  config,
  trusted = true,
  tools = ['bash', 'codemode'],
  active = ['bash']
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-commit-test-'))
  roots.push(cwd)
  if (config !== undefined) {
    await mkdir(join(cwd, '.pi'))
    await writeFile(
      join(cwd, '.pi', 'pi-commit.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    )
  }
  const handlers = new Map()
  const notifications = []
  const toolChanges = []
  let activeTools = [...active]
  const pi = {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    getAllTools: () => tools.map((name) => ({ name })),
    getActiveTools: () => [...activeTools],
    setActiveTools(names) {
      activeTools = [...names]
      toolChanges.push(names)
    },
    registerCommand() {
      throw new Error('Commit must remain a prompt template')
    },
    sendMessage() {
      throw new Error('No worker/custom-message delivery')
    }
  }
  const ctx = {
    cwd,
    isProjectTrusted: () => trusted,
    ui: { notify: (message, type) => notifications.push({ message, type }) }
  }
  piCommitExtension(pi)
  const dispatch = async (name, event = {}) => {
    let result
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, ctx)
      if (result?.action === 'handled') break
    }
    return result
  }
  const prompt = (
    await readFile(new URL('../prompts/commit.md', import.meta.url), 'utf8')
  )
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .trimStart()
  const prepare = async (
    args = '',
    options = { promptGuidelines: [], sections: {} }
  ) => {
    const event = {
      prompt: prompt.replace('$ARGUMENTS', args),
      systemPromptOptions: options
    }
    await dispatch('before_agent_start', event)
    return event
  }
  return {
    pi,
    ctx,
    handlers,
    notifications,
    toolChanges,
    dispatch,
    prepare,
    prompt
  }
}
