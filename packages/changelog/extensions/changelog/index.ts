import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerCommit } from 'pi-commit'

export default function noiceChangelogExtension(pi: ExtensionAPI) {
  registerCommit(pi)
}
