/* Tests for the `when:` mini-language, evaluated against real repository
   state built by the sandbox engine. Run: node test-when.js */
const git = require('isomorphic-git');
const Core = require('../src/sandbox-core.js');
const W = require('../src/sandbox-when.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(label + (detail ? '\n     ' + detail : '')); }
}

// Build a context the way the UI does.
async function contextFor(sb) {
  const graph = await sb.graphModel();
  const isRepo = await sb.isRepo();
  const status = isRepo ? await sb.statusModel()
    : { staged: [], modified: [], untracked: [], deleted: [], stagedDeleted: [] };
  const files = await sb.listFiles();
  const contents = {};
  for (const f of files) {
    try { contents[f] = await sb.readFile(f); } catch (e) { contents[f] = ''; }
  }
  return {
    sb, graph, status, files, isRepo,
    history: sb.__history || [],
    _fileText: (n) => contents[n] || ''
  };
}

async function build(commands) {
  const sb = Core.createSandbox({ git });
  sb.__history = [];
  for (const c of commands) {
    const r = await sb.run(c);
    sb.__history.push(c);
    if (!r.ok && !/^__allowfail/.test(c)) {
      // surface setup problems instead of testing against a broken repo
      throw new Error('setup command failed: ' + c + ' -> ' + String(r.out).split('\n')[0]);
    }
  }
  return sb;
}

function evalWhen(expr, ctx) {
  return W.compileWhen(expr)(ctx);
}

