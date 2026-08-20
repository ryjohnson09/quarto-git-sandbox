# Changelog

## 1.0.2

- `merged X into Y` now requires a merge to have actually happened. It was an
  ancestry check, which is trivially true the moment X is branched off Y's tip,
  so "merge X into Y" tasks checked off before any merge occurred. The sandbox
  now records ref-moving merges (`git merge` and `git pull`, fast-forward or
  merge commit; not "Already up to date"), and the condition requires one, plus
  the merge result still being in Y's history. Compound guards like
  `merged X into Y and commits on X >= N` are no longer needed.
- `merged X into Y` also stays true after the merged branch is deleted.
- The `GitSandboxUI.isMerged(graph, name, into)` helper follows the same
  semantics, using the new `graph.merges` record.

## 1.0.1

- Reset now clears the command history, so tasks checked with `ran "..."`
  no longer re-complete themselves immediately after a reset.
- Reset also clears any text left in the terminal input.
- Typing `reset` as a command no longer leaves the word `reset` itself in
  the freshly cleared history.

## 1.0.0

First release.

- A `git-sandbox` code block that renders a real Git repository in the browser,
  running isomorphic-git against an in-memory filesystem.
- A terminal supporting `init`, `status`, `add`, `rm`, `commit`, `log`, `diff`,
  `branch`, `checkout`, `switch`, `merge` and `config`, plus enough shell
  (`ls`, `cat`, `echo >`, `touch`, `rm`, `mkdir`, `pwd`) to create something to
  commit.
- A working-directory/staging/repository diagram and a lane-assigned commit
  graph, both updating after every command.
- Declarative task conditions via `when:`, so lessons need no JavaScript, with a
  `js:` escape hatch for the rest.
- Author-facing error reporting: unreadable options render a visible error box,
  unreadable conditions are flagged next to the task they belong to.
- A static fallback for non-HTML formats.
- `example.qmd`, a three-exercise lesson on committing, branching and merging.
