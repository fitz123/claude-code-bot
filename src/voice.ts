import { tmpdir } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
export const WHISPER_MODEL = "/opt/homebrew/share/ggml-small.bin";

/**
 * Generate a unique temp file path with given prefix and extension.
 */
export function tempFilePath(prefix: string, extension: string): string {
  return `${tmpdir()}/tg-${prefix}-${randomUUID()}${extension}`;
}

/**
 * Download a file from a URL to a local path.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(destPath, buffer);
}

/**
 * Transcribe an audio file using local whisper-cli.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(WHISPER_BIN, [
    "-m", WHISPER_MODEL,
    "-f", filePath,
    "--no-timestamps",
  ], { timeout: 120_000 });
  return stdout.trim();
}

/**
 * Remove a temp file, ignoring errors if it doesn't exist.
 */
export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore - file may already be gone
  }
}
