#!/bin/sh
# The hub's production smoke (the .github/release/smoke.sh hook; the workflow retries it),
# against production Accounts as the issuer.
set -eu
EXPECT_ISSUER=https://accounts.superjackfruit.com exec sh deploy/smoke.sh https://hub.agentpod.dev
