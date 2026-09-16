import { formatDuration } from "./duration.ts";

export interface Options {
  verbose: boolean;
  retries: number;
  /** Seconds. */
  timeout: number;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { verbose: false, retries: 3, timeout: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verbose") options.verbose = true;
    else if (arg === "--retries") options.retries = Number(argv[++i]);
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function describe(options: Options): string {
  return `retries=${options.retries} timeout=${formatDuration(options.timeout)}${options.verbose ? " verbose" : ""}`;
}
