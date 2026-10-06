# Evidence — shared fixture corpus

What superwitness reads from AgentPod, pinned so the producer's CI fails before a reader does
(superwitness milestone-1 spec §7.2; contracts C3 and C5 in its plan index).

| File | Pins | Validated by |
|---|---|---|
| `fingerprint_digest.json` | C3: canonical JSON and digest, with the encodings that must NOT match | `apps/hub/src/services/evidence/fingerprint.test.ts` |
| `hub_evidence_run.json` | C5 `GET /api/evidence/runs/:source/:externalRunId` | `packages/contract/src/evidence.test.ts` (shape), `apps/hub/src/routes/evidence.test.ts` (live response) |
| `hub_evidence_attempt.json` | C5 `GET /api/evidence/attempts/:attemptId` | same two files |
| `hub_evidence_principal.json` | C5 `GET /api/evidence/principals/:principalId` | `packages/contract/src/evidence.test.ts`, `apps/hub/src/routes/evidence.test.ts` |
| `hub_evidence_transcript.json` | `GET /api/evidence/sessions/:sessionId/transcript` (superwitness transcripts spec §3.3): every item kind, partial items, a redaction, a cut field, the error bodies | `packages/contract/src/evidence.test.ts` (shape), `apps/hub/src/routes/evidence-transcript.test.ts` (live response) |
| `hub_evidence_transcript_item.json` | `GET /api/evidence/sessions/:sessionId/transcript/items/:seqFrom` | same two files |

Same rules as `../ecosystem-identity/`: plain JSON, no repo's types, copied (never linked) into a
consumer, negative cases included. A change to a shape bumps `version` and is a change to the
consumer too.
