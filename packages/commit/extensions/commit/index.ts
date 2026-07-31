import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerCommit } from './register.ts'

export default function piCommitExtension(pi: ExtensionAPI) {
  registerCommit(pi)
}
