process.env.TZ = "UTC";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  discordSessionKey,
  resolveDiscordBinding,
  shouldRespondInDiscord,
  buildDiscordSourcePrefix,
  installDiscordErrorHandlers,
} from "../discord-bot.js";
import { validateDiscordBinding } from "../config.js";
import type { DiscordBinding } from "../types.js";

// --- discordSessionKey ---

describe("discordSessionKey", () => {
  it("returns discord:channelId when no threadId", () => {
    assert.strictEqual(discordSessionKey("123456"), "discord:123456");
  });

  it("returns discord:channelId:threadId when threadId is present", () => {
    assert.strictEqual(discordSessionKey("123456", "789"), "discord:123456:789");
  });

  it("handles large snowflake IDs", () => {
    assert.strictEqual(
      discordSessionKey("1234567890123456789", "9876543210987654321"),
      "discord:1234567890123456789:9876543210987654321",
    );
  });

  it("does not append colon when threadId is undefined", () => {
    assert.strictEqual(discordSessionKey("123456", undefined), "discord:123456");
  });

  it("does not collide with Telegram session keys", () => {
    const discordKey = discordSessionKey("123456");
    // Telegram keys are just "123456" or "123456:topicId"
    assert.ok(discordKey.startsWith("discord:"));
    assert.notStrictEqual(discordKey, "123456");
  });
});

// --- resolveDiscordBinding ---

const testBindings: DiscordBinding[] = [
  { channelId: "111", guildId: "g1", agentId: "main", kind: "channel", label: "General" },
  { channelId: "222", guildId: "g1", agentId: "dev", kind: "channel", label: "Dev" },
  { channelId: "333", guildId: "g2", agentId: "support", kind: "dm" },
];

describe("resolveDiscordBinding", () => {
  it("resolves binding by channelId", () => {
    const binding = resolveDiscordBinding("111", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.label, "General");
  });

  it("resolves second binding", () => {
    const binding = resolveDiscordBinding("222", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "dev");
  });

  it("resolves DM binding", () => {
    const binding = resolveDiscordBinding("333", testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.kind, "dm");
    assert.strictEqual(binding.agentId, "support");
  });

  it("returns undefined for unknown channelId", () => {
    const binding = resolveDiscordBinding("999", testBindings);
    assert.strictEqual(binding, undefined);
  });

  it("handles empty bindings array", () => {
    const binding = resolveDiscordBinding("111", []);
    assert.strictEqual(binding, undefined);
  });
});

// --- resolveDiscordBinding with guild-wide defaults and channel overrides ---

