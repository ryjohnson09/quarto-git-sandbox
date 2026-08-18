/* =====================================================================
   git-sandbox.js — a real git repository that lives entirely in the page.
   Runs isomorphic-git (MIT) against an in-memory filesystem, and renders
   a terminal, a working-directory/staging/repository diagram, and a live
   commit graph. Nothing is sent to a server; nothing is written to disk.

   Load isomorphic-git.bundle.js first, then this file.

   Usage:
     <div class="git-sandbox" id="sbx-first-commit"></div>
     <script>
       GitSandboxUI.mount('#sbx-first-commit', { title: '...', tasks: [...] });
     </script>
   ===================================================================== */

/* ------------------------------------------------------------------
   git sandbox core: in-memory fs + shell/git command engine + graph model
   No DOM. Works in Node (for tests) and in the browser.
   Requires a global `git` (isomorphic-git UMD).
   ------------------------------------------------------------------ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitSandboxCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- memory fs ---------------------------- */

  function createMemFS() {
    var store = new Map();
    var enc = new TextEncoder();
    var dec = new TextDecoder();
    var inode = 1;

    function norm(p) {
      p = String(p).replace(/\\/g, '/');
      if (p.charAt(0) !== '/') p = '/' + p;
      var parts = [];
      p.split('/').forEach(function (seg) {
        if (seg === '' || seg === '.') return;
        if (seg === '..') { parts.pop(); return; }
        parts.push(seg);
      });
      return '/' + parts.join('/');
    }
    function dirname(p) {
      p = norm(p);
      if (p === '/') return '/';
      var i = p.lastIndexOf('/');
      return i <= 0 ? '/' : p.slice(0, i);
    }
    function basename(p) {
      p = norm(p);
      return p.slice(p.lastIndexOf('/') + 1);
    }
    function mkErr(code, path) {
      var msgs = {
        ENOENT: 'no such file or directory',
        EEXIST: 'file already exists',
        ENOTDIR: 'not a directory',
        EISDIR: 'illegal operation on a directory',
        ENOTEMPTY: 'directory not empty',
        EINVAL: 'invalid argument'
      };
      var e = new Error(code + ': ' + (msgs[code] || code) + ", '" + path + "'");
      e.code = code;
      e.path = path;
      e.errno = -1;
      return e;
    }
    function statObj(node) {
      var isDir = node.type === 'dir';
      var isLink = node.type === 'symlink';
      return {
        type: node.type,
        mode: node.mode,
        size: isDir ? 0 : (node.content ? node.content.length : 0),
        ino: node.ino,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.mtimeMs,
        uid: 1, gid: 1, dev: 1,
        isFile: function () { return node.type === 'file'; },
        isDirectory: function () { return isDir; },
        isSymbolicLink: function () { return isLink; }
      };
    }
    function get(p) { return store.get(norm(p)); }
    function requireParentDir(p) {
      var d = dirname(p);
      var pn = store.get(d);
      if (!pn) throw mkErr('ENOENT', p);
      if (pn.type !== 'dir') throw mkErr('ENOTDIR', p);
    }

    store.set('/', { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });

    var promises = {
      readFile: function (p, opts) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          var encoding = typeof opts === 'string' ? opts : (opts && opts.encoding);
          return encoding ? dec.decode(n.content) : n.content.slice();
        });
      },
      writeFile: function (p, data, opts) {
        return Promise.resolve().then(function () {
          requireParentDir(p);
          var bytes = typeof data === 'string' ? enc.encode(data)
            : (data instanceof Uint8Array ? new Uint8Array(data) : enc.encode(String(data)));
          var mode = (opts && typeof opts === 'object' && opts.mode) || 33188;
          var existing = get(p);
          store.set(norm(p), {
            type: 'file', content: bytes, mode: existing ? existing.mode : mode,
            mtimeMs: Date.now(), ino: existing ? existing.ino : inode++
          });
        });
      },
      unlink: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          store.delete(norm(p));
        });
      },
      readdir: function (p) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type !== 'dir') throw mkErr('ENOTDIR', p);
          var prefix = d === '/' ? '/' : d + '/';
          var out = [];
          store.forEach(function (_v, k) {
            if (k === d || k.indexOf(prefix) !== 0) return;
            var rest = k.slice(prefix.length);
            if (rest.indexOf('/') === -1 && rest !== '') out.push(rest);
          });
          return out.sort();
        });
      },
      mkdir: function (p, opts) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          if (store.has(d)) {
            if (opts && opts.recursive) return;
            throw mkErr('EEXIST', p);
          }
          if (opts && opts.recursive) {
            var parts = d.split('/').filter(Boolean);
            var cur = '';
            parts.forEach(function (seg) {
              cur += '/' + seg;
              if (!store.has(cur)) store.set(cur, { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });
            });
            return;
          }
          requireParentDir(d);
          store.set(d, { type: 'dir', mode: 16877, mtimeMs: Date.now(), ino: inode++ });
        });
      },
      rmdir: function (p) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) throw mkErr('ENOENT', p);
          if (n.type !== 'dir') throw mkErr('ENOTDIR', p);
          var prefix = d === '/' ? '/' : d + '/';
          var empty = true;
          store.forEach(function (_v, k) { if (k !== d && k.indexOf(prefix) === 0) empty = false; });
          if (!empty) throw mkErr('ENOTEMPTY', p);
          store.delete(d);
        });
      },
      stat: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          return statObj(n);
        });
      },
      lstat: function (p) { return promises.stat(p); },
      readlink: function (p) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n || n.type !== 'symlink') throw mkErr('EINVAL', p);
          return n.target;
        });
      },
      symlink: function (target, p) {
        return Promise.resolve().then(function () {
          requireParentDir(p);
          store.set(norm(p), { type: 'symlink', target: target, mode: 41453, mtimeMs: Date.now(), ino: inode++ });
        });
      },
      chmod: function (p, mode) {
        return Promise.resolve().then(function () {
          var n = get(p);
          if (!n) throw mkErr('ENOENT', p);
          n.mode = mode;
        });
      },
      rm: function (p, opts) {
        return Promise.resolve().then(function () {
          var d = norm(p);
          var n = store.get(d);
          if (!n) {
            if (opts && opts.force) return;
            throw mkErr('ENOENT', p);
          }
          if (n.type === 'dir' && opts && opts.recursive) {
            var prefix = d === '/' ? '/' : d + '/';
            var kill = [];
            store.forEach(function (_v, k) { if (k === d || k.indexOf(prefix) === 0) kill.push(k); });
            kill.forEach(function (k) { store.delete(k); });
            return;
          }
          if (n.type === 'dir') throw mkErr('EISDIR', p);
          store.delete(d);
        });
      }
    };

    return {
      promises: promises,
      _store: store,
      _norm: norm,
      _dirname: dirname,
      _basename: basename
    };
  }

  /* --------------------------- tokenizing --------------------------- */

  // Split a command line into tokens, honouring single/double quotes,
  // and pull out redirection targets (> and >>).
  function tokenize(line) {
    var tokens = [];
    var cur = '';
    var has = false;
    var quote = null;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; }
        else if (ch === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; has = true; }
        else { cur += ch; has = true; }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (ch === ' ' || ch === '\t') {
        if (has) { tokens.push(cur); cur = ''; has = false; }
        continue;
      }
      if (ch === '>' ) {
        if (has) { tokens.push(cur); cur = ''; has = false; }
        if (line[i + 1] === '>') { tokens.push('>>'); i++; } else { tokens.push('>'); }
        continue;
      }
      cur += ch; has = true;
    }
    if (has) tokens.push(cur);
    if (quote) throw new Error('unmatched quote');
    return tokens;
  }

  function splitRedirect(tokens) {
    var out = { args: [], redirect: null, target: null };
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === '>' || tokens[i] === '>>') {
        out.redirect = tokens[i];
        out.target = tokens[i + 1] || null;
        i++;
        continue;
      }
      out.args.push(tokens[i]);
    }
    return out;
  }

  /* ------------------------------ engine ---------------------------- */

  function createSandbox(options) {
    options = options || {};
    var gitlib = options.git || (typeof self !== 'undefined' ? self.git : null);
    if (!gitlib) throw new Error('isomorphic-git not found');

    var fs = createMemFS();
    var dir = options.dir || '/project';
    var author = { name: 'Your Name', email: 'you@example.com' };
    var defaultBranch = options.defaultBranch || 'main';
    var repoReady = false;

    var base = { fs: fs, dir: dir };
    function opts(extra) {
      var o = { fs: fs, dir: dir };
      for (var k in extra) o[k] = extra[k];
      return o;
    }

    function abs(p) {
      if (!p) return dir;
      return p.charAt(0) === '/' ? fs._norm(p) : fs._norm(dir + '/' + p);
    }
    function rel(p) {
      var a = abs(p);
      return a.indexOf(dir + '/') === 0 ? a.slice(dir.length + 1) : a.replace(/^\//, '');
    }

    async function ensureWorkdir() {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    async function isRepo() {
      try { await fs.promises.stat(dir + '/.git'); return true; }
      catch (e) { return false; }
    }

    async function currentBranch() {
      try { return (await gitlib.currentBranch(opts({ fullname: false }))) || null; }
      catch (e) { return null; }
    }

    // list tracked+untracked files in the workdir (excluding .git)
    async function listFiles() {
      var out = [];
      var prefix = dir + '/';
      fs._store.forEach(function (v, k) {
        if (k.indexOf(prefix) !== 0) return;
        if (k.indexOf(dir + '/.git') === 0) return;
        if (v.type !== 'file') return;
        out.push(k.slice(prefix.length));
      });
      return out.sort();
    }

    /* ------------------------- graph model ------------------------- */

    async function graphModel() {
      if (!(await isRepo())) return { commits: [], branches: [], head: null, detached: false };

      var branches = await gitlib.listBranches(opts());
      var head = await currentBranch();
      var refs = {};
      var seeds = [];

      for (var i = 0; i < branches.length; i++) {
        try {
          var oid = await gitlib.resolveRef(opts({ ref: branches[i] }));
          refs[branches[i]] = oid;
          seeds.push(oid);
        } catch (e) { /* unborn branch */ }
      }
      // include HEAD in case it is detached
      var headOid = null;
      try { headOid = await gitlib.resolveRef(opts({ ref: 'HEAD' })); if (headOid) seeds.push(headOid); }
      catch (e) { /* no commits yet */ }

      var seen = new Map();
      var queue = seeds.slice();
      while (queue.length) {
        var oid2 = queue.shift();
        if (!oid2 || seen.has(oid2)) continue;
        var c;
        try { c = await gitlib.readCommit(opts({ oid: oid2 })); }
        catch (e) { continue; }
        seen.set(oid2, {
          oid: oid2,
          short: oid2.slice(0, 7),
          message: (c.commit.message || '').split('\n')[0],
          parents: c.commit.parent || [],
          timestamp: c.commit.author.timestamp,
          author: c.commit.author.name,
          refs: []
        });
        (c.commit.parent || []).forEach(function (p) { queue.push(p); });
      }

      // Topological order, children before parents, preferring newer commits.
      // A plain timestamp sort is not enough: commits made in the same second
      // (which happens whenever we seed a repo programmatically) would tie.
      var all = Array.from(seen.values());
      var childCount = {};
      all.forEach(function (c) { childCount[c.oid] = 0; });
      all.forEach(function (c) {
        (c.parents || []).forEach(function (p) {
          if (p in childCount) childCount[p]++;
        });
      });
      var ready = all.filter(function (c) { return childCount[c.oid] === 0; });
      var commits = [];
      var guard = all.length + 1;
      while (ready.length && guard-- > 0) {
        ready.sort(function (a, b) { return b.timestamp - a.timestamp; });
        var next = ready.shift();
        commits.push(next);
        (next.parents || []).forEach(function (p) {
          if (!(p in childCount)) return;
          childCount[p]--;
          if (childCount[p] === 0) ready.push(seen.get(p));
        });
      }
      // safety net: if a cycle ever appeared, fall back to timestamp order
      if (commits.length !== all.length) {
        commits = all.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
      }

      Object.keys(refs).forEach(function (name) {
        var node = seen.get(refs[name]);
        if (node) node.refs.push({ name: name, isHead: name === head });
      });

      // lane assignment: walk newest -> oldest keeping a set of open lanes
      var lanes = [];
      var laneOf = {};
      commits.forEach(function (c2) {
        var lane = lanes.indexOf(c2.oid);
        if (lane === -1) {
          lane = lanes.indexOf(null);
          if (lane === -1) { lane = lanes.length; lanes.push(null); }
        }
        lanes[lane] = null;
        laneOf[c2.oid] = lane;
        c2.lane = lane;
        var ps = c2.parents || [];
        if (ps.length) {
          lanes[lane] = ps[0];
          for (var j = 1; j < ps.length; j++) {
            if (lanes.indexOf(ps[j]) !== -1) continue;
            var free = lanes.indexOf(null);
            if (free === -1) { lanes.push(ps[j]); } else { lanes[free] = ps[j]; }
          }
        }
      });

      return {
        commits: commits,
        branches: branches.map(function (b) { return { name: b, oid: refs[b] || null, isHead: b === head }; }),
        head: head,
        headOid: headOid,
        detached: head === null && headOid !== null
      };
    }

    /* --------------------------- git status ------------------------ */

    // returns { staged:[], modified:[], untracked:[], deleted:[], stagedDeleted:[] }
    // isomorphic-git statusMatrix rows are [filepath, HEAD, WORKDIR, STAGE] where
    //   HEAD:    0 = absent,               1 = present
    //   WORKDIR: 0 = absent,               1 = same as HEAD, 2 = different from HEAD
    //   STAGE:   0 = absent, 1 = same as HEAD, 2 = same as WORKDIR, 3 = different from both
    async function statusModel() {
      var matrix = await gitlib.statusMatrix(opts());
      var res = { staged: [], modified: [], untracked: [], deleted: [], stagedDeleted: [] };
      matrix.forEach(function (row) {
        var file = row[0], head = row[1], workdir = row[2], stage = row[3];

        if (head === 0) {
          // file is not in the last commit
          if (stage === 0) { if (workdir !== 0) res.untracked.push(file); return; }
          res.staged.push({ file: file, kind: 'new file' });
          if (workdir === 0) res.deleted.push(file);       // staged then deleted on disk
          else if (stage === 3) res.modified.push(file);   // staged, then edited again
          return;
        }

        // file was in the last commit
        if (stage === 0) { res.stagedDeleted.push(file); if (workdir !== 0) res.untracked.push(file); return; }
        if (workdir === 0) { res.deleted.push(file); return; }
        if (stage === 1) { if (workdir === 2) res.modified.push(file); return; }
        // stage 2 or 3 => something is staged
        if (workdir === 2 || stage === 3) {
          res.staged.push({ file: file, kind: 'modified' });
          if (stage === 3) res.modified.push(file);        // staged one version, edited again
        }
      });
      return res;
    }

    /* -------------------------- git commands ----------------------- */

    async function gitCommand(args) {
      var sub = args[0];
      var rest = args.slice(1);

      if (!sub) return { out: usageGit(), ok: false };

      if (sub !== 'init' && sub !== 'help' && sub !== 'config' && !(await isRepo())) {
        return { out: 'fatal: not a git repository (or any of the parent directories): .git\nHint: run `git init` first.', ok: false };
      }

      switch (sub) {
        case 'init': {
          if (await isRepo()) return { out: 'Reinitialized existing Git repository in ' + dir + '/.git/', ok: true };
          await gitlib.init(opts({ defaultBranch: defaultBranch }));
          repoReady = true;
          return { out: 'Initialized empty Git repository in ' + dir + '/.git/', ok: true };
        }

        case 'config': {
          if (rest[0] === 'user.name' && rest[1]) { author.name = rest.slice(1).join(' '); return { out: '', ok: true }; }
          if (rest[0] === 'user.email' && rest[1]) { author.email = rest[1]; return { out: '', ok: true }; }
          if (rest[0] === 'user.name') return { out: author.name, ok: true };
          if (rest[0] === 'user.email') return { out: author.email, ok: true };
          return { out: 'usage: git config user.name "Your Name"', ok: false };
        }

        case 'status': {
          var st = await statusModel();
          var br = await currentBranch();
          var lines = ['On branch ' + (br || 'HEAD (detached)')];
          var anyCommit = true;
          try { await gitlib.resolveRef(opts({ ref: 'HEAD' })); }
          catch (e) { anyCommit = false; }
          if (!anyCommit) lines.push('', 'No commits yet');

          if (st.staged.length || st.stagedDeleted.length) {
            lines.push('', 'Changes to be committed:');
            st.staged.forEach(function (s) { lines.push('  {g}' + s.kind + ':   ' + s.file + '{/}'); });
            st.stagedDeleted.forEach(function (f) { lines.push('  {g}deleted:    ' + f + '{/}'); });
          }
          if (st.modified.length || st.deleted.length) {
            lines.push('', 'Changes not staged for commit:');
            st.modified.forEach(function (f) { lines.push('  {r}modified:   ' + f + '{/}'); });
            st.deleted.forEach(function (f) { lines.push('  {r}deleted:    ' + f + '{/}'); });
          }
          if (st.untracked.length) {
            lines.push('', 'Untracked files:');
            st.untracked.forEach(function (f) { lines.push('  {r}' + f + '{/}'); });
          }
          if (!st.staged.length && !st.stagedDeleted.length && !st.modified.length && !st.deleted.length && !st.untracked.length) {
            lines.push('', 'nothing to commit, working tree clean');
          }
          return { out: lines.join('\n'), ok: true };
        }

        case 'add': {
          if (!rest.length) return { out: "Nothing specified, nothing added.\nhint: try 'git add .' or 'git add <file>'", ok: false };
          var added = 0;
          for (var i = 0; i < rest.length; i++) {
            var spec = rest[i];
            if (spec === '.' || spec === '-A' || spec === '--all' || spec === '*') {
              var m = await gitlib.statusMatrix(opts());
              for (var j = 0; j < m.length; j++) {
                var row = m[j];
                if (row[2] === 0) await gitlib.remove(opts({ filepath: row[0] }));
                else await gitlib.add(opts({ filepath: row[0] }));
                added++;
              }
            } else {
              var f = rel(spec);
              try { await fs.promises.stat(abs(spec)); }
              catch (e) { return { out: "fatal: pathspec '" + spec + "' did not match any files", ok: false }; }
              await gitlib.add(opts({ filepath: f }));
              added++;
            }
          }
          return { out: '', ok: true, silentNote: added + ' path(s) staged' };
        }

        case 'rm': {
          var target = rest.filter(function (a) { return a.charAt(0) !== '-'; })[0];
          if (!target) return { out: 'usage: git rm <file>', ok: false };
          await gitlib.remove(opts({ filepath: rel(target) }));
          try { await fs.promises.unlink(abs(target)); } catch (e) {}
          return { out: "rm '" + rel(target) + "'", ok: true };
        }

        case 'commit': {
          var msg = null;
          for (var k = 0; k < rest.length; k++) {
            if (rest[k] === '-m' || rest[k] === '--message') { msg = rest[k + 1]; break; }
            if (rest[k].indexOf('-m') === 0 && rest[k].length > 2) { msg = rest[k].slice(2); break; }
          }
          if (!msg) return { out: 'Aborting commit due to empty commit message.\nhint: use  git commit -m "your message"', ok: false };
          var st2 = await statusModel();
          if (!st2.staged.length && !st2.stagedDeleted.length) {
            var br2 = await currentBranch();
            var extra = st2.untracked.length || st2.modified.length
              ? '\nUse `git add <file>` to stage changes first.' : '';
            return { out: 'On branch ' + br2 + '\nnothing to commit, working tree clean' + extra, ok: false };
          }
          var sha = await gitlib.commit(opts({ message: msg, author: { name: author.name, email: author.email } }));
          var branch3 = await currentBranch();
          var nFiles = st2.staged.length + st2.stagedDeleted.length;
          return {
            out: '[' + branch3 + ' ' + sha.slice(0, 7) + '] ' + msg + '\n ' + nFiles + ' file' + (nFiles === 1 ? '' : 's') + ' changed',
            ok: true
          };
        }

        case 'log': {
          var oneline = rest.indexOf('--oneline') !== -1;
          var commits;
          try { commits = await gitlib.log(opts({ depth: 50 })); }
          catch (e) { return { out: "fatal: your current branch does not have any commits yet", ok: false }; }
          if (!commits.length) return { out: 'fatal: your current branch does not have any commits yet', ok: false };
          var g = await graphModel();
          var refsByOid = {};
          g.commits.forEach(function (c) { if (c.refs.length) refsByOid[c.oid] = c.refs; });
          var outLines = [];
          commits.forEach(function (c) {
            var decor = refsByOid[c.oid]
              ? ' {y}(' + refsByOid[c.oid].map(function (r) { return r.isHead ? 'HEAD -> ' + r.name : r.name; }).join(', ') + '){/}'
              : '';
            if (oneline) {
              outLines.push('{y}' + c.oid.slice(0, 7) + '{/}' + decor + ' ' + c.commit.message.split('\n')[0]);
            } else {
              outLines.push('{y}commit ' + c.oid + '{/}' + decor);
              outLines.push('Author: ' + c.commit.author.name + ' <' + c.commit.author.email + '>');
              outLines.push('');
              outLines.push('    ' + c.commit.message.split('\n')[0]);
              outLines.push('');
            }
          });
          return { out: outLines.join('\n'), ok: true };
        }

        case 'branch': {
          var del = rest.indexOf('-d') !== -1 || rest.indexOf('-D') !== -1;
          var names = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          var all = await gitlib.listBranches(opts());
          var cur = await currentBranch();
          if (del) {
            if (!names.length) return { out: 'fatal: branch name required', ok: false };
            if (names[0] === cur) return { out: "error: cannot delete branch '" + names[0] + "' checked out at '" + dir + "'", ok: false };
            if (all.indexOf(names[0]) === -1) return { out: "error: branch '" + names[0] + "' not found.", ok: false };
            await gitlib.deleteBranch(opts({ ref: names[0] }));
            return { out: "Deleted branch " + names[0], ok: true };
          }
          if (!names.length) {
            if (!all.length) return { out: '', ok: true };
            return { out: all.map(function (b) { return b === cur ? '{g}* ' + b + '{/}' : '  ' + b; }).join('\n'), ok: true };
          }
          if (all.indexOf(names[0]) !== -1) return { out: "fatal: a branch named '" + names[0] + "' already exists", ok: false };
          try { await gitlib.branch(opts({ ref: names[0] })); }
          catch (e) { return { out: 'fatal: ' + e.message, ok: false }; }
          return { out: '', ok: true, silentNote: 'created branch ' + names[0] };
        }

        case 'switch':
        case 'checkout': {
          var create = rest.indexOf('-b') !== -1 || rest.indexOf('-c') !== -1;
          var names2 = rest.filter(function (a) { return a.charAt(0) !== '-'; });
          if (!names2.length) return { out: 'fatal: missing branch name', ok: false };
          var name = names2[0];
          var all2 = await gitlib.listBranches(opts());
          if (create) {
            if (all2.indexOf(name) !== -1) return { out: "fatal: a branch named '" + name + "' already exists", ok: false };
            await gitlib.branch(opts({ ref: name, checkout: true }));
            return { out: "Switched to a new branch '" + name + "'", ok: true };
          }
          if (all2.indexOf(name) === -1) {
            return { out: "error: pathspec '" + name + "' did not match any file(s) known to git\nhint: use `git checkout -b " + name + "` to create it", ok: false };
          }
          await gitlib.checkout(opts({ ref: name }));
          return { out: "Switched to branch '" + name + "'", ok: true };
        }

        case 'merge': {
          var theirs = rest.filter(function (a) { return a.charAt(0) !== '-'; })[0];
          if (!theirs) return { out: 'usage: git merge <branch>', ok: false };
          var ours = await currentBranch();
          var known = await gitlib.listBranches(opts());
          if (known.indexOf(theirs) === -1) return { out: "merge: " + theirs + " - not something we can merge", ok: false };
          if (theirs === ours) return { out: 'Already up to date.', ok: true };
          var result;
          try {
            result = await gitlib.merge(opts({
              ours: ours, theirs: theirs,
              author: { name: author.name, email: author.email },
              message: "Merge branch '" + theirs + "' into " + ours
            }));
          } catch (e) {
            if (e.code === 'MergeNotSupportedError' || e.code === 'MergeConflictError') {
              return {
                out: 'CONFLICT: both branches changed the same file.\n' +
                     'Automatic merge failed. In this sandbox, conflicts are not resolvable —\n' +
                     'try `reset` and take the guided path instead.',
                ok: false
              };
            }
            return { out: 'fatal: ' + e.message, ok: false };
          }
          // bring the working directory in line with the new ref
          await gitlib.checkout(opts({ ref: ours, force: true }));
          if (result.alreadyMerged) return { out: 'Already up to date.', ok: true };
          if (result.fastForward) return { out: 'Updating ' + (result.oid || '').slice(0, 7) + '\nFast-forward', ok: true };
          return { out: "Merge made by the 'recursive' strategy.", ok: true };
        }

        case 'diff': {
          var st3 = await statusModel();
          if (!st3.modified.length && !st3.untracked.length) return { out: '', ok: true };
          var chunks = [];
          for (var d = 0; d < st3.modified.length; d++) {
            var file = st3.modified[d];
            var headOid = await gitlib.resolveRef(opts({ ref: 'HEAD' }));
            var blob = await gitlib.readBlob(opts({ oid: headOid, filepath: file }));
            var oldTxt = new TextDecoder().decode(blob.blob);
            var newTxt = await fs.promises.readFile(dir + '/' + file, 'utf8');
            chunks.push('{w}diff --git a/' + file + ' b/' + file + '{/}');
            chunks.push(simpleDiff(oldTxt, newTxt));
          }
          return { out: chunks.join('\n'), ok: true };
        }

        case 'help':
          return { out: usageGit(), ok: true };

        default:
          return { out: "git: '" + sub + "' is not supported in this sandbox.\n" + usageGit(), ok: false };
      }
    }

    function simpleDiff(oldTxt, newTxt) {
      var a = oldTxt.split('\n'), b = newTxt.split('\n');
      var out = [];
      var i = 0, j = 0;
      while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
        else if (j < b.length && (i >= a.length || a.indexOf(b[j], i) === -1)) { out.push('{g}+' + b[j] + '{/}'); j++; }
        else if (i < a.length) { out.push('{r}-' + a[i] + '{/}'); i++; }
        else break;
      }
      return out.join('\n');
    }

    function usageGit() {
      return [
        'Supported git commands in this sandbox:',
        '  git init                      git status',
        '  git add <file> | .            git commit -m "message"',
        '  git log [--oneline]           git diff',
        '  git branch [name] [-d name]   git checkout [-b] <branch>',
        '  git switch [-c] <branch>      git merge <branch>',
        '  git config user.name "..."'
      ].join('\n');
    }

    /* ------------------------- shell commands ---------------------- */

    async function shellCommand(cmd, args, redirect, target) {
      switch (cmd) {
        case 'ls': {
          var showAll = args.indexOf('-a') !== -1 || args.indexOf('-la') !== -1 || args.indexOf('-al') !== -1;
          var entries = await fs.promises.readdir(dir);
          if (!showAll) entries = entries.filter(function (e) { return e.charAt(0) !== '.'; });
          if (!entries.length) return { out: '', ok: true };
          var marked = [];
          for (var i = 0; i < entries.length; i++) {
            var s = await fs.promises.stat(dir + '/' + entries[i]);
            marked.push(s.isDirectory() ? '{b}' + entries[i] + '/{/}' : entries[i]);
          }
          return { out: marked.join('  '), ok: true };
        }
        case 'cat': {
          if (!args.length) return { out: 'usage: cat <file>', ok: false };
          try {
            var txt = await fs.promises.readFile(abs(args[0]), 'utf8');
            return { out: txt.replace(/\n$/, ''), ok: true };
          } catch (e) {
            return { out: 'cat: ' + args[0] + ': No such file or directory', ok: false };
          }
        }
        case 'echo': {
          var text = args.join(' ');
          if (redirect && target) {
            var p = abs(target);
            var prev = '';
            if (redirect === '>>') { try { prev = await fs.promises.readFile(p, 'utf8'); } catch (e) {} }
            await fs.promises.writeFile(p, prev + text + '\n');
            return { out: '', ok: true, silentNote: 'wrote ' + rel(target) };
          }
          return { out: text, ok: true };
        }
        case 'touch': {
          if (!args.length) return { out: 'usage: touch <file>', ok: false };
          for (var t = 0; t < args.length; t++) {
            var pt = abs(args[t]);
            try { await fs.promises.stat(pt); }
            catch (e) { await fs.promises.writeFile(pt, ''); }
          }
          return { out: '', ok: true, silentNote: 'touched ' + args.join(' ') };
        }
        case 'rm': {
          var files = args.filter(function (a) { return a.charAt(0) !== '-'; });
          if (!files.length) return { out: 'usage: rm <file>', ok: false };
          for (var r = 0; r < files.length; r++) {
            try { await fs.promises.unlink(abs(files[r])); }
            catch (e) { return { out: 'rm: ' + files[r] + ': No such file or directory', ok: false }; }
          }
          return { out: '', ok: true };
        }
        case 'mkdir': {
          if (!args.length) return { out: 'usage: mkdir <dir>', ok: false };
          await fs.promises.mkdir(abs(args[args.length - 1]), { recursive: true });
          return { out: '', ok: true };
        }
        case 'pwd':
          return { out: dir.replace('/project', '~/project'), ok: true };
        case 'whoami':
          return { out: author.name + ' <' + author.email + '>', ok: true };
        default:
          return null;
      }
    }

    /* ---------------------------- dispatch -------------------------- */

    async function run(line) {
      line = String(line || '').trim();
      if (!line) return { out: '', ok: true, kind: 'empty' };

      var tokens;
      try { tokens = tokenize(line); }
      catch (e) { return { out: 'sh: ' + e.message, ok: false, kind: 'error' }; }

      var parsed = splitRedirect(tokens);
      var args = parsed.args;
      var cmd = args[0];

      await ensureWorkdir();

      try {
        if (cmd === 'git') {
          var r = await gitCommand(args.slice(1));
          r.kind = 'git';
          return r;
        }
        var sh = await shellCommand(cmd, args.slice(1), parsed.redirect, parsed.target);
        if (sh) { sh.kind = 'shell'; return sh; }
        return {
          out: cmd + ': command not found\nType `help` to see what this sandbox supports.',
          ok: false, kind: 'error'
        };
      } catch (e) {
        return { out: 'error: ' + (e && e.message ? e.message : String(e)), ok: false, kind: 'error' };
      }
    }

    async function reset(seed) {
      fs = createMemFS();
      base.fs = fs;
      repoReady = false;
      author = { name: 'Your Name', email: 'you@example.com' };
      await ensureWorkdir();
      if (seed) await seed(api);
    }

    var api = {
      run: run,
      reset: reset,
      graphModel: graphModel,
      statusModel: statusModel,
      isRepo: isRepo,
      currentBranch: currentBranch,
      listFiles: listFiles,
      readFile: function (p) { return fs.promises.readFile(abs(p), 'utf8'); },
      writeFile: function (p, c) { return ensureWorkdir().then(function () { return fs.promises.writeFile(abs(p), c); }); },
      get fs() { return fs; },
      get dir() { return dir; },
      git: gitlib
    };
    return api;
  }

  return {
    createSandbox: createSandbox,
    createMemFS: createMemFS,
    tokenize: tokenize,
    splitRedirect: splitRedirect
  };
});


