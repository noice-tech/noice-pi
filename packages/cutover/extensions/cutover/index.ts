import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export interface CutoverOptions {
  createPlanFile?: () => Promise<string>
  verifyPlan?: (path: string) => Promise<void>
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /[.!?]$/.test(message) ? message : `${message}.`
}

export async function createTemporaryPlanFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cutover-'))
  const planPath = join(directory, 'plan.md')
  await writeFile(planPath, '', { encoding: 'utf8', flag: 'wx' })
  return planPath
}

export function planRequest(path: string): string {
  return `Write a complete implementation plan for the work we have been discussing to ${path}. The empty file has already been created for you. Use your file-writing tools to replace its contents with the plan. Do not implement the plan yet. Once the plan has been written, stop.`
}

export async function verifyPlanWritten(path: string): Promise<void> {
  const content = await readFile(path, 'utf8')
  if (!content.trim()) {
    throw new Error(`The agent did not write a plan to ${path}`)
  }
}

export function createCutover(options: CutoverOptions = {}): ExtensionFactory {
  const createPlanFile = options.createPlanFile ?? createTemporaryPlanFile
  const verifyPlan = options.verifyPlan ?? verifyPlanWritten

  return (pi) => {
    let inProgress = false
    let pendingPlanPath: string | undefined

    pi.on('agent_settled', async (_event, ctx) => {
      if (!pendingPlanPath) return

      const planPath = pendingPlanPath
      pendingPlanPath = undefined

      try {
        await verifyPlan(planPath)
        ctx.ui.notify(
          `Plan written to ${planPath}. Compacting the session…`,
          'info'
        )

        ctx.compact({
          onComplete: () => {
            try {
              pi.sendUserMessage(`Implement the plan from ${planPath}`)
            } catch (error) {
              ctx.ui.notify(
                `Compaction completed, but implementation could not start: ${describeError(error)} The plan remains at ${planPath}.`,
                'error'
              )
            } finally {
              inProgress = false
            }
          },
          onError: (error) => {
            inProgress = false
            ctx.ui.notify(
              `Cutover could not compact the session: ${describeError(error)} The plan remains at ${planPath}.`,
              'error'
            )
          }
        })
      } catch (error) {
        inProgress = false
        ctx.ui.notify(
          `Cutover failed: ${describeError(error)} The plan file remains at ${planPath}.`,
          'error'
        )
      }
    })

    pi.registerCommand('cutover', {
      description: 'Write a plan to a temp file, compact, and implement it',
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

          planPath = await createPlanFile()
          pendingPlanPath = planPath
          pi.sendUserMessage(planRequest(planPath))
          ctx.ui.notify(
            `Asked the agent to write the plan to ${planPath}.`,
            'info'
          )
        } catch (error) {
          pendingPlanPath = undefined
          inProgress = false
          const createdFile = planPath
            ? ` The plan file remains at ${planPath}.`
            : ''
          ctx.ui.notify(
            `Cutover failed: ${describeError(error)}${createdFile}`,
            'error'
          )
        }
      }
    })
  }
}

export default createCutover()
