/**
 * OutputBudget — keeps model-visible verification output bounded (P5).
 *
 * Codex caps model-visible hook output at roughly 2,500 tokens and spills
 * anything larger to a file, passing the model a head/tail preview plus the
 * path. Claude Code does the same at 10,000 characters. Unbounded compiler or
 * test output is the fastest way to burn a context window on noise, so
 * sentinel applies the same rule to its formatted failure payloads.
 *
 * Pure preview calculation + one isolated file write; no business logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { SpillResult } from "../types.ts";

/** Rough characters-per-token ratio used for the budget conversion. */
export const CHARS_PER_TOKEN = 4;

/**
 * Build a head/tail preview of `text` that fits in `capChars`.
 *
 * Keeps the beginning (where compilers put the first error and the tool
 * banner) and the end (where the summary/count lives), marking the cut with
 * an explicit notice so the model never assumes it saw everything.
 */
export function preview(text: string, capChars: number, notice = "… [output truncated]"): string {
  if (capChars <= 0 || text.length <= capChars) return text;

  const marker = `\n${notice}\n`;
  const remaining = Math.max(0, capChars - marker.length);
  if (remaining === 0) return text.slice(0, capChars);

  // 60/40 split: the head carries the actionable first error, the tail the
  // aggregate summary.
  const headChars = Math.floor(remaining * 0.6);
  const tailChars = remaining - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  return `${head}${marker}${tail}`;
}

/**
 * Enforce the configured token budget on `text`.
 *
 * @param text      Model-visible payload.
 * @param maxTokens Budget in tokens; `0` disables the cap entirely.
 * @param dir       Directory to spill the full output into.
 * @param label     File-name label for the spilled artifact.
 */
export function applyOutputCap(
  text: string,
  maxTokens: number,
  dir: string,
  label: string,
): SpillResult {
  if (maxTokens <= 0) return { text };

  const capChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= capChars) return { text };

  let spilledPath: string | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, "_") || "output";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    spilledPath = path.join(dir, `${stamp}-${safeLabel}.log`);
    fs.writeFileSync(spilledPath, text, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Spilling is best-effort: if the file cannot be written we still return
    // a bounded preview rather than the full (context-blowing) payload.
    spilledPath = undefined;
  }

  const notice = spilledPath
    ? `… [sentinel: output truncated to ${maxTokens} tokens — full output: ${spilledPath}]`
    : `… [sentinel: output truncated to ${maxTokens} tokens]`;

  return { text: preview(text, capChars, notice), spilledPath };
}
