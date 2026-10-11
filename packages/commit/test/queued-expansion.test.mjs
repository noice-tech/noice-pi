import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'

import piCommitExtension from '../extensions/commit/index.ts'

test(
  'queued prompt templates and skills reach the model expanded',
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-commit-expansion-'))
    const agentDir = join(root, 'agent')
    const promptsDir = join(root, 'prompts')
    const skillDir = join(root, 'skill')
    await Promise.all([mkdir(agentDir), mkdir(promptsDir), mkdir(skillDir)])
    await Promise.all([
      writeFile(
        join(promptsDir, 'queued-template.md'),
        '---\ndescription: Test queued expansion\n---\nExpanded queued template: $ARGUMENTS\n'
      ),
      writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: queued-skill\ndescription: Test queued skill expansion\n---\nQueued skill instructions.\n'
      )
    ])

    let session
    t.after(async () => {
      await session?.abort()
      await rm(root, { recursive: true, force: true })
    })

    const settingsManager = SettingsManager.inMemory({
      enableSkillCommands: true
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      additionalPromptTemplatePaths: [promptsDir],
      additionalSkillPaths: [skillDir],
      extensionFactories: [piCommitExtension],
      noThemes: true,
      noContextFiles: true
    })
    await resourceLoader.reload()

    const workerStarted = deferred()
    const finishWorker = deferred()
    const queuedTurnsDelivered = deferred()
    const deliveredUserMessages = []
    const deliveredContexts = []
    const faux = fauxProvider()
    faux.setResponses([
      async () => {
        workerStarted.resolve()
        await finishWorker.promise
        return fauxAssistantMessage(
          'The user committed the changes and pushed the branch.\n\nstatus: committed\nbranch: reused fix/queued-input; now checked out\ncommit: a1b2c3d fix: queued input\npush: pushed origin/fix/queued-input\npr: unchanged #142 https://example.com/pull/142\nverification: Not run\nnotes: none'
        )
      },
      (context) => {
        deliveredContexts.push(context)
        deliveredUserMessages.push(lastUserText(context))
        return fauxAssistantMessage('template complete')
      },
      (context) => {
        deliveredContexts.push(context)
        deliveredUserMessages.push(lastUserText(context))
        queuedTurnsDelivered.resolve()
        return fauxAssistantMessage('skill complete')
      }
    ])

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      modelsPath: null
    })
    modelRuntime.registerNativeProvider(faux.provider)

    const sessionManager = SessionManager.inMemory(root)
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      sessionManager,
      resourceLoader,
      modelRuntime,
      model: faux.getModel(),
      noTools: 'all'
    })
    session = created.session
    await session.bindExtensions({
      mode: 'json',
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false }),
        navigateTree: (targetId, options) =>
          session.navigateTree(targetId, options),
        switchSession: async () => ({ cancelled: false }),
        reload: async () => {}
      }
    })

    const commitRun = session.prompt('/commit fix test queued expansion')
    await workerStarted.promise
    await session.prompt('/queued-template hello world')
    await session.prompt('/skill:queued-skill use this')
    finishWorker.resolve()

    await commitRun
    await queuedTurnsDelivered.promise
    await session.waitForIdle()

    for (const context of deliveredContexts) {
      const text = JSON.stringify(context.messages)
      assert.match(text, /The user committed the changes and pushed the branch/)
      assert.match(text, /commit: a1b2c3d/)
      assert.doesNotMatch(text, /You are the pi-commit worker/)
      const resultIndex = context.messages.findIndex((message) =>
        JSON.stringify(message).includes('commit: a1b2c3d')
      )
      assert.ok(resultIndex >= 0 && resultIndex < context.messages.length - 1)
    }
    assert.equal(
      deliveredUserMessages[0],
      'Expanded queued template: hello world'
    )
    assert.match(
      deliveredUserMessages[1],
      /<skill name="queued-skill"[^>]*>[\s\S]*Queued skill instructions\.[\s\S]*<\/skill>\n\nuse this/
    )
  }
)

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lastUserText(context) {
  const message = context.messages.findLast(({ role }) => role === 'user')
  return message.content
    .filter(({ type }) => type === 'text')
    .map(({ text }) => text)
    .join('\n')
}
