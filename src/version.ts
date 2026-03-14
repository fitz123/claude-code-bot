import { execFileSync } from "node:child_process";

/**
 * Read the short git commit hash for the current repo.
 * Returns "unknown" if git is unavailable or the directory is not a repo.
 */
export function getVersion(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
