import { expect, test } from "bun:test";
import { SalaamWorkPlan } from "../../../../../packages/contract/src/salaam-work-payload";
import { HANDOFF_FILE, runDirectory, runScopedPlan } from "./salaam-run-scope";

const plan = SalaamWorkPlan.parse({
  objective: "Answer a question",
  constraints: ["Quote exactly."],
  steps: [
    {
      key: "research",
      title: "Research",
      instruction: "Write answer.md",
      depends_on: [],
      checks: ["answer"],
    },
  ],
  acceptance: [
    { key: "answer", command: "grep -q 502 answer.md", cwd: "." },
    { key: "nested", command: "test -s out.txt", cwd: "out" },
  ],
  deliverables: ["answer.md", "out/out.txt"],
  limits: {
    requests: 24,
    runtime_ms: 900000,
    concurrency: 1,
    token_units: null,
    input_token_bound: 400000,
    output_token_bound: null,
    verification_runs: 2,
  },
});

test("each run works in its own directory, so a check cannot pass on another run's files", () => {
  const a = runScopedPlan(plan, "run_aaaaaa111"),
    b = runScopedPlan(plan, "run_bbbbbb222");
  expect(runDirectory("run_aaaaaa111")).toBe("runs/run_aaaaaa111");
  expect(a.deliverables).toEqual([
    "runs/run_aaaaaa111/answer.md",
    "runs/run_aaaaaa111/out/out.txt",
    "runs/run_aaaaaa111/" + HANDOFF_FILE,
  ]);
  // A station check runs only at the workspace root (cwd "."), so the run's directory goes in
  // the command, never in cwd (run_8a58b17fbea94bbb: every per-run check failed unrun).
  expect(a.acceptance.map((c) => c.cwd)).toEqual([".", "."]);
  expect(a.acceptance.map((c) => c.command)).toEqual([
    "cd 'runs/run_aaaaaa111' && (grep -q 502 answer.md)",
    "cd 'runs/run_aaaaaa111/out' && (test -s out.txt)",
  ]);
  for (const path of a.deliverables) expect(b.deliverables).not.toContain(path);
  expect(a.constraints.at(-1)).toBe("Quote exactly.");
  expect(a.constraints[0]).toContain("runs/run_aaaaaa111/");
  expect(a.constraints.join("\n")).toContain(HANDOFF_FILE);
  expect(SalaamWorkPlan.parse(a)).toEqual(a);
  // The same run always scopes the same way, so a resumed run keeps its admitted digest.
  expect(runScopedPlan(plan, "run_aaaaaa111")).toEqual(a);
});

test("an author-declared handoff file is not declared twice", () => {
  const scoped = runScopedPlan(
    { ...plan, deliverables: [HANDOFF_FILE, "answer.md"] },
    "run_aaaaaa111",
  );
  expect(scoped.deliverables.filter((d) => d.endsWith(HANDOFF_FILE))).toHaveLength(1);
});

test("scoping refuses run ids that are not plain run ids and plans with no room", () => {
  expect(() => runScopedPlan(plan, "../run_x")).toThrow(/run id/);
  expect(() => runScopedPlan(plan, "run_a/b")).toThrow(/run id/);
  expect(() =>
    runScopedPlan(
      { ...plan, constraints: Array.from({ length: 15 }, (_, n) => "c" + n) },
      "run_aaaaaa111",
    ),
  ).toThrow();
  expect(() =>
    runScopedPlan(
      { ...plan, deliverables: Array.from({ length: 32 }, (_, n) => "d" + n) },
      "run_aaaaaa111",
    ),
  ).toThrow();
});

test("a check directory that could break out of its quoting is refused", () => {
  expect(() =>
    runScopedPlan(
      { ...plan, acceptance: [{ key: "answer", command: "true", cwd: "it's" }] },
      "run_aaaaaa111",
    ),
  ).toThrow();
});

// Item 8: completion hooks are required completion checks; they run inside the run directory too.
test("completion hooks are scoped to the run directory like acceptance checks", () => {
  const gated = SalaamWorkPlan.parse({
    ...plan,
    completion_gate: { critic: null, hooks: [{ key: "lint", command: "test -s answer.md", cwd: "." }] },
  });
  const scoped = runScopedPlan(gated, "run_aaaaaa111");
  expect(scoped.completion_gate).toEqual({
    critic: null,
    hooks: [{ key: "lint", cwd: ".", command: "cd \x27runs/run_aaaaaa111\x27 && (test -s answer.md)" }],
  });
  expect("completion_gate" in runScopedPlan(plan, "run_aaaaaa111")).toBe(false);
});

test("a completion gate is closed: unique hooks, at most 8, none colliding with an acceptance check, a critic only by rubric", () => {
  const hook = (key: string) => ({ key, command: "true", cwd: "." });
  for (const gate of [
    { critic: null, hooks: [] },
    { critic: null, hooks: [hook("a"), hook("a")] },
    { critic: null, hooks: Array.from({ length: 9 }, (_, n) => hook("h" + n)) },
    { critic: { rubric: "x", profile: "salaam/builder" }, hooks: [hook("a")] },
    { critic: null, hooks: [hook("a")], extra: 1 },
  ])
    expect(SalaamWorkPlan.safeParse({ ...plan, completion_gate: gate }).success).toBe(false);
  // "hook-answer" would collide with the derived key of a hook named "answer" if an acceptance
  // check were called that; here an acceptance key "hook-x" collides with hook "x".
  const colliding = { ...plan, acceptance: [...plan.acceptance, { key: "hook-x", command: "true", cwd: "." }] };
  expect(SalaamWorkPlan.safeParse({ ...colliding, completion_gate: { critic: null, hooks: [hook("x")] } }).success).toBe(false);
});

// Item 8 part 2: a plan may declare a critic: a rubric the built-in reviewer judges the verified
// deliverables against. It passes through the run scoping unchanged.
test("a completion gate may declare a critic rubric; nothing else about it", () => {
  const gate = { critic: { rubric: "Every claim cites RFC 9110." }, hooks: [{ key: "lint", command: "true", cwd: "." }] };
  const scoped = runScopedPlan(SalaamWorkPlan.parse({ ...plan, completion_gate: gate }), "run_aaaaaa111");
  expect(scoped.completion_gate?.critic).toEqual({ rubric: "Every claim cites RFC 9110." });
  for (const critic of [{ rubric: "" }, { rubric: "x".repeat(4097) }, { rubric: "x", model: "y" }, { profile: "salaam/builder" }])
    expect(SalaamWorkPlan.safeParse({ ...plan, completion_gate: { ...gate, critic } }).success).toBe(false);
  // A critic alone, with no hooks, is a gate too.
  expect(SalaamWorkPlan.safeParse({ ...plan, completion_gate: { critic: { rubric: "x" }, hooks: [] } }).success).toBe(true);
});
