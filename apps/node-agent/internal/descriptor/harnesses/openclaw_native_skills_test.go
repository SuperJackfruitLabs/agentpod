package harnesses

// The report OpenClaw 2026.2.12 prints for `skills list --json`, trimmed to the
// fields a placement reads. Taken from a real run, not invented: the probe row
// is what a fixture placed at ~/.openclaw/skills/<name>/SKILL.md produced.
// The report OpenClaw 2026.2.12 prints for `skills list --json`: an OBJECT
// carrying the directories it resolved and the inventory under `skills`, with
// the rows trimmed to the fields a placement reads.
//
// An earlier version of this fixture was a bare array. The rows were real but
// the envelope was invented, so the parser was written against a shape the
// harness never emits and this test passed on both halves of the same mistake.
// The probe row is what a fixture placed at ~/.openclaw/skills/<name>/SKILL.md
// actually produced.
const openclawSkillReport = `{
 "workspaceDir": "/home/u/.openclaw/workspace",
 "managedSkillsDir": "/home/u/.openclaw/skills",
 "skills": [
  {"name":"sjl-fixture","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
  {"name":"ai-elements","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"agents-skills-personal","bundled":false},
  {"name":"1password","eligible":false,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-bundled","bundled":true},
  {"name":"muted","eligible":true,"disabled":true,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
  {"name":"blocked","eligible":true,"disabled":false,"blockedByAllowlist":true,"source":"openclaw-managed","bundled":false}
 ]
}`
