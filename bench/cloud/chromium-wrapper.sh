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
for a in "$@"; do
  case "$a" in
    --user-data-dir=*)
      chown -R nobody "${a#--user-data-dir=}"
      ;;
  esac
done

# A writable scratch home for nobody (fontconfig cache, crashpad database).
mkdir -p /tmp/chromium-nobody
export HOME=/tmp/chromium-nobody
export XDG_CACHE_HOME=/tmp/chromium-nobody
export XDG_CONFIG_HOME=/tmp/chromium-nobody

exec setpriv --reuid=nobody --regid=nogroup --init-groups "$REAL_CHROMIUM" "$@" --ignore-certificate-errors
