import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSopsSecret,
  resolveSecret,
  SecretResolutionError,
  SecretSourceError,
  sopsExtractExpression,
  type ExecFileSyncLike,
} from "../secrets.js";

describe("SOPS extract expression conversion", () => {
  it("converts safe dot paths into sops extract expressions", () => {
    assert.equal(sopsExtractExpression("tavily.api_key"), '["tavily"]["api_key"]');
    assert.equal(sopsExtractExpression("telegram.bot-token_1"), '["telegram"]["bot-token_1"]');
  });

  it("rejects unsafe path segments", () => {
    for (const key of ["", ".foo", "foo.", "foo..bar", "foo/bar", "foo[bar]", "foo bar", "foo.$bar"]) {
      assert.throws(
        () => sopsExtractExpression(key),
        (err: unknown) => err instanceof SecretSourceError &&
          err.failure.source === "sops" &&
          err.failure.kind === "invalid-key",
      );
    }
  });
});

describe("SOPS secret reader", () => {
  it("calls sops with a safe extract expression and trims stdout", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const file = join(tmpDir, "secrets.sops.yaml");
    writeFileSync(file, "placeholder: true\n", "utf8");
    const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
    const execFileSync: ExecFileSyncLike = (cmd, args, options) => {
      calls.push({ file: cmd, args, timeout: options.timeout });
      return "value-from-sops\n";
    };

    try {
      assert.equal(readSopsSecret({ file, key: "tavily.api_key", execFileSync }), "value-from-sops");
      assert.deepEqual(calls, [{
        file: "sops",
        args: ["-d", "--extract", '["tavily"]["api_key"]', file],
        timeout: 10_000,
      }]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid keys before invoking sops", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const file = join(tmpDir, "secrets.sops.yaml");
    writeFileSync(file, "placeholder: true\n", "utf8");
    let calls = 0;
    const execFileSync: ExecFileSyncLike = () => {
      calls += 1;
      return "should-not-run\n";
    };

    try {
      assert.throws(
        () => readSopsSecret({ file, key: "tavily.api key", execFileSync }),
        (err: unknown) => err instanceof SecretSourceError &&
          err.failure.source === "sops" &&
          err.failure.kind === "invalid-key" &&
          err.failure.key === "tavily.api key",
      );
      assert.equal(calls, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports a missing SOPS file without invoking sops", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const missingFile = join(tmpDir, "missing.sops.yaml");
    let calls = 0;
    const execFileSync: ExecFileSyncLike = () => {
      calls += 1;
      return "should-not-run\n";
    };

    try {
      assert.throws(
        () => readSopsSecret({ file: missingFile, key: "tavily.api_key", execFileSync }),
        (err: unknown) => err instanceof SecretSourceError &&
          err.failure.source === "sops" &&
          err.failure.kind === "missing-file" &&
          err.failure.key === "tavily.api_key",
      );
      assert.equal(calls, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports decrypt failures without leaking command stderr text", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const file = join(tmpDir, "secrets.sops.yaml");
    writeFileSync(file, "placeholder: true\n", "utf8");
    const execFileSync: ExecFileSyncLike = () => {
      throw Object.assign(new Error("sensitive stderr text"), { status: 1 });
    };

    try {
      assert.throws(
        () => readSopsSecret({ file, key: "tavily.api_key", execFileSync }),
        (err: unknown) => {
          assert.ok(err instanceof SecretSourceError);
          assert.equal(err.failure.source, "sops");
          assert.equal(err.failure.kind, "decrypt-failed");
          assert.equal(err.failure.key, "tavily.api_key");
          assert.doesNotMatch(err.message, /sensitive stderr text/);
          return true;
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports sops timeout without leaking command stderr text", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const file = join(tmpDir, "secrets.sops.yaml");
    writeFileSync(file, "placeholder: true\n", "utf8");
    const execFileSync: ExecFileSyncLike = () => {
      throw Object.assign(new Error("sensitive timeout stderr text"), { signal: "SIGTERM" });
    };

    try {
      assert.throws(
        () => readSopsSecret({ file, key: "tavily.api_key", execFileSync }),
        (err: unknown) => {
          assert.ok(err instanceof SecretSourceError);
          assert.equal(err.failure.source, "sops");
          assert.equal(err.failure.kind, "timeout");
          assert.equal(err.failure.key, "tavily.api_key");
          assert.doesNotMatch(err.message, /sensitive timeout stderr text/);
          return true;
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("secret resolver", () => {
  function withSopsFile(fn: (file: string) => void): void {
    const tmpDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    const file = join(tmpDir, "secrets.sops.yaml");
    writeFileSync(file, "placeholder: true\n", "utf8");
    try {
      fn(file);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("uses SOPS before env when SOPS succeeds", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => "value-from-sops\n";

    const value = resolveSecret({
      sopsFile,
      sopsKey: "telegram.bot_token",
      envVar: "TELEGRAM_BOT_TOKEN",
      fieldName: "telegramToken",
      env: { TELEGRAM_BOT_TOKEN: "value-from-env" },
      execFileSync,
    });

    assert.equal(value, "value-from-sops");
  }));

  it("falls back to env when SOPS returns a blank value", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => "\n";

    const value = resolveSecret({
      sopsFile,
      sopsKey: "discord.bot_token",
      envVar: "DISCORD_BOT_TOKEN",
      fieldName: "discord.token",
      env: { DISCORD_BOT_TOKEN: "value-from-env\n" },
      execFileSync,
    });

    assert.equal(value, "value-from-env");
  }));

  it("falls back to env when SOPS fails", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => {
      throw Object.assign(new Error("not included in sanitized error"), { status: 1 });
    };

    const value = resolveSecret({
      sopsFile,
      sopsKey: "discord.bot_token",
      envVar: "DISCORD_BOT_TOKEN",
      fieldName: "discord.token",
      env: { DISCORD_BOT_TOKEN: "value-from-env" },
      execFileSync,
    });

    assert.equal(value, "value-from-env");
  }));

  it("falls back to env when SOPS times out", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => {
      throw Object.assign(new Error("not included in sanitized error"), { signal: "SIGTERM" });
    };

    const value = resolveSecret({
      sopsFile,
      sopsKey: "discord.bot_token",
      envVar: "DISCORD_BOT_TOKEN",
      fieldName: "discord.token",
      env: { DISCORD_BOT_TOKEN: "value-from-env" },
      execFileSync,
    });

    assert.equal(value, "value-from-env");
  }));

  it("does not treat a global SOPS file as configured when this secret has no SOPS key", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => {
      throw new Error("sops should not be called without a per-secret key");
    };

    assert.throws(
      () => resolveSecret({
        sopsFile,
        envVar: "DISCORD_BOT_TOKEN",
        fieldName: "discord.token",
        env: {},
        execFileSync,
      }),
      (err: unknown) => {
        assert.ok(err instanceof SecretResolutionError);
        assert.deepEqual(err.failures, [
          { source: "env", kind: "unset", envVar: "DISCORD_BOT_TOKEN" },
        ]);
        assert.doesNotMatch(err.message, /SOPS/);
        return true;
      },
    );
  }));

  it("reports env blank as a missing-source error", () => {
    assert.throws(
      () => resolveSecret({
        envVar: "TELEGRAM_BOT_TOKEN",
        fieldName: "telegramToken",
        env: { TELEGRAM_BOT_TOKEN: "   " },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SecretResolutionError);
        assert.equal(err.failures[0]?.source, "env");
        assert.equal(err.failures[0]?.kind, "blank");
        assert.match(err.message, /env var 'TELEGRAM_BOT_TOKEN' failed \(blank\)/);
        return true;
      },
    );
  });

  it("returns sanitized aggregate errors when all configured sources fail", () => withSopsFile((sopsFile) => {
    const execFileSync: ExecFileSyncLike = () => {
      throw Object.assign(new Error("stderr might include sensitive text"), { code: "ENOENT" });
    };

    assert.throws(
      () => resolveSecret({
        sopsFile,
        sopsKey: "tavily.api_key",
        envVar: "TAVILY_API_KEY",
        fieldName: "tavily.apiKey",
        env: {},
        execFileSync,
      }),
      (err: unknown) => {
        assert.ok(err instanceof SecretResolutionError);
        assert.deepEqual(err.failures.map((failure) => failure.kind), ["command-not-found", "unset"]);
        assert.match(err.message, /SOPS key 'tavily\.api_key' failed \(command-not-found\)/);
        assert.match(err.message, /env var 'TAVILY_API_KEY' failed \(unset\)/);
        assert.doesNotMatch(err.message, /sensitive text/);
        return true;
      },
    );
  }));

  it("returns sanitized errors when no source is configured", () => {
    assert.throws(
      () => resolveSecret({ fieldName: "telegramToken", env: {} }),
      (err: unknown) => {
        assert.ok(err instanceof SecretResolutionError);
        assert.deepEqual(err.failures, [
          { source: "sops", kind: "not-configured" },
          { source: "env", kind: "not-configured" },
        ]);
        assert.match(err.message, /SOPS failed \(not-configured\)/);
        assert.match(err.message, /env var failed \(not-configured\)/);
        return true;
      },
    );
  });
});
