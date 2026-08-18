#!/usr/bin/env bash
# Run everything. Needs: node, npm install, and quarto on PATH.
#
#   ./tests/run.sh
#
# 1. yaml.lua      the option parser, run under Quarto's bundled Lua
# 2. test-core     the git command engine, headless
# 3. test-when     the `when:` mini-language against real repository state
# 4. test-ui       terminal, staging diagram and commit graph at the DOM level
# 5. test-errors   bad options and bad conditions produce visible messages
# 6. test-embed    the same widget on a plain HTML page, no Quarto
# 7. test-rendered the extension's real rendered output, driven end to end

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() {
  printf '\n\033[1m--- %s\033[0m\n' "$1"
}

step "yaml.lua (option parser)"
quarto pandoc lua tests/test_yaml.lua || fail=1

for t in test-core test-when test-ui; do
  step "$t"
  node "tests/$t.js" | tail -8 || fail=1
done

step "test-errors (authoring mistakes)"
node tests/test-errors.js | tail -8 || fail=1

step "test-embed (standalone HTML page)"
node tests/test-embed.js | tail -4 || fail=1

step "rendering example.qmd"
quarto render example.qmd --quiet || fail=1

step "test-rendered (end to end, real output)"
node tests/test-rendered.js example.html 2>/dev/null | tail -12 || fail=1

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32mall suites passed\033[0m\n'
else
  printf '\033[31msome suites failed\033[0m\n'
  exit 1
fi
