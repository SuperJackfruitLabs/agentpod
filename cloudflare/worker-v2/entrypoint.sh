#!/bin/sh
set -e

# Enroll reads AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN from the environment.
#
# On an ephemeral-disk substrate this runs on every start, not just the first.
# The hub returns the SAME node for a runtime-bound token whose runtime already
# has one (runtime identity persistence, #245), so a restart resumes rather than
# orphaning. Without that this loop would mint a new node every restart.
/usr/local/bin/agentpod-node enroll

exec /usr/local/bin/agentpod-node run
