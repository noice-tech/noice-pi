import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionFactory,
  SessionEntry
} from '@earendil-works/pi-coding-agent'

export interface CutoverOptions {
  writePlan?: (content: string) => Promise<string>
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /[.!?]$/.test(message) ? message : `${message}.`
}

export function latestAssistantText(entries: readonly SessionEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.type !== 'message' || entry.message.role !== 'assistant') {
      continue
    }

    const text = entry.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()

    if (!text) {
      throw new Error('The latest assistant response has no text to save.')
    }

    return text
  }

  throw new Error('The current session branch has no assistant response.')
}

export async function writeTemporaryPlan(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cutover-'))
  const planPath = join(directory, 'plan.md')
  await writeFile(planPath, `${content.trim()}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
  return planPath
}

export function createCutover(options: CutoverOptions = {}): ExtensionFactory {
  const writePlan = options.writePlan ?? writeTemporaryPlan

  return (pi) => {
    let inProgress = false

    pi.registerCommand('cutover', {
      description: 'Save the latest plan, compact, and start implementation',
      handler: async (args, ctx) => {
        if (args.trim()) {
          ctx.ui.notify('Usage: /cutover', 'warning')
          return
        }

        if (inProgress) {
          ctx.ui.notify('A cutover is already in progress.', 'warning')
          return
        }

        inProgress = true
        let planPath: string | undefined

        try {
          if (!ctx.isIdle()) {
            ctx.ui.notify(
              'Waiting for the current turn before cutting over…',
              'info'
            )
          }
          await ctx.waitForIdle()

          const plan = latestAssistantText(ctx.sessionManager.getBranch())
          planPath = await writePlan(plan)
          const savedPlanPath = planPath
          ctx.ui.notify(
            `Saved the plan to ${savedPlanPath}. Compacting the session…`,
            'info'
          )

          ctx.compact({
            onComplete: () => {
              try {
                pi.sendUserMessage(`Implement the plan from ${savedPlanPath}`)
              } catch (error) {
                ctx.ui.notify(
                  `Compaction completed, but implementation could not start: ${describeError(error)} The plan remains at ${savedPlanPath}.`,
                  'error'
                )
              } finally {
                inProgress = false
              }
            },
            onError: (error) => {
              inProgress = false
              ctx.ui.notify(
                `Cutover could not compact the session: ${describeError(error)} The plan remains at ${savedPlanPath}.`,
                'error'
              )
            }
          })
        } catch (error) {
          inProgress = false
          const savedPlan = planPath ? ` The plan remains at ${planPath}.` : ''
          ctx.ui.notify(
            `Cutover failed: ${describeError(error)}${savedPlan}`,
            'error'
          )
        }
      }
    })
  }
}

export default createCutover()
