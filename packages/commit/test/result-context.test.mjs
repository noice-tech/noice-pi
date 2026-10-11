import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai'

import piCommitExtension from '../extensions/commit/index.ts'

const RESULT_TYPE = 'pi-commit-result'
const PROMPT_TYPE = 'noice-changelog-commit-worker-prompt'
const BOUNDARY =
  'These actions are complete. Further commits, pushes, or PR changes require a new user request.'

const created = report(
  'The user created branch fix/result-context, committed the changes, pushed the branch, and opened PR #142.',
  {
    branch: 'created fix/result-context from main; now checked out',
    pr: 'created #142 — fix: retain commit outcomes https://example.com/pull/142'
  }
)
const updated = report(
  'The user committed the changes on fix/result-context, pushed the branch, and updated PR #142.',
  {
    commit: 'd4e5f6a fix: retain queued outcomes',
    pr: 'updated #142 — fix: retain commit outcomes https://example.com/pull/142'
  }
)

for (const [name, command, summary, status] of [
  ['created PR', '/commit fix retain outcomes', created, 'ok'],
  ['updated PR', '/commit fix retain outcomes', updated, 'ok'],
  [
    'no PR',
    '/commit --no-pr fix retain outcomes',
    report('The user committed the changes and pushed the branch.', {
      pr: 'skipped (--no-pr); no PR inspection or modification performed'
    }),
    'ok'
  ],
  [
    'stacked PR',
    '/commit stacked fix retain outcomes',
    report(
      'The user created a child branch, committed and pushed it, and opened PR #143 above PR #142.',
      {
        branch:
          'created fix/child from fix/parent; now checked out; base fix/parent',
        pr: 'created #143 — fix: retain commit outcomes https://example.com/pull/143'
      }
    ),
    'ok'
  ],
  [
    'no changes',
    '/commit fix retain outcomes',
    report('No changes were made.', {
      status: 'no_changes',
      commit: 'none',
      push: 'not attempted',
      pr: 'none'
    }),
    'ok'
  ],
  [
    'partial failure',
    '/commit fix retain outcomes',
    report(
      'The user created a branch and committed the changes. The push failed; no PR was created.',
      {
        status: 'failed',
        branch: 'created fix/result-context from main; now checked out',
        push: 'failed — authentication rejected',
        pr: 'not attempted',
        notes:
          'Branch and commit remain locally; no automatic rollback performed.'
      }
    ),
    'failed'
  ],
  ['cancelled before a report', '/commit fix retain outcomes', '', 'cancelled']
]) {
  test(
    `the next model request sees the ${name} outcome, not the worker transcript`,
    { timeout: 10_000 },
    async (t) => {
      const harness = await createHarness(t)
      const { session, manager, faux } = harness
      let workerPrompt
      faux.setResponses([
        (context) => {
          workerPrompt = context.messages.at(-1).content
          return fauxAssistantMessage(fauxToolCall('worker_probe', {}), {
            stopReason: 'toolUse'
          })
        },
        fauxAssistantMessage(summary)
      ])

      // Exercise /commit as the first action, with no existing conversation leaf.
      await session.prompt(command)
      await session.waitForIdle()
      assert.equal(
        faux.state.callCount,
        2,
        'recording the result must not start a model turn'
      )
      const result = manager
        .getBranch()
        .find((entry) => entry.customType === RESULT_TYPE)
      assert.ok(result, 'the result must be on the active conversation path')
      assert.equal(result.details.status, status)
      assert.ok(result.content.endsWith(BOUNDARY))
      if (summary) assert.ok(result.content.startsWith(summary))
      else
        assert.match(result.content, /Git\/PR changes already made are unknown/)
      assert.ok(
        manager.getEntries().some((entry) => entry.customType === PROMPT_TYPE)
      )
      assert.ok(
        !manager.getBranch().some((entry) => entry.customType === PROMPT_TYPE)
      )

      assert.match(JSON.stringify(workerPrompt), /short factual paragraph/)
      assert.match(JSON.stringify(workerPrompt), /these seven fields/)
      assert.match(
        JSON.stringify(workerPrompt),
        /whether it was created or reused/
      )

      let nextContext
      faux.appendResponses([
        (context) => {
          nextContext = context
          return fauxAssistantMessage('Continuing coding work.')
        }
      ])
      await session.prompt('Continue coding, without publishing anything.')
      assertCleanContext(nextContext, [result.content])
    }
  )
}

test(
  'consecutive outcomes stay in order and survive a real session reopen',
  { timeout: 10_000 },
  async (t) => {
    const harness = await createHarness(t)
    const { session, manager, faux } = harness
    faux.setResponses([
      fauxAssistantMessage(created),
      fauxAssistantMessage(updated)
    ])
    await session.prompt('/commit fix first change')
    await session.prompt('/commit fix second change')
    await session.waitForIdle()
    assert.equal(faux.state.callCount, 2)

    const results = manager
      .getBranch()
      .filter((entry) => entry.customType === RESULT_TYPE)
    assert.equal(
      results.length,
      2,
      'navigating back must not discard the previous custom result'
    )
    assert.ok(results[0].content.startsWith(created))
    assert.ok(results[1].content.startsWith(updated))

    session.dispose()
    const reopened = SessionManager.open(manager.getSessionFile())
    const resumed = await harness.openSession(reopened)
    let nextContext
    faux.appendResponses([
      (context) => {
        nextContext = context
        return fauxAssistantMessage('Resumed coding work.')
      }
    ])
    await resumed.prompt('Continue coding.')
    assertCleanContext(
      nextContext,
      results.map((entry) => entry.content)
    )
  }
)

