#!/bin/sh
# Release hook (smoke): the hub's production smoke; the workflow retries it.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
sh deploy/release/smoke.sh
