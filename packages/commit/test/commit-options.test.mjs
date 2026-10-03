import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommitArguments } from '../extensions/commit/command.ts'

const defaultConfig = { pullRequest: 'auto', format: 'opinionated' }
const customConfig = {
  pullRequest: 'never',
  format: {
    changeTypes: [
      { name: 'docs', description: 'Documentation', public: true },
      { name: 'chore', description: 'Maintenance', public: false }
    ],
    instructions: 'Use type(scope): description.'
  }
}

test('parser resolves types, descriptions, modes, and PR overrides', () => {
  assert.deepEqual(parseCommitArguments('--no-pr fix do work', defaultConfig), {
    mode: 'normal',
    changeType: 'fix',
    context: 'do work',
    pullRequest: 'never',
    flag: '--no-pr'
  })
  assert.deepEqual(
    parseCommitArguments('stacked --pr docs document work', customConfig),
    {
      mode: 'stacked',
      changeType: 'docs',
      context: 'document work',
      pullRequest: 'auto',
      flag: '--pr'
    }
  )
  const inferred = parseCommitArguments('describe the change', customConfig)
  assert.equal(inferred.changeType, undefined)
  assert.equal(inferred.context, 'describe the change')
  assert.equal(inferred.pullRequest, 'never')
})

test('parser rejects unknown, conflicting, duplicate, and incompatible flags', () => {
  for (const args of [
    '--pr --no-pr fix work',
    '--pr --pr fix work',
    '--wat fix work'
  ]) {
    assert.throws(() => parseCommitArguments(args, defaultConfig))
  }
  assert.throws(() => parseCommitArguments('stacked chore work', customConfig))
  assert.throws(() =>
    parseCommitArguments('stacked --no-pr fix work', defaultConfig)
  )
})
