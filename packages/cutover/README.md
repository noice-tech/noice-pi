# @noice-tech/pi-cutover

One command from plan to implementation.

## Install

```bash
pi install npm:@noice-tech/pi-cutover
```

## Usage

First, work with Pi until its latest response is the final implementation plan. Ask it not to implement the plan yet. Then run:

```text
/cutover
```

Cutover takes over from there without further interaction:

1. waits for the current turn to finish;
2. saves the latest assistant response from the active session branch to a temporary Markdown file;
3. compacts the session using Pi's normal compaction behavior; and
4. starts a new turn with `Implement the plan from <path>`.

The plan is stored as `plan.md` in a unique `pi-cutover-*` directory under the operating system's temporary directory. Cutover reports the path and intentionally leaves it in place so the implementation turn can reread it. Normal operating-system temporary-file cleanup applies.

If saving or compaction fails, Cutover does not start implementation. A compaction error includes the saved plan path so you can recover manually.

## Why cut over?

Long planning conversations accumulate exploration, rejected approaches, tool output, and repeated context. All of it competes with the final plan for the model's attention during implementation.

Cutover keeps the durable artifact—the agreed plan—outside the conversation, compacts the planning history, and then gives the implementation turn one unambiguous instruction pointing to that artifact. This reduces irrelevant context without discarding Pi's compacted record of the decisions that led there.

Cutover is a focused workflow helper, not a replacement for deliberate context management. Use Pi's `/tree`, `/fork`, and other session tools when you need to revisit decisions or preserve alternate branches.

## Further reading

- Anthropic, [“Effective context engineering for AI agents”](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Chroma Research, [“Context Rot: How Increasing Input Tokens Impacts LLM Performance”](https://www.trychroma.com/research/context-rot)
- JetBrains Research, [“The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management”](https://github.com/JetBrains-Research/the-complexity-trap)
