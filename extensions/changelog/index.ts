import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHANGE_TYPES = [
  "auto",
  "feat",
  "fix",
  "improve",
  "internal",
  "ignore",
] as const;
type ChangeType = (typeof CHANGE_TYPES)[number];

const CHANGE_TYPE_OPTIONS: Array<{ type: ChangeType; label: string }> = [
  {
    type: "auto",
    label: "auto - Let commit worker infer from session and diff",
  },
  { type: "feat", label: "feat - New user-facing capability" },
  { type: "fix", label: "fix - User-facing bug fix" },
  {
    type: "improve",
    label: "improve - User-facing refinement/performance/reliability",
  },
  {
    type: "internal",
    label: "internal - Infra/tooling/tests/refactor/deps/logging",
  },
  { type: "ignore", label: "ignore - No changelog/release value" },
];

const MESSAGE_TYPE = "noice-changelog-commit-result";
const PROMPT_MESSAGE_TYPE = "noice-changelog-commit-worker-prompt";
const STATUS_KEY = "noice-changelog";

interface CommitResultDetails {
  changeType: ChangeType;
  userContext: string;
  workerLeafId?: string | null;
}

let commitWorkerRunning = false;
let agentEndWaiter: ((messages: unknown[]) => void) | undefined;

export default function noiceChangelogExtension(pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    agentEndWaiter?.(event.messages);
    agentEndWaiter = undefined;
  });

  pi.on("context", (event) => {
    return {
      messages: event.messages.filter((message) => {
        const customType = (message as { customType?: string }).customType;
        if (customType === MESSAGE_TYPE) return false;
        if (customType === PROMPT_MESSAGE_TYPE && !commitWorkerRunning)
          return false;
        return true;
      }),
    };
  });

  pi.registerMessageRenderer<CommitResultDetails>(
    MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      const c = new Container();
      c.addChild(
        new Text(
          `${theme.fg("success", "ok")} ${theme.fg("toolTitle", theme.bold("commit"))}${details?.changeType ? ` ${theme.fg("accent", details.changeType)}` : ""}`,
          0,
          0,
        ),
      );

      if (details?.userContext) {
        c.addChild(
          new Text(theme.fg("dim", `Context: ${details.userContext}`), 0, 0),
        );
      }

      c.addChild(new Spacer(1));
      c.addChild(
        new Markdown(
          typeof message.content === "string" ? message.content : "",
          0,
          0,
          getMarkdownTheme(),
        ),
      );

      if (details?.workerLeafId) {
        c.addChild(new Spacer(1));
        c.addChild(
          new Text(
            theme.fg("dim", `Worker branch: ${details.workerLeafId}`),
            0,
            0,
          ),
        );
      }

      return c;
    },
  );

  pi.registerCommand("commit", {
    description:
      "Commit changes and create or update PR using Noice changelog rules",
    getArgumentCompletions: (prefix) => {
      const matches = CHANGE_TYPES.filter((type) => type.startsWith(prefix));
      return matches.length > 0
        ? matches.map((type) => ({ value: type, label: type }))
        : null;
    },
    handler: async (args, ctx) => {
      if (commitWorkerRunning) {
        ctx.ui.notify("Commit worker is already running", "warning");
        return;
      }

      await ctx.waitForIdle();

      const parsed = await resolveChangeTypeAndContext(args, ctx);
      if (!parsed) return;

      const startLeafId = ctx.sessionManager.getLeafId();
      const prompt = await buildWorkerPrompt(parsed.changeType, parsed.context);

      commitWorkerRunning = true;
      ctx.ui.setStatus(STATUS_KEY, "running in session branch...");
      ctx.ui.notify(`Starting commit worker (${parsed.changeType})`, "info");

      try {
        const agentEnd = waitForNextAgentEnd();
        pi.sendMessage(
          {
            customType: PROMPT_MESSAGE_TYPE,
            content: prompt,
            display: false,
            details: {
              changeType: parsed.changeType,
              userContext: parsed.context,
            },
          },
          { triggerTurn: true },
        );
        const messages = await agentEnd;

        const workerLeafId = ctx.sessionManager.getLeafId();
        const summary =
          extractLastAssistantText(messages) || "Commit worker finished.";

        if (startLeafId && workerLeafId && workerLeafId !== startLeafId) {
          const nav = await ctx.navigateTree(startLeafId, { summarize: false });
          if (nav.cancelled) {
            ctx.ui.notify(
              "Commit finished, but tree navigation was cancelled",
              "warning",
            );
            return;
          }
        }

        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: summary,
          display: true,
          details: {
            changeType: parsed.changeType,
            userContext: parsed.context,
            workerLeafId,
          },
        });
        ctx.ui.notify("Commit worker finished", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (startLeafId)
          await ctx.navigateTree(startLeafId, { summarize: false });
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `Commit worker failed: ${message}`,
          display: true,
          details: {
            changeType: parsed.changeType,
            userContext: parsed.context,
          },
        });
        ctx.ui.notify(`Commit worker failed: ${message}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        commitWorkerRunning = false;
      }
    },
  });
}

async function resolveChangeTypeAndContext(
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<{ changeType: ChangeType; context: string } | null> {
  const trimmedArgs = args?.trim() ?? "";
  const [firstWord = "", ...rest] = trimmedArgs.split(/\s+/);

  if (isChangeType(firstWord)) {
    return { changeType: firstWord, context: rest.join(" ").trim() };
  }

  const selected = await ctx.ui.select(
    "Change type",
    CHANGE_TYPE_OPTIONS.map((option) => option.label),
  );
  if (!selected) return null;

  const option = CHANGE_TYPE_OPTIONS.find((item) =>
    selected.startsWith(item.type),
  );
  if (!option) return null;

  return { changeType: option.type, context: trimmedArgs };
}

function isChangeType(value: string): value is ChangeType {
  return CHANGE_TYPES.includes(value as ChangeType);
}

async function buildWorkerPrompt(changeType: ChangeType, userContext: string) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const [template, rules] = await Promise.all([
    readFile(join(extensionDir, "worker-prompt.md"), "utf-8"),
    readFile(join(extensionDir, "rules.md"), "utf-8"),
  ]);

  return template
    .replaceAll("{{changeType}}", changeType)
    .replaceAll("{{userContext}}", userContext || "(none)")
    .replaceAll("{{rules}}", rules);
}

function waitForNextAgentEnd() {
  return new Promise<unknown[]>((resolve) => {
    agentEndWaiter = resolve;
  });
}

function extractLastAssistantText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;

    const text = extractTextFromContent(message.content).trim();
    if (text) return text;
  }

  return "";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