describe("resolveDiscordBinding with guild-wide defaults", () => {
  const guildBindings: DiscordBinding[] = [
    {
      guildId: "g1",
      agentId: "main",
      kind: "channel",
      label: "My Server",
      requireMention: true,
      channels: [
        { channelId: "c1", label: "Platform", requireMention: false },
        { channelId: "c2", agentId: "coder", label: "Coding" },
      ],
    },
    { channelId: "c3", guildId: "g2", agentId: "support", kind: "channel", label: "Support" },
  ];

  it("resolves exact channelId match over guild default", () => {
    const binding = resolveDiscordBinding("c3", guildBindings, "g2");
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "support");
    assert.strictEqual(binding.label, "Support");
  });

  it("resolves channel override from channels[] with overridden fields", () => {
    const binding = resolveDiscordBinding("c1", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main"); // inherited from guild
    assert.strictEqual(binding.label, "Platform"); // overridden
    assert.strictEqual(binding.requireMention, false); // overridden
    assert.strictEqual(binding.channelId, "c1");
  });

  it("resolves channel override with agentId override", () => {
    const binding = resolveDiscordBinding("c2", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "coder"); // overridden
    assert.strictEqual(binding.label, "Coding"); // overridden
    assert.strictEqual(binding.requireMention, true); // inherited from guild
  });

  it("falls back to guild-wide default for unlisted channel", () => {
    const binding = resolveDiscordBinding("c999", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    assert.strictEqual(binding.label, "My Server");
    assert.strictEqual(binding.requireMention, true);
  });

  it("returns undefined when no guild matches", () => {
    const binding = resolveDiscordBinding("c999", guildBindings, "g999");
    assert.strictEqual(binding, undefined);
  });

  it("returns undefined when guildId not provided and no channelId match", () => {
    const binding = resolveDiscordBinding("c999", guildBindings);
    assert.strictEqual(binding, undefined);
  });

  it("exact channelId match wins over guild fallback even without guildId", () => {
    const binding = resolveDiscordBinding("c3", guildBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "support");
  });

  it("preserves kind from guild binding in channel override", () => {
    const binding = resolveDiscordBinding("c1", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.kind, "channel");
  });

  it("does not include channels[] array in resolved override result", () => {
    const binding = resolveDiscordBinding("c1", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.channels, undefined);
  });

  it("guild default result does not include channels[] array", () => {
    const binding = resolveDiscordBinding("c999", guildBindings, "g1");
    assert.ok(binding);
    assert.strictEqual(binding.channels, undefined);
  });
});

// --- shouldRespondInDiscord ---

describe("shouldRespondInDiscord", () => {
  const channelBinding: DiscordBinding = { channelId: "111", guildId: "g1", agentId: "main", kind: "channel" };
  const channelRequireMention: DiscordBinding = { channelId: "111", guildId: "g1", agentId: "main", kind: "channel", requireMention: true };
  const channelNoMention: DiscordBinding = { channelId: "111", guildId: "g1", agentId: "main", kind: "channel", requireMention: false };
  const dmBinding: DiscordBinding = { channelId: "333", guildId: "g1", agentId: "main", kind: "dm" };
  const botUserId = "bot999";

  // Minimal mock for Discord Message — only what shouldRespondInDiscord uses
  function mockMessage(opts: { hasBotMention?: boolean } = {}): any {
    return {
      mentions: {
        has(userId: string): boolean {
          return opts.hasBotMention === true && userId === botUserId;
        },
      },
    };
  }

  it("always returns true for DM bindings", () => {
    assert.strictEqual(shouldRespondInDiscord(dmBinding, botUserId, mockMessage()), true);
  });

  it("returns true for channel with requireMention: false", () => {
    assert.strictEqual(shouldRespondInDiscord(channelNoMention, botUserId, mockMessage()), true);
  });

  it("returns true for channel with no requireMention set and no sessionDefaults (default false)", () => {
    assert.strictEqual(shouldRespondInDiscord(channelBinding, botUserId, mockMessage()), true);
  });

  it("returns false for channel with requireMention: true and no mention", () => {
    assert.strictEqual(shouldRespondInDiscord(channelRequireMention, botUserId, mockMessage()), false);
  });

  it("falls back to sessionDefaults.requireMention when binding has none", () => {
    assert.strictEqual(shouldRespondInDiscord(channelBinding, botUserId, mockMessage(), { requireMention: true }), false);
    assert.strictEqual(shouldRespondInDiscord(channelBinding, botUserId, mockMessage(), { requireMention: false }), true);
  });

  it("binding requireMention overrides sessionDefaults", () => {
    assert.strictEqual(shouldRespondInDiscord(channelRequireMention, botUserId, mockMessage(), { requireMention: false }), false);
    assert.strictEqual(shouldRespondInDiscord(channelNoMention, botUserId, mockMessage(), { requireMention: true }), true);
  });

  it("returns true when bot is mentioned", () => {
    assert.strictEqual(
      shouldRespondInDiscord(channelRequireMention, botUserId, mockMessage({ hasBotMention: true })),
      true,
    );
  });

  it("returns false when different user is mentioned", () => {
    const msg = {
      mentions: {
        has(userId: string): boolean {
          return userId === "other123";
        },
      },
    };
    assert.strictEqual(shouldRespondInDiscord(channelRequireMention, botUserId, msg as any), false);
  });

  it("returns true for channel with explicit requireMention: true and bot mention", () => {
    const explicit: DiscordBinding = { ...channelBinding, requireMention: true };
    assert.strictEqual(
      shouldRespondInDiscord(explicit, botUserId, mockMessage({ hasBotMention: true })),
      true,
    );
  });
});

// --- buildDiscordSourcePrefix ---

describe("buildDiscordSourcePrefix", () => {
  it("includes chat label and sender with username", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "General" };
    const author = { username: "johndoe", globalName: "John Doe" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: General | From: John Doe (@johndoe)]\n",
    );
  });

  it("falls back to username when globalName is null", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Dev" };
    const author = { username: "alice", globalName: null };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Dev | From: alice (@alice)]\n",
    );
  });

  it("uses displayName when globalName is not available", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Dev" };
    const author = { username: "bob", displayName: "Bobby", globalName: null };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Dev | From: Bobby (@bob)]\n",
    );
  });

  it("omits chat label when binding has no label", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel" };
    const author = { username: "bob", globalName: "Bob Smith" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[From: Bob Smith (@bob)]\n",
    );
  });

  it("omits sender when author is undefined", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Help" };
    assert.strictEqual(buildDiscordSourcePrefix(binding, undefined), "[Chat: Help]\n");
  });

  it("returns empty string when no label and no author", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "dm" };
    assert.strictEqual(buildDiscordSourcePrefix(binding, undefined), "");
  });

  it("strips newlines from display names", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Chat" };
    const author = { username: "evil\nuser", globalName: "Evil\nName" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author),
      "[Chat: Chat | From: Evil Name (@eviluser)]\n",
    );
  });

  it("appends HH:MM timestamp as last field when timestampMs is provided", () => {
    // 1700000000000 ms = 2023-11-14T22:13:20Z (UTC)
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "General" };
    const author = { username: "johndoe", globalName: "John Doe" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author, 1700000000000),
      "[Chat: General | From: John Doe (@johndoe) | 22:13]\n",
    );
  });

  it("works without crash when timestamp is undefined (backward compat)", () => {
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "Dev" };
    const author = { username: "alice", globalName: "Alice" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author, undefined),
      "[Chat: Dev | From: Alice (@alice)]\n",
    );
  });

  it("includes timestamp even when no label and no author", () => {
    // 1700000000000 ms = 2023-11-14T22:13:20Z (UTC)
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "dm" };
    assert.strictEqual(buildDiscordSourcePrefix(binding, undefined, 1700000000000), "[22:13]\n");
  });

  it("zero-pads single-digit hours and minutes in timestamp", () => {
    // 1700006700000 ms = 2023-11-15T00:05:00Z (UTC) → "00:05"
    const binding: DiscordBinding = { channelId: "1", guildId: "g1", agentId: "main", kind: "channel", label: "General" };
    const author = { username: "johndoe", globalName: "John Doe" };
    assert.strictEqual(
      buildDiscordSourcePrefix(binding, author, 1700006700000),
      "[Chat: General | From: John Doe (@johndoe) | 00:05]\n",
    );
  });
});

