/* Authoring mistakes must be visible, not silent.
   Renders the fixtures with Quarto, then checks what a reader would see.
   Run: node tests/test-errors.js            (from the repo root) */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(label + (detail ? '\n     ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function render(fixture) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-err-'));
  fs.cpSync(path.join(root, '_extensions'), path.join(work, '_extensions'), { recursive: true });
  const name = path.basename(fixture);
  fs.copyFileSync(path.join(root, 'tests', 'fixtures', fixture), path.join(work, name));
  let stderr = '';
  try {
    execFileSync('quarto', ['render', name], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stderr = String(e.stderr || '');
    throw new Error('quarto render failed for ' + fixture + '\n' + stderr);
  }
  const out = path.join(work, name.replace(/\.qmd$/, '.html'));
  return { html: fs.readFileSync(out, 'utf8'), file: out, dir: work };
}

(async () => {

  /* ------------------- configuration errors are visible ------------------- */
  {
    const { html } = render('bad-config.qmd');

    // seven bad blocks, and the duplicate-id pair which should still render
    const errors = (html.match(/gs-config-error/g) || []).length;
    check('six config errors reported', errors === 6, 'found ' + errors);

    check('names the unknown option', /unknown option &quot;tittle&quot;/.test(html) ||
      /unknown option "tittle"/.test(html), 'no mention of tittle');
    check('says which task is missing a condition',
      /task 1 needs a &quot;when:&quot; condition|task 1 needs a "when:" condition/.test(html));
    check('rejects both when and js',
      /task 1 has both &quot;when:&quot; and &quot;js:&quot;|task 1 has both "when:" and "js:"/.test(html));
    check('names an unknown option inside a task',
      /unknown option &quot;whn&quot; in task 1|unknown option "whn" in task 1/.test(html));
    check('explains that tasks must be a list',
      /must be a list of items/.test(html));
    check('rejects options that are not key/value',
      /must be a set of ("|&quot;)key: value("|&quot;) lines|expected ("|&quot;)key: value("|&quot;)/.test(html),
      (html.match(/gs-loading[\s\S]{0,400}/) || [''])[0].slice(0, 400));

    // duplicate ids: both exercises survive, with distinct ids
    const ids = (html.match(/<div class="git-sandbox" id="([^"]+)"/g) || [])
      .map(s => s.match(/id="([^"]+)"/)[1]);
    check('duplicate ids both render', ids.length === 2, JSON.stringify(ids));
    check('duplicate ids are made unique', new Set(ids).size === ids.length, JSON.stringify(ids));
    check('first duplicate keeps the authored id', ids[0] === 'duplicated', JSON.stringify(ids));

    // a broken block must not take the assets or the good blocks with it
    check('assets still injected alongside broken blocks',
      /git-sandbox\.js/.test(html) && /isomorphic-git\.bundle\.js/.test(html) &&
      /git-sandbox\.css/.test(html),
      (html.match(/(src|href)="[^"]*git[^"]*"/g) || []).join(' ') || 'no git assets found');
  }

  /* ------------------- unreadable conditions are visible ------------------ */
  {
    const { html, dir, file } = render('bad-when.qmd');
    check('bad-when renders without a config error', !/gs-config-error/.test(html));
    // This fixture deliberately does NOT use embed-resources, so the extension's
    // scripts are separate files. Load over file:// so jsdom can fetch them the
    // way a browser would, which also proves asset injection works unembedded.
    check('assets injected as separate files',
      /<script src="[^"]*git-sandbox\.js"/.test(html) &&
      /<script src="[^"]*isomorphic-git\.bundle\.js"/.test(html) &&
      /<link[^>]+git-sandbox\.css/.test(html),
      (html.match(/<script src="[^"]*"/g) || []).slice(0, 6).join(' '));

    const vc = new VirtualConsole();
    const dom = new JSDOM(html, {
      url: 'file://' + file,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(w) {
        w.TextEncoder = TextEncoder;
        w.TextDecoder = TextDecoder;
        if (!w.crypto) w.crypto = require('crypto').webcrypto;
        class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
        w.IntersectionObserver = NoopObserver;
        w.ResizeObserver = NoopObserver;
        w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      }
    });
    const win = dom.window;
    await new Promise(r => win.addEventListener('load', r, { once: true }));
    for (let i = 0; i < 150 && !win.document.querySelector('.gs-task'); i++) await sleep(80);
    await sleep(200);

    const host = win.document.querySelector('#broken-conditions');
    check('exercise still mounted', !!host && !!host.querySelector('.gs-input'),
      host ? host.innerHTML.slice(0, 200) : 'no host');
    if (!host || !host.querySelector('.gs-tasks')) {
      throw new Error('the exercise never mounted; cannot check condition errors');
    }
    const broken = host.querySelectorAll('.gs-task-broken');
    check('two tasks marked broken', broken.length === 2, 'found ' + broken.length);
    const text = host.querySelector('.gs-tasks').textContent;
    check('typo condition names the culprit', /unknown condition "frobnicate"/.test(text), text);
    check('incomplete condition explains what was expected',
      /expected a number/.test(text), text);
    check('error quotes the original condition', /when: frobnicate/.test(text), text);
    check('good tasks are unaffected',
      host.querySelectorAll('.gs-task').length === 4 &&
      host.querySelectorAll('.gs-task-broken').length === 2);
    check('js escape hatch works',
      host.querySelectorAll('.gs-task.is-done').length === 1,
      'done: ' + host.querySelectorAll('.gs-task.is-done').length + ' :: ' + text);
    check('a broken task never shows the completion note', !/gs-done/.test(host.innerHTML));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ------------------- non-HTML formats degrade sanely ------------------- */
  {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-md-'));
    fs.cpSync(path.join(root, '_extensions'), path.join(work, '_extensions'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'bad-when.qmd'), path.join(work, 'doc.qmd'));
    execFileSync('quarto', ['render', 'doc.qmd', '--to', 'gfm'], { cwd: work, stdio: 'ignore' });
    const md = fs.readFileSync(path.join(work, 'doc.md'), 'utf8');
    check('non-HTML output explains the exercise is interactive',
      /interactive/i.test(md) && /HTML version/i.test(md), md.slice(0, 300));
    check('non-HTML output still lists the tasks', /This one is fine/.test(md), md.slice(0, 400));
    check('non-HTML output has no script tags', !/<script/.test(md));
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log('\n===== authoring errors =====');
  console.log('passed: ' + pass + '   failed: ' + fail);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
