# Changelog

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
