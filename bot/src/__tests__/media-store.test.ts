import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, symlinkSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  MEDIA_BASE,
  sessionMediaDir,
  ensureSessionMediaDir,
  cleanupSessionMediaDir,
  cleanupAllMedia,
  allocateMediaPath,
  enforceMediaCap,
} from "../media-store.js";

function resetMediaBase(): void {
  rmSync(MEDIA_BASE, { recursive: true, force: true });
}

describe("sessionMediaDir", () => {
  it("returns deterministic path under /tmp/bot-media", () => {
    assert.strictEqual(sessionMediaDir("chat123"), "/tmp/bot-media/chat123");
  });

  it("sanitizes unsafe characters in chatId", () => {
    assert.strictEqual(sessionMediaDir("tg:12345"), "/tmp/bot-media/tg_12345");
    assert.strictEqual(sessionMediaDir("../evil"), "/tmp/bot-media/___evil");
  });

  it("returns same path for same chatId", () => {
    assert.strictEqual(sessionMediaDir("abc"), sessionMediaDir("abc"));
  });
});

describe("ensureSessionMediaDir", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  it("creates the session dir when absent and returns its path", () => {
    const dir = ensureSessionMediaDir("chat-a");
    assert.ok(existsSync(dir), "dir should exist after ensure");
    assert.strictEqual(dir, "/tmp/bot-media/chat-a");
  });

  it("does NOT wipe existing files (protects early downloads)", () => {
    const dir = ensureSessionMediaDir("chat-b");
    const filePath = join(dir, "photo.jpg");
    writeFileSync(filePath, "content");

    ensureSessionMediaDir("chat-b");

    assert.ok(existsSync(filePath), "pre-existing file must survive ensure");
  });
});

describe("allocateMediaPath", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  it("returns a UUID path inside the session dir", () => {
    const path = allocateMediaPath("chat-x", "photo", ".jpg");
    assert.ok(path.startsWith("/tmp/bot-media/chat-x/photo-"));
    assert.ok(path.endsWith(".jpg"));
    assert.ok(existsSync(sessionMediaDir("chat-x")), "session dir should exist");
  });

  it("generates unique paths on each call", () => {
    const a = allocateMediaPath("chat-x", "doc", ".pdf");
    const b = allocateMediaPath("chat-x", "doc", ".pdf");
    assert.notStrictEqual(a, b);
  });

  it("isolates sessions: paths differ per chatId", () => {
    const a = allocateMediaPath("chat-1", "photo", ".jpg");
    const b = allocateMediaPath("chat-2", "photo", ".jpg");
    assert.ok(a.startsWith("/tmp/bot-media/chat-1/"));
    assert.ok(b.startsWith("/tmp/bot-media/chat-2/"));
  });
});

describe("cleanupSessionMediaDir", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  it("removes the session dir and all its files", () => {
    const p1 = allocateMediaPath("chat-a", "photo", ".jpg");
    const p2 = allocateMediaPath("chat-a", "doc", ".pdf");
    writeFileSync(p1, "x");
    writeFileSync(p2, "y");

    cleanupSessionMediaDir("chat-a");

    assert.ok(!existsSync(p1));
    assert.ok(!existsSync(p2));
    assert.ok(!existsSync(sessionMediaDir("chat-a")));
  });

  it("is a no-op for missing session dir", () => {
    assert.doesNotThrow(() => cleanupSessionMediaDir("nonexistent"));
  });

  it("leaves other sessions' files untouched", () => {
    const p1 = allocateMediaPath("chat-a", "photo", ".jpg");
    const p2 = allocateMediaPath("chat-b", "photo", ".jpg");
    writeFileSync(p1, "x");
    writeFileSync(p2, "y");

    cleanupSessionMediaDir("chat-a");

    assert.ok(!existsSync(p1), "chat-a file removed");
    assert.ok(existsSync(p2), "chat-b file preserved");
  });
});

