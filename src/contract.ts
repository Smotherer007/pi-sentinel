/**
 * The working rules added to the system prompt. Kept to what changes behaviour.
 */

import type { Step } from "./types.ts";

export const CONTRACT_MARKER = "## pi-sentinel";

export function contractText(input: { beforeDone: Step[]; maxAttempts: number; repair: boolean; graph: boolean }): string {
  const gate = input.beforeDone.filter((step) => !step.warnOnly).map((step) => `\`${step.name}\``);
  const rules: string[] = [];
  if (gate.length > 0) {
    rules.push(
      `- When you finish, sentinel runs ${gate.join(", ")}.` +
        (input.repair ? ` If one fails you are sent back to fix it (at most ${input.maxAttempts} rounds).` : ""),
    );
  } else {
    rules.push("- No checks are configured for this project, so nothing verifies your changes automatically. Run the relevant commands yourself.");
  }
  rules.push(
    "- Only say a check passes if it ran after your last change (`sentinel_verify` runs the checks on demand).",
    "- Fix causes, not symptoms: never delete, skip or weaken a test or check to make it pass.",
    "- If a fix is out of reach, stop and explain what still fails instead of widening the change.",
  );
  if (input.graph) {
    rules.push("- Before changing code other files depend on, use `mindplace_explain` to see the dependents.");
  }
  return [CONTRACT_MARKER, ...rules].join("\n");
}