// --- Thread session isolation ---

describe("thread session isolation", () => {
  it("thread session key differs from parent channel key", () => {
    const parentKey = discordSessionKey("111");
    const threadKey = discordSessionKey("111", "thread1");
    assert.notStrictEqual(parentKey, threadKey);
  });

  it("different threads in same channel get different keys", () => {
    const thread1 = discordSessionKey("111", "t1");
    const thread2 = discordSessionKey("111", "t2");
    assert.notStrictEqual(thread1, thread2);
  });

  it("thread inherits parent channel binding", () => {
    // When a thread message arrives, we look up the parent channel's binding
    const parentChannelId = "111";
    const binding = resolveDiscordBinding(parentChannelId, testBindings);
    assert.ok(binding);
    assert.strictEqual(binding.agentId, "main");
    // But the session key includes the thread ID for isolation
    const key = discordSessionKey(parentChannelId, "thread123");
    assert.strictEqual(key, "discord:111:thread123");
  });
});

// --- validateDiscordBinding config validation ---

describe("validateDiscordBinding", () => {
  it("accepts binding with channelId", () => {
    const binding = validateDiscordBinding(
      { channelId: "c1", guildId: "g1", agentId: "main", kind: "channel" },
      0,
    );
    assert.strictEqual(binding.channelId, "c1");
    assert.strictEqual(binding.guildId, "g1");
  });

  it("accepts guild-only binding without channelId", () => {
    const binding = validateDiscordBinding(
      { guildId: "g1", agentId: "main", kind: "channel" },
      0,
    );
    assert.strictEqual(binding.channelId, undefined);
    assert.strictEqual(binding.guildId, "g1");
  });

  it("accepts guild binding with channels array", () => {
    const binding = validateDiscordBinding(
      {
        guildId: "g1",
        agentId: "main",
        kind: "channel",
        channels: [
          { channelId: "c1", label: "General" },
          { channelId: "c2", agentId: "coder" },
        ],
      },
      0,
    );
    assert.ok(binding.channels);
    assert.strictEqual(binding.channels.length, 2);
    assert.strictEqual(binding.channels[0].channelId, "c1");
    assert.strictEqual(binding.channels[1].agentId, "coder");
  });

  it("rejects binding with both channelId and channels", () => {
    assert.throws(
      () =>
        validateDiscordBinding(
          { channelId: "c1", guildId: "g1", agentId: "main", kind: "channel", channels: [] },
          0,
        ),
      /cannot have both channelId and channels/,
    );
  });

  it("rejects missing guildId", () => {
    assert.throws(
      () => validateDiscordBinding({ agentId: "main", kind: "channel" }, 0),
      /missing guildId/,
    );
  });

  it("rejects missing agentId", () => {
    assert.throws(
      () => validateDiscordBinding({ guildId: "g1", kind: "channel" }, 0),
      /missing agentId/,
    );
  });

  it("rejects invalid kind", () => {
    assert.throws(
      () => validateDiscordBinding({ guildId: "g1", agentId: "main", kind: "server" }, 0),
      /invalid kind/,
    );
  });

  it("rejects channel override missing channelId", () => {
    assert.throws(
      () =>
        validateDiscordBinding(
          {
            guildId: "g1",
            agentId: "main",
            kind: "channel",
            channels: [{ label: "No ID" }],
          },
          0,
        ),
      /channels\[0\] missing channelId/,
    );
  });

  it("rejects non-array channels", () => {
    assert.throws(
      () =>
        validateDiscordBinding(
          { guildId: "g1", agentId: "main", kind: "channel", channels: "bad" },
          0,
        ),
      /channels must be an array/,
    );
  });

  it("rejects DM binding without channelId", () => {
    assert.throws(
      () => validateDiscordBinding({ guildId: "g1", agentId: "main", kind: "dm" }, 0),
      /kind "dm" requires channelId/,
    );
  });
});

