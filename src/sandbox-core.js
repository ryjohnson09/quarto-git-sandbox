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