test(
  'provider errors preserve partial reports and mark unreported state unknown',
  { timeout: 10_000 },
  async (t) => {
    const { session, manager, faux } = await createHarness(t)
    faux.setResponses([
      fauxAssistantMessage(
        'The user created branch fix/partial.\nbranch: fix/partial',
        {
          stopReason: 'error',
          errorMessage: 'provider unavailable'
        }
      )
    ])
    await session.prompt('/commit fix retain outcomes')
    const result = manager
      .getBranch()
      .find((entry) => entry.customType === RESULT_TYPE)
    assert.equal(result.details.status, 'failed')
    assert.match(result.content, /unreported Git\/PR changes are unknown/)
    assert.match(result.content, /branch: fix\/partial/)
    assert.match(result.content, /provider unavailable/)
    assert.ok(result.content.endsWith(BOUNDARY))
    let nextContext
    faux.appendResponses([
      (context) => {
        nextContext = context
        return fauxAssistantMessage('Continuing coding work.')
      }
    ])
    await session.prompt('Continue coding.')
    assertCleanContext(nextContext, [result.content])
  }
)

test(
  'cancelled tree navigation preserves the real outcome and holds queued input',
  { timeout: 10_000 },
  async (t) => {
    const { session, manager, faux } = await createHarness(t, [
      (pi) => {
        pi.on('session_before_tree', () => ({ cancel: true }))
      }
    ])
    let started
    let finish
    const workerStarted = new Promise((resolve) => {
      started = resolve
    })
    const workerFinished = new Promise((resolve) => {
      finish = resolve
    })
    faux.setResponses([
      async () => {
        started()
        await workerFinished
        return fauxAssistantMessage(created)
      }
    ])
    const run = session.prompt('/commit fix retain outcomes')
    await workerStarted
    await session.prompt('Queued coding request')
    finish()
    await run
    await session.waitForIdle()

    const result = manager
      .getBranch()
      .find((entry) => entry.customType === RESULT_TYPE)
    assert.ok(
      result.content.startsWith(created),
      'navigation cancellation must not hide performed actions'
    )
    assert.match(result.content, /Session navigation:.*cancelled/)
    assert.match(result.content, /reported Git\/PR actions are not undone/)
    assert.equal(
      faux.state.callCount,
      1,
      'queued input must not run on the worker branch'
    )
    assert.ok(
      manager.getBranch().some((entry) => entry.customType === PROMPT_TYPE)
    )
  }
)

function report(prose, overrides = {}) {
  const fields = {
    status: 'committed',
    branch: 'reused fix/result-context; now checked out',
    commit: 'a1b2c3d fix: retain commit outcomes',
    push: 'pushed origin/fix/result-context',
    pr: 'unchanged #142 https://example.com/pull/142',
    verification: 'Not run',
    notes: 'none',
    ...overrides
  }
  return `${prose}\n\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}`
}

function assertCleanContext(context, reports) {
  const text = JSON.stringify(context.messages)
  assert.doesNotMatch(
    text,
    /You are the pi-commit worker|worker_probe|worker-only tool output/
  )
  let previousIndex = -1
  for (const report of reports) {
    const index = context.messages.findIndex((message) =>
      messageText(message).includes(report)
    )
    assert.ok(
      index > previousIndex,
      'outcomes must reach the model once and in order'
    )
    assert.equal(
      context.messages.filter((message) =>
        messageText(message).includes(report)
      ).length,
      1
    )
    previousIndex = index
  }
}

function messageText(message) {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
}

async function createHarness(t, additionalFactories = []) {
  const root = await mkdtemp(join(tmpdir(), 'pi-commit-result-'))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir)
  const sessions = []
  t.after(async () => {
    for (const session of sessions) {
      await session.abort()
      session.dispose()
    }
    await rm(root, { recursive: true, force: true })
  })
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    extensionFactories: [
      piCommitExtension,
      (pi) => {
        pi.registerTool({
          name: 'worker_probe',
          label: 'Worker probe',
          description: 'A test-only worker tool.',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return {
              content: [{ type: 'text', text: 'worker-only tool output' }],
              details: {}
            }
          }
        })
      },
      ...additionalFactories
    ],
    noThemes: true,
    noContextFiles: true
  })
  await resourceLoader.reload()
  const faux = fauxProvider()
  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    modelsPath: null
  })
  modelRuntime.registerNativeProvider(faux.provider)
  const manager = SessionManager.create(root, join(root, 'sessions'))
  const openSession = async (sessionManager) => {
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      sessionManager,
      resourceLoader,
      modelRuntime,
      model: faux.getModel(),
      noTools: 'all'
    })
    sessions.push(session)
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
    return session
  }
  return { session: await openSession(manager), manager, faux, openSession }
}
