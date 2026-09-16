/**
 * Helpers for the hidden acceptance checks. An oracle runs with cwd set to the
 * finished workspace and prints one JSON object: { passed, checks: [...] }.
 * The agent never sees these checks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const results = [];

export async function check(name, predicate, detail) {
  let passed = false;
  let info;
  try {
    passed = Boolean(await predicate());
  } catch (err) {
    info = `threw: ${err?.message ?? err}`;
  }
  if (!passed && info === undefined && detail) {
    try {
      info = `got: ${JSON.stringify(await detail())}`;
    } catch (err) {
      info = `threw: ${err?.message ?? err}`;
    }
  }
  results.push({ name, passed, ...(info ? { info } : {}) });
}

/** Import a TypeScript module from the workspace; a failed import becomes an empty module. */
export async function importTs(rel) {
  try {
    return await import(`${pathToFileURL(path.resolve(rel)).href}?t=${Date.now()}`);
  } catch (err) {
    results.push({ name: `import ${rel}`, passed: false, info: String(err?.message ?? err).slice(0, 300) });
    return {};
  }
}

export function readText(rel) {
  try {
    return fs.readFileSync(rel, "utf-8");
  } catch {
    return "";
  }
}

export function grepFiles(dirs, pattern) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(fs.readFileSync(full, "utf-8"))) hits.push(full);
    }
  };
  dirs.forEach(walk);
  return hits;
}

export function finish() {
  const passed = results.length > 0 && results.every((r) => r.passed);
  process.stdout.write(JSON.stringify({ passed, total: results.length, failed: results.filter((r) => !r.passed).length, checks: results }));
}
