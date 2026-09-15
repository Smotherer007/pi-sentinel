/**
 * Minimal POSIX-style globs (`**`, `*`, `?`) and project-relative paths.
 */

import * as path from "node:path";

function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          i += 1;
          out += "(?:.*/)?"; // `**/` matches zero or more directories
        } else {
          out += ".*";
        }
      } else {
        i += 1;
        out += "[^/]*";
      }
    } else if (c === "?") {
      i += 1;
      out += "[^/]";
    } else {
      i += 1;
      out += "\\^$+.()|{}[]".includes(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`${out}$`);
}

const compiled = new Map<string, RegExp>();

export function matchesGlob(pattern: string, relPath: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = compiled.get(p);
  if (!re) {
    re = globToRegExp(p);
    compiled.set(p, re);
  }
  return re.test(relPath.replace(/\\/g, "/").replace(/^\.\//, ""));
}

export function matchesAny(patterns: readonly string[], relPath: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, relPath));
}

/** Project-relative POSIX path; absolute paths outside the project stay absolute. */
export function relativeTo(cwd: string, filePath: string): string {
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  return abs.replace(/\\/g, "/");
}

/** Whether a path lies inside the project directory. */
export function insideProject(cwd: string, filePath: string): boolean {
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
