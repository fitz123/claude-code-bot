// CLI wrapper for markdownToHtml — allows shell scripts to pipe markdown through the converter.
// Usage: echo "markdown" | npx tsx src/markdown-html-cli.ts

import { readFileSync } from "node:fs";
import { markdownToHtml } from "./markdown-html.js";

const input = readFileSync(0, "utf8").replace(/\n$/, "");
process.stdout.write(markdownToHtml(input));
