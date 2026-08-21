const fs=require('fs'),path=require('path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'example-embed.html');
const errs=[]; const vc=new VirtualConsole();
vc.on('jsdomError',e=>{const m=String(e.message||e); if(!/stylesheet|Could not load link/i.test(m)) errs.push(m.slice(0,160));});
const dom=new JSDOM(fs.readFileSync(file,'utf8'),{
  url:'file://'+file, runScripts:'dangerously', resources:'usable', pretendToBeVisual:true, virtualConsole:vc,
  beforeParse(w){w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;if(!w.crypto)w.crypto=require('crypto').webcrypto;}
});
const win=dom.window, sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await new Promise(r=>win.addEventListener('load',r,{once:true}));
  for(let i=0;i<150 && !win.document.querySelector('.gs-task');i++) await sleep(80);
  await sleep(200);
  let p=0,f=0; const ck=(l,c,d)=>{c?p++:(f++,console.log(' FAIL',l,d||''));};
  const host=win.document.querySelector('#anatomy');
  ck('git loaded', typeof win.git==='object' && typeof win.git.init==='function');
  ck('Buffer polyfill present', typeof win.Buffer!=='undefined');
  ck('mounted', !!host.querySelector('.gs-input'), host.textContent.slice(0,120));
  const form=host.querySelector('.gs-input-row'), input=host.querySelector('.gs-input');
  const type=async l=>{for(let i=0;i<200&&input.disabled;i++)await sleep(40);
    input.value=l; form.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));
    for(let i=0;i<200&&input.disabled;i++)await sleep(40); await sleep(20);};
  const graph=()=>{const g=host.querySelector('.gs-graph');return g?g.textContent:'';};
  ck('seed left two commits', /Start the analysis/.test(graph()), graph().slice(0,160));
  for(const c of ['git status','echo "A new line." >> README.md','git add .',
                  'git commit -m "Extend the README"']) await type(c);
  const done=host.querySelectorAll('.gs-task.is-done').length;
  ck('all 4 tasks complete', done===4, 'done='+done+' :: '+host.querySelector('.gs-tasks').textContent);
  ck('no script errors', errs.length===0, errs.join(' | '));
  console.log('example-embed.html — passed: '+p+'   failed: '+f);
  process.exit(f?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
