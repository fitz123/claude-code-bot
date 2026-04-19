import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = resolve(__dirname, "../../scripts/restart-bot.sh");

// Mock launchctl: writes / reads a key=value state file in $STATE_DIR/state.
// Supports: list, kill <sig> <svc>, bootout <svc>, bootstrap <domain> <plist>.
// Timing is driven by optional keys: kill_delay, bootout_delay (seconds).
const MOCK_LAUNCHCTL = `#!/bin/bash
set -uo pipefail
STATE="\${STATE_DIR}/state"
touch "\$STATE"

get() { awk -F= -v k="\$1" 'BEGIN{v=""} $1==k {v=$0; sub(/^[^=]*=/,"",v)} END{print v}' "\$STATE"; }
set_kv() {
  tmp="\$STATE.tmp"
  awk -F= -v k="\$1" '$1!=k' "\$STATE" > "\$tmp"
  printf '%s=%s\\n' "\$1" "\$2" >> "\$tmp"
  mv "\$tmp" "\$STATE"
}
del_kv() {
  tmp="\$STATE.tmp"
  awk -F= -v k="\$1" '$1!=k' "\$STATE" > "\$tmp"
  mv "\$tmp" "\$STATE"
}
now() { date +%s; }

apply() {
  kat=\$(get kill_at)
  bat=\$(get bootout_at)
  if [ -n "\$kat" ] && [ "\$(now)" -ge "\$kat" ]; then
    np=\$(get next_pid); [ -z "\$np" ] && np=99999
    set_kv pid "\$np"
    del_kv kill_at
  fi
  if [ -n "\$bat" ] && [ "\$(now)" -ge "\$bat" ]; then
    set_kv registered 0
    del_kv pid
    del_kv bootout_at
  fi
}

cmd="\${1:-}"; shift || true
case "\$cmd" in
  list)
    apply
    if [ "\$(get registered)" = "1" ]; then
      label=\$(get label); [ -z "\$label" ] && label="ai.minime.telegram-bot"
      pid=\$(get pid); [ -z "\$pid" ] && pid="-"
      printf 'PID\\tStatus\\tLabel\\n'
      printf '%s\\t0\\t%s\\n' "\$pid" "\$label"
    fi
    ;;
  kill)
    apply
    delay=\$(get kill_delay); [ -z "\$delay" ] && delay=0
    set_kv kill_at \$(( \$(now) + delay ))
    ;;
  bootout)
    apply
    delay=\$(get bootout_delay); [ -z "\$delay" ] && delay=0
    set_kv bootout_at \$(( \$(now) + delay ))
    ;;
  bootstrap)
    apply
    if [ "\$(get registered)" = "1" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    plist_path="\${2:-}"
    if [ -n "\$plist_path" ] && [ -f "\$plist_path" ]; then
      sig=\$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha1').update(fs.readFileSync(process.argv[1])).digest('hex'))" "\$plist_path")
      set_kv bootstrapped_sig "\$sig"
    fi
    np=\$(get next_pid); [ -z "\$np" ] && np=99999
    set_kv pid "\$np"
    set_kv registered 1
    ;;
  *)
    echo "mock-launchctl: unknown command: \$cmd" >&2
    exit 1
    ;;
esac
`;

