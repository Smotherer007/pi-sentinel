import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { _clearRepoRootCache } from "../src/workspace.ts";
import { _clearGraphCache } from "../src/mindplace.ts";

export function tempDir(prefix = "sentinel-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A throwaway HOME so checkpoints and spills never touch the real one. */
export function isolateHome(): () => void {
  const previous = process.env.HOME;
  process.env.HOME = tempDir("sentinel-home-");
  return () => {
    process.env.HOME = previous;
  };
}

export function write(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function read(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

export function gitInit(root: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init", "--allow-empty");
  _clearRepoRootCache();
}

export function resetCaches(): void {
  _clearRepoRootCache();
  _clearGraphCache();
}

type Handler = (event: any, ctx: any) => any;

export interface FakePi {
  api: any;
  tools: Map<string, any>;
  commands: Map<string, any>;
  sent: Array<{ message: any; options: any }>;
  fire(name: string, event: any, ctx: any): Promise<any>;
}

export function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  return {
    api,
    tools,
    commands,
    sent,
    async fire(name, event, ctx) {
      let result: any;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
  };
}

export interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  ui: any;
  notifications: Array<{ text: string; level: string }>;
  widget: string[];
  status: string | undefined;
}

export function createCtx(cwd: string): FakeCtx {
  const ctx: FakeCtx = {
    cwd,
    hasUI: false,
    signal: undefined,
    notifications: [],
    widget: [],
    status: undefined,
    ui: {
      notify: (text: string, level = "info") => ctx.notifications.push({ text, level }),
      setStatus: (_key: string, text: string | undefined) => {
        ctx.status = text;
      },
      setWidget: (_key: string, lines: string[]) => {
        ctx.widget = lines;
      },
      select: async () => undefined,
    },
  };
  return ctx;
}
