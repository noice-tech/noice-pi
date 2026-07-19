import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readAsset = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), 'utf8')

test('commit worker keeps commits unscoped and scopes only multi-package PR titles', async () => {
  const [rules, workerPrompt] = await Promise.all([
    readAsset('../extensions/changelog/rules.md'),
    readAsset('../extensions/changelog/worker-prompt.md')
  ])
  const contract = `${rules}\n${workerPrompt}`

  assert.match(
    contract,
    /single-package repository or workspace[^\n]+`type: description`/i
  )
  assert.match(
    contract,
    /multi-package workspace[^\n]+`type\(package\): description`/i
  )
  assert.match(contract, /commit messages always[^\n]+unscoped/i)
  assert.match(contract, /workspace directory basename/i)
  assert.match(rules, /count distinct package roots/i)
  assert.match(rules, /private root manifest[^\n]+does not count/i)
  assert.match(rules, /two or more[^\n]+multi-package workspace/i)
  assert.match(
    workerPrompt,
    /after committing the current changes so the diff includes them/i
  )
  assert.match(
    workerPrompt,
    /PR title must describe the cumulative full branch/i
  )
  assert.match(workerPrompt, /do not let the latest delta replace/i)
  assert.match(
    workerPrompt,
    /primary source for the current commit wording[^\n]+current change/i
  )
  assert.doesNotMatch(workerPrompt, /primary source for commit\/PR wording/i)
  assert.match(contract, /incidental shared files/i)
  assert.match(contract, /use exactly one (?:package )?scope/i)
  assert.match(contract, /`type\(monorepo\): description`/i)
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
