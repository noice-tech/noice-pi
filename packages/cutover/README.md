# @noice-tech/pi-cutover

One command from plan to implementation.

## Install

```bash
pi install npm:@noice-tech/pi-cutover
```

## Usage

Work with Pi until you are ready to turn the discussion into an implementation plan, then run:

```text
/cutover
```

Cutover takes over from there without further interaction:

1. waits for the current turn to finish;
2. creates an empty `plan.md` in a unique operating-system temporary directory;
3. explicitly asks the agent to replace that file with a complete plan, without implementing it;
4. ignores the planning response and verifies directly that the known plan file is non-empty;
5. compacts the session using Pi's normal compaction behavior; and
6. starts a new turn with `Implement the plan from <path>`.

Cutover does not copy, infer, or parse a plan from an assistant response. The dedicated planning turn writes the durable artifact directly to the extension-provided path.

Cutover intentionally leaves the temporary plan in place so the implementation turn can reread it. Normal operating-system temporary-file cleanup applies.

If planning, file verification, or compaction fails, Cutover does not start implementation. Errors report the plan path when available so you can inspect and recover it manually.

## Why cut over?

Long planning conversations accumulate exploration, rejected approaches, tool output, and repeated context. All of it competes with the final plan for the model's attention during implementation.

Cutover keeps the durable artifact—the agreed plan—outside the conversation, compacts the planning history, and then gives the implementation turn one unambiguous instruction pointing to that artifact. This reduces irrelevant context without discarding Pi's compacted record of the decisions that led there.

Cutover is a focused workflow helper, not a replacement for deliberate context management. Use Pi's `/tree`, `/fork`, and other session tools when you need to revisit decisions or preserve alternate branches.

## Further reading

- Anthropic, [“Effective context engineering for AI agents”](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Chroma Research, [“Context Rot: How Increasing Input Tokens Impacts LLM Performance”](https://www.trychroma.com/research/context-rot)
- JetBrains Research, [“The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management”](https://github.com/JetBrains-Research/the-complexity-trap)
