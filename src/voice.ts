import { tmpdir } from "node:os";
import { writeFile, unlink, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
export const WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
export const WHISPER_MODEL = "/opt/homebrew/share/whisper-cpp/ggml-medium.bin";

/**
 * Generate a unique temp file path with given prefix and extension.
 */
export function tempFilePath(prefix: string, extension: string): string {
  return `${tmpdir()}/bot-${prefix}-${randomUUID()}${extension}`;
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
  await writeFile(destPath, buffer, { mode: 0o600 });
}

/**
 * Convert an audio file to 16kHz mono WAV using ffmpeg.
 * Returns the path to the generated WAV file.
 */
export async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = tempFilePath("voice-wav", ".wav");
  try {
    await execFileAsync(FFMPEG_BIN, [
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      wavPath,
      "-y",
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
    await chmod(wavPath, 0o600);
  } catch (err) {
    await cleanupTempFile(wavPath);
    throw err;
  }
  return wavPath;
}

/**
 * Transcribe an audio file using local whisper-cli.
 * Converts to WAV first since whisper-cli cannot decode Opus-in-OGG directly.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const wavPath = await convertToWav(filePath);
  try {
    const { stdout } = await execFileAsync(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "-f", wavPath,
      "--no-timestamps",
      "--no-prints",
      "--language", "ru",
    ], { timeout: 120_000 });
    return stdout.trim();
  } finally {
    await cleanupTempFile(wavPath);
  }
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
