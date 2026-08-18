/* End-to-end: load the RENDERED git-lesson.html in jsdom, execute its real
   inlined scripts, and drive all three exercises to completion.
   Run: node test-rendered.js ../git-lesson.html */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// a path given on the command line is relative to where you ran node from
const target = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, '..', 'example.html');
const html = fs.readFileSync(target, 'utf8');

const consoleErrors = [];
const vc = new VirtualConsole();
function brief(x) { return String((x && (x.message || x.stack)) || x).replace(/\s+/g, ' ').slice(0, 220); }
vc.on('jsdomError', (e) => { consoleErrors.push('jsdomError: ' + brief(e)); console.log('!! jsdomError:', brief(e)); });
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.map(brief).join(' ')));

const dom = new JSDOM(html, {
  url: 'https://academy.posit.co/lesson/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.TextEncoder = TextEncoder;
    window.TextDecoder = TextDecoder;
    if (!window.crypto) window.crypto = require('crypto').webcrypto;
    // jsdom lacks these; Quarto's own theme JS uses them. Not our code.
    class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
    window.IntersectionObserver = window.IntersectionObserver || NoopObserver;
    window.ResizeObserver = window.ResizeObserver || NoopObserver;
    if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
});
const win = dom.window;

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(label + (detail ? '\n     ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (e) { /* keep waiting */ }
    await sleep(80);
  }
  throw new Error('timed out waiting for ' + label);
}

// drive a sandbox the way a learner would: type into the input, press Enter
function typer(win, hostId) {
  const host = win.document.querySelector('#' + hostId);
  const form = host.querySelector('.gs-input-row');
  const input = host.querySelector('.gs-input');
  return async function type(line) {
    await waitFor(() => !input.disabled, 8000, 'input ready before "' + line + '"');
    input.value = line;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !input.disabled, 8000, 'command to finish: "' + line + '"');
    await sleep(20);
  };
}
function tasksState(win, hostId) {
  const host = win.document.querySelector('#' + hostId);
  const all = host.querySelectorAll('.gs-task');
  const done = host.querySelectorAll('.gs-task.is-done');
  return { total: all.length, done: done.length, text: host.querySelector('.gs-tasks').textContent };
}
function outText(win, hostId) {
  return win.document.querySelector('#' + hostId + ' .gs-out').textContent;
}