/* ------------------------------------------------------------------
   The `when:` mini-language.

   Lesson authors describe what a learner must achieve as a condition on
   repository state rather than as JavaScript:

     when: repo
     when: commits >= 2
     when: commits on report >= 3
     when: branch report and on main
     when: merged report into main
     when: merge commit
     when: file report.qmd contains "Q3"
     when: ran /git\s+status/
     when: not clean

   compileWhen(src) returns a predicate (ctx) => boolean, or throws an Error
   with an author-facing message. Compilation happens once at mount time so
   mistakes surface immediately rather than on the learner's tenth command.
   ------------------------------------------------------------------ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitSandboxWhen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEYWORDS = ['and', 'or', 'not'];

  /* ------------------------------ tokenizer ------------------------------ */

  function tokenize(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')') { tokens.push({ t: c, v: c, at: i }); i++; continue; }
      if (c === '"' || c === "'") {
        var q = c, buf = '', start = i;
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === '\\' && i + 1 < n) { buf += src[i + 1]; i += 2; }
          else { buf += src[i]; i++; }
        }
        if (i >= n) throw new Error('unterminated string starting at character ' + (start + 1));
        i++;
        tokens.push({ t: 'str', v: buf, at: start });
        continue;
      }
      if (c === '/') {
        var rstart = i, rbuf = '';
        i++;
        while (i < n && src[i] !== '/') {
          if (src[i] === '\\' && i + 1 < n) { rbuf += src[i] + src[i + 1]; i += 2; }
          else { rbuf += src[i]; i++; }
        }
        if (i >= n) throw new Error('unterminated /regex/ starting at character ' + (rstart + 1));
        i++;
        var flags = '';
        while (i < n && /[a-z]/.test(src[i])) { flags += src[i]; i++; }
        tokens.push({ t: 'regex', v: rbuf, flags: flags, at: rstart });
        continue;
      }
      var opMatch = /^(>=|<=|==|=|>|<)/.exec(src.slice(i));
      if (opMatch) { tokens.push({ t: 'op', v: opMatch[1], at: i }); i += opMatch[1].length; continue; }
      var wordMatch = /^[^\s()]+/.exec(src.slice(i));
      if (!wordMatch) throw new Error('unexpected character ' + JSON.stringify(c));
      var w = wordMatch[0];
      if (/^\d+$/.test(w)) tokens.push({ t: 'num', v: parseInt(w, 10), at: i });
      else if (KEYWORDS.indexOf(w) !== -1) tokens.push({ t: w, v: w, at: i });
      else tokens.push({ t: 'word', v: w, at: i });
      i += w.length;
    }
    return tokens;
  }

  /* ------------------------------ predicates ----------------------------- */

  function ui() {
    return (typeof self !== 'undefined' && self.GitSandboxUI) || null;
  }
  function branchOid(ctx, name) {
    var b = (ctx.graph.branches || []).filter(function (x) { return x.name === name; })[0];
    return b ? b.oid : null;
  }
  function reaches(ctx, from, target) {
    if (!from || !target) return false;
    if (from === target) return true;
    var byOid = {};
    ctx.graph.commits.forEach(function (c) { byOid[c.oid] = c; });
    var stack = [from], seen = {};
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
  function commitCount(ctx, name) {
    if (!name) return ctx.graph.commits.length;
    var tip = branchOid(ctx, name);
    if (!tip) return 0;
    var byOid = {};
    ctx.graph.commits.forEach(function (c) { byOid[c.oid] = c; });
    var stack = [tip], seen = {}, count = 0;
    while (stack.length) {
      var oid = stack.pop();
      if (seen[oid]) continue;
      seen[oid] = true;
      count++;
      var c = byOid[oid];
      if (c) (c.parents || []).forEach(function (p) { stack.push(p); });
    }
    return count;
  }
  function compare(op, left, right) {
    switch (op) {
      case '>=': return left >= right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '<': return left < right;
      case '==':
      case '=': return left === right;
    }
    return false;
  }

  /* -------------------------------- parser ------------------------------- */

  function parse(src) {
    var tokens = tokenize(src);
    var pos = 0;

    function peek(k) { return tokens[pos + (k || 0)]; }
    function next() { return tokens[pos++]; }
    function describe(tok) {
      if (!tok) return 'end of expression';
      return JSON.stringify(String(tok.v));
    }
    function expectWord(what) {
      var tok = peek();
      if (!tok || (tok.t !== 'word' && tok.t !== 'str' && tok.t !== 'num')) {
        throw new Error('expected ' + what + ' but found ' + describe(tok));
      }
      return String(next().v);
    }

    function parseOr() {
      var left = parseAnd();
      while (peek() && peek().t === 'or') {
        next();
        var right = parseAnd();
        left = (function (a, b) {
          return function (ctx) { return a(ctx) || b(ctx); };
        })(left, right);
      }
      return left;
    }

    function parseAnd() {
      var left = parseNot();
      while (peek() && peek().t === 'and') {
        next();
        var right = parseNot();
        left = (function (a, b) {
          return function (ctx) { return a(ctx) && b(ctx); };
        })(left, right);
      }
      return left;
    }

    function parseNot() {
      if (peek() && peek().t === 'not') {
        next();
        var inner = parseNot();
        return function (ctx) { return !inner(ctx); };
      }
      if (peek() && peek().t === '(') {
        next();
        var expr = parseOr();
        if (!peek() || peek().t !== ')') {
          throw new Error('missing closing parenthesis');
        }
        next();
        return expr;
      }
      return parsePredicate();
    }

    function parsePredicate() {
      var tok = peek();
      if (!tok) throw new Error('expression ended early; expected a condition');
      if (tok.t !== 'word') {
        throw new Error('expected a condition but found ' + describe(tok));
      }
      var word = String(next().v);

      switch (word) {
        case 'repo':
          return function (ctx) { return !!ctx.isRepo; };

        case 'clean':
          return function (ctx) {
            var s = ctx.status;
            return ctx.isRepo && s.staged.length === 0 && s.modified.length === 0 &&
                   s.untracked.length === 0 && s.deleted.length === 0 &&
                   s.stagedDeleted.length === 0;
          };

        case 'staged':
          return function (ctx) {
            return ctx.status.staged.length > 0 || ctx.status.stagedDeleted.length > 0;
          };

        case 'merge': {
          var m = peek();
          if (!m || String(m.v) !== 'commit') {
            throw new Error('expected "merge commit" but found "merge ' +
              (m ? String(m.v) : '') + '"');
          }
          next();
          return function (ctx) {
            return ctx.graph.commits.some(function (c) { return (c.parents || []).length > 1; });
          };
        }

        case 'commits': {
          var branch = null;
          if (peek() && peek().t === 'word' && String(peek().v) === 'on') {
            next();
            branch = expectWord('a branch name after "commits on"');
          }
          var op = '>=';
          if (peek() && peek().t === 'op') op = String(next().v);
          var numTok = peek();
          if (!numTok || numTok.t !== 'num') {
            throw new Error('expected a number after "commits' +
              (branch ? ' on ' + branch : '') + (op !== '>=' ? ' ' + op : '') +
              '" but found ' + describe(numTok));
          }
          next();
          var want = numTok.v;
          return function (ctx) { return compare(op, commitCount(ctx, branch), want); };
        }

        case 'branch': {
          var bname = expectWord('a branch name after "branch"');
          return function (ctx) {
            return (ctx.graph.branches || []).some(function (b) { return b.name === bname; });
          };
        }

        case 'on': {
          var onName = expectWord('a branch name after "on"');
          return function (ctx) { return ctx.graph.head === onName; };
        }

        case 'merged': {
          var from = expectWord('a branch name after "merged"');
          var into = peek();
          if (!into || String(into.v) !== 'into') {
            throw new Error('expected "merged ' + from + ' into <branch>" but found ' +
              describe(into) + ' after the branch name');
          }
          next();
          var target = expectWord('a branch name after "into"');
          return function (ctx) {
            return reaches(ctx, branchOid(ctx, target), branchOid(ctx, from));
          };
        }

        case 'file': {
          var fname = expectWord('a filename after "file"');
          if (peek() && peek().t === 'word' && String(peek().v) === 'contains') {
            next();
            var needleTok = peek();
            if (!needleTok || (needleTok.t !== 'str' && needleTok.t !== 'word' && needleTok.t !== 'regex')) {
              throw new Error('expected text or /regex/ after "contains" but found ' + describe(needleTok));
            }
            next();
            if (needleTok.t === 'regex') {
              var fre = new RegExp(needleTok.v, needleTok.flags || '');
              return function (ctx) { return fre.test(ctx._fileText(fname)); };
            }
            var needle = String(needleTok.v);
            return function (ctx) { return ctx._fileText(fname).indexOf(needle) !== -1; };
          }
          return function (ctx) { return ctx.files.indexOf(fname) !== -1; };
        }

        case 'ran': {
          var rTok = peek();
          if (!rTok || (rTok.t !== 'regex' && rTok.t !== 'str' && rTok.t !== 'word')) {
            throw new Error('expected /regex/ or "text" after "ran" but found ' + describe(rTok));
          }
          next();
          if (rTok.t === 'regex') {
            var re = new RegExp(rTok.v, rTok.flags || '');
            return function (ctx) { return (ctx.history || []).some(function (h) { return re.test(h); }); };
          }
          var text = String(rTok.v);
          return function (ctx) {
            return (ctx.history || []).some(function (h) { return h.indexOf(text) !== -1; });
          };
        }

        default:
          throw new Error('unknown condition "' + word + '". Available: repo, clean, staged, ' +
            'commits, commits on <branch>, branch <name>, on <branch>, merged <a> into <b>, ' +
            'merge commit, file <name> [contains "text"], ran /regex/');
      }
    }

    var fn = parseOr();
    if (pos < tokens.length) {
      throw new Error('unexpected ' + describe(peek()) + ' after a complete condition');
    }
    return fn;
  }

  /* -------------------------------- public ------------------------------- */

  function compileWhen(src) {
    if (typeof src !== 'string' || src.trim() === '') {
      throw new Error('`when:` is empty');
    }
    var fn;
    try {
      fn = parse(src);
    } catch (e) {
      throw new Error('cannot read `when: ' + src + '` — ' + e.message);
    }
    return function (ctx) {
      // `file ... contains` needs file contents, which are async; the UI
      // pre-loads them into ctx._files before evaluating.
      return fn(ctx);
    };
  }

  // Which filenames does this expression need the contents of? The UI reads
  // them before evaluating so predicates can stay synchronous.
  function filesNeeded(src) {
    var out = [];
    try {
      var tokens = tokenize(src);
      for (var i = 0; i < tokens.length - 2; i++) {
        if (tokens[i].t === 'word' && String(tokens[i].v) === 'file' &&
            tokens[i + 2] && tokens[i + 2].t === 'word' && String(tokens[i + 2].v) === 'contains') {
          out.push(String(tokens[i + 1].v));
        }
      }
    } catch (e) { /* compileWhen will report it */ }
    return out;
  }

  function compileJs(src) {
    var body = /(^|[\s;{])return[\s(]/.test(src) ? src : 'return (' + src + ');';
    try {
      /* eslint-disable no-new-func */
      var fn = new Function('c', body);
      return function (ctx) { return fn(ctx); };
    } catch (e) {
      throw new Error('cannot compile `js:` block — ' + e.message);
    }
  }

  return { compileWhen: compileWhen, compileJs: compileJs, filesNeeded: filesNeeded, tokenize: tokenize };
});


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

    if (!model.commits.length) {
      svg.setAttribute('viewBox', '0 0 300 60');
      svg.setAttribute('height', '60');
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', '12'); t.setAttribute('y', '34');
      t.setAttribute('class', 'gs-empty-text');
      t.textContent = 'No commits yet.';
      svg.appendChild(t);
      return;
    }

    var rowH = 44, laneW = 24, padTop = 26, padLeft = 22;
    var maxLane = 0;
    model.commits.forEach(function (c) { if (c.lane > maxLane) maxLane = c.lane; });
    var graphW = padLeft + maxLane * laneW + 22;
    var width = 640;
    var height = padTop + model.commits.length * rowH;

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

    var index = {};
    model.commits.forEach(function (c, i) { index[c.oid] = i; });
    var x = function (lane) { return padLeft + lane * laneW; };
    var y = function (i) { return padTop + i * rowH - rowH / 2 + 8; };

    // edges first so nodes sit on top
    model.commits.forEach(function (c, i) {
      (c.parents || []).forEach(function (p, pi) {
        if (!(p in index)) return;
        var j = index[p];
        var x1 = x(c.lane), y1 = y(i), x2 = x(model.commits[j].lane), y2 = y(j);
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
      var cx = x(c.lane), cy = y(i);
      var isMerge = (c.parents || []).length > 1;

      var circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', cx); circle.setAttribute('cy', cy);
      circle.setAttribute('r', isMerge ? 7 : 6);
      circle.setAttribute('fill', isMerge ? '#FFFFFF' : LANE_COLORS[c.lane % LANE_COLORS.length]);
      circle.setAttribute('stroke', LANE_COLORS[c.lane % LANE_COLORS.length]);
      circle.setAttribute('stroke-width', isMerge ? '3' : '2');
      svg.appendChild(circle);

      var tx = graphW + 6;

      // ref pills
      (c.refs || []).forEach(function (r) {
        var label = (r.isHead ? 'HEAD → ' : '') + r.name;
        var w = label.length * 6.6 + 14;
        var rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', tx); rect.setAttribute('y', cy - 10);
        rect.setAttribute('width', w); rect.setAttribute('height', 20);
        rect.setAttribute('rx', 10);
        rect.setAttribute('fill', r.isHead ? '#447099' : '#D0DBE5');
        svg.appendChild(rect);
        var lt = document.createElementNS(NS, 'text');
        lt.setAttribute('x', tx + 7); lt.setAttribute('y', cy + 4);
        lt.setAttribute('class', r.isHead ? 'gs-ref gs-ref-head' : 'gs-ref');
        lt.textContent = label;
        svg.appendChild(lt);
        tx += w + 6;
      });

      var sha = document.createElementNS(NS, 'text');
      sha.setAttribute('x', tx); sha.setAttribute('y', cy + 4);
      sha.setAttribute('class', 'gs-sha');
      sha.textContent = c.short;
      svg.appendChild(sha);

      var msg = document.createElementNS(NS, 'text');
      msg.setAttribute('x', tx + 62); msg.setAttribute('y', cy + 4);
      msg.setAttribute('class', 'gs-msg');
      var m = c.message.length > 46 ? c.message.slice(0, 45) + '…' : c.message;
      msg.textContent = m;
      svg.appendChild(msg);
    });
  }

  /* -------------------------- staging diagram ------------------------ */

  function renderStages(node, status, graph, files) {
    var needAdd = []
      .concat(status.untracked.map(function (f) { return { f: f, k: 'untracked' }; }))
      .concat(status.modified.map(function (f) { return { f: f, k: 'modified' }; }))
      .concat(status.deleted.map(function (f) { return { f: f, k: 'deleted' }; }));
    var staged = status.staged.map(function (s) { return { f: s.file, k: s.kind }; })
      .concat(status.stagedDeleted.map(function (f) { return { f: f, k: 'deleted' }; }));

    function col(title, note, items, kind) {
      var chips = items.length
        ? items.map(function (it) {
            return '<span class="gs-chip gs-chip-' + kind + '">' + esc(it.f) +
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
      col('Working directory', 'what you edit', needAdd, 'work') +
      '<div class="gs-arrow"><span>git add</span>→</div>' +
      col('Staging area', 'what goes in next commit', staged, 'stage') +
      '<div class="gs-arrow"><span>git commit</span>→</div>' +
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

    var sb = root.GitSandboxCore.createSandbox({ git: root.git });
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
        '<button type="button" class="gs-reset">Reset</button>' +
      '</div>' +
      '<div class="gs-body">' +
        '<div class="gs-term-wrap">' +
          '<div class="gs-out" role="log" aria-live="polite" aria-label="Terminal output"></div>' +
          '<form class="gs-input-row" autocomplete="off">' +
            '<label class="gs-prompt" for="' + (host.id || 'gs') + '-in">' + esc(config.prompt || '~/project $') + '</label>' +
            '<input class="gs-input" id="' + (host.id || 'gs') + '-in" type="text" spellcheck="false"' +
            ' autocapitalize="off" autocorrect="off" aria-label="Type a git command">' +
          '</form>' +
          '<div class="gs-hints"></div>' +
        '</div>' +
        '<div class="gs-viz">' +
          '<div class="gs-viz-h">Where your work lives</div>' +
          '<div class="gs-stages"></div>' +
          '<div class="gs-viz-h">Commit history</div>' +
          '<div class="gs-graph-scroll"><svg class="gs-graph" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
        '</div>' +
      '</div>' +
      '<div class="gs-tasks"></div>';

    var out = host.querySelector('.gs-out');
    var form = host.querySelector('.gs-input-row');
    var input = host.querySelector('.gs-input');
    var hintsNode = host.querySelector('.gs-hints');
    var stagesNode = host.querySelector('.gs-stages');
    var svg = host.querySelector('.gs-graph');
    var tasksNode = host.querySelector('.gs-tasks');
    var resetBtn = host.querySelector('.gs-reset');

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
      if (!isRepo) {
        status.untracked = files.slice();
      }
      renderStages(stagesNode, status, graph, files);
      renderGraph(svg, graph);

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
        history: history, isRepo: isRepo,
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
      var r = await sb.run(line);
      if (line.trim() === 'clear') { out.innerHTML = ''; }
      else if (line.trim() === 'help') { writeText(helpText()); }
      else if (line.trim() === 'reset') { await doReset(); }
      else { writeText(r.out, r.ok ? '' : 'gs-err'); }
      history.push(line);
      histIdx = history.length;
      await refresh();
      input.disabled = false;
      busy = false;
      input.focus();
    }

    function helpText() {
      return [
        '{w}This sandbox runs real git{/} (isomorphic-git) on a repo that lives only in this page.',
        '',
        '{y}git{/}    init, status, add, commit -m, log [--oneline], diff,',
        '       branch [-d], checkout [-b], switch [-c], merge, config',
        '{y}shell{/}  ls, cat, echo "text" > file, echo "text" >> file, touch, rm, mkdir, pwd',
        '{y}other{/}  help, clear, reset'
      ].join('\n');
    }

    async function doReset() {
      out.innerHTML = '';
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
