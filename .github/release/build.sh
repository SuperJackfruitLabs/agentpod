#!/bin/sh
# Release hook (build): builds the node-agent, fleet and private bench-worker binaries at the tag.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
sh deploy/release/build.sh
