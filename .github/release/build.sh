#!/bin/sh
# Release hook (build): builds the node-agent and fleet binaries at the tag.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
sh deploy/release/build.sh
