#!/bin/sh
# Cloud bench container ONLY — never product code. Installed as
# /usr/bin/chromium on the bench image (spec 2026-09-26-wingman-forced-handoff
# § 10.A, recipe from the 2026-09-26 A/B rerun r2): the container's egress
# proxy re-terminates TLS with a CA the Chrome Root Store does not trust, and
# the bench runs as root, which Chromium's own sandbox refuses. This wrapper
# drops to an unprivileged uid (keeping the browser sandbox enabled) and
# appends --ignore-certificate-errors so navigation through that proxy
# succeeds. Nothing in src/ reads or ships this file.

REAL_CHROMIUM="${REAL_CHROMIUM:-/opt/pw-browsers/chromium}"

# ensureChrome() creates the profile dir as root; hand it to nobody first.
# `nobody` also needs +x (traverse, never +r/list) on every ANCESTOR
# directory of user-data-dir, not just its immediate parent: the ephemeral
# mkdtemp case only needed one level because its parent was already
# world-traversable (under /tmp), but the default profile
# (~/.jev-browser-wingman/profile, i.e. /root/.jev-browser-wingman/profile
# when the bench runs as root) sits two levels under /root itself, which
# defaults to 0700 — a single-level chmod leaves /root blocking traversal
# and chrome never starts. Walk every ancestor up to (not including) `/`,
# granting only the execute bit (never read, so `nobody` still cannot list
# /root's other contents).
for a in "$@"; do
  case "$a" in
    --user-data-dir=*)
      dir="${a#--user-data-dir=}"
      chown -R nobody "$dir"
      d="$(dirname "$dir")"
      while [ "$d" != "/" ] && [ "$d" != "." ] && [ -n "$d" ]; do
        chmod o+x "$d" 2>/dev/null || true
        d="$(dirname "$d")"
      done
      ;;
  esac
done

# A writable scratch home for nobody (fontconfig cache, crashpad database).
mkdir -p /tmp/chromium-nobody
export HOME=/tmp/chromium-nobody
export XDG_CACHE_HOME=/tmp/chromium-nobody
export XDG_CONFIG_HOME=/tmp/chromium-nobody

exec setpriv --reuid=nobody --regid=nogroup --init-groups "$REAL_CHROMIUM" "$@" --ignore-certificate-errors
