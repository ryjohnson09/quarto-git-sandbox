/* Headless tests for the git sandbox engine. Run: node test-core.js */
const git = require('isomorphic-git');
const Core = require('../src/sandbox-core.js');

let pass = 0, fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(label + (detail ? '\n     ' + detail : '')); }
}
function strip(s) { return String(s).replace(/\{[gryb\/w]\}/g, ''); }

async function scenario(name, fn) {
  const sb = Core.createSandbox({ git });
  const log = [];
  const run = async (line) => {
    const r = await sb.run(line);
    log.push('$ ' + line + '\n' + strip(r.out));
    return { ...r, out: strip(r.out) };
  };
  try {
    await fn({ sb, run, check: (label, cond, detail) => check(name + ' :: ' + label, cond, detail) });
  } catch (e) {
    fail++;
    failures.push(name + ' :: THREW ' + e.stack);
  }
  return log;
}

(async () => {

  /* ---------------- 1. memory fs sanity ---------------- */
  await scenario('memfs', async ({ sb, check }) => {
    const fs = sb.fs.promises;
    await fs.mkdir('/a/b/c', { recursive: true });
    await fs.writeFile('/a/b/c/f.txt', 'hello');
    check('readFile utf8', (await fs.readFile('/a/b/c/f.txt', 'utf8')) === 'hello');
    check('readFile bytes', (await fs.readFile('/a/b/c/f.txt')) instanceof Uint8Array);
    check('readdir', JSON.stringify(await fs.readdir('/a/b/c')) === '["f.txt"]');
    check('stat isFile', (await fs.stat('/a/b/c/f.txt')).isFile() === true);
    check('stat isDirectory', (await fs.stat('/a/b')).isDirectory() === true);
    let code = null;
    try { await fs.stat('/nope'); } catch (e) { code = e.code; }
    check('ENOENT on missing', code === 'ENOENT', 'got ' + code);
    code = null;
    try { await fs.mkdir('/a'); } catch (e) { code = e.code; }
    check('EEXIST on dup mkdir', code === 'EEXIST', 'got ' + code);
    code = null;
    try { await fs.mkdir('/zzz/deep'); } catch (e) { code = e.code; }
    check('ENOENT on orphan mkdir', code === 'ENOENT', 'got ' + code);
    code = null;
    try { await fs.rmdir('/a/b'); } catch (e) { code = e.code; }
    check('ENOTEMPTY', code === 'ENOTEMPTY', 'got ' + code);
    await fs.unlink('/a/b/c/f.txt');
    check('unlink', (await fs.readdir('/a/b/c')).length === 0);
  });

  /* ---------------- 2. tokenizer ---------------- */
  {
    const t = Core.tokenize('git commit -m "my first commit"');
    check('tokenize quoted', JSON.stringify(t) === '["git","commit","-m","my first commit"]', JSON.stringify(t));
    const t2 = Core.tokenize('echo "hello world" > notes.txt');
    check('tokenize redirect', JSON.stringify(t2) === '["echo","hello world",">","notes.txt"]', JSON.stringify(t2));
    const t3 = Core.tokenize("echo 'a b' >> f.txt");
    check('tokenize append', JSON.stringify(t3) === '["echo","a b",">>","f.txt"]', JSON.stringify(t3));
    const s = Core.splitRedirect(t2);
    check('splitRedirect', s.args.join('|') === 'echo|hello world' && s.redirect === '>' && s.target === 'notes.txt');
    const t4 = Core.tokenize('echo hello>f.txt');
    check('tokenize no-space redirect', JSON.stringify(t4) === '["echo","hello",">","f.txt"]', JSON.stringify(t4));
  }

  /* ---------------- 3. guardrails before init ---------------- */
  await scenario('guardrails', async ({ run, check }) => {
    let r = await run('git status');
    check('status w/o repo errors', !r.ok && /not a git repository/.test(r.out), r.out);
    r = await run('frobnicate');
    check('unknown command', !r.ok && /command not found/.test(r.out), r.out);
    r = await run('git commit -m "x"');
    check('commit w/o repo', !r.ok, r.out);
  });

  /* ---------------- 4. core happy path ---------------- */
  const mainLog = await scenario('core', async ({ sb, run, check }) => {
    let r = await run('git init');
    check('init', r.ok && /Initialized empty Git repository/.test(r.out), r.out);
    check('branch is main', (await sb.currentBranch()) === 'main', String(await sb.currentBranch()));

    r = await run('git status');
    check('status: no commits yet', /No commits yet/.test(r.out), r.out);
    check('status: clean tree', /nothing to commit/.test(r.out), r.out);

    await run('echo "# My Project" > README.md');
    r = await run('ls');
    check('ls shows file', /README\.md/.test(r.out), r.out);
    r = await run('cat README.md');
    check('cat', r.out === '# My Project', r.out);

    r = await run('git status');
    check('status: untracked', /Untracked files/.test(r.out) && /README\.md/.test(r.out), r.out);

    r = await run('git commit -m "too soon"');
    check('commit w/o staging fails', !r.ok && /nothing to commit/.test(r.out), r.out);

    await run('git add README.md');
    r = await run('git status');
    check('status: staged new file', /Changes to be committed/.test(r.out) && /new file:\s+README\.md/.test(r.out), r.out);

    r = await run('git commit -m "First commit"');
    check('commit ok', r.ok && /\[main [0-9a-f]{7}\] First commit/.test(r.out), r.out);
    check('commit reports 1 file', /1 file changed/.test(r.out), r.out);

    r = await run('git status');
    check('status clean after commit', /nothing to commit, working tree clean/.test(r.out), r.out);

    r = await run('git log --oneline');
    check('log oneline', /First commit/.test(r.out) && /HEAD -> main/.test(r.out), r.out);

    // modify -> unstaged change
    await run('echo "Now with docs." >> README.md');
    r = await run('git status');
    check('status: modified unstaged', /Changes not staged/.test(r.out) && /modified:\s+README\.md/.test(r.out), r.out);
    r = await run('git diff');
    check('diff shows addition', /\+Now with docs\./.test(r.out), r.out);

    await run('git add .');
    await run('git commit -m "Add a description"');
    r = await run('git log --oneline');
    check('two commits in log', r.out.trim().split('\n').length === 2, r.out);
  });

  /* ---------------- 5. branching + merging ---------------- */
  await scenario('branching', async ({ sb, run, check }) => {
    await run('git init');
    await run('echo "line one" > notes.txt');
    await run('git add .');
    await run('git commit -m "Start notes"');

    let r = await run('git checkout -b feature');
    check('checkout -b', r.ok && /Switched to a new branch 'feature'/.test(r.out), r.out);
    check('on feature', (await sb.currentBranch()) === 'feature');

    r = await run('git branch');
    check('branch list marks current', /\* feature/.test(r.out) && /main/.test(r.out), r.out);

    await run('echo "line two" >> notes.txt');
    await run('git add notes.txt');
    r = await run('git commit -m "Add line two"');
    check('commit on feature', r.ok && /\[feature /.test(r.out), r.out);

    r = await run('git checkout main');
    check('back to main', r.ok && /Switched to branch 'main'/.test(r.out), r.out);
    r = await run('cat notes.txt');
    check('workdir reverted on checkout', r.out === 'line one', JSON.stringify(r.out));

    r = await run('git merge feature');
    check('fast-forward merge', r.ok && /Fast-forward/.test(r.out), r.out);
    r = await run('cat notes.txt');
    check('workdir updated after merge', r.out === 'line one\nline two', JSON.stringify(r.out));

    r = await run('git merge feature');
    check('merge again = up to date', /Already up to date/.test(r.out), r.out);

    r = await run('git branch -d feature');
    check('delete branch', r.ok && /Deleted branch feature/.test(r.out), r.out);
    r = await run('git branch');
    check('feature gone', !/feature/.test(r.out), r.out);
  });

  /* ---------------- 6. true merge commit (divergent history) ---------------- */
  const mergeLog = await scenario('true-merge', async ({ sb, run, check }) => {
    await run('git init');
    await run('echo "base" > base.txt');
    await run('git add .');
    await run('git commit -m "Base"');

    await run('git checkout -b feature');
    await run('echo "feature work" > feature.txt');
    await run('git add .');
    await run('git commit -m "Feature work"');

    await run('git checkout main');
    await run('echo "hotfix" > hotfix.txt');
    await run('git add .');
    await run('git commit -m "Hotfix on main"');

    let r = await run('git merge feature');
    check('recursive merge', r.ok && /Merge made by/.test(r.out), r.out);

    r = await run('ls');
    check('both files present after merge', /feature\.txt/.test(r.out) && /hotfix\.txt/.test(r.out), r.out);

    const g = await sb.graphModel();
    check('graph has 4 commits', g.commits.length === 4, 'got ' + g.commits.length);
    const merge = g.commits.find(c => c.parents.length === 2);
    check('graph has a merge commit', !!merge, JSON.stringify(g.commits.map(c => [c.message, c.parents.length])));
    check('graph head is main', g.head === 'main', g.head);
    const laneCount = new Set(g.commits.map(c => c.lane)).size;
    check('graph uses >1 lane for divergent history', laneCount >= 2, 'lanes=' + JSON.stringify(g.commits.map(c => [c.message, c.lane])));
    const headNode = g.commits.find(c => c.refs.some(x => x.isHead));
    check('graph marks HEAD ref', !!headNode && headNode.oid === merge.oid, JSON.stringify(g.commits.map(c => [c.message, c.refs])));
    // parents must appear after children in the ordering
    let orderOk = true;
    g.commits.forEach((c, i) => {
      (c.parents || []).forEach(p => {
        const pi = g.commits.findIndex(x => x.oid === p);
        if (pi !== -1 && pi < i) orderOk = false;
      });
    });
    check('graph ordering: children before parents', orderOk, JSON.stringify(g.commits.map(c => c.message)));
  });

  /* ---------------- 7. exercise checkers ---------------- */
  await scenario('checkers', async ({ sb, run, check }) => {
    await run('git init');
    await run('echo hi > a.txt');
    await run('git add a.txt');
    await run('git commit -m "one"');
    await run('git checkout -b topic');
    await run('echo yo > b.txt');
    await run('git add b.txt');
    await run('git commit -m "two"');
    await run('git checkout main');
    await run('git merge topic');

    const g = await sb.graphModel();
    check('checker: >=2 commits', g.commits.length >= 2, 'got ' + g.commits.length);
    check('checker: branch topic exists', g.branches.some(b => b.name === 'topic'));
    check('checker: on main', g.head === 'main', g.head);
    const files = await sb.listFiles();
    check('checker: listFiles', JSON.stringify(files) === '["a.txt","b.txt"]', JSON.stringify(files));
    const st = await sb.statusModel();
    check('checker: clean status', st.staged.length === 0 && st.modified.length === 0 && st.untracked.length === 0, JSON.stringify(st));
  });

  /* ---------------- 8. reset ---------------- */
  await scenario('reset', async ({ sb, run, check }) => {
    await run('git init');
    await run('echo x > x.txt');
    await run('git add .');
    await run('git commit -m "x"');
    await sb.reset();
    check('repo gone after reset', (await sb.isRepo()) === false);
    check('files gone after reset', (await sb.listFiles()).length === 0);
    const r = await sb.run('git status');
    check('status errors after reset', !r.ok, r.out);
    const r2 = await sb.run('git init');
    check('can re-init after reset', r2.ok, r2.out);
  });

  /* ---------------- 9. misc error handling ---------------- */
  await scenario('errors', async ({ run, check }) => {
    await run('git init');
    let r = await run('git add missing.txt');
    check('add missing file', !r.ok && /did not match any files/.test(r.out), r.out);
    r = await run('git checkout nope');
    check('checkout unknown branch', !r.ok && /did not match/.test(r.out), r.out);
    r = await run('git merge nope');
    check('merge unknown branch', !r.ok && /not something we can merge/.test(r.out), r.out);
    r = await run('cat nope.txt');
    check('cat missing', !r.ok && /No such file/.test(r.out), r.out);
    r = await run('git commit');
    check('commit without -m', !r.ok && /empty commit message/.test(r.out), r.out);
    r = await run('git log');
    check('log with no commits', !r.ok && /does not have any commits/.test(r.out), r.out);
    r = await run('git bogus');
    check('unsupported subcommand', !r.ok && /not supported in this sandbox/.test(r.out), r.out);
    r = await run('');
    check('empty line is a no-op', r.ok && r.out === '', r.out);
  });

  /* ---------------- 10. topological ordering with same-second commits ---------------- */
  await scenario('topo-order', async ({ sb, run, check }) => {
    // every one of these lands in the same second, so timestamps all tie
    await run('git init');
    for (const n of ['a', 'b', 'c']) {
      await run(`echo ${n} > ${n}.txt`);
      await run('git add .');
      await run(`git commit -m "main ${n}"`);
    }
    await run('git checkout -b side');
    for (const n of ['d', 'e']) {
      await run(`echo ${n} > ${n}.txt`);
      await run('git add .');
      await run(`git commit -m "side ${n}"`);
    }
    await run('git checkout main');
    await run('echo f > f.txt');
    await run('git add .');
    await run('git commit -m "main f"');
    const r = await run('git merge side');
    check('merge succeeded', r.ok, r.out);

    const g = await sb.graphModel();
    check('7 commits total', g.commits.length === 7, 'got ' + g.commits.length);

    const ts = new Set(g.commits.map(c => c.timestamp));
    check('timestamps really do collide (test is meaningful)', ts.size < g.commits.length,
      'distinct timestamps: ' + ts.size);

    let orderOk = true, offender = null;
    g.commits.forEach((c, i) => {
      (c.parents || []).forEach(p => {
        const pi = g.commits.findIndex(x => x.oid === p);
        if (pi !== -1 && pi < i) { orderOk = false; offender = c.message + ' before parent'; }
      });
    });
    check('children always listed before parents', orderOk, offender);
    check('merge commit is first (it is the tip)', g.commits[0].parents.length === 2, g.commits[0].message);
    check('two lanes used', new Set(g.commits.map(c => c.lane)).size === 2,
      JSON.stringify(g.commits.map(c => [c.message, c.lane])));
    check('every commit has a lane', g.commits.every(c => typeof c.lane === 'number'));
  });

  /* ---------------- 11. seeded repo (as the lesson uses it) ---------------- */
  await scenario('seed', async ({ sb, check }) => {
    await sb.reset(async (api) => {
      await api.run('git init');
      await api.run('echo "# Sales analysis" > README.md');
      await api.run('git add .');
      await api.run('git commit -m "Add the project README"');
      await api.run('echo "library(tidyverse)" > analysis.R');
      await api.run('git add .');
      await api.run('git commit -m "Start the analysis script"');
    });
    check('seeded repo exists', (await sb.isRepo()) === true);
    const g = await sb.graphModel();
    check('seeded 2 commits', g.commits.length === 2, 'got ' + g.commits.length);
    check('seeded head is main', g.head === 'main', String(g.head));
    check('seed order correct', g.commits[0].message === 'Start the analysis script',
      JSON.stringify(g.commits.map(c => c.message)));
    const st = await sb.statusModel();
    check('seeded tree is clean',
      st.staged.length === 0 && st.modified.length === 0 && st.untracked.length === 0,
      JSON.stringify(st));
    const files = await sb.listFiles();
    check('seeded files present', JSON.stringify(files) === '["README.md","analysis.R"]', JSON.stringify(files));
  });

  /* ---------------- diff model ---------------- */
  await scenario('diffModel', async ({ sb, run, check }) => {
    check('null before init', (await sb.diffModel()) === null);
    await run('git init');
    let m = await sb.diffModel();
    check('empty after init', m.files.length === 0, JSON.stringify(m));

    await run('echo "one" > a.txt');
    m = await sb.diffModel();
    check('new file appears', m.files.length === 1 && m.files[0].kind === 'new' && m.files[0].file === 'a.txt',
      JSON.stringify(m));
    check('new file is all additions', m.files[0].lines.every(l => l.t === '+'), JSON.stringify(m.files[0].lines));

    await run('git add .');
    await run('git commit -m "Add a"');
    m = await sb.diffModel();
    check('clean after commit', m.files.length === 0, JSON.stringify(m));

    await run('echo "two" >> a.txt');
    m = await sb.diffModel();
    check('edited file is modified', m.files.length === 1 && m.files[0].kind === 'modified', JSON.stringify(m));
    const added = m.files[0].lines.filter(l => l.t === '+');
    check('addition carries new line number', added.length === 1 && added[0].text === 'two' && added[0].b === 2,
      JSON.stringify(m.files[0].lines));
    check('context line numbered on both sides',
      m.files[0].lines[0].t === ' ' && m.files[0].lines[0].a === 1 && m.files[0].lines[0].b === 1,
      JSON.stringify(m.files[0].lines));

    await run('rm a.txt');
    m = await sb.diffModel();
    check('removed file is deleted, all removals',
      m.files.length === 1 && m.files[0].kind === 'deleted' && m.files[0].lines.every(l => l.t === '-'),
      JSON.stringify(m));
  });

  /* ---------------- remote: push / fetch / pull ---------------- */
  await scenario('remote', async ({ sb, run, check }) => {
    await run('git init');
    let r = await run('git push');
    check('push without remote fails', !r.ok && /No configured push destination/.test(r.out), r.out);

    await run('git remote add origin https://github.com/acme/sales');
    r = await run('git remote -v');
    check('remote -v lists origin', /origin\thttps:\/\/github\.com\/acme\/sales \(fetch\)/.test(r.out), r.out);
    check('remoteModel exists and is empty', (await sb.remoteModel()).graph.commits.length === 0);

    await run('echo "# Sales" > README.md'); await run('git add .'); await run('git commit -m "Add README"');
    r = await run('git push');
    check('push without upstream fails helpfully', !r.ok && /git push -u origin main/.test(r.out), r.out);

    r = await run('git push -u origin main');
    check('first push says new branch', r.ok && /\* \[new branch\]\s+main -> main/.test(r.out), r.out);
    check('first push sets upstream', /set up to track 'origin\/main'/.test(r.out), r.out);
    let m = await sb.remoteModel();
    check('remote has the commit', m.graph.commits.length === 1 && m.ahead === 0 && m.behind === 0, JSON.stringify(m.graph.commits));

    r = await run('git push');
    check('repeat push is up-to-date', r.ok && /Everything up-to-date/.test(r.out), r.out);

    // colleague pushes while we were away: commit, push, rewind
    await run('echo "arima(sales)" > forecast.R'); await run('git add .'); await run('git commit -m "Colleague forecast"');
    await run('git push');
    r = await run('rewind 1');
    check('rewind ok', r.ok, r.out);
    m = await sb.remoteModel();
    check('remote is ahead after rewind', m.behind === 1 && m.ahead === 0, JSON.stringify({ ahead: m.ahead, behind: m.behind }));
    let g = await sb.graphModel();
    check('local graph does not know yet', g.commits.length === 1, String(g.commits.length));

    r = await run('git push');
    check('stale push rejected', !r.ok && /\[rejected\]/.test(r.out) && /fetch first/.test(r.out), r.out);

    r = await run('git fetch');
    check('fetch reports the new commit', r.ok && /-> origin\/main/.test(r.out), r.out);
    g = await sb.graphModel();
    check('origin/main pill appears after fetch',
      g.commits.length === 2 && g.commits.some(c => c.refs.some(rf => rf.name === 'origin/main' && rf.remote)),
      JSON.stringify(g.commits.map(c => c.refs)));

    r = await run('git pull');
    check('pull fast-forwards', r.ok && /Fast-forward/.test(r.out), r.out);
    r = await run('git pull');
    check('second pull up to date', r.ok && /Already up to date/.test(r.out), r.out);

    // diverge: remote-only commit + local-only commit -> pull merges
    await run('echo "x" > x.md'); await run('git add .'); await run('git commit -m "Remote-only"');
    await run('git push');
    await run('rewind 1');
    await run('echo "y" > y.md'); await run('git add .'); await run('git commit -m "Local-only"');
    r = await run('git pull');
    check('diverged pull makes a merge commit', r.ok && /Merge made by/.test(r.out), r.out);
    r = await run('git log --oneline');
    const shas = r.out.trim().split('\n').map(l => l.slice(0, 7));
    check('log has no duplicates after merge', new Set(shas).size === shas.length, r.out);

    r = await run('git push');
    check('push after merge succeeds', r.ok && /main -> main/.test(r.out), r.out);
    m = await sb.remoteModel();
    check('in sync at the end', m.ahead === 0 && m.behind === 0, JSON.stringify({ ahead: m.ahead, behind: m.behind }));

    await sb.reset();
    check('reset clears the remote', (await sb.remoteModel()) === null);
  });

  /* ---------------- report ---------------- */
  console.log('\n===== TRANSCRIPT: core happy path =====');
  console.log(mainLog.join('\n'));
  console.log('\n===== TRANSCRIPT: true merge =====');
  console.log(mergeLog.join('\n'));

  console.log('\n===== RESULTS =====');
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})();
