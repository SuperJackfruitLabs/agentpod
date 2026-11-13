#!/bin/sh
# Release hook (deploy): the production deploy of the hub and console.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
sh deploy/release/deploy.sh
