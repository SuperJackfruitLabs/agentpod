import { test, expect } from "bun:test";
import { observeWithLease } from "../../src/services/bridge/salaam-observation";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
test("long observation renews serially and stops renewal before returning", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const result = await observeWithLease(
    async () => {
      await delay(40);
      return "fresh";
    },
    async () => {
      calls++;
      max = Math.max(max, ++active);
      await delay(5);
      active--;
    },
    2,
  );
  expect(result).toBe("fresh");
  expect(calls).toBeGreaterThan(0);
  expect(max).toBe(1);
  expect(active).toBe(0);
  const saved = calls;
  await delay(10);
  expect(calls).toBe(saved);
});
test("lease loss wins over late successful observation and no timer survives", async () => {
  let calls = 0,
    settled = false;
  await expect(
    observeWithLease(
      async () => {
        await delay(30);
        settled = true;
        return "untrusted late success";
      },
      async () => {
        calls++;
        throw Error("lease lost");
      },
      2,
    ),
  ).rejects.toThrow("lease lost");
  await delay(40);
  expect(settled).toBe(true);
  expect(calls).toBe(1);
});
test("observation waits for in-flight renewal failure before returning success", async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  const run = observeWithLease(
    async () => {
      await ready;
      release();
      return "too early";
    },
    async () => {
      started();
      await gate;
      throw Error("revoked while verifying");
    },
    1,
  );
  await expect(run).rejects.toThrow("revoked while verifying");
});