// --- installDiscordErrorHandlers ---

describe("installDiscordErrorHandlers", () => {
  // Use a plain EventEmitter as a stand-in for the Discord Client.
  // installDiscordErrorHandlers only calls client.on(), which is
  // inherited from EventEmitter — no other Client methods are needed.

  it("registers handlers for Error, ShardError, Warn, ShardReconnecting, ShardResume", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    // discord.js Events enum values — these are the actual event name strings
    const expectedEvents = ["error", "shardError", "warn", "shardReconnecting", "shardResume"];
    for (const event of expectedEvents) {
      assert.ok(
        emitter.listenerCount(event) > 0,
        `Expected at least one listener for '${event}'`,
      );
    }
  });

  it("error handler does not throw (prevents process crash)", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    // Without the handler, emitting 'error' on an EventEmitter throws.
    // With the handler, it should be silently caught and logged.
    assert.doesNotThrow(() => {
      emitter.emit("error", new Error("Opening handshake has timed out"));
    });
  });

  it("shardError handler does not throw", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    assert.doesNotThrow(() => {
      emitter.emit("shardError", new Error("WebSocket connection failed"), 0);
    });
  });

  it("warn handler does not throw", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    assert.doesNotThrow(() => {
      emitter.emit("warn", "Rate limit hit");
    });
  });

  it("shardReconnecting handler does not throw", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    assert.doesNotThrow(() => {
      emitter.emit("shardReconnecting", 0);
    });
  });

  it("shardResume handler does not throw", () => {
    const emitter = new EventEmitter() as any;
    installDiscordErrorHandlers(emitter);

    assert.doesNotThrow(() => {
      emitter.emit("shardResume", 0, 42);
    });
  });
});

// Streaming control flag tests are in discord-adapter.test.ts
// where they verify actual adapter behavior, not just type shapes.
