import assert from 'node:assert/strict'
import test from 'node:test'

import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui'
import githubIssuesExtension from '../extensions/github-issues/index.ts'

const REPOSITORY = 'noice-tech/noice-pi'

function result(stdout = '', stderr = '', code = 0) {
  return { code, stdout, stderr, killed: false }
}

function createHarness(options = {}) {
  const commands = []
  const execCalls = []
  const notifications = []
  const pickerRenders = []
  const sentUserMessages = []
  const sessionNames = []
  let command
  let pickerCalls = 0

  const responses = {
    assigned: result(
      JSON.stringify(
        options.assignedIssues ?? [{ number: 7, title: 'Improve docs' }]
      )
    ),
    all: result(
      JSON.stringify(
        options.allIssues ?? [
          { number: 6, title: 'Add issue planning' },
          { number: 7, title: 'Improve docs' }
        ]
      )
    ),
    auth: result(),
    issue: result(
      JSON.stringify({
        number: 6,
        title: 'Add issue planning',
        state: 'OPEN',
        url: 'https://github.com/noice-tech/noice-pi/issues/6'
      })
    ),
    repo: result(JSON.stringify({ nameWithOwner: REPOSITORY })),
    version: result('gh version 2.88.1'),
    ...options.responses
  }

  const pi = {
    registerCommand(name, registered) {
      commands.push(name)
      if (name === 'plan-issue') command = registered
    },
    async exec(executable, args, execOptions) {
      execCalls.push({ executable, args, options: execOptions })
      if (options.resolveExec) return options.resolveExec(args)
      if (args[0] === '--version') return responses.version
      if (args[0] === 'auth') return responses.auth
      if (args[0] === 'repo') return responses.repo
      if (args[0] === 'issue' && args[1] === 'view') return responses.issue
      if (args[0] === 'issue' && args[1] === 'list') {
        return args.includes('@me') ? responses.assigned : responses.all
      }
      throw new Error(`Unexpected gh arguments: ${args.join(' ')}`)
    },
    setSessionName(name) {
      sessionNames.push(name)
    },
    sendUserMessage(message) {
      sentUserMessages.push(message)
    }
  }

  const theme = {
    bg(_color, text) {
      return text
    },
    bold(text) {
      return text
    },
    fg(_color, text) {
      return text
    }
  }
  const tui = { requestRender() {} }

  const ctx = {
    cwd: '/work/repository',
    mode: options.mode ?? 'tui',
    isIdle() {
      return options.idle ?? true
    },
    async waitForIdle() {
      options.onWaitForIdle?.()
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type })
      },
      async custom(factory) {
        pickerCalls++
        let completed = false
        let selected
        const component = await factory(
          tui,
          theme,
          getKeybindings(),
          (value) => {
            completed = true
            selected = value
          }
        )
        if ('focused' in component) component.focused = true
        pickerRenders.push(component.render(80))
        for (const input of options.pickerInputs ?? ['\r']) {
          component.handleInput?.(input)
          pickerRenders.push(component.render(80))
          if (completed) break
        }
        if (!completed) throw new Error('Picker test did not complete')
        return selected
      }
    }
  }

  githubIssuesExtension(pi)
  assert.deepEqual(commands, ['plan-issue'])
  assert.ok(command)

  return {
    execCalls,
    invoke: (args = '') => command.handler(args, ctx),
    notifications,
    pickerCalls: () => pickerCalls,
    pickerRenders,
    sentUserMessages,
    sessionNames
  }
}

test('/plan-issue 6 bypasses the picker and starts the exact lightweight turn', async () => {
  const harness = createHarness()

  await harness.invoke('6')

  assert.equal(harness.pickerCalls(), 0)
  assert.deepEqual(harness.sessionNames, ['#6 — Add issue planning'])
  assert.deepEqual(harness.sentUserMessages, [
    'Let’s plan solving issue #6 from GitHub.'
  ])

  const issueView = harness.execCalls.find(
    ({ args }) => args[0] === 'issue' && args[1] === 'view'
  )
  assert.ok(issueView)
  assert.deepEqual(issueView.args, [
    'issue',
    'view',
    '6',
    '--repo',
    REPOSITORY,
    '--json',
    'number,title,state,url'
  ])
  assert.equal(
    issueView.args.some((argument) => argument.includes('body')),
    false
  )
  assert.equal(
    harness.execCalls.some(({ args }) => args[1] === 'list'),
    false
  )
})

