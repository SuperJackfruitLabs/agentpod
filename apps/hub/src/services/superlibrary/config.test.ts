import { afterEach, expect, test } from "bun:test";
import { superlibraryConfig } from "./config";

const original = {
  url: process.env.SUPERLIBRARY_URL,
  audience: process.env.SUPERLIBRARY_AUDIENCE,
};
afterEach(() => {
  for (const [key, value] of Object.entries({
    SUPERLIBRARY_URL: original.url,
    SUPERLIBRARY_AUDIENCE: original.audience,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Library stays disabled without a transport URL", () => {
  delete process.env.SUPERLIBRARY_URL;
  process.env.SUPERLIBRARY_AUDIENCE = "https://library.superjackfruit.com";
  expect(superlibraryConfig()).toBeNull();
});

test("unset audience preserves the existing normalized transport audience", () => {
  process.env.SUPERLIBRARY_URL = " https://library.superjackfruit.com/// ";
  delete process.env.SUPERLIBRARY_AUDIENCE;
  expect(superlibraryConfig()).toEqual({
    url: "https://library.superjackfruit.com",
    audience: "https://library.superjackfruit.com",
  });
});

test("operator resource audience is independent of an isolated transport", () => {
  process.env.SUPERLIBRARY_URL = "http://127.0.0.1:8787/";
  process.env.SUPERLIBRARY_AUDIENCE = "https://library.superjackfruit.com/";
  expect(superlibraryConfig()).toEqual({
    url: "http://127.0.0.1:8787",
    audience: "https://library.superjackfruit.com/",
  });
});

test("an invalid explicit audience never falls back to the transport", () => {
  process.env.SUPERLIBRARY_URL = "http://127.0.0.1:8787";
  for (const value of ["", "http://example.com", "not-a-url", "https://user:pass@example.com", "https://example.com/#fragment"]) {
    process.env.SUPERLIBRARY_AUDIENCE = value;
    expect(() => superlibraryConfig()).toThrow();
  }
});
