/**
 * The text the model reads. Short, specific, and always ending in what to do.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { failureAdvice, failureHeadline, summarizeFailure } from "./classify.ts";
import { pruneTrace } from "./prune.ts";
import { relativeTo } from "../glob.ts";
import type { StepResult } from "../types.ts";

export const CHARS_PER_TOKEN = 4;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function list(cwd: string, files: string[], max = 6): string {
  const shown = files.slice(0, max).map((file) => relativeTo(cwd, file));
  return files.length > max ? `${shown.join(", ")} (+${files.length - max} more)` : shown.join(", ");
}

function headline(result: StepResult): string {
  const kind = result.kind ? failureHeadline(result.kind) : "failure";
  return `"${result.name}" failed (${kind}, exit ${result.exitCode}, ${seconds(result.durationMs)})`;
}

export interface Dependents {
  file: string;
  dependents: string[];
}

function impactLines(dependents: Dependents[]): string[] {
  if (dependents.length === 0) return [];
  return [
    "Code that depends on the changed files (pi-mindplace graph):",
    ...dependents.slice(0, 5).map((entry) => `  ${entry.file} → ${entry.dependents.join(", ")}`),
  ];
}

/** Attached to an `edit`/`write` result when a fast check is red. A hint, not an order. */
export function editFeedback(input: {
  cwd: string;
  result: StepResult;
  focus: string[];
  maxTraceLines: number;
}): string {
  const { result } = input;
  const trace = pruneTrace(result.output, Math.min(input.maxTraceLines, 12), input.focus);
  return [
    `[sentinel] ${headline(result)} after this edit:`,
    trace || summarizeFailure(result.kind ?? "unknown", result.output),
    "If this is the middle of a multi-file change, keep going — but these checks must pass before you finish.",
  ].join("\n");
}

/** Sent when the agent stops while a gate check is red. */
export function repairPrompt(input: {
  cwd: string;
  result: StepResult;
  changed: string[];
  attempt: number;
  maxAttempts: number;
  maxTraceLines: number;
  dependents: Dependents[];
}): string {
  const { result } = input;
  const lines = [
    `[sentinel] Not done yet: ${headline(result)}. Repair attempt ${input.attempt}/${input.maxAttempts}.`,
  ];
  if (input.changed.length > 0) lines.push(`Changed since the task started: ${list(input.cwd, input.changed)}`);
  lines.push(`Command: ${result.cmd}`);
  lines.push("─".repeat(40), pruneTrace(result.output, input.maxTraceLines, input.changed) || result.output.slice(0, 2000), "─".repeat(40));
  lines.push(...impactLines(input.dependents));
  const advice = result.kind ? failureAdvice(result.kind) : null;
  if (advice) lines.push(advice);
  lines.push(
    "Fix the cause, not the symptom (do not weaken or delete the failing check). When you finish, sentinel runs the checks again." +
      (input.attempt >= input.maxAttempts ? " This is the last attempt: if it still fails, stop and explain what is wrong." : ""),
  );
  return lines.join("\n");
}

/** Sent (without waking the agent) when sentinel gives up on a red gate. */
export function stopNotice(input: { cwd: string; result: StepResult; reason: "exhausted" | "no-progress" | "disabled" }): string {
  const why =
    input.reason === "exhausted"
      ? "the repair budget is used up"
      : input.reason === "no-progress"
        ? "the last repair attempt did not change any code"
        : "automatic repair is disabled";
  return [
    `[sentinel] ${headline(input.result)} and ${why}, so sentinel stopped re-prompting.`,
    `Summary: ${summarizeFailure(input.result.kind ?? "unknown", input.result.output)}`,
    "Do not claim the work is complete while this check is red. Tell the user what still fails.",
  ].join("\n");
}

/** Keep model-visible text inside the token budget; spill the rest to a file. */
export function capOutput(text: string, maxTokens: number, spillDir: string, label: string): string {
  const cap = maxTokens * CHARS_PER_TOKEN;
  if (maxTokens <= 0 || text.length <= cap) return text;
  let where = "";
  try {
    fs.mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    const file = path.join(spillDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w.-]/g, "_")}.log`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    where = ` — full text: ${file}`;
  } catch {
    /* the preview is still bounded */
  }
  const notice = `\n… [sentinel: truncated to ~${maxTokens} tokens${where}] …\n`;
  const room = Math.max(0, cap - notice.length);
  const head = Math.floor(room * 0.7);
  return `${text.slice(0, head)}${notice}${text.slice(text.length - (room - head))}`;
}