test('the picker defaults to issues assigned to me and filters by title', async () => {
  const harness = createHarness({ pickerInputs: ['D', 'o', 'c', 's', '\r'] })

  await harness.invoke()

  assert.equal(harness.pickerCalls(), 1)
  assert.ok(
    harness.pickerRenders[0].some((line) => line.includes('[Assigned to me]'))
  )
  assert.ok(
    harness.pickerRenders[0].some((line) => line.includes('#7  Improve docs'))
  )
  assert.equal(
    harness.pickerRenders[0].some((line) => line.includes('#6')),
    false
  )
  assert.deepEqual(harness.sessionNames, ['#7 — Improve docs'])
  assert.deepEqual(harness.sentUserMessages, [
    'Let’s plan solving issue #7 from GitHub.'
  ])

  const assignedCall = harness.execCalls.find(
    ({ args }) => args[1] === 'list' && args.includes('@me')
  )
  assert.ok(assignedCall)
  assert.ok(assignedCall.args.includes('--assignee'))
  assert.ok(assignedCall.args.includes('@me'))
  for (const render of harness.pickerRenders) {
    assert.ok(render.every((line) => visibleWidth(line) <= 80))
  }
})

test('Tab switches to all open issues and number search selects an issue', async () => {
  const harness = createHarness({
    assignedIssues: [],
    pickerInputs: ['\t', '6', '\r']
  })

  await harness.invoke()

  assert.ok(
    harness.pickerRenders[0].some((line) =>
      line.includes('No open issues assigned to you')
    )
  )
  assert.ok(
    harness.pickerRenders[1].some((line) => line.includes('[All open issues]'))
  )
  assert.deepEqual(harness.sessionNames, ['#6 — Add issue planning'])
  assert.deepEqual(harness.sentUserMessages, [
    'Let’s plan solving issue #6 from GitHub.'
  ])
})

test('cancelling the picker does not rename the session or start a turn', async () => {
  const harness = createHarness({ pickerInputs: ['\x1b'] })

  await harness.invoke()

  assert.deepEqual(harness.sessionNames, [])
  assert.deepEqual(harness.sentUserMessages, [])
  assert.deepEqual(harness.notifications, [])
})

const errorCases = [
  {
    name: 'missing gh',
    options: { responses: { version: result('', 'command not found', 127) } },
    expected: /GitHub CLI \(gh\) is required but was not found/
  },
  {
    name: 'missing authentication',
    options: { responses: { auth: result('', 'not logged in', 1) } },
    expected: /gh auth login/
  },
  {
    name: 'gh timeout',
    options: {
      responses: { version: { ...result(), killed: true } }
    },
    expected: /GitHub CLI timed out while running `gh --version`/
  },
  {
    name: 'non-GitHub repository',
    options: {
      responses: {
        repo: result(
          '',
          'none of the git remotes configured for this repository point to a known GitHub host',
          1
        )
      }
    },
    expected: /current directory is not a GitHub repository/
  },
  {
    name: 'empty open issue list',
    options: { assignedIssues: [], allIssues: [] },
    expected: /No open GitHub issues found in noice-tech\/noice-pi/
  },
  {
    name: 'malformed gh output',
    options: { responses: { assigned: result('{not json') } },
    expected: /malformed assigned issue data/
  },
  {
    name: 'GitHub API failure',
    options: {
      responses: {
        assigned: result('', 'HTTP 502: upstream unavailable', 1)
      }
    },
    expected: /Failed to load issues assigned to you.*HTTP 502/
  }
]

for (const { name, options, expected } of errorCases) {
  test(`reports a clear error for ${name}`, async () => {
    const harness = createHarness(options)

    await harness.invoke()

    assert.equal(harness.notifications.length, 1)
    assert.equal(harness.notifications[0].type, 'error')
    assert.match(harness.notifications[0].message, expected)
    assert.deepEqual(harness.sessionNames, [])
    assert.deepEqual(harness.sentUserMessages, [])
  })
}

test('rejects malformed direct issue metadata without renaming or prompting', async () => {
  const harness = createHarness({
    responses: { issue: result(JSON.stringify({ number: 6, title: '' })) }
  })

  await harness.invoke('6')

  assert.match(harness.notifications[0].message, /malformed data for issue #6/)
  assert.deepEqual(harness.sessionNames, [])
  assert.deepEqual(harness.sentUserMessages, [])
})

test('validates direct arguments before invoking gh', async () => {
  const harness = createHarness()

  await harness.invoke('#6')

  assert.equal(harness.execCalls.length, 0)
  assert.match(harness.notifications[0].message, /positive issue number/)
})
