# Ralphex Notifications — Current Topic

If you don't launch `ralphex` (non-code agents), skip this rule.

When launching `ralphex` from a Telegram session that isn't the default Ops topic, set `RALPHEX_NOTIFY_THREAD=<current-thread-id>` so completion/error notifications come back to the same topic where the user requested the run.

The thread ID is in the chat header of every incoming message: `[Chat: <name> | Topic: <thread-id> | From: ...]`.

## How to apply

Include the env var in the `nohup ralphex` command:

```bash
cd <repo> && \
CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 \
RALPHEX_NOTIFY_THREAD=<thread-id> \
nohup ralphex --debug --no-color <plan-file> > <log> 2>&1 &
```

The `notify-minime.sh` script honors `RALPHEX_NOTIFY_THREAD` over its PWD heuristic (which only catches `*/.minime/bot*`).

## Why

User asks for the run from a specific topic — they want results delivered there, not in the default Ops feed. Otherwise the user has to switch topics to see whether their run completed.