describe("enforceMediaCap", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  function writeSized(path: string, size: number, mtime: number): void {
    writeFileSync(path, Buffer.alloc(size));
    utimesSync(path, mtime / 1000, mtime / 1000);
  }

  it("is a no-op when MEDIA_BASE does not exist", () => {
    assert.doesNotThrow(() => enforceMediaCap(100));
  });

  it("is a no-op when under cap", () => {
    const p = allocateMediaPath("chat-a", "doc", ".bin");
    writeFileSync(p, Buffer.alloc(100));

    enforceMediaCap(1000);

    assert.ok(existsSync(p));
  });

  it("evicts oldest files first until total ≤ cap (across sessions)", () => {
    const now = Date.now();
    const pOld = allocateMediaPath("chat-a", "doc", ".bin");
    const pMid = allocateMediaPath("chat-b", "doc", ".bin");
    const pNew = allocateMediaPath("chat-a", "doc", ".bin");
    writeSized(pOld, 100, now - 3000);
    writeSized(pMid, 100, now - 2000);
    writeSized(pNew, 100, now - 1000);

    // Total = 300, cap = 150 → evict oldest two (200 bytes removed, 100 remain)
    enforceMediaCap(150);

    assert.ok(!existsSync(pOld), "oldest evicted");
    assert.ok(!existsSync(pMid), "second-oldest evicted");
    assert.ok(existsSync(pNew), "newest preserved");
  });

  it("stops evicting as soon as under cap", () => {
    const now = Date.now();
    const p1 = allocateMediaPath("chat-a", "doc", ".bin");
    const p2 = allocateMediaPath("chat-a", "doc", ".bin");
    const p3 = allocateMediaPath("chat-a", "doc", ".bin");
    writeSized(p1, 100, now - 3000);
    writeSized(p2, 100, now - 2000);
    writeSized(p3, 100, now - 1000);

    // Total = 300, cap = 250 → evict only oldest (50 bytes over)
    enforceMediaCap(250);

    assert.ok(!existsSync(p1), "oldest evicted");
    assert.ok(existsSync(p2), "sufficient eviction — p2 preserved");
    assert.ok(existsSync(p3), "p3 preserved");
  });

  it("handles sessions with no files gracefully", () => {
    ensureSessionMediaDir("empty-chat");
    const p = allocateMediaPath("chat-a", "doc", ".bin");
    writeFileSync(p, Buffer.alloc(100));

    assert.doesNotThrow(() => enforceMediaCap(1000));
    assert.ok(existsSync(p));
  });
});

describe("ensureSessionMediaDir permissions", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  it("creates MEDIA_BASE and session dir with mode 0o700", () => {
    const dir = ensureSessionMediaDir("chat-perm");
    // Mask off file-type bits; check only permission bits.
    assert.strictEqual(statSync(MEDIA_BASE).mode & 0o777, 0o700);
    assert.strictEqual(statSync(dir).mode & 0o777, 0o700);
  });

  it("chmods an existing loose-permission MEDIA_BASE to 0o700", () => {
    // Simulate pre-squat: another process created the dir with loose perms.
    mkdirSync(MEDIA_BASE, { recursive: true, mode: 0o755 });
    assert.strictEqual(statSync(MEDIA_BASE).mode & 0o777, 0o755);

    ensureSessionMediaDir("chat-tighten");

    assert.strictEqual(statSync(MEDIA_BASE).mode & 0o777, 0o700);
  });

  it("chmods an existing loose-permission session dir to 0o700", () => {
    mkdirSync(sessionMediaDir("chat-loose"), { recursive: true, mode: 0o755 });
    assert.strictEqual(statSync(sessionMediaDir("chat-loose")).mode & 0o777, 0o755);

    ensureSessionMediaDir("chat-loose");

    assert.strictEqual(statSync(sessionMediaDir("chat-loose")).mode & 0o777, 0o700);
  });

  it("refuses to use MEDIA_BASE if it is a symlink", () => {
    const decoy = "/tmp/bot-media-decoy-target";
    rmSync(decoy, { recursive: true, force: true });
    mkdirSync(decoy, { recursive: true, mode: 0o700 });
    rmSync(MEDIA_BASE, { recursive: true, force: true });
    symlinkSync(decoy, MEDIA_BASE);

    try {
      assert.throws(() => ensureSessionMediaDir("chat-symlink"), /symlink/);
    } finally {
      rmSync(MEDIA_BASE, { force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe("cleanupAllMedia", () => {
  beforeEach(resetMediaBase);
  afterEach(resetMediaBase);

  it("removes the entire media root and every session's files", () => {
    const a = allocateMediaPath("chat-a", "photo", ".jpg");
    const b = allocateMediaPath("chat-b", "doc", ".pdf");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    assert.ok(existsSync(a) && existsSync(b));

    cleanupAllMedia();

    assert.ok(!existsSync(MEDIA_BASE), "media root removed");
    assert.ok(!existsSync(a));
    assert.ok(!existsSync(b));
  });

  it("is a no-op when the media root is absent", () => {
    rmSync(MEDIA_BASE, { recursive: true, force: true });
    assert.doesNotThrow(() => cleanupAllMedia());
  });
});

describe("enforceMediaCap error handling", () => {
  const blockedDir = sessionMediaDir("chat-blocked");

  beforeEach(resetMediaBase);
  afterEach(() => {
    // Restore permissions so resetMediaBase can traverse/remove the tree.
    try { chmodSync(blockedDir, 0o700); } catch { /* ignore */ }
    resetMediaBase();
  });

  it("does not throw when a session dir is unreadable", (t) => {
    // Skip on root: root bypasses permission checks so chmod 0 has no effect.
    if (process.getuid?.() === 0) {
      t.skip("cannot simulate EACCES as root");
      return;
    }

    const p = allocateMediaPath("chat-readable", "doc", ".bin");
    writeFileSync(p, Buffer.alloc(100));

    ensureSessionMediaDir("chat-blocked");
    writeFileSync(join(blockedDir, "file.bin"), Buffer.alloc(100));
    chmodSync(blockedDir, 0o000);

    // Must not throw — best-effort eviction.
    assert.doesNotThrow(() => enforceMediaCap(50));

    // Files in the unreadable dir were not counted/evicted, but the readable
    // one may have been (total known = 100, cap = 50).
    assert.ok(!existsSync(p), "readable file was evicted");
  });
});
