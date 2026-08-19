# Contributing

Thanks for looking. Bug reports and pull requests are both welcome.

## Getting set up

```bash
git clone https://github.com/ryjohnson09/quarto-git-sandbox
cd quarto-git-sandbox
npm install
./tests/run.sh
```

You need Node 18+ and Quarto 1.4+. `npm install` pulls development
dependencies only; the extension itself ships as plain files and needs no
build step to *use*.

## How the pieces fit together

```
_extensions/git-sandbox/
  git-sandbox.lua      the filter: reads the block, emits a div + config JSON
  yaml.lua             a small YAML subset parser
  resources/
    git-sandbox.js     GENERATED from src/ by ./build.sh; do not edit
    git-sandbox.css    styling
    isomorphic-git.bundle.js   GENERATED from vendor/ by ./build.sh --vendor
    git-sandbox-boot.js        mounts the exercises the filter queued
src/
  sandbox-core.js      in-memory filesystem, git and shell commands, graph model
  sandbox-when.js      the `when:` mini-language
  sandbox-ui.js        terminal, staging diagram, commit graph, task list
```

At render time the filter turns each block into a container plus a
`window.__gsPending.push([...])` call. The boot script, loaded after the body,
drains that queue. This keeps a 260 KB library off the critical path while still
letting per-exercise configuration sit inline where the author wrote it.

Edit `src/`, run `./build.sh`, and the concatenated bundle lands in
`resources/`. The generated file is committed so that `quarto add` works
without a toolchain.

## Tests

```bash
./tests/run.sh
```

| Suite | Covers |
|---|---|
| `tests/test_yaml.lua` | The option parser, run under Quarto's bundled Lua |
| `tests/test-core.js` | Git and shell commands against a real isomorphic-git |
| `tests/test-when.js` | Every `when:` condition, against real repository state |
| `tests/test-ui.js` | Terminal, staging diagram and commit graph, at DOM level |
| `tests/test-errors.js` | Bad options and bad conditions produce visible messages |
| `tests/test-embed.js` | The same widget on a plain HTML page, without Quarto |
| `tests/test-rendered.js` | The real rendered `example.qmd`, driven end to end |

The UI and end-to-end suites use jsdom, so they run in CI without a browser.
`test-rendered.js` loads the actual rendered HTML, executes its real scripts,
and completes the exercises by submitting the form. If it passes, the
lesson works.

Please add tests with changes. New `when:` conditions in particular should get
both a true and a false case, plus an error case for bad syntax.

## Two things that will surprise you

**Quarto replaces the global `error` inside Lua filters** with its own logger.
Calling `error("...")` prints a message and then *returns*, so execution
continues with nil values and blows up somewhere unrelated. `assert` is
untouched, so `yaml.lua` raises through `assert(false, msg)` and `M.parse`
returns `nil, message` instead of raising. Do not add `error()` calls to the
Lua here expecting them to abort.

**Do not use `pandoc.read` to parse the block options.** Pandoc parses metadata
values as Markdown, which mangles the strings that matter most: `echo "# hi" >
f.txt` loses its quotes to smart punctuation, and a literal block's newlines
collapse into spaces. That is why `yaml.lua` exists. Markdown is applied
afterwards, and only to fields that should have it (`title`, `done-note`, task
`text`).

## Style

- Two-space indentation in Lua and JavaScript.
- The browser code is ES5-flavoured on purpose (`var`, no arrow functions in
  `src/`) so it runs without transpilation in older embedded webviews. Tests may
  use modern syntax.
- Comments should explain *why*, not restate the code. If a line looks wrong but
  is deliberate, say why; the `Buffer` polyfill and the `assert` workaround are
  the model here.
- Error messages are read by lesson authors, not programmers. Name the thing
  that is wrong and what was expected.

## Accessibility and contrast

Every text and background pair in the widget meets WCAG AA, and status is never
conveyed by colour alone. If you add a colour, check the contrast ratio before
opening a pull request, and keep a non-colour signal alongside it.

## Releasing

1. Update `CHANGELOG.md`.
2. Bump `version` in `_extensions/git-sandbox/_extension.yml`, `package.json`,
   and the `version` passed to `addHtmlDependency` in `git-sandbox.lua`.
3. Tag the release: `git tag v1.0.1 && git push --tags`.

`quarto add ryjohnson09/quarto-git-sandbox` installs from the **HEAD of `main`**,
not from the latest tag, so whatever is on `main` is what people get. Tags are
opt-in for users who ask for them:

```bash
quarto add ryjohnson09/quarto-git-sandbox        # HEAD of main
quarto add ryjohnson09/quarto-git-sandbox@v1.0.0 # a specific tag
```

Two consequences worth keeping in mind: keep `main` releasable at all times, and
make sure the generated files in `_extensions/git-sandbox/resources/` are
committed and current, because that is what users install.