type Harness = {
  dir: string;
  launchctl: string;
  plist: string;
  stateDir: string;
  setState(kv: Record<string, string | number>): void;
  readState(): Record<string, string>;
  writePlist(content: string): void;
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
};

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "restart-bot-test-"));
  const launchctl = join(dir, "launchctl");
  const stateDir = join(dir, "state-dir");
  const plist = join(dir, "ai.minime.telegram-bot.plist");
  writeFileSync(launchctl, MOCK_LAUNCHCTL);
  chmodSync(launchctl, 0o755);
  writeFileSync(plist, "<plist>initial</plist>");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "state");

  const setState = (kv: Record<string, string | number>) => {
    const existing: Record<string, string> = {};
    if (existsSync(stateFile)) {
      for (const line of readFileSync(stateFile, "utf8").split("\n")) {
        if (!line) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        existing[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    for (const [k, v] of Object.entries(kv)) existing[k] = String(v);
    writeFileSync(
      stateFile,
      Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    );
  };

  const readState = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!existsSync(stateFile)) return out;
    for (const line of readFileSync(stateFile, "utf8").split("\n")) {
      if (!line) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  };

  const writePlist = (content: string) => writeFileSync(plist, content);

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(SCRIPT, args, {
      env: {
        ...process.env,
        LAUNCHCTL_BIN: launchctl,
        BOT_LABEL: "ai.minime.telegram-bot",
        BOT_PLIST: plist,
        BOT_UID: "501",
        STATE_DIR: stateDir,
        POLL_INTERVAL: "0.1",
        SHUTDOWN_TIMEOUT: "30",
        TEARDOWN_TIMEOUT: "30",
        STARTUP_TIMEOUT: "20",
        CONFIG_VALIDATE_BIN: "true",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  return { dir, launchctl, plist, stateDir, setState, readState, writePlist, run };
}

function cleanup(h: Harness) {
  rmSync(h.dir, { recursive: true, force: true });
}

describe("restart-bot.sh", () => {
  it("prints usage and exits 0 for --help", () => {
    const h = createHarness();
    try {
      const { status, stdout } = h.run(["--help"]);
      assert.strictEqual(status, 0);
      assert.match(stdout, /Usage:/);
      assert.match(stdout, /--plist/);
    } finally {
      cleanup(h);
    }
  });

  it("does not blow up when HOME is unset (launchd context)", () => {
    const h = createHarness();
    try {
      // Regression: `set -u` + `${BOT_PLIST:-$HOME/...}` crashed when HOME was unset.
      // Drop HOME from the inherited env; --help should still print and exit 0.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.HOME;
      const result = spawnSync(SCRIPT, ["--help"], {
        env: env as Record<string, string>,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:/);
      assert.doesNotMatch(result.stderr, /unbound variable/);
    } finally {
      cleanup(h);
    }
  });

  it("exits 2 with usage on unknown argument", () => {
    const h = createHarness();
    try {
      const { status, stderr } = h.run(["--bogus"]);
      assert.strictEqual(status, 2);
      assert.match(stderr, /unknown argument/);
      assert.match(stderr, /Usage:/);
    } finally {
      cleanup(h);
    }
  });

  it("graceful: returns new PID and exits 0", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222, kill_delay: 0 });
      const { status, stdout, stderr } = h.run([]);
      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      assert.match(stdout, /New PID: 2222/);
      assert.match(stdout.trim(), /2222\s*$/m);
      const state = h.readState();
      assert.strictEqual(state.pid, "2222");
    } finally {
      cleanup(h);
    }
  });

  it("graceful: refuses when service is not registered", () => {
    const h = createHarness();
    try {
      const { status, stderr } = h.run([]);
      assert.notStrictEqual(status, 0);
      assert.match(stderr, /not registered/);
    } finally {
      cleanup(h);
    }
  });

  it("graceful: tolerates a slow shutdown without racing teardown", () => {
    const h = createHarness();
    try {
      // Simulate a realistic drain: the old PID stays listed for several seconds
      // before KeepAlive swaps in the new PID. Script must keep polling the whole
      // time, not time out or declare success early.
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 3333, kill_delay: 5 });
      const start = Date.now();
      const { status, stdout, stderr } = h.run([]);
      const elapsedMs = Date.now() - start;
      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      // It really did wait for the drain to complete.
      // Script must have actually waited for the drain — not exited early.
      // Give ~500ms slack for 1-second mock-clock granularity and poll interval.
      assert.ok(elapsedMs >= 4000, `expected >= ~5s wait, got ${elapsedMs}ms`);
      assert.match(stdout, /New PID: 3333/);
    } finally {
      cleanup(h);
    }
  });

  it("graceful: aborts before SIGTERM when config validation fails", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });
      const { status, stdout, stderr } = h.run([], {
        CONFIG_VALIDATE_BIN: "false",
      });
      assert.notStrictEqual(status, 0);
      assert.match(stderr, /config validation failed/);
      // No kill_at was set -> kill was never sent.
      const state = h.readState();
      assert.ok(!("kill_at" in state), `expected no kill scheduled, got state: ${JSON.stringify(state)}`);
      assert.strictEqual(state.pid, "1111");
      assert.doesNotMatch(stdout, /Sending SIGTERM/);
    } finally {
      cleanup(h);
    }
  });

  it("--plist: new on-disk plist is reflected after success", () => {
    const h = createHarness();
    try {
      // Old plist content, bot currently running.
      h.writePlist("<plist>OLD</plist>");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 4444, bootout_delay: 2 });
      // Operator edits the plist on disk just before restart.
      h.writePlist("<plist>NEW_ENV_VAR=BAR</plist>");

      // Capture signature of the NEW plist (matches mock launchctl's sha1 digest).
      const newSig = createHash("sha1").update(readFileSync(h.plist)).digest("hex");

      const { status, stdout, stderr } = h.run(["--plist"]);
      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      assert.match(stdout, /New PID: 4444/);

      const state = h.readState();
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "4444");
      // Script bootstrapped from the NEW plist, not a cached one.
      assert.strictEqual(state.bootstrapped_sig, newSig);
    } finally {
      cleanup(h);
    }
  });

  it("--plist: does not race bootout teardown (bootstrap waits for unregister)", () => {
    const h = createHarness();
    try {
      // bootout takes 4s to drain. If the script didn't wait, bootstrap would
      // fire against a still-registered service and get EIO.
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 5555, bootout_delay: 4 });
      const start = Date.now();
      const { status, stdout, stderr } = h.run(["--plist"]);
      const elapsedMs = Date.now() - start;
      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      assert.ok(elapsedMs >= 3500, `expected >= ~4s wait, got ${elapsedMs}ms`);
      assert.match(stdout, /New PID: 5555/);
      assert.doesNotMatch(stderr, /Input\/output error/);
    } finally {
      cleanup(h);
    }
  });

  it("--plist: aborts when config validation fails", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 4444 });
      const { status, stderr } = h.run(["--plist"], { CONFIG_VALIDATE_BIN: "false" });
      assert.notStrictEqual(status, 0);
      assert.match(stderr, /config validation failed/);
      const state = h.readState();
      // No bootout scheduled.
      assert.ok(!("bootout_at" in state));
      assert.strictEqual(state.pid, "1111");
    } finally {
      cleanup(h);
    }
  });

  it("--plist: fails cleanly when plist file is missing", () => {
    const h = createHarness();
    try {
      rmSync(h.plist);
      const { status, stderr } = h.run(["--plist"]);
      assert.notStrictEqual(status, 0);
      assert.match(stderr, /plist not found/);
    } finally {
      cleanup(h);
    }
  });
});
