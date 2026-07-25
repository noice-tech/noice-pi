import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateCommitProse } from '../extensions/changelog/commit-workflow.ts'

const readAsset = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), 'utf8')

test('commit prose enforces unscoped commits and layout-derived PR scopes', () => {
  const base = {
    commitType: 'fix',
    commitMessage: 'fix: prevent hidden tracks from rendering',
    prType: 'fix',
    prHeadline: 'prevent hidden tracks from rendering',
    summary: ['Prevent hidden tracks from being rendered.'],
    publicSummary: 'Hidden tracks no longer appear in rendered output.',
    context: ['Applies to renderer output.']
  }
  assert.equal(
    validateCommitProse(base, 'fix', 'renderer').prTitle,
    'fix(renderer): prevent hidden tracks from rendering'
  )
  assert.throws(
    () =>
      validateCommitProse(
        {
          ...base,
          commitMessage: 'fix(renderer): prevent hidden tracks from rendering'
        },
        'fix',
        'renderer'
      ),
    /unscoped/
  )
  assert.throws(
    () =>
      validateCommitProse(
        {
          ...base,
          prHeadline: 'fix(editor): prevent hidden tracks from rendering'
        },
        'fix',
        'renderer'
      ),
    /must not include/
  )
  assert.equal(
    validateCommitProse(base, 'fix', null).prTitle,
    'fix: prevent hidden tracks from rendering'
  )
})

test('changelog prompts accept scoped and unscoped titles without publishing scopes', async () => {
  const prompts = await Promise.all([
    readAsset('../prompts/unreleased.md'),
    readAsset('../prompts/release-notes.md')
  ])

  for (const prompt of prompts) {
    assert.match(prompt, /unscoped `type: description`/i)
    assert.match(prompt, /package-scoped `type\(package\): description`/i)
    assert.match(prompt, /whether scoped or unscoped/i)
    assert.match(prompt, /include[^\n]+`feat`, `fix`, and `improve`/i)
    assert.match(prompt, /skip `internal`/i)
    assert.match(prompt, /must not be copied into public changelog text/i)
  }
})
