#!/usr/bin/env bash
# A backtick inside a Go raw string TERMINATES it. Inside a SQL comment the damage is
# invisible at a glance and surfaces as a syntax error many lines away.
hits=$(grep -rn "^[[:space:]]*--.*\`" --include="*.go" internal/ 2>/dev/null)
if [ -n "$hits" ]; then printf 'backtick inside raw SQL:\n%s\n' "$hits"; exit 1; fi
echo "clean: no backticks inside raw SQL comments"
