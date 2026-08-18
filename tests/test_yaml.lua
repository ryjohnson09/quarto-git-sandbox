-- Unit tests for yaml.lua.  Run: quarto pandoc lua tests/test_yaml.lua
package.path = '_extensions/git-sandbox/?.lua;' .. package.path
local yaml = require('yaml')

local pass, fail, failures = 0, 0, {}

local function show(v, depth)
  depth = depth or 0
  if type(v) ~= 'table' then return string.format('%q', tostring(v)) end
  local isArray = #v > 0
  local parts = {}
  if isArray then
    for _, x in ipairs(v) do parts[#parts + 1] = show(x, depth + 1) end
    return '[' .. table.concat(parts, ', ') .. ']'
  end
  local keys = {}
  for k in pairs(v) do if k ~= '__keys' then keys[#keys + 1] = k end end
  table.sort(keys)
  for _, k in ipairs(keys) do parts[#parts + 1] = k .. '=' .. show(v[k], depth + 1) end
  return '{' .. table.concat(parts, ', ') .. '}'
end

local function eq(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for i, v in ipairs(a) do if not eq(v, b[i]) then return false end end
  if #a ~= #b then return false end
  for k, v in pairs(a) do
    if k ~= '__keys' and not eq(v, b[k]) then return false end
  end
  for k, v in pairs(b) do
    if k ~= '__keys' and a[k] == nil then return false end
  end
  return true
end

local function check(label, got, want)
  if eq(got, want) then pass = pass + 1
  else
    fail = fail + 1
    failures[#failures + 1] = label .. '\n     got:  ' .. show(got) .. '\n     want: ' .. show(want)
  end
end

-- M.parse returns (nil, message) rather than raising: Quarto's Lua filter
-- environment replaces the global `error`, so raising is not dependable.
local function check_error(label, src, pattern)
  local value, err = yaml.parse(src)
  if value ~= nil then
    fail = fail + 1
    failures[#failures + 1] = label .. '\n     expected an error, got: ' .. show(value)
  elseif pattern and not tostring(err):match(pattern) then
    fail = fail + 1
    failures[#failures + 1] = label .. '\n     error did not match ' .. pattern .. '\n     got: ' .. tostring(err)
  else
    pass = pass + 1
  end
end

----------------------------------------------------------------- scalars

check('bare scalar', yaml.parse('a: hello'), { a = 'hello' })
check('scalar with spaces', yaml.parse('a: hello there world'), { a = 'hello there world' })
check('double quoted', yaml.parse('a: "hello there"'), { a = 'hello there' })
check('single quoted', yaml.parse("a: 'hello there'"), { a = 'hello there' })
check('quotes preserved inside bare scalar',
  yaml.parse('a: echo "# Sales analysis" > README.md'),
  { a = 'echo "# Sales analysis" > README.md' })
check('hash inside quotes is not a comment',
  yaml.parse('a: "value # not a comment"'),
  { a = 'value # not a comment' })
check('trailing comment stripped', yaml.parse('a: value  # a comment'), { a = 'value' })
check('hash without leading space is kept', yaml.parse('a: value#tag'), { a = 'value#tag' })
check('whole-line comment ignored', yaml.parse('# top\na: 1\n# mid\nb: 2'), { a = '1', b = '2' })
check('escape sequences in double quotes', yaml.parse('a: "one\\ntwo"'), { a = 'one\ntwo' })
check('doubled single quote', yaml.parse("a: 'it''s here'"), { a = "it's here" })
check('empty value', yaml.parse('a:\nb: 2'), { a = '', b = '2' })
check('colon inside quoted value', yaml.parse('a: "12:30 sharp"'), { a = '12:30 sharp' })
check('prompt with dollar and tilde', yaml.parse('prompt: "~/sales-analysis $"'),
  { prompt = '~/sales-analysis $' })

----------------------------------------------------------------- flow seqs

check('flow sequence', yaml.parse('a: [x, y, z]'), { a = { 'x', 'y', 'z' } })
check('flow sequence with quotes and commas',
  yaml.parse('a: ["one, two", three]'),
  { a = { 'one, two', 'three' } })
check('flow sequence with git commands',
  yaml.parse('hints: [git init, git status, git commit -m "hello"]'),
  { hints = { 'git init', 'git status', 'git commit -m "hello"' } })
check('empty flow sequence', yaml.parse('a: []'), { a = {} })

----------------------------------------------------------------- blocks

check('literal block keeps newlines',
  yaml.parse('seed: |\n  git init\n  git add .\n'),
  { seed = 'git init\ngit add .\n' })
check('literal block strip chomp',
  yaml.parse('seed: |-\n  git init\n  git add .\n'),
  { seed = 'git init\ngit add .' })
check('literal block preserves quotes and redirects',
  yaml.parse('seed: |\n  echo "# Sales analysis" > README.md\n  git commit -m "Add the README"\n'),
  { seed = 'echo "# Sales analysis" > README.md\ngit commit -m "Add the README"\n' })
check('literal block keeps a leading hash line',
  yaml.parse('seed: |\n  # this is a shell comment\n  git init\n'),
  { seed = '# this is a shell comment\ngit init\n' })
check('literal block with internal blank line',
  yaml.parse('seed: |\n  one\n\n  two\n'),
  { seed = 'one\n\ntwo\n' })
check('literal block ends at dedent',
  yaml.parse('seed: |\n  git init\nnext: after'),
  { seed = 'git init\n', next = 'after' })
check('folded block joins lines',
  yaml.parse('note: >\n  one\n  two\n'),
  { note = 'one two\n' })
check('folded block keeps paragraph breaks',
  yaml.parse('note: >-\n  one\n  two\n\n  three\n'),
  { note = 'one two\nthree' })
check('deeper indented literal block',
  yaml.parse('a:\n  seed: |\n      git init\n      ls\n'),
  { a = { seed = 'git init\nls\n' } })

----------------------------------------------------------------- sequences

check('block sequence of scalars',
  yaml.parse('a:\n  - one\n  - two\n'),
  { a = { 'one', 'two' } })
check('block sequence of mappings',
  yaml.parse('tasks:\n  - text: first\n    when: repo\n  - text: second\n    when: commits >= 1\n'),
  { tasks = { { text = 'first', when = 'repo' }, { text = 'second', when = 'commits >= 1' } } })
check('sequence item with a quoted value',
  yaml.parse('tasks:\n  - text: "Run `git init`"\n    when: repo\n'),
  { tasks = { { text = 'Run `git init`', when = 'repo' } } })
check('sequence item with a literal block inside',
  yaml.parse('tasks:\n  - text: one\n    js: |\n      return c.isRepo;\n'),
  { tasks = { { text = 'one', js = 'return c.isRepo;\n' } } })
check('four-space sequence indentation',
  yaml.parse('tasks:\n    - text: first\n      when: repo\n'),
  { tasks = { { text = 'first', when = 'repo' } } })
check('sequence then another key',
  yaml.parse('a:\n  - one\n  - two\nb: after\n'),
  { a = { 'one', 'two' }, b = 'after' })
check('nested mapping', yaml.parse('a:\n  b: 1\n  c: 2\n'), { a = { b = '1', c = '2' } })
check('top-level sequence', yaml.parse('- one\n- two\n'), { 'one', 'two' })

----------------------------------------------------------------- realistic

local cfg = yaml.parse([[
id: first-commit
title: "Exercise 1 — your first commit"
prompt: "~/sales-analysis $"
hints: [git init, git status, git commit -m "Add the README"]
intro: |
  You have an empty project folder. Nothing is tracked yet.
  Type {y}help{/} to see the available commands.
seed: |
  git init
  echo "# Sales analysis" > README.md
  git add .
  git commit -m "Add the project README"
done-note: Edit, stage, commit.
tasks:
  - text: Start tracking the folder with `git init`
    when: repo
  - text: Make a commit
    when: commits >= 1
  - text: Merge `report` into `main`
    when: merged report into main and on main
]])

check('realistic: id', cfg.id, 'first-commit')
check('realistic: title', cfg.title, 'Exercise 1 — your first commit')
check('realistic: prompt', cfg.prompt, '~/sales-analysis $')
check('realistic: hints', cfg.hints, { 'git init', 'git status', 'git commit -m "Add the README"' })
check('realistic: intro keeps two lines and markers', cfg.intro,
  'You have an empty project folder. Nothing is tracked yet.\nType {y}help{/} to see the available commands.\n')
check('realistic: seed keeps quotes, hash and redirect', cfg.seed,
  'git init\necho "# Sales analysis" > README.md\ngit add .\ngit commit -m "Add the project README"\n')
check('realistic: hyphenated key', cfg['done-note'], 'Edit, stage, commit.')
check('realistic: 3 tasks', #cfg.tasks, 3)
check('realistic: task 1', cfg.tasks[1], { text = 'Start tracking the folder with `git init`', when = 'repo' })
check('realistic: task 3 when', cfg.tasks[3].when, 'merged report into main and on main')
check('realistic: key order recorded', cfg.__keys[1], 'id')

----------------------------------------------------------------- errors

check_error('missing colon', 'just some text', 'expected "key: value"')
check_error('over-indented line', 'a: 1\n    b: 2', 'unexpected indentation')
check_error('bad flow sequence', 'a: [x, y', 'expected a flow sequence')

-- the message must be clean: no "yaml.lua:123:" prefix leaking to authors
do
  local _, err = yaml.parse('just some text')
  if tostring(err):match('yaml%.lua:%d+:') then
    fail = fail + 1
    failures[#failures + 1] = 'error message leaks a Lua source location\n     got: ' .. tostring(err)
  else
    pass = pass + 1
  end
  local _, err2 = yaml.parse('just some text')
  if tostring(err2):match('^line 1: ') then pass = pass + 1
  else
    fail = fail + 1
    failures[#failures + 1] = 'error message should start with the line number\n     got: ' .. tostring(err2)
  end
end

-- a successful parse must not return a spurious second value
do
  local value, err = yaml.parse('a: 1')
  if err == nil and type(value) == 'table' then pass = pass + 1
  else
    fail = fail + 1
    failures[#failures + 1] = 'successful parse returned an error: ' .. tostring(err)
  end
end

----------------------------------------------------------------- report

print('')
print('===== yaml.lua =====')
print('passed: ' .. pass .. '   failed: ' .. fail)
if #failures > 0 then
  print('')
  print('FAILURES:')
  for _, f in ipairs(failures) do print(' - ' .. f) end
  os.exit(1)
end
