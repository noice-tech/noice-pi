import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DefaultResourceLoader,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import {
  registerCommit,
  COMMIT_AUTHORIZATION_POLICY
} from '../extensions/commit/register.ts'
import { createHarness } from './harness.mjs'

test('commit and changelog packages discover one commit template in either order', async () => {
  const commitPath = fileURLToPath(new URL('..', import.meta.url))
  const changelogPath = fileURLToPath(
    new URL('../../changelog', import.meta.url)
  )
  for (const packages of [
    [commitPath, changelogPath],
    [changelogPath, commitPath]
  ]) {
    const h = await createHarness()
    const loader = new DefaultResourceLoader({
      cwd: h.ctx.cwd,
      agentDir: join(h.ctx.cwd, 'agent'),
      settingsManager: SettingsManager.inMemory({ packages }),
      noThemes: true,
      noSkills: true,
      noContextFiles: true
    })
    await loader.reload()
    assert.equal(
      loader.getPrompts().prompts.filter(({ name }) => name === 'commit')
        .length,
      1
    )
    assert.deepEqual(loader.getExtensions().errors, [])
    assert.ok(
      loader
        .getExtensions()
        .extensions.every((extension) => !extension.commands.has('commit'))
    )
  }
})

test('adapter enables Codemode, supplies validated configuration, and clears invocation state', async () => {
  const config = {
    pullRequest: 'never',
    format: {
      changeTypes: [
        { name: 'docs', description: 'Documentation', public: true }
      ],
      instructions: 'Use type(scope): description.'
    }
  }
  const h = await createHarness({ config, active: ['bash', 'read'] })
  registerCommit(h.pi)
  await h.dispatch('session_start')
  assert.deepEqual(h.toolChanges, [['bash', 'read', 'codemode']])
  assert.deepEqual(
    await h.dispatch('input', { text: '/commit --pr docs document workflow' }),
    { action: 'continue' }
  )
  const event = await h.prepare('--pr docs document workflow')
  const section = event.systemPromptOptions.sections.commit_request
  assert.deepEqual(JSON.parse(section.split('\n')[1]), {
    mode: 'normal',
    changeType: 'docs',
    context: 'document workflow',
    pullRequest: 'auto',
    flag: '--pr'
  })
  assert.ok(section.includes(config.format.instructions))
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, [
    COMMIT_AUTHORIZATION_POLICY
  ])

  const inferred = await h.prepare('describe the change')
  assert.equal(
    JSON.parse(
      inferred.systemPromptOptions.sections.commit_request.split('\n')[1]
    ).changeType,
    'auto'
  )
  await h.dispatch('before_agent_start', {
    prompt: 'continue coding',
    systemPromptOptions: inferred.systemPromptOptions
  })
  assert.equal(inferred.systemPromptOptions.sections.commit_request, undefined)
  assert.deepEqual(inferred.systemPromptOptions.promptGuidelines, [
    COMMIT_AUTHORIZATION_POLICY
  ])
})
