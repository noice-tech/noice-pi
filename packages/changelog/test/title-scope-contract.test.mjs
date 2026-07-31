import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readAsset = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), 'utf8')

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
