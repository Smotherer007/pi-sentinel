import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { REDACTED, looksSecret, redactEnv, redactSecrets, secretValues } from "../src/formatting/redact.ts";

const env = {
  NPM_TOKEN: "npm_abcdefghijklmnop",
  GITHUB_TOKEN: "ghp_abcdefghijklmnopqrst",
  MY_PASSWORD: "hunter2hunter2",
  API_KEY: "short", // too short to redact safely
  PATH: "/usr/bin",
  HOME: "/home/x",
};

describe("secretValues", () => {
  test("collects values of secret-looking variables only", () => {
    const values = secretValues(env);
    assert.ok(values.includes(env.NPM_TOKEN));
    assert.ok(values.includes(env.MY_PASSWORD));
    assert.equal(values.includes(env.PATH), false, "PATH is not a secret");
    assert.equal(values.includes("short"), false, "too short to be remembered");
  });

  test("longest first, so a longer secret is not cut into fragments", () => {
    const values = secretValues({ A_TOKEN: "aaaaaaaa", B_SECRET: "aaaaaaaa-and-more" });
    assert.equal(values[0], "aaaaaaaa-and-more");
  });
});

describe("looksSecret", () => {
  test("matches credential-ish names", () => {
    assert.equal(looksSecret("AWS_SECRET_ACCESS_KEY"), true);
    assert.equal(looksSecret("GITHUB_TOKEN"), true);
    assert.equal(looksSecret("PATH"), false);
  });
});

describe("redactSecrets", () => {
  test("replaces configured environment values", () => {
    const text = `Authorization: token ${env.NPM_TOKEN}`;
    const out = redactSecrets(text, env);
    assert.equal(out.includes(env.NPM_TOKEN), false);
    assert.ok(out.includes(REDACTED));
  });

  test("leaves unrelated output untouched", () => {
    const text = "error TS2322: Type 'string' is not assignable to type 'number'";
    assert.equal(redactSecrets(text, env), text);
  });

  test("redacts bearer tokens and key/value pairs", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh", env);
    assert.equal(out.includes("eyJhbGciOiJIUzI1NiJ9.abcdefgh"), false);
    assert.ok(out.includes("Bearer"));

    const pair = redactSecrets("client_secret=abcdef123456", env);
    assert.equal(pair.includes("abcdef123456"), false);
    assert.ok(pair.includes("client_secret="));
  });

  test("redacts well-known key shapes", () => {
    const out = redactSecrets("key sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrst", env);
    assert.equal(out.includes("sk-abcdefghijklmnopqrstuvwx"), false);
    assert.equal(out.includes("ghp_abcdefghijklmnopqrst"), false);
  });

  test("is stateless across calls (global regexes must not skip matches)", () => {
    const text = "sk-aaaaaaaaaaaaaaaaaaaa";
    assert.equal(redactSecrets(text, env), REDACTED);
    assert.equal(redactSecrets(text, env), REDACTED);
  });

  test("handles empty input", () => {
    assert.equal(redactSecrets("", env), "");
  });
});

describe("redactEnv", () => {
  test("keeps keys, hides credential values", () => {
    const out = redactEnv({ NODE_ENV: "test", NPM_TOKEN: "npm_abcdefghijklmnop" });
    assert.equal(out?.NODE_ENV, "test");
    assert.equal(out?.NPM_TOKEN, REDACTED);
  });

  test("passes undefined through", () => {
    assert.equal(redactEnv(undefined), undefined);
  });
});
