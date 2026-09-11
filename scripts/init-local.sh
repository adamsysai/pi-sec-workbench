#!/bin/sh
set -eu
umask 077
mkdir -p .local
node scripts/init-local.mjs