(async () => {
  await new Promise(r => win.addEventListener('load', r, { once: true }));
  await sleep(300);

  check('isomorphic-git loaded from the page', typeof win.git === 'object' && typeof win.git.init === 'function');
  check('sandbox library loaded from the page', typeof win.GitSandboxUI === 'object');
  check('helpers exported', typeof win.GitSandboxUI.isMerged === 'function');

  // whichever ids the page used (hand-written qmd or the extension)
  const IDS = Array.from(win.document.querySelectorAll('.git-sandbox')).map(d => d.id);
  check('page has three exercises', IDS.length === 3, JSON.stringify(IDS));
  const [ID1, ID2, ID3] = IDS;

  for (const id of IDS) {
    await waitFor(() => win.document.querySelector('#' + id + ' .gs-input'), 15000, id + ' to mount');
    check(id + ' mounted', !!win.document.querySelector('#' + id + ' .gs-input'));
    check(id + ' loading placeholder replaced',
      !/Loading the Git sandbox/.test(win.document.querySelector('#' + id).textContent));
  }

  /* ---------------- exercise 1 ---------------- */
  {
    const id = ID1;
    const type = typer(win, id);
    check('ex1 starts at 0 done', tasksState(win, id).done === 0, tasksState(win, id).text);
    check('ex1 has 6 tasks', tasksState(win, id).total === 6);
    check('ex1 starts with no repo', /No commits yet/.test(win.document.querySelector('#' + id + ' .gs-graph').textContent));

    await type('git status');
    check('ex1 status before init errors', /not a git repository/.test(outText(win, id)));

    await type('git init');
    await type('echo "# Sales analysis" > README.md');
    await type('git status');
    await type('git add README.md');
    await type('git commit -m "Add the project README"');
    check('ex1 5 of 6 after first commit', tasksState(win, id).done === 5, tasksState(win, id).text);

    await type('echo "Quarterly revenue analysis." >> README.md');
    await type('git diff');
    check('ex1 diff shows the new line', /Quarterly revenue analysis/.test(outText(win, id)));
    await type('git add .');
    await type('git commit -m "Describe the project"');

    const st = tasksState(win, id);
    check('ex1 all 6 tasks complete', st.done === 6, st.text);
    check('ex1 done note shown', /repeat that loop/.test(st.text), st.text);
    check('ex1 graph has 2 commits', win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 2);
    check('ex1 repo column shows 2 commits',
      /2 commits/.test(win.document.querySelectorAll('#' + id + ' .gs-col')[2].textContent));
  }

  /* ---------------- exercise 2 ---------------- */
  {
    const id = ID2;
    const type = typer(win, id);
    check('ex2 seeded with 2 commits',
      win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 2,
      String(win.document.querySelectorAll('#' + id + ' .gs-graph circle').length));
    check('ex2 seeded tree is clean',
      /empty/.test(win.document.querySelectorAll('#' + id + ' .gs-col')[0].textContent));

    await type('git log --oneline');
    check('ex2 log shows seeded messages', /Start the analysis script/.test(outText(win, id)));

    await type('git checkout -b report');
    check('ex2 task 1 ticks', tasksState(win, id).done >= 1, tasksState(win, id).text);

    await type('echo "# Q3 findings" > report.qmd');
    await type('git add .');
    await type('git commit -m "Draft the Q3 report"');
    check('ex2 task 2 ticks', tasksState(win, id).done >= 2, tasksState(win, id).text);

    await type('git checkout main');
    await type('ls');
    check('ex2 report.qmd absent on main', !/report\.qmd/.test(outText(win, id).split('$ ls').pop()),
      outText(win, id).split('$ ls').pop().slice(0, 120));
    check('ex2 task 3 ticks', tasksState(win, id).done >= 3, tasksState(win, id).text);

    await type('git merge report');
    check('ex2 merge is a fast-forward', /Fast-forward/.test(outText(win, id)), outText(win, id).slice(-200));
    const st = tasksState(win, id);
    check('ex2 all 4 tasks complete', st.done === 4, st.text);
    check('ex2 fast-forward note shown', /fast-forward merge/i.test(st.text), st.text);
    check('ex2 graph still linear (3 commits, 1 lane)',
      win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 3);
  }

  /* ---------------- exercise 3 ---------------- */
  {
    const id = ID3;
    const type = typer(win, id);
    check('ex3 seeded with a diverged branch',
      win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 3,
      String(win.document.querySelectorAll('#' + id + ' .gs-graph circle').length));
    await type('git branch');
    check('ex3 forecast branch exists', /forecast/.test(outText(win, id)));
    check('ex3 starts on main', /\(main\)/.test(win.document.querySelector('#' + id + ' .gs-prompt').textContent));
    check('ex3 no tasks ticked at start', tasksState(win, id).done === 0, tasksState(win, id).text);

    await type('echo "fixed the parser" > hotfix.md');
    await type('git add .');
    await type('git commit -m "Fix the date parsing"');
    check('ex3 task 1 ticks (branches diverged)', tasksState(win, id).done >= 1, tasksState(win, id).text);

    await type('git merge forecast');
    check('ex3 merge made a merge commit', /Merge made by/.test(outText(win, id)), outText(win, id).slice(-200));
    check('ex3 tasks 2 and 3 tick', tasksState(win, id).done >= 3, tasksState(win, id).text);

    await type('ls');
    const lsOut = outText(win, id).split('$ ls').pop();
    check('ex3 both branches\' files present after merge',
      /forecast\.R/.test(lsOut) && /hotfix\.md/.test(lsOut), lsOut.slice(0, 160));

    await type('git branch -d forecast');
    const st = tasksState(win, id);
    check('ex3 all 4 tasks complete', st.done === 4, st.text);
    check('ex3 graph has 5 commits',
      win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 5,
      String(win.document.querySelectorAll('#' + id + ' .gs-graph circle').length));
    check('ex3 has a merge node (hollow circle)',
      Array.from(win.document.querySelectorAll('#' + id + ' .gs-graph circle'))
        .some(c => c.getAttribute('fill') === '#FFFFFF'));

    // reset button restores the seeded state
    win.document.querySelector('#' + id + ' .gs-reset').dispatchEvent(new win.Event('click'));
    await sleep(600);
    check('ex3 reset restores the seed (3 commits)',
      win.document.querySelectorAll('#' + id + ' .gs-graph circle').length === 3,
      String(win.document.querySelectorAll('#' + id + ' .gs-graph circle').length));
    check('ex3 reset unticks tasks', tasksState(win, id).done === 0, tasksState(win, id).text);
  }

  /* ---------------- isolation between exercises ---------------- */
  check('exercise 1 unaffected by later exercises',
    win.document.querySelectorAll('#' + ID1 + ' .gs-graph circle').length === 2);
  check('exercise 2 unaffected by later exercises',
    win.document.querySelectorAll('#' + ID2 + ' .gs-graph circle').length === 3);
  check('no authoring errors anywhere on the page',
    win.document.querySelectorAll('.gs-task-broken, .gs-config-error').length === 0,
    win.document.querySelector('.gs-task-err') ? win.document.querySelector('.gs-task-err').textContent : '');

  /* ---------------- page-level checks ---------------- */
  check('no page script errors', consoleErrors.length === 0, consoleErrors.join('\n     '));
  check('lesson title present', /Version control with Git/.test(win.document.title), win.document.title);
  check('command reference table present',
    win.document.querySelectorAll('table').length >= 1);
  check('all sandboxes have an accessible label',
    Array.from(win.document.querySelectorAll('.gs-input')).every(i => i.getAttribute('aria-label')));
  check('terminal output is a live region',
    Array.from(win.document.querySelectorAll('.gs-out')).every(o => o.getAttribute('aria-live') === 'polite'));

  console.log('\n===== RESULTS (rendered page, end to end) =====');
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
