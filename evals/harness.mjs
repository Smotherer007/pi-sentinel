/**
 * Eval harness — drive the real extension through a scripted trajectory.
 *
 * This is the fake host the unit tests use, promoted into a reusable piece for
 * `evals/run.mjs`: a fake pi (hooks, tools, commands, bus, `sendMessage`), a
 * fake ctx (notifications, statuses, widget, session manager), and a driver
 * that plays a trajectory of tool calls at it.
 *
 * Two deliberate choices:
 *
 *   1. **The real extension factory**, not a stand-in. An eval that measures a
 *      model of sentinel measures the model, not sentinel.
 *   2. **`backgroundTurnEnd: false`.** A turn's outcome must be settled when the
 *      hook returns; an eval whose numbers depend on scheduling would be one
 *      more flake, and today produced four of those.
 */

import { fire as runHooks } from "./hooks.mjs";

export function createFakePi() {
  const handlers = new Map();
  const tools = [];
  const commands = [];
  const sent = [];
  const busHandlers = new Map();

  const api = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      commands.push({ name, ...options });
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    events: {
      on(channel, handler) {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {};
      },
      emit(channel, data) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
    },
  };

  return {
    api,
    handlers,
    tools,
    commands,
    sent,
    /** Fire a hook and return the last defined result, like the host does. */
    async fire(name, event, ctx) {
      return runHooks(handlers, name, event, ctx);
    },
  };
}

export function createFakeCtx(cwd) {
  const notifications = [];
  const statuses = new Map();
  const widgets = new Map();
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (text, level = "info") => notifications.push({ text, level }),
      setStatus: (key, value) => statuses.set(key, value),
      setWidget: (key, value) => widgets.set(key, value),
      select: async () => undefined,
      confirm: async () => true,
    },
    sessionManager: { getLeafId: () => "entry-1", getSessionFile: () => undefined },
    notifications,
    statuses,
    widgets,
  };
}

/**
 * An edit, driven the way the host drives one: `tool_call` before the bytes
 * change, `tool_result` after. Sentinel snapshots on the first and verifies on
 * the second, so skipping either would measure a different program.
 */
export async function edit(fake, ctx, rel, content, toolCallId) {
  await fake.fire(
    "tool_call",
    { type: "tool_call", toolName: "edit", toolCallId, input: { path: rel } },
    ctx,
  );
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  mkdirSync(dirname(join(ctx.cwd, rel)), { recursive: true });
  writeFileSync(join(ctx.cwd, rel), content);
  return fake.fire(
    "tool_result",
    {
      type: "tool_result",
      toolName: "edit",
      toolCallId,
      input: { path: rel },
      content: [{ type: "text", text: "updated" }],
      isError: false,
    },
    ctx,
  );
}

/** One turn around a single edit, ending the turn like the host does. */
export async function turn(fake, ctx, turnIndex, rel, content, toolCallId) {
  await fake.fire("turn_start", { type: "turn_start", turnIndex }, ctx);
  const result = rel === null ? undefined : await edit(fake, ctx, rel, content, toolCallId);
  await fake.fire("turn_end", { type: "turn_end", turnIndex, message: {}, toolResults: [] }, ctx);
  return result;
}
