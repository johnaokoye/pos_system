#!/bin/sh
# Prints the short commit this Docker build is running, or "unknown".
#
# A normal clone has .git, so git answers directly. A Portainer Git stack
# doesn't: Portainer deletes .git after cloning. Then this asks GitHub for the
# latest master and uses its commit only if the source being built matches it,
# so a stack that rebuilt without pulling shows "unknown", not a commit it isn't
# running.

REPO=https://github.com/johnaokoye/pos_system.git
BRANCH=master
PATHS="server.js database.js package.json package-lock.json lib routes public"
TMP=/tmp/build-commit-src

if git rev-parse --short HEAD 2>/dev/null; then exit 0; fi

if ! timeout 60 git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$TMP" 2>/dev/null; then
  echo unknown
  exit 0
fi

result=$(git -C "$TMP" rev-parse --short HEAD)
for p in $PATHS; do
  diff -r "$p" "$TMP/$p" >/dev/null 2>&1 || result=unknown
done
rm -rf "$TMP"
echo "$result"
