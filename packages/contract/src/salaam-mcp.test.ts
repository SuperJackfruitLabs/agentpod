import { expect, test } from "bun:test";
import authority from "./fixtures/salaam-authority-v1.json";
import { SalaamMcpProfile, SalaamMcpAssignment } from "./salaam-mcp";
import corpus from "./fixtures/salaam-mcp-v1.json";

for (const [cases, schema] of [
  [corpus.profiles, SalaamMcpProfile],
  [corpus.assignments, SalaamMcpAssignment],
] as const)
  for (const sample of cases)
    test(`shared managed MCP corpus: ${sample.name}`, () => {
      expect(schema.safeParse(sample.value).success).toBe(sample.accept);
    });

const sha = "a".repeat(64);
const profile = {
  version: 1,
  scope: "agentpod-proxy",
  proxy_origin: "http://127.0.0.1:43421",
  servers: [
    {
      name: "superlibrary",
      protocol_version: "2025-11-25",
      catalog_digest: sha,
      tools: [{ name: "library_search", schema_digest: sha, policy: "read" }],
    },
  ],
  limits: {
    request_bytes: 32768,
    response_bytes: 262144,
    timeout_ms: 10000,
    calls_per_attempt: 16,
  },
};
const assignment = {
  version: 1,
  binding: authority,
  profile_digest: sha,
  credential_generation: 1,
  servers: [
    {
      type: "http",
      name: "superlibrary",
      url: `${profile.proxy_origin}/stations/${authority.station_id}/mcp/superlibrary`,
      headers: [
        {
          name: "X-Agentpod-Proxy-Key",
          value: "fixture-proxy-key-never-use-as-a-live-secret",
        },
      ],
    },
  ],
};

test("managed MCP needs an explicit reviewed schema and authority policy, never annotations", () => {
  expect<unknown>(SalaamMcpProfile.parse(profile)).toEqual(profile);
  for (const tool of [
    { name: "library_search", schema_digest: sha },
    { name: "library_search", schema_digest: sha, policy: "annotation" },
    {
      name: "library_search",
      schema_digest: sha,
      policy: "read",
      readOnlyHint: true,
    },
    { name: "library_search", schema_digest: "unpinned", policy: "read" },
  ]) {
    expect(
      SalaamMcpProfile.safeParse({
        ...profile,
        servers: [{ ...profile.servers[0], tools: [tool] }],
      }).success,
    ).toBe(false);
  }
});

test("only a literal canonical loopback proxy origin and bounded limits are admitted", () => {
  for (const proxy_origin of [
    "http://localhost:43421",
    "http://0.0.0.0:43421",
    "http://127.1:43421",
    "http://127.0.0.1:43421/",
    "http://127.0.0.1:43421/path",
    "http://secret@127.0.0.1:43421",
    "http://127.0.0.1:43421?token=x",
    "https://remote.example",
    "http://127.0.0.1:43421#fragment",
  ])
    expect(
      SalaamMcpProfile.safeParse({ ...profile, proxy_origin }).success,
    ).toBe(false);
  for (const limits of [
    { ...profile.limits, timeout_ms: 0 },
    { ...profile.limits, timeout_ms: 30001 },
    { ...profile.limits, response_bytes: 1048577 },
    { ...profile.limits, calls_per_attempt: 33 },
    { ...profile.limits, request_bytes: 65537 },
    { ...profile.limits, retries: 1 },
  ])
    expect(SalaamMcpProfile.safeParse({ ...profile, limits }).success).toBe(
      false,
    );
});

test("duplicate servers/tools and caller-invented configuration are rejected", () => {
  for (const value of [
    { ...profile, headers: assignment.servers[0]!.headers },
    { ...profile, servers: [profile.servers[0], profile.servers[0]] },
    {
      ...profile,
      servers: [
        {
          ...profile.servers[0],
          tools: [profile.servers[0]!.tools[0], profile.servers[0]!.tools[0]],
        },
      ],
    },
    {
      ...profile,
      servers: [{ ...profile.servers[0], protocol_version: "assume-latest" }],
    },
    {
      ...profile,
      servers: [{ ...profile.servers[0], name: "caller-controlled-service" }],
    },
  ])
    expect(SalaamMcpProfile.safeParse(value).success).toBe(false);
});

test("private node assignment binds the station endpoint, current authority and exact proxy header", () => {
  expect<unknown>(SalaamMcpAssignment.parse(assignment)).toEqual(assignment);
  for (const url of [
    `${profile.proxy_origin}/stations/other/mcp/superlibrary`,
    `${profile.proxy_origin}/stations/${authority.station_id}/mcp/hub`,
    `${assignment.servers[0]!.url}?token=secret`,
    `${assignment.servers[0]!.url}#fragment`,
    assignment.servers[0]!.url.replace("127.0.0.1", "localhost"),
  ])
    expect(
      SalaamMcpAssignment.safeParse({
        ...assignment,
        servers: [{ ...assignment.servers[0], url }],
      }).success,
    ).toBe(false);
  for (const patch of [
    { credential_generation: 0 },
    { profile_digest: "unreviewed" },
    { binding: { ...authority, run: { ...authority.run, epoch: 0 } } },
    { mayDispatch: ["*"] },
    { servers: [...assignment.servers, ...assignment.servers] },
    {
      servers: [
        {
          ...assignment.servers[0],
          headers: [{ name: "Authorization", value: "Bearer fixture" }],
        },
      ],
    },
    { servers: [{ ...assignment.servers[0], headers: [] }] },
  ])
    expect(
      SalaamMcpAssignment.safeParse({ ...assignment, ...patch }).success,
    ).toBe(false);
});
