import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Cloudflare image's entrypoint is a COPY of the Docker image's, and must
 * stay byte-identical.
 *
 * That script is subtle and was arrived at by fixing live-fleet bugs: it
 * double-forks so the supervision loop re-parents to init (a direct child
 * lingers as a zombie whose comm still matches the descriptor's pgrep health
 * check, freezing Health at "running"), and it uses a sentinel file so the
 * descriptor's lifecycle Stop is not immediately undone by the loop respawning.
 *
 * A second, hand-maintained copy would drift and rediscover both bugs on a
 * substrate where the feedback loop is a deploy. Hence a test rather than a
 * comment asking nicely.
 */
describe("entrypoint parity", () => {
  it("is byte-identical to the Docker image's entrypoint", () => {
    const here = readFileSync(join(import.meta.dirname, "../entrypoint.sh"), "utf8");
    const canonical = readFileSync(
      join(import.meta.dirname, "../../../apps/node-agent/deploy/node-opencode-entrypoint.sh"),
      "utf8"
    );

    expect(here).toBe(canonical);
  });
});
