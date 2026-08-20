/* ------------------------------------------------------------------
   git sandbox UI: terminal + staging diagram + commit graph.
   Depends on window.GitSandboxCore and window.git (isomorphic-git UMD).
   ------------------------------------------------------------------ */
(function (root) {
  'use strict';

  var LANE_COLORS = ['#447099', '#419599', '#72994E', '#9A4665', '#EE6331', '#3276B5'];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // {g} green {r} red {y} yellow {b} blue {w} bold {/} reset
  function markup(s) {
    var map = { g: 'tg', r: 'tr', y: 'ty', b: 'tb', w: 'tw' };
    var out = esc(s);
    out = out.replace(/\{([grybw])\}/g, function (_m, k) { return '<span class="' + map[k] + '">'; });
    out = out.replace(/\{\/\}/g, '</span>');
    return out;
  }

  /* --------------------- config normalisation ------------------------ */

  // Authors can describe a task three ways:
  //   check: async (c) => ...     a JavaScript predicate (hand-written qmd)
  //   when:  'commits >= 2'       the declarative mini-language (extension)
  //   js:    'c.isRepo'           an escape hatch for the extension
  // Normalise all three to a `check` function, recording any compile error so
  // it can be shown in place instead of failing silently.
  function normaliseTasks(tasks) {
    var W = root.GitSandboxWhen;
    return (tasks || []).map(function (t) {
      var task = { text: t.text, _done: false, _error: null, _files: [] };
      if (typeof t.check === 'function') {
        task.check = t.check;
        return task;
      }
      if (!W) {
        task._error = 'the `when:` compiler is not loaded';
        task.check = function () { return false; };
        return task;
      }
      try {
        if (typeof t.when === 'string' && t.when.trim() !== '') {
          task._files = W.filesNeeded(t.when);
          var pred = W.compileWhen(t.when);
          task.check = function (ctx) { return pred(ctx); };
        } else if (typeof t.js === 'string' && t.js.trim() !== '') {
          var jsPred = W.compileJs(t.js);
          task.check = function (ctx) { return jsPred(ctx); };
        } else {
          throw new Error('a task needs one of `when:`, `js:` or a `check` function');
        }
      } catch (e) {
        task._error = e.message;
        task.check = function () { return false; };
      }
      return task;
    });
  }

  // `seed` may be a function or a block of commands from YAML.
  function normaliseSeed(seed) {
    if (!seed) return null;
    if (typeof seed === 'function') return seed;
    var lines = String(seed).split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== '' && l.charAt(0) !== '#'; });
    if (!lines.length) return null;
    return async function (sb) {
      for (var i = 0; i < lines.length; i++) {
        var r = await sb.run(lines[i]);
        if (!r.ok) {
          // A broken seed is an authoring bug, so make it loud rather than
          // leaving the learner in a half-built repository.
          throw new Error('seed command failed: ' + lines[i] + ' — ' + String(r.out).split('\n')[0]);
        }
      }
    };
  }

  function normaliseIntro(intro) {
    if (!intro) return [];
    if (Array.isArray(intro)) return intro;
    return String(intro).replace(/\n$/, '').split('\n');
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* --------------------------- commit graph -------------------------- */

  function renderGraph(svg, model) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var NS = 'http://www.w3.org/2000/svg';

    // Draw at the SVG's real pixel width so nothing overflows sideways; the
    // graph never needs a horizontal scrollbar.
    var W = svg.clientWidth || 640;

    if (!model.commits.length) {
      svg.setAttribute('viewBox', '0 0 ' + W + ' 60');
      svg.setAttribute('height', '60');
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(W / 2)); t.setAttribute('y', '34');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'gs-empty-text');
      t.textContent = 'No commits yet.';
      svg.appendChild(t);
      return;
    }

    var rowH = 44, laneW = 24, padTop = 26, padLeft = 22, lineH = 17;
    var maxLane = 0;
    model.commits.forEach(function (c) { if (c.lane > maxLane) maxLane = c.lane; });
    var graphW = padLeft + maxLane * laneW + 22;

    // Wrap a commit message to a character budget, breaking on spaces and
    // hard-breaking any single word longer than the line.
    function wrapWords(text, maxChars) {
      var words = String(text).split(/\s+/), lines = [], cur = '';
      words.forEach(function (w) {
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
      });
      if (cur) lines.push(cur);
      var out = [];
      lines.forEach(function (l) {
        while (l.length > maxChars) { out.push(l.slice(0, maxChars)); l = l.slice(maxChars); }
        out.push(l);
      });
      return out.length ? out : [''];
    }

    // First pass: place refs/sha/message per row and measure the wrapped height.
    var rows = model.commits.map(function (c) {
      var tx = graphW + 6;
      var refLayouts = (c.refs || []).map(function (r) {
        var label = (r.isHead ? 'HEAD → ' : '') + r.name;
        var w = label.length * 6.6 + 14;
        var lay = { label: label, x: tx, w: w, isHead: r.isHead, remote: r.remote };
        tx += w + 6;
        return lay;
      });
      var shaX = tx, msgX = tx + 62;
      var maxChars = Math.max(8, Math.floor((W - msgX - 12) / 6.8));
      var lines = wrapWords(c.message, maxChars);
      return { refLayouts: refLayouts, shaX: shaX, msgX: msgX, lines: lines,
               h: Math.max(rowH, lines.length * lineH + 20) };
    });

    // Second pass: stack rows so a wrapped message never overlaps the next.
    var tops = [], acc = padTop;
    rows.forEach(function (r) { tops.push(acc); acc += r.h; });
    var height = acc + 6;

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + height);
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

    var index = {};
    model.commits.forEach(function (c, i) { index[c.oid] = i; });
    var x = function (lane) { return padLeft + lane * laneW; };
    var cyOf = function (i) { return tops[i] + 16; };

    // edges first so nodes sit on top
    model.commits.forEach(function (c, i) {
      (c.parents || []).forEach(function (p, pi) {
        if (!(p in index)) return;
        var j = index[p];
        var x1 = x(c.lane), y1 = cyOf(i), x2 = x(model.commits[j].lane), y2 = cyOf(j);
        var path = document.createElementNS(NS, 'path');
        var d;
        if (x1 === x2) {
          d = 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2;
        } else {
          var mid = y1 + (y2 - y1) * 0.55;
          d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + mid + ' ' + x2 + ',' + (y2 - (y2 - y1) * 0.45) + ' ' + x2 + ',' + y2;
        }
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', LANE_COLORS[(pi === 0 ? c.lane : model.commits[j].lane) % LANE_COLORS.length]);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('opacity', '0.55');
        svg.appendChild(path);
      });
    });

    model.commits.forEach(function (c, i) {
      var cx = x(c.lane), cy = cyOf(i), row = rows[i];
      var isMerge = (c.parents || []).length > 1;

      var circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', cx); circle.setAttribute('cy', cy);
      circle.setAttribute('r', isMerge ? 7 : 6);
      circle.setAttribute('fill', isMerge ? '#FFFFFF' : LANE_COLORS[c.lane % LANE_COLORS.length]);
      circle.setAttribute('stroke', LANE_COLORS[c.lane % LANE_COLORS.length]);
      circle.setAttribute('stroke-width', isMerge ? '3' : '2');
      svg.appendChild(circle);

      // ref pills
      row.refLayouts.forEach(function (rl) {
        var rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', rl.x); rect.setAttribute('y', cy - 10);
        rect.setAttribute('width', rl.w); rect.setAttribute('height', 20);
        rect.setAttribute('rx', 10);
        rect.setAttribute('fill', rl.isHead ? '#447099' : (rl.remote ? '#E7E9EC' : '#D0DBE5'));
        svg.appendChild(rect);
        var lt = document.createElementNS(NS, 'text');
        lt.setAttribute('x', rl.x + 7); lt.setAttribute('y', cy + 4);
        lt.setAttribute('class', rl.isHead ? 'gs-ref gs-ref-head' : (rl.remote ? 'gs-ref gs-ref-remote' : 'gs-ref'));
        lt.textContent = rl.label;
        svg.appendChild(lt);
      });

      var sha = document.createElementNS(NS, 'text');
      sha.setAttribute('x', row.shaX); sha.setAttribute('y', cy + 4);
      sha.setAttribute('class', 'gs-sha');
      sha.textContent = c.short;
      svg.appendChild(sha);

      var msg = document.createElementNS(NS, 'text');
      msg.setAttribute('y', cy + 4);
      msg.setAttribute('class', 'gs-msg');
      row.lines.forEach(function (line, li) {
        var ts = document.createElementNS(NS, 'tspan');
        ts.setAttribute('x', row.msgX);
        ts.setAttribute('dy', li === 0 ? '0' : String(lineH));
        ts.textContent = line;
        msg.appendChild(ts);
      });
      svg.appendChild(msg);
    });
  }

  /* ------------------------------ diff panel ------------------------- */

  function renderDiff(node, model) {
    if (!model) {
      node.innerHTML = '<div class="gs-diff-empty">Nothing is tracked yet — run <code>git init</code> to start.</div>';
      return;
    }
    if (!model.files.length) {
      node.innerHTML = '<div class="gs-diff-empty">Working directory clean — no changes since the last commit.</div>';
      return;
    }
    node.innerHTML = model.files.map(function (f) {
      var rows = f.lines.map(function (l) {
        var cls = l.t === '+' ? ' gs-diff-add' : (l.t === '-' ? ' gs-diff-del' : '');
        return '<div class="gs-diff-line' + cls + '">' +
          '<span class="gs-diff-num">' + (l.a || '') + '</span>' +
          '<span class="gs-diff-num">' + (l.b || '') + '</span>' +
          '<span class="gs-diff-sign">' + (l.t === ' ' ? '' : l.t) + '</span>' +
          '<span class="gs-diff-text">' + esc(l.text) + '</span>' +
        '</div>';
      }).join('');
      return '<div class="gs-diff-file">' +
        '<div class="gs-diff-filehead">' +
          '<span class="gs-diff-name">' + esc(f.file) + '</span>' +
          '<span class="gs-diff-kind gs-diff-kind-' + f.kind + '">' + f.kind + '</span>' +
        '</div>' + rows +
      '</div>';
    }).join('');
  }

  /* -------------------------- staging diagram ------------------------ */

  function renderStages(node, status, graph, files, isRepo) {
    var needAdd = []
      .concat(status.untracked.map(function (f) { return { f: f, k: 'untracked' }; }))
      .concat(status.modified.map(function (f) { return { f: f, k: 'modified' }; }))
      .concat(status.deleted.map(function (f) { return { f: f, k: 'deleted' }; }));
    var staged = status.staged.map(function (s) { return { f: s.file, k: s.kind }; })
      .concat(status.stagedDeleted.map(function (f) { return { f: f, k: 'deleted' }; }));

    // Files with no git status still need to be visible: committed-and-clean
    // files after init, and every file before it. Before `git init` they are
    // just files — calling them "untracked" would use a git-status word while
    // no git status exists yet — so they render as quiet grey chips either way.
    var accounted = {};
    needAdd.concat(staged).forEach(function (it) { accounted[it.f] = true; });
    var clean = (files || [])
      .filter(function (f) { return !accounted[f]; })
      .map(function (f) { return { f: f, k: isRepo ? 'unchanged' : 'not in git yet' }; });

    function col(title, note, items, kind) {
      var chips = items.length
        ? items.map(function (it) {
            var quiet = it.k === 'unchanged' || it.k === 'not in git yet';
            var cls = 'gs-chip gs-chip-' + kind + (quiet ? ' gs-chip-clean' : '');
            return '<span class="' + cls + '">' + esc(it.f) +
                   '<span class="gs-chip-k">' + esc(it.k) + '</span></span>';
          }).join('')
        : '<span class="gs-chip gs-chip-empty">empty</span>';
      return '<div class="gs-col">' +
             '<div class="gs-col-h">' + esc(title) + '</div>' +
             '<div class="gs-col-n">' + esc(note) + '</div>' +
             '<div class="gs-chips">' + chips + '</div></div>';
    }

    var nCommits = graph.commits.length;
    var repoItems = nCommits
      ? [{ f: nCommits + ' commit' + (nCommits === 1 ? '' : 's'), k: graph.head || 'detached' }]
      : [];

    node.innerHTML =
      col('Working directory', 'what you edit', needAdd.concat(clean), 'work') +
      '<div class="gs-arrow"><span>git add</span><i class="gs-arrow-g">→</i></div>' +
      col('Staging area', 'what goes in next commit', staged, 'stage') +
      '<div class="gs-arrow"><span>git commit</span><i class="gs-arrow-g">→</i></div>' +
      col('Repository', 'permanent history', repoItems, 'repo');
  }

  /* ------------------------------- mount ----------------------------- */

  function mount(selector, config) {
    config = config || {};
    var host = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!host) return null;

    if (!root.git || typeof root.git.init !== 'function') {
      host.classList.add('gs');
      host.innerHTML = '<div class="gs-loading">This exercise could not start: the git library did not load. ' +
        'Check that isomorphic-git.bundle.js is reachable from this page.</div>';
      return null;
    }
    if (typeof root.Buffer === 'undefined') {
      // isomorphic-git's index code calls a global Buffer. The bundle shipped with
      // this lesson provides one; a bare CDN copy of isomorphic-git does not.
      host.classList.add('gs');
      host.innerHTML = '<div class="gs-loading">This exercise could not start: no Buffer polyfill is present. ' +
        'Load isomorphic-git.bundle.js (which includes one) rather than isomorphic-git on its own.</div>';
      return null;
    }

    var sb = root.GitSandboxCore.createSandbox({
      git: root.git,
      displayDir: (config.prompt || '~/project').replace(/\s*\$\s*$/, '')
    });
    var history = [];
    var histIdx = -1;
    var busy = false;
    var tasks = normaliseTasks(config.tasks);
    var seed = normaliseSeed(config.seed);
    var intro = normaliseIntro(config.intro);

    host.classList.add('gs');
    host.innerHTML =
      '<div class="gs-head">' +
        '<span class="gs-eyebrow">' + esc(config.title || 'Git sandbox') + '</span>' +
        '<span class="gs-state" role="status"></span>' +
        '<button type="button" class="gs-reset">Reset</button>' +
      '</div>' +
      '<div class="gs-body">' +
        '<div class="gs-term-wrap">' +
          '<div class="gs-out" role="log" aria-live="polite" aria-label="Terminal output"></div>' +
          '<form class="gs-input-row" autocomplete="off">' +
            '<label class="gs-prompt" for="' + (host.id || 'gs') + '-in">' + esc(config.prompt || '~/project $') + '</label>' +
            '<input class="gs-input" id="' + (host.id || 'gs') + '-in" type="text" spellcheck="false"' +
            ' autocapitalize="off" autocorrect="off" aria-label="Type a git command"' +
            ' placeholder="type a command and press Enter">' +
          '</form>' +
          '<div class="gs-hints"></div>' +
        '</div>' +
        '<div class="gs-viz">' +
          '<div class="gs-viz-h">Where your work lives</div>' +
          '<div class="gs-stages"></div>' +
          '<div class="gs-viz-h">Changes since last commit</div>' +
          '<div class="gs-diff"></div>' +
          '<div class="gs-viz-h">Commit history</div>' +
          '<div class="gs-graph-scroll"><svg class="gs-graph" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
          '<div class="gs-remote" hidden>' +
            '<div class="gs-viz-h">Remote (origin)</div>' +
            '<div class="gs-graph-scroll"><svg class="gs-remote-graph" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
            '<div class="gs-remote-sync"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="gs-tasks"></div>';

    var out = host.querySelector('.gs-out');
    var form = host.querySelector('.gs-input-row');
    var input = host.querySelector('.gs-input');
    var hintsNode = host.querySelector('.gs-hints');
    var stagesNode = host.querySelector('.gs-stages');
    var diffNode = host.querySelector('.gs-diff');
    var svg = host.querySelector('.gs-graph');
    var remoteWrap = host.querySelector('.gs-remote');
    var remoteSvg = host.querySelector('.gs-remote-graph');
    var remoteSync = host.querySelector('.gs-remote-sync');
    var tasksNode = host.querySelector('.gs-tasks');
    var stateNode = host.querySelector('.gs-state');
    var resetBtn = host.querySelector('.gs-reset');
    var lastStateHtml = '';

    // The graph is drawn at the SVG's current pixel width, so a later resize
    // would scale it like an image (tiny text on narrow screens). Redraw the
    // last model whenever the width actually changes.
    var lastGraph = null;
    var lastGraphW = 0;
    var lastRemoteGraph = null;
    var lastRemoteGraphW = 0;
    function redrawGraph() {
      var w = svg.clientWidth;
      if (lastGraph && w && w !== lastGraphW) {
        lastGraphW = w;
        renderGraph(svg, lastGraph);
      }
      var rw = remoteSvg.clientWidth;
      if (lastRemoteGraph && rw && rw !== lastRemoteGraphW) {
        lastRemoteGraphW = rw;
        renderGraph(remoteSvg, lastRemoteGraph);
      }
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(redrawGraph).observe(svg.parentNode);
    } else {
      root.addEventListener('resize', redrawGraph);
    }

    function write(html, cls) {
      var line = el('div', 'gs-line' + (cls ? ' ' + cls : ''), html);
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
    }
    function writeText(text, cls) {
      if (text === '' || text == null) return;
      write(markup(text), cls);
    }

    function renderHints() {
      var hints = config.hints || [];
      if (!hints.length) { hintsNode.innerHTML = ''; return; }
      hintsNode.innerHTML = '<span class="gs-hints-label">Try:</span>';
      hints.forEach(function (h) {
        var b = el('button', 'gs-hint', esc(h));
        b.type = 'button';
        b.addEventListener('click', function () { input.value = h; input.focus(); });
        hintsNode.appendChild(b);
      });
    }

    function renderTasks() {
      if (!tasks.length) { tasksNode.innerHTML = ''; return; }
      var done = 0;
      var rows = tasks.map(function (t) {
        if (t._error) {
          return '<li class="gs-task gs-task-broken">' +
                 '<span class="gs-task-mark" aria-hidden="true">!</span>' +
                 '<span class="gs-task-txt">' + t.text +
                 '<span class="gs-task-err">Authoring error: ' + esc(t._error) + '</span></span></li>';
        }
        var ok = !!t._done;
        if (ok) done++;
        return '<li class="gs-task' + (ok ? ' is-done' : '') + '">' +
               '<span class="gs-task-mark" aria-hidden="true">' + (ok ? '✓' : '') + '</span>' +
               '<span class="gs-task-txt">' + t.text + '</span></li>';
      }).join('');
      var broken = tasks.some(function (t) { return !!t._error; });
      var all = !broken && done === tasks.length;
      var note = config.doneNote || 'That is the whole exercise.';
      tasksNode.innerHTML =
        '<div class="gs-tasks-h">Your turn <span class="gs-count">' + done + ' of ' + tasks.length + '</span></div>' +
        '<ul class="gs-task-list">' + rows + '</ul>' +
        (all ? '<div class="gs-done">' + note + '</div>' : '');
    }

    async function refresh() {
      var graph = await sb.graphModel();
      var isRepo = await sb.isRepo();
      var status = isRepo ? await sb.statusModel()
        : { staged: [], modified: [], untracked: [], deleted: [], stagedDeleted: [] };
      var files = await sb.listFiles();
      renderStages(stagesNode, status, graph, files, isRepo);
      renderDiff(diffNode, await sb.diffModel());
      renderGraph(svg, graph);
      lastGraph = graph;
      lastGraphW = svg.clientWidth;

      var remote = await sb.remoteModel();
      if (remote) {
        remoteWrap.hidden = false;
        renderGraph(remoteSvg, remote.graph);
        lastRemoteGraph = remote.graph;
        lastRemoteGraphW = remoteSvg.clientWidth;
        remoteSync.innerHTML = remoteSyncText(remote);
      } else {
        remoteWrap.hidden = true;
        lastRemoteGraph = null;
        remoteSync.innerHTML = '';
      }

      var stateHtml = !isRepo
        ? '<span class="gs-state-pill gs-state-none">○ no repository</span>'
        : '<span class="gs-state-pill gs-state-repo">● repository</span>' +
          (remote ? '<span class="gs-state-pill gs-state-remote">⇄ origin</span>' : '');
      // role="status" announces DOM changes, so only touch it on a real change.
      if (stateHtml !== lastStateHtml) {
        stateNode.innerHTML = stateHtml;
        lastStateHtml = stateHtml;
      }

      // `file x contains "y"` needs file contents; read them up front so the
      // compiled predicates can stay synchronous.
      var contents = {};
      for (var f = 0; f < tasks.length; f++) {
        for (var g = 0; g < (tasks[f]._files || []).length; g++) {
          var name = tasks[f]._files[g];
          if (name in contents) continue;
          try { contents[name] = await sb.readFile(name); }
          catch (e) { contents[name] = ''; }
        }
      }

      var ctx = {
        sb: sb, graph: graph, status: status, files: files,
        history: history, isRepo: isRepo, remote: remote,
        _fileText: function (name) { return contents[name] || ''; }
      };
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i]._done || tasks[i]._error) continue;
        try { tasks[i]._done = !!(await tasks[i].check(ctx)); }
        catch (e) { tasks[i]._done = false; }
      }
      renderTasks();

      var br = graph.head;
      var promptText = (config.prompt || '~/project') .replace(/\s*\$\s*$/, '');
      host.querySelector('.gs-prompt').textContent =
        promptText + (br ? ' (' + br + ')' : '') + ' $';
    }

    async function submit(line) {
      if (busy) return;
      busy = true;
      input.disabled = true;
      write('<span class="gs-echo-prompt">' + esc(host.querySelector('.gs-prompt').textContent) + '</span> ' + esc(line), 'gs-echo');
      history.push(line);
      histIdx = history.length;
      var r = await sb.run(line);
      if (line.trim() === 'clear') { out.innerHTML = ''; }
      else if (line.trim() === 'help') { writeText(helpText()); }
      else if (line.trim() === 'reset') { await doReset(); }
      else { writeText(r.out, r.ok ? '' : 'gs-err'); }
      await refresh();
      input.disabled = false;
      busy = false;
      input.focus();
    }

    // one-line summary under the remote graph: how the learner's current
    // branch compares to its counterpart on the remote
    function remoteSyncText(r) {
      if (!r.branch || !r.tracked) return '';
      var b = esc(r.branch);
      var n = function (k) { return k + ' commit' + (k === 1 ? '' : 's'); };
      if (!r.ahead && !r.behind) return '✓ in sync with your <code>' + b + '</code>';
      if (r.ahead && r.behind) return '<code>origin/' + b + '</code> and your <code>' + b + '</code> have diverged — <code>git pull</code>, then <code>git push</code>';
      if (r.behind) return '<code>origin/' + b + '</code> is ' + n(r.behind) + ' ahead of your <code>' + b + '</code> — <code>git pull</code> to update';
      return 'your <code>' + b + '</code> is ' + n(r.ahead) + ' ahead — <code>git push</code> to publish';
    }

    function helpText() {
      return [
        '{w}This sandbox runs real git{/} (isomorphic-git) on a repo that lives only in this page.',
        '',
        '{y}git{/}    init, status, add, commit -m, log [--oneline], diff,',
        '       branch [-d], checkout [-b], switch [-c], merge, config,',
        '       remote add origin, push [-u], pull, fetch',
        '{y}shell{/}  ls, cat, echo "text" > file, echo "text" >> file, touch, rm, mkdir, pwd',
        '{y}other{/}  help, clear, reset'
      ].join('\n');
    }

    async function doReset() {
      out.innerHTML = '';
      input.value = '';
      // Tasks checked with `ran "..."` read the command history, so it has to
      // go too or they re-complete themselves on the very next refresh.
      history.length = 0;
      histIdx = 0;
      tasks.forEach(function (t) { t._done = false; });
      try {
        await sb.reset(seed);
      } catch (e) {
        writeText('{r}This exercise could not be set up: ' + e.message + '{/}', 'gs-err');
        await refresh();
        return;
      }
      intro.forEach(function (l) { writeText(l); });
      await refresh();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value;
      input.value = '';
      if (!v.trim()) return;
      submit(v);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') {
        if (!history.length) return;
        e.preventDefault();
        histIdx = Math.max(0, histIdx - 1);
        input.value = history[histIdx] || '';
      } else if (e.key === 'ArrowDown') {
        if (!history.length) return;
        e.preventDefault();
        histIdx = Math.min(history.length, histIdx + 1);
        input.value = history[histIdx] || '';
      }
    });

    resetBtn.addEventListener('click', function () { doReset(); });
    host.querySelector('.gs-out').addEventListener('click', function () { input.focus(); });

    renderHints();
    var ready = doReset();

    return { sandbox: sb, refresh: refresh, run: submit, ready: ready, tasks: tasks };
  }

  /* ------------------- helpers for exercise checks ------------------- */

  // oid a branch currently points at, or null
  function branchOid(graph, name) {
    var b = (graph.branches || []).filter(function (x) { return x.name === name; })[0];
    return b ? b.oid : null;
  }

  // is `target` reachable by walking parents back from `from`?
  function reaches(graph, from, target) {
    if (!from || !target) return false;
    if (from === target) return true;
    var byOid = {};
    graph.commits.forEach(function (c) { byOid[c.oid] = c; });
    var stack = [from];
    var seen = {};
    while (stack.length) {
      var oid = stack.pop();
      if (oid === target) return true;
      if (seen[oid]) continue;
      seen[oid] = true;
      var c = byOid[oid];
      if (c) (c.parents || []).forEach(function (p) { stack.push(p); });
    }
    return false;
  }

  // has branch `name` been merged into branch `into`?
  function isMerged(graph, name, into) {
    return reaches(graph, branchOid(graph, into), branchOid(graph, name));
  }

  // how many commits are reachable from a branch tip
  function commitCount(graph, name) {
    var tip = branchOid(graph, name);
    if (!tip) return 0;
    var byOid = {};
    graph.commits.forEach(function (c) { byOid[c.oid] = c; });
    var stack = [tip], seen = {}, n = 0;
    while (stack.length) {
      var oid = stack.pop();
      if (seen[oid]) continue;
      seen[oid] = true; n++;
      var c = byOid[oid];
      if (c) (c.parents || []).forEach(function (p) { stack.push(p); });
    }
    return n;
  }

  function hasMergeCommit(graph) {
    return graph.commits.some(function (c) { return (c.parents || []).length > 1; });
  }

  function boot() {
    var pending = root.__gsPending || [];
    pending.forEach(function (p) { mount(p[0], p[1]); });
    root.__gsPending = { push: function (p) { mount(p[0], p[1]); } };
  }

  root.GitSandboxUI = {
    mount: mount,
    boot: boot,
    branchOid: branchOid,
    reaches: reaches,
    isMerged: isMerged,
    commitCount: commitCount,
    hasMergeCommit: hasMergeCommit
  };
})(window);
