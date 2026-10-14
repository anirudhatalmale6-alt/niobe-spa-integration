#!/bin/sh
# Build /etc/nginx/.niobe_desk_all: the central login PLUS every branch login, for the staff
# pages every front desk needs — the gift card desk (/desk/cards) and the all-branch booking
# search (/desk/search). Each branch page keeps its own branch-only file; the gift-card sweep
# report (customer names and balances) stays on the central login only.
#
# nginx takes ONE password file per location, so the shared file is a concatenation. Re-run
# this after ANY password change, or the shared pages keep accepting the old password.
set -eu
cd /etc/nginx
out=.niobe_desk_all
tmp=$(mktemp)
cat .niobe_htpasswd .niobe_desk_east_legon .niobe_desk_cantonments .niobe_desk_african_regent \
    .niobe_desk_hfc_c18 .niobe_desk_alisa_hotel > "$tmp"
# The same username in two files would let whichever comes first win, silently.
dups=$(cut -d: -f1 "$tmp" | sort | uniq -d)
if [ -n "$dups" ]; then echo "Duplicate username(s): $dups - not writing $out" >&2; rm -f "$tmp"; exit 1; fi
chown root:www-data "$tmp"; chmod 640 "$tmp"
mv "$tmp" "$out"
echo "Wrote /etc/nginx/$out ($(wc -l < "$out") logins: $(cut -d: -f1 "$out" | tr '\n' ' '))"