(async () => {

  /* ------------------- an empty folder, no repository ------------------- */
  {
    const ctx = await contextFor(await build([]));
    check('repo is false before init', evalWhen('repo', ctx) === false);
    check('not repo is true', evalWhen('not repo', ctx) === true);
    check('commits >= 1 is false', evalWhen('commits >= 1', ctx) === false);
    check('branch main is false', evalWhen('branch main', ctx) === false);
  }

  /* ------------------- linear history on main ------------------- */
  {
    const sb = await build([
      'git init',
      'echo "# Sales analysis" > README.md',
      'git add .',
      'git commit -m "Add the README"',
      'echo "library(tidyverse)" > analysis.R',
      'git add .',
      'git commit -m "Start the analysis"'
    ]);
    const ctx = await contextFor(sb);

    check('repo', evalWhen('repo', ctx) === true);
    check('clean', evalWhen('clean', ctx) === true);
    check('staged is false on a clean tree', evalWhen('staged', ctx) === false);
    check('commits >= 2', evalWhen('commits >= 2', ctx) === true);
    check('commits >= 3 is false', evalWhen('commits >= 3', ctx) === false);
    check('commits 2 means >= 2', evalWhen('commits 2', ctx) === true);
    check('commits == 2', evalWhen('commits == 2', ctx) === true);
    check('commits = 2', evalWhen('commits = 2', ctx) === true);
    check('commits > 2 is false', evalWhen('commits > 2', ctx) === false);
    check('commits < 5', evalWhen('commits < 5', ctx) === true);
    check('commits <= 2', evalWhen('commits <= 2', ctx) === true);
    check('commits on main >= 2', evalWhen('commits on main >= 2', ctx) === true);
    check('commits on nonesuch >= 1 is false', evalWhen('commits on nonesuch >= 1', ctx) === false);
    check('branch main', evalWhen('branch main', ctx) === true);
    check('on main', evalWhen('on main', ctx) === true);
    check('on report is false', evalWhen('on report', ctx) === false);
    check('merge commit is false', evalWhen('merge commit', ctx) === false);
    check('file README.md', evalWhen('file README.md', ctx) === true);
    check('file missing.txt is false', evalWhen('file missing.txt', ctx) === false);
    check('file contains text', evalWhen('file README.md contains "Sales analysis"', ctx) === true);
    check('file contains absent text is false',
      evalWhen('file README.md contains "Marketing"', ctx) === false);
    check('file contains regex', evalWhen('file analysis.R contains /library\\(\\w+\\)/', ctx) === true);
    check('ran regex', evalWhen('ran /git\\s+add/', ctx) === true);
    check('ran regex not matched is false', evalWhen('ran /git\\s+rebase/', ctx) === false);
    check('ran string', evalWhen('ran "git init"', ctx) === true);

    // boolean composition
    check('and both true', evalWhen('repo and on main', ctx) === true);
    check('and one false', evalWhen('repo and on report', ctx) === false);
    check('or one true', evalWhen('on report or on main', ctx) === true);
    check('or both false', evalWhen('on report or on topic', ctx) === false);
    check('not', evalWhen('not merge commit', ctx) === true);
    check('and binds tighter than or',
      evalWhen('on report and commits >= 99 or repo', ctx) === true);
    check('parentheses override precedence',
      evalWhen('(on report or on main) and commits >= 2', ctx) === true);
    check('parenthesised false', evalWhen('(on report or on topic) and repo', ctx) === false);
    check('three-term and', evalWhen('repo and on main and clean', ctx) === true);
  }

  /* ------------------- dirty working tree ------------------- */
  {
    const sb = await build([
      'git init', 'echo one > a.txt', 'git add .', 'git commit -m "one"',
      'echo two >> a.txt'
    ]);
    const ctx = await contextFor(sb);
    check('clean is false with unstaged edit', evalWhen('clean', ctx) === false);
    check('not clean', evalWhen('not clean', ctx) === true);
    check('staged is false before add', evalWhen('staged', ctx) === false);

    const sb2 = await build([
      'git init', 'echo one > a.txt', 'git add .', 'git commit -m "one"',
      'echo two >> a.txt', 'git add a.txt'
    ]);
    const ctx2 = await contextFor(sb2);
    check('staged after add', evalWhen('staged', ctx2) === true);
    check('clean is false with staged change', evalWhen('clean', ctx2) === false);
  }

  /* ------------------- fast-forward merge ------------------- */
  {
    const sb = await build([
      'git init', 'echo base > base.txt', 'git add .', 'git commit -m "base"',
      'git checkout -b report', 'echo r > report.qmd', 'git add .', 'git commit -m "report"',
      'git checkout main'
    ]);
    let ctx = await contextFor(sb);
    check('merged before merging is false', evalWhen('merged report into main', ctx) === false);
    check('commits on report >= 2', evalWhen('commits on report >= 2', ctx) === true);
    check('commits on main >= 2 is false', evalWhen('commits on main >= 2', ctx) === false);

    await sb.run('git merge report');
    sb.__history.push('git merge report');
    ctx = await contextFor(sb);
    check('merged after fast-forward', evalWhen('merged report into main', ctx) === true);
    check('fast-forward makes no merge commit', evalWhen('merge commit', ctx) === false);
    check('combined branch+merge condition',
      evalWhen('on main and merged report into main', ctx) === true);
  }

  /* ------------------- true merge commit ------------------- */
  {
    const sb = await build([
      'git init', 'echo base > base.txt', 'git add .', 'git commit -m "base"',
      'git checkout -b forecast', 'echo f > forecast.R', 'git add .', 'git commit -m "forecast"',
      'git checkout main', 'echo h > hotfix.md', 'git add .', 'git commit -m "hotfix"'
    ]);
    let ctx = await contextFor(sb);
    check('diverged: forecast not merged', evalWhen('merged forecast into main', ctx) === false);
    check('diverged: no merge commit yet', evalWhen('merge commit', ctx) === false);

    await sb.run('git merge forecast');
    sb.__history.push('git merge forecast');
    ctx = await contextFor(sb);
    check('merge commit exists', evalWhen('merge commit', ctx) === true);
    check('merged forecast into main', evalWhen('merged forecast into main', ctx) === true);
    check('merged main into forecast is false (direction matters)',
      evalWhen('merged main into forecast', ctx) === false);
    check('commits >= 4', evalWhen('commits >= 4', ctx) === true);

    await sb.run('git branch -d forecast');
    sb.__history.push('git branch -d forecast');
    ctx = await contextFor(sb);
    check('branch gone after delete', evalWhen('branch forecast', ctx) === false);
    check('not branch forecast', evalWhen('not branch forecast', ctx) === true);
    check('merge commit survives branch deletion', evalWhen('merge commit', ctx) === true);
  }

  /* ------------------- filesNeeded ------------------- */
  check('filesNeeded finds one file',
    JSON.stringify(W.filesNeeded('file README.md contains "hi"')) === '["README.md"]',
    JSON.stringify(W.filesNeeded('file README.md contains "hi"')));
  check('filesNeeded finds two files',
    JSON.stringify(W.filesNeeded('file a.txt contains "x" and file b.txt contains "y"')) === '["a.txt","b.txt"]',
    JSON.stringify(W.filesNeeded('file a.txt contains "x" and file b.txt contains "y"')));
  check('filesNeeded ignores plain file existence',
    JSON.stringify(W.filesNeeded('file a.txt and repo')) === '[]',
    JSON.stringify(W.filesNeeded('file a.txt and repo')));

  /* ------------------- js: escape hatch ------------------- */
  {
    const sb = await build(['git init', 'echo a > a.txt', 'git add .', 'git commit -m "one"']);
    const ctx = await contextFor(sb);
    check('js expression', W.compileJs('c.graph.commits.length === 1')(ctx) === true);
    check('js with return statement',
      W.compileJs('if (!c.isRepo) return false; return c.files.length === 1;')(ctx) === true);
    let threw = false;
    try { W.compileJs('this is not javascript ((('); } catch (e) { threw = /cannot compile/.test(e.message); }
    check('js syntax error is reported', threw);
  }

  /* ------------------- author-facing error messages ------------------- */
  const badExpressions = [
    ['', /empty/],
    ['   ', /empty/],
    ['frobnicate', /unknown condition "frobnicate"/],
    ['commits', /expected a number/],
    ['commits >=', /expected a number/],
    ['commits >= many', /expected a number/],
    ['commits on', /expected a branch name after "commits on"/],
    ['branch', /expected a branch name after "branch"/],
    ['on', /expected a branch name after "on"/],
    ['merged report', /expected "merged report into <branch>"/],
    ['merged report onto main', /expected "merged report into <branch>"/],
    ['merged report into', /expected a branch name after "into"/],
    ['merge branch', /expected "merge commit"/],
    ['file', /expected a filename after "file"/],
    ['file a.txt contains', /expected text or \/regex\/ after "contains"/],
    ['ran', /expected \/regex\/ or "text" after "ran"/],
    ['repo and', /expected a condition/],
    ['repo or', /expected a condition/],
    ['not', /expected a condition/],
    ['(repo', /missing closing parenthesis/],
    ['repo repo', /unexpected "repo" after a complete condition/],
    ['ran /unterminated', /unterminated \/regex\//],
    ['file a.txt contains "unterminated', /unterminated string/]
  ];
  badExpressions.forEach(([expr, pattern]) => {
    let msg = null;
    try { W.compileWhen(expr); } catch (e) { msg = e.message; }
    check('error for `' + expr + '`', msg !== null && pattern.test(msg),
      msg === null ? 'no error thrown' : 'got: ' + msg);
  });
  // every error should quote the original expression so authors can find it
  {
    let msg = null;
    try { W.compileWhen('commits >= lots'); } catch (e) { msg = e.message; }
    check('error quotes the original expression', /commits >= lots/.test(msg || ''), msg);
  }

  console.log('\n===== when: mini-language =====');
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
