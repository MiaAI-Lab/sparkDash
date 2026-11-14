# Shared by every Storage Manager program. Programs always exit 0 and answer as KEY=value lines
# (RESULT=ok|error, CODE, MSG, ...), so a failed ssh and a refused action can be told apart.
fail() { printf 'RESULT=error\nCODE=%s\nMSG=%s\n' "$1" "$2"; exit 0; }
# One short line of plain characters: safe to put in a message whatever a tool printed.
clean() { printf '%s' "$1" | head -n 1 | tr -cd 'A-Za-z0-9 .,:_()/+@=-' | head -c 200; }
