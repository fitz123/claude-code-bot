import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tempFilePath, downloadFile, cleanupTempFile, transcribeAudio, convertToWav, FFMPEG_BIN, WHISPER_BIN, WHISPER_MODEL } from "../voice.js";

describe("tempFilePath", () => {
  it("generates path with correct prefix and extension", () => {
    const path = tempFilePath("voice", ".oga");
    assert.ok(path.includes("/tg-voice-"), `Expected path to contain /tg-voice-, got: ${path}`);
    assert.ok(path.endsWith(".oga"), `Expected path to end with .oga, got: ${path}`);
  });

  it("generates unique paths on each call", () => {
    const a = tempFilePath("voice", ".oga");
    const b = tempFilePath("voice", ".oga");
    assert.notStrictEqual(a, b);
  });

  it("uses the given prefix", () => {
    const path = tempFilePath("photo", ".jpg");
    assert.ok(path.includes("/tg-photo-"));
    assert.ok(path.endsWith(".jpg"));
  });
});

describe("downloadFile", () => {
  const testDest = "/tmp/openclaw-test-download-voice.oga";

  afterEach(() => {
    try { rmSync(testDest); } catch { /* ignore */ }
  });

  it("writes fetched content to destination", async () => {
    const testData = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OggS magic
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => testData.buffer,
    })) as unknown as typeof fetch;

    try {
      await downloadFile("https://api.telegram.org/file/bot123/voice/file.oga", testDest);
      assert.ok(existsSync(testDest));
      const content = readFileSync(testDest);
      assert.strictEqual(content.length, 4);
      assert.strictEqual(content[0], 0x4f); // 'O'
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on HTTP error response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
    })) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => downloadFile("https://example.com/missing.oga", testDest),
        { message: "Download failed: HTTP 404" },
      );
      assert.ok(!existsSync(testDest));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on fetch network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => downloadFile("https://example.com/file.oga", testDest),
        { message: "Network error" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("convertToWav", () => {
  it("exports correct ffmpeg path", () => {
    assert.strictEqual(FFMPEG_BIN, "/opt/homebrew/bin/ffmpeg");
  });

  it("converts a valid audio file to 16kHz mono WAV", async () => {
    // Create a minimal valid WAV: 44-byte RIFF header + 2 bytes of silence
    const header = Buffer.alloc(46);
    header.write("RIFF", 0);
    header.writeUInt32LE(38, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(44100, 24); // sample rate
    header.writeUInt32LE(88200, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(2, 40); // 2 bytes of audio data
    // 2 bytes of silence already zeroed

    const inputPath = tempFilePath("test-input", ".wav");
    writeFileSync(inputPath, header);

    try {
      const outputPath = await convertToWav(inputPath);
      try {
        assert.ok(existsSync(outputPath), "Output WAV file should exist");
        assert.ok(outputPath.includes("/tg-voice-wav-"), "Output path should use voice-wav prefix");
        assert.ok(outputPath.endsWith(".wav"), "Output should have .wav extension");
        const content = readFileSync(outputPath);
        assert.strictEqual(content.toString("ascii", 0, 4), "RIFF", "Output should have RIFF header");
      } finally {
        await cleanupTempFile(outputPath);
      }
    } finally {
      rmSync(inputPath, { force: true });
    }
  });

  it("rejects when given a nonexistent input file", async () => {
    await assert.rejects(
      () => convertToWav("/tmp/openclaw-nonexistent-audio-99999.oga"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("transcribeAudio", () => {
  it("exports correct whisper-cli paths", () => {
    assert.strictEqual(WHISPER_BIN, "/opt/homebrew/bin/whisper-cli");
    assert.strictEqual(WHISPER_MODEL, "/opt/homebrew/share/whisper-cpp/ggml-small.bin");
  });

  it("rejects when given a nonexistent audio file", async () => {
    await assert.rejects(
      () => transcribeAudio("/tmp/openclaw-nonexistent-audio-99999.oga"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("cleanupTempFile", () => {
  it("removes an existing file", async () => {
    const path = "/tmp/openclaw-test-cleanup-voice.tmp";
    writeFileSync(path, "test data");
    assert.ok(existsSync(path));

    await cleanupTempFile(path);
    assert.ok(!existsSync(path));
  });

  it("does not throw for non-existent file", async () => {
    // Should complete without error
    await cleanupTempFile("/tmp/openclaw-nonexistent-file-12345.tmp");
  });
});
