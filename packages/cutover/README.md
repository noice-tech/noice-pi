# @noice-tech/pi-cutover

Turn a Pi planning session into a clean implementation handoff with one command.

## Install

```bash
pi install -l npm:@noice-tech/pi-cutover
```

## Use

When the plan is settled, run:

```text
/cutover
```

Cutover then:

1. asks Pi to write the complete plan to a temporary file;
2. verifies that the plan file is not empty;
3. compacts the planning conversation; and
4. starts a new turn with `Implement the plan from <path>`.

The plan is written directly to the provided path—it is not copied or inferred from the assistant response. The temporary file remains available to the implementation turn and is later handled by normal operating-system cleanup.

If planning, verification, or compaction fails, implementation does not start. The error includes the plan path when available.

## Why use it?

Long planning sessions collect exploration, rejected ideas, and tool output. Cutover preserves the agreed plan as a durable file while reducing irrelevant implementation context.

Use Pi's `/tree` and `/fork` commands instead when you need to revisit decisions or keep alternate approaches.
