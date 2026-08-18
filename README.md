# quarto-git-sandbox

[![test](https://github.com/ryjohnson09/quarto-git-sandbox/actions/workflows/test.yml/badge.svg)](https://github.com/ryjohnson09/quarto-git-sandbox/actions/workflows/test.yml)

**[Try the live demo →](https://ryjohnson09.github.io/quarto-git-sandbox/)**

Interactive Git exercises for Quarto documents. Each exercise is a **real Git
repository running in the reader's browser** — learners type real `git`
commands and watch a working-directory/staging/repository diagram and a live
commit graph update as they go.

Nothing is installed, nothing is uploaded, nothing is written to disk. The
repository lives in memory and disappears on reload.

```markdown
```git-sandbox
title: Your first commit
tasks:
  - text: Start tracking the folder with `git init`
    when: repo
  - text: Stage a file and commit it
    when: commits >= 1
```
```

Conditions are declarative, so lessons stay in Markdown and YAML. You do not
need to write JavaScript to author an exercise.

## Install

```bash
quarto add ryjohnson09/quarto-git-sandbox
```

Then add the filter to your document, and use a `git-sandbox` block wherever
you want an exercise:

```yaml
---
title: "Version control with Git"
format: html
filters:
  - git-sandbox
---
```

`example.qmd` in this repository is a complete three-exercise lesson. Render it
to see everything working:

```bash
quarto render example.qmd
```

Requires Quarto 1.4 or later, and an HTML output format.

## Writing an exercise

````markdown
```git-sandbox
id: first-commit
title: Exercise 1 — your first commit
prompt: "~/sales-analysis $"
intro: |
  You have an empty project folder. Nothing is tracked yet.
  Type {y}help{/} to see the available commands.
hints: [git init, git status, git add ., 'git commit -m "First commit"']
seed: |
  git init
  echo "# Sales analysis" > README.md
  git add .
  git commit -m "Add the project README"
done-note: Edit, stage, commit — that loop is most of Git.
tasks:
  - text: Create a branch called `report`
    when: branch report
  - text: Commit something on it
    when: commits on report >= 2
  - text: Merge it back into `main`
    when: on main and merged report into main
```
````

### Options

| Option | What it does |
|---|---|
| `id` | HTML id for the exercise. Defaults to `git-sandbox-1`, `-2`, … Useful for linking. |
| `title` | Shown in the exercise header. Markdown allowed. |
| `prompt` | Shell prompt. The current branch is appended automatically. Default `~/project $`. |
| `intro` | Lines printed in the terminal when the exercise loads. Verbatim — no Markdown. |
| `hints` | Clickable buttons that fill the input. Give learners the commands they need. |
| `seed` | Commands run before the learner arrives, to set up a starting history. |
| `done-note` | Shown once every task is complete. Markdown allowed. |
| `tasks` | The checklist. Each needs a `text:` and a `when:`. |

Two notes on quoting, because both bite:

- `intro` is terminal output, not Markdown. Use `{y}…{/}` for yellow, `{g}`
  green, `{r}` red, `{b}` blue, `{w}` bold, and `{/}` to end. Backticks will
  appear literally.
- In flow sequences like `hints: [...]`, wrap any entry containing a double
  quote in single quotes: `'git commit -m "First commit"'`.

`seed` failures are loud. If a seed command fails, the exercise says so rather
than dropping the learner into a half-built repository.

## Conditions: the `when:` language

A task ticks when its condition becomes true, and stays ticked afterwards — so
you can check for states the learner passes through.

| Condition | True when |
|---|---|
| `repo` | `git init` has been run |
| `clean` | No uncommitted or untracked changes |
| `staged` | Something is in the staging area |
| `commits >= 3` | At least three commits exist. `>`, `<`, `<=`, `==` and `=` also work; a bare number means `>=` |
| `commits on report >= 2` | Two commits are reachable from the `report` branch |
| `branch report` | A branch called `report` exists |
| `on main` | `HEAD` is on `main` |
| `merged report into main` | `report`'s tip is an ancestor of `main`'s tip |
| `merge commit` | Some commit has two parents |
| `file report.qmd` | That file exists in the working directory |
| `file report.qmd contains "Q3"` | It exists and contains that text. `/regex/` works too |
| `ran /git\s+status/` | The learner ran a matching command. Plain text matches as a substring |

Combine with `and`, `or`, `not` and parentheses. `and` binds tighter than `or`.

```yaml
when: on main and merged report into main
when: not branch forecast and ran /git\s+branch\s+-[dD]/
when: (staged or commits >= 1) and file README.md
```

**Prefer state over `ran`.** `commits >= 1` is true however the learner got
there; `ran "git commit"` breaks the moment someone uses a different flag. Use
`ran` only when running a specific command *is* the point — checking `git
status`, for instance.

### Errors are visible

A condition that cannot be read shows the problem in place, next to the task,
naming what it expected. Bad block options produce a visible error box instead
of a silently missing exercise. You should never have to open the console to
find out why an exercise is not working.

### The `js:` escape hatch

For anything the language cannot express, use `js:` instead of `when:`. It
receives a context object `c`:

```yaml
tasks:
  - text: Write a commit message longer than ten characters
    js: c.graph.commits.some(x => x.message.length > 10)
```

| Field | Contents |
|---|---|
| `c.isRepo` | Boolean |
| `c.graph.commits` | `[{ oid, short, message, parents, refs, lane, timestamp, author }]`, children first |
| `c.graph.branches` | `[{ name, oid, isHead }]` |
| `c.graph.head` | Current branch name |
| `c.status` | `{ staged, modified, untracked, deleted, stagedDeleted }` |
| `c.files` | Filenames in the working directory |
| `c.history` | Every command typed, in order |
| `c.sb` | The sandbox, for `await c.sb.readFile('notes.txt')` |

`js:` uses `new Function`, so it needs `'unsafe-eval'` in your Content Security
Policy. `when:` does not — another reason to prefer it.

## What the sandbox supports

**Git** — `init`, `status`, `add`, `rm`, `commit -m`, `log [--oneline]`,
`diff`, `branch [-d]`, `checkout [-b]`, `switch [-c]`, `merge`,
`config user.name|user.email`

**Shell** — `ls [-a]`, `cat`, `echo "…" > file`, `echo "…" >> file`, `touch`,
`rm`, `mkdir`, `pwd`, `whoami`, plus `help`, `clear`, `reset`

Up arrow recalls previous commands. **Reset** returns the exercise to its
seeded state.

## What it does not do, on purpose

- **No remotes.** `push`, `pull`, `clone` and `fetch` need a server.
  isomorphic-git can talk to GitHub through a CORS proxy, which is a real but
  separate piece of work.
- **No conflict resolution.** isomorphic-git merges cleanly or fails. A
  conflict prints an explanation and suggests resetting, so a lesson stays
  honest about the limit rather than faking it.
- **No `rebase`, `stash`, `reset --hard`, `cherry-pick` or `revert`.** These
  could be added to the engine in `src/sandbox-core.js`.

## Using it outside Quarto

`example-embed.html` is a plain HTML page with no Quarto and no build step:
copy the three files from `_extensions/git-sandbox/resources/`, add a
container, and call `GitSandboxUI.mount()` with the same options in JavaScript.
Useful when a platform will take an HTML block or an iframe but not a Quarto
document.

## Notes for platform and LMS embedding

- **Page weight.** The Git engine is 260 KB (80 KB gzipped) and loads after the
  body, so it never blocks first paint. With `embed-resources: true` a lesson
  becomes a single self-contained file of roughly 2 MB, much of it embedded
  fonts — worth dropping the font `<link>` if your platform already serves Open
  Sans and Source Code Pro.
- **Content Security Policy.** `embed-resources: true` inlines scripts as
  `data:` URIs, so `script-src` needs `data:`. Without `embed-resources` the
  assets are ordinary files and no CSP exception is needed. Avoid `js:` if
  `'unsafe-eval'` is not available.
- **Non-HTML formats.** In PDF, Word and Markdown output, each exercise becomes
  a note that it is interactive plus a list of its tasks, rather than a hole.
- **Accessibility.** Terminal output is an `aria-live="polite"` region, the
  input is labelled, and every text/background pair meets WCAG AA. Status is
  never conveyed by colour alone.

## Development

```bash
npm install          # dev dependencies only; the extension itself needs none
./build.sh           # rebuild _extensions/.../git-sandbox.js from src/
./build.sh --vendor  # also re-bundle isomorphic-git
./tests/run.sh       # all six suites
```

`_extensions/git-sandbox/resources/git-sandbox.js` is generated. Edit `src/`
and rebuild. See `CONTRIBUTING.md`.

## Licence

MIT — see `LICENSE`.

`_extensions/git-sandbox/resources/isomorphic-git.bundle.js` bundles
[isomorphic-git](https://isomorphic-git.org) and
[buffer](https://github.com/feross/buffer), both MIT. The bundle header records
both licences and the command that regenerates it.

The polyfill is not optional: isomorphic-git's index code calls a global
`Buffer`, which browsers do not provide, so a bare CDN copy of isomorphic-git
fails at the first `git add`.
