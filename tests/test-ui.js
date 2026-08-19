/* DOM-level test of the sandbox UI using jsdom. Run: node test-ui.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const git = require('isomorphic-git');

const dom = new JSDOM('<!doctype html><html><body><div id="box"></div></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true
});
const win = dom.window;
win.TextEncoder = TextEncoder;
win.TextDecoder = TextDecoder;
global.window = win;
global.document = win.document;
global.navigator = win.navigator;

// expose libs the way the CDN script tags will
win.git = git;
win.Buffer = Buffer; // the shipped bundle provides this in the browser
win.GitSandboxCore = require('../src/sandbox-core.js');

// evaluate the UI file in the jsdom window context
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'sandbox-ui.js'), 'utf8');
new Function('window', 'document', uiSrc)(win, win.document);

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(label + (detail ? '\n     ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const tasks = [
    { text: 'Create a repo', check: async (c) => c.isRepo },
    { text: 'Make a commit', check: async (c) => c.graph.commits.length >= 1 },
    { text: 'Create and merge a branch', check: async (c) => c.graph.commits.length >= 3 && c.graph.head === 'main' }
  ];

  const inst = win.GitSandboxUI.mount('#box', {
    title: 'Test sandbox',
    prompt: '~/project $',
    intro: ['Welcome to the {y}sandbox{/}.'],
    hints: ['git init', 'git status'],
    tasks,
    doneNote: 'Well done.'
  });
  await sleep(120);

  const host = win.document.querySelector('#box');
  check('mounted', !!host.querySelector('.gs-out'), host.innerHTML.slice(0, 200));
  check('intro rendered with markup', /class="ty"/.test(host.querySelector('.gs-out').innerHTML),
    host.querySelector('.gs-out').innerHTML);
  check('hint buttons rendered', host.querySelectorAll('.gs-hint').length === 2);
  check('empty graph message', /No commits yet/.test(host.querySelector('.gs-graph').textContent),
    host.querySelector('.gs-graph').textContent);
  check('stages render 3 columns', host.querySelectorAll('.gs-col').length === 3);
  check('diff panel prompts for init', /Nothing is tracked yet/.test(host.querySelector('.gs-diff').textContent),
    host.querySelector('.gs-diff').textContent);
  check('remote panel hidden without a remote', host.querySelector('.gs-remote').hidden === true);
  check('state pill says no repository before init',
    /no repository/.test(host.querySelector('.gs-state').textContent),
    host.querySelector('.gs-state').innerHTML);
  check('tasks render', host.querySelectorAll('.gs-task').length === 3);
  check('0 of 3 to start', /0 of 3/.test(host.querySelector('.gs-tasks').textContent),
    host.querySelector('.gs-tasks').textContent);

  const run = async (line) => { await inst.run(line); await sleep(30); };

  await run('git init');
  check('task 1 ticks', host.querySelectorAll('.gs-task.is-done').length === 1,
    host.querySelector('.gs-tasks').textContent);
  check('prompt shows branch', /\(main\)/.test(host.querySelector('.gs-prompt').textContent),
    host.querySelector('.gs-prompt').textContent);
  check('state pill flips to repository after init',
    /repository/.test(host.querySelector('.gs-state').textContent) &&
    !/no repository/.test(host.querySelector('.gs-state').textContent) &&
    !/origin/.test(host.querySelector('.gs-state').textContent),
    host.querySelector('.gs-state').innerHTML);
  check('diff panel clean after init', /clean/.test(host.querySelector('.gs-diff').textContent),
    host.querySelector('.gs-diff').textContent);

  await run('echo "# Project" > README.md');
  check('untracked chip in working dir col',
    /README\.md/.test(host.querySelectorAll('.gs-col')[0].textContent) &&
    /untracked/.test(host.querySelectorAll('.gs-col')[0].textContent),
    host.querySelectorAll('.gs-col')[0].textContent);
  check('diff panel shows new file with + line',
    /README\.md/.test(host.querySelector('.gs-diff').textContent) &&
    host.querySelectorAll('.gs-diff-add').length >= 1 &&
    /# Project/.test(host.querySelector('.gs-diff').textContent),
    host.querySelector('.gs-diff').innerHTML.slice(0, 300));

  await run('git add README.md');
  check('staged chip moves to staging col',
    /README\.md/.test(host.querySelectorAll('.gs-col')[1].textContent),
    host.querySelectorAll('.gs-col')[1].textContent);
  check('working dir col now empty',
    /empty/.test(host.querySelectorAll('.gs-col')[0].textContent),
    host.querySelectorAll('.gs-col')[0].textContent);

  await run('git commit -m "First commit"');
  check('repo col shows 1 commit',
    /1 commit/.test(host.querySelectorAll('.gs-col')[2].textContent),
    host.querySelectorAll('.gs-col')[2].textContent);
  check('graph has 1 node', host.querySelectorAll('.gs-graph circle').length === 1);
  check('diff panel clean after commit', /clean/.test(host.querySelector('.gs-diff').textContent),
    host.querySelector('.gs-diff').textContent);
  check('graph shows HEAD ref', /HEAD → main/.test(host.querySelector('.gs-graph').textContent),
    host.querySelector('.gs-graph').textContent);
  check('task 2 ticks', host.querySelectorAll('.gs-task.is-done').length === 2);

  const workCol = () => host.querySelectorAll('.gs-col')[0];
  check('committed file shows as unchanged chip in working dir',
    /README\.md/.test(workCol().textContent) &&
    workCol().querySelectorAll('.gs-chip-clean').length === 1,
    workCol().innerHTML);

  await run('echo "edited" > README.md');
  check('editing swaps unchanged chip for modified',
    /modified/.test(workCol().textContent) &&
    workCol().querySelectorAll('.gs-chip-clean').length === 0,
    workCol().innerHTML);

  await run('echo "# Project" > README.md');
  check('restoring committed content brings the unchanged chip back',
    workCol().querySelectorAll('.gs-chip-clean').length === 1,
    workCol().innerHTML);

  await run('git checkout -b feature');
  await run('echo "feature" > feature.txt');
  await run('git add .');
  await run('git commit -m "Feature work"');
  await run('git checkout main');
  await run('echo "fix" > fix.txt');
  await run('git add .');
  await run('git commit -m "Hotfix"');
  await run('git merge feature');

  check('graph has 4 nodes', host.querySelectorAll('.gs-graph circle').length === 4,
    'got ' + host.querySelectorAll('.gs-graph circle').length);
  check('graph has curved edges', host.querySelectorAll('.gs-graph path').length >= 4,
    'got ' + host.querySelectorAll('.gs-graph path').length);
  check('all tasks done', host.querySelectorAll('.gs-task.is-done').length === 3,
    host.querySelector('.gs-tasks').textContent);
  check('done note appears', /Well done/.test(host.querySelector('.gs-tasks').textContent));

  const vb = host.querySelector('.gs-graph').getAttribute('viewBox');
  check('viewBox set', /^0 0 \d+ \d+$/.test(vb), vb);

  // error path
  await run('git frobnicate');
  const lines = host.querySelectorAll('.gs-line');
  check('error line styled', host.querySelectorAll('.gs-line.gs-err').length >= 1);

  // help + clear
  await run('help');
  check('help printed', /isomorphic-git/.test(host.querySelector('.gs-out').textContent));
  await run('clear');
  check('clear empties terminal', host.querySelector('.gs-out').children.length === 0,
    String(host.querySelector('.gs-out').children.length));

  // reset button
  host.querySelector('.gs-reset').dispatchEvent(new win.Event('click'));
  await sleep(150);
  check('reset clears graph', /No commits yet/.test(host.querySelector('.gs-graph').textContent),
    host.querySelector('.gs-graph').textContent);
  check('reset unticks tasks', host.querySelectorAll('.gs-task.is-done').length === 0,
    host.querySelector('.gs-tasks').textContent);
  check('reset restores intro', /sandbox/.test(host.querySelector('.gs-out').textContent));
  check('reset returns state pill to no repository',
    /no repository/.test(host.querySelector('.gs-state').textContent),
    host.querySelector('.gs-state').innerHTML);

  // pre-init files are just files, not "untracked"
  await run('echo hi > pre.txt');
  check('pre-init file renders as grey "not in git yet" chip',
    /pre\.txt/.test(workCol().textContent) &&
    /not in git yet/.test(workCol().textContent) &&
    !/untracked/.test(workCol().textContent) &&
    workCol().querySelectorAll('.gs-chip-clean').length === 1,
    workCol().innerHTML);

  // rebuild a graph and dump the SVG for visual inspection
  await run('git init');
  check('pre-init file becomes untracked once a repo exists',
    /untracked/.test(workCol().textContent) &&
    workCol().querySelectorAll('.gs-chip-clean').length === 0,
    workCol().innerHTML);
  await run('echo a > a.txt'); await run('git add .'); await run('git commit -m "Add the project README"');
  await run('echo b > b.txt'); await run('git add .'); await run('git commit -m "Set up the data folder"');
  await run('git checkout -b analysis');
  await run('echo c > c.txt'); await run('git add .'); await run('git commit -m "Draft the regression model"');
  await run('git checkout main');
  await run('echo d > d.txt'); await run('git add .'); await run('git commit -m "Fix a typo in the README"');
  await run('git merge analysis');

  await run('git remote add origin https://example.com/demo.git');
  check('state shows origin pill once a remote exists',
    /repository/.test(host.querySelector('.gs-state').textContent) &&
    /origin/.test(host.querySelector('.gs-state').textContent),
    host.querySelector('.gs-state').innerHTML);

  const svg = host.querySelector('.gs-graph');
  const style = `<style>
    .gs-sha{font-family:monospace;font-size:12px;fill:#717171}
    .gs-msg{font-family:sans-serif;font-size:13px;fill:#404041}
    .gs-ref{font-family:monospace;font-size:11px;fill:#22384C}
    .gs-ref-head{fill:#fff}
    .gs-empty-text{font-family:sans-serif;font-size:13px;fill:#717171}
  </style>`;
  const svgOut = svg.outerHTML.replace('>', ' width="640">').replace(/^(<svg[^>]*>)/, '$1' + style);
  fs.writeFileSync(path.join(__dirname, 'graph-preview.svg'),
    '<?xml version="1.0"?>' + svgOut.replace('<svg', '<svg style="background:#fff"'));

  console.log('\n===== TERMINAL RENDER (last run) =====');
  console.log(host.querySelector('.gs-out').textContent.trim().split('\n').slice(-14).join('\n'));
  console.log('\n===== STAGING =====');
  console.log(Array.from(host.querySelectorAll('.gs-col')).map(c => c.textContent.trim()).join('\n---\n'));

  console.log('\n===== RESULTS =====');
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
