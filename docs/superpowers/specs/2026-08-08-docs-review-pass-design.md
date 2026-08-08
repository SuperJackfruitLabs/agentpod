# Docs Review Pass — Design

**Date:** 2026-08-08. Approved scope, four items:

1. **Fix living operator docs** — `docs/DEPLOYMENT.md`, `docs/OPERATING.md`, `docs/README.md` (+ `CONTRIBUTING.md`/`TESTING.md` if stale): purge OpenCode-era references, correct known lies (VPS branch note), reflect actual deploy mechanics (VPS `git fetch && merge --ff-only FETCH_HEAD` + restart; console built with `PUBLIC_HUB_URL` + wrangler pages; releases via `v*` tags).
2. **Agent orientation docs** — write a root `CLAUDE.md` (three-tier architecture, per-app test/build commands incl. the hub test-DB requirements, branch/release conventions); replace the OpenCode-era `apps/hub/CLAUDE.md`. Use the claude-md-improver tooling.
3. **Archive pre-pivot product docs** — move `portable-command-center.md`, `technical-architecture.md`, `user-journey.md`, `vision/`, `v2/`, `ideas/`, `docs/operations/` (production-readiness phases) into `docs/archive/pre-pivot/`. No rewriting.
4. **Ride-along** — delete `.forgejo/workflows/build-containers.yml` (built the now-deleted GHCR codeopen images).

Untouched: historical artifacts (`docs/superpowers/**`, `RELEASE-v0.1.0.md`, `UI-UX-AUDIT-*`, `docs/archive/**`, research/design/getting-started reviewed only for dead links), root `README.md` (already current).

Verification: grep sweep — living docs (DEPLOYMENT, OPERATING, docs/README, CLAUDE.md files, CONTRIBUTING, TESTING) contain no Coolify/Forgejo/OpenCode-sandbox references; every doc referenced from docs/README.md exists.
