#!/usr/bin/env python3
import re,subprocess,hashlib,sys,json,os
ROOT='/home/user/jev-browser-wingman'; os.chdir(ROOT)
OUT='.build/kb-r21'; LOG='/tmp/claude-0/r17/mut21'; os.makedirs(LOG,exist_ok=True)
ENTRIES=['tests/act-nav.test.ts','tests/page-scripts.test.ts','tests/pointer-enum.test.ts','tests/loop.test.ts','tests/chain.test.ts','tests/adapter-playwright.test.ts','tests/adapter-cdp.test.ts','src/cli/main.ts']
# flag, src file, files to run, mapped pin title prefixes
FLAGS=[
 ('KB_CAPTCHA_SCOPED','src/core/page-scripts.ts',['page-scripts','pointer-enum'],['captcha-decoys.html does not set the captcha signal']),
 ('KB_CURSOR_POINTER','src/core/page-scripts.ts',['pointer-enum','page-scripts'],['click Save on pointer-interactive.html','enumerate lists the decoy divs']),
 ('KB_PW_NOWAIT','src/adapters/playwright.ts',['act-nav','adapter-playwright'],['T-nav-nowait']),
 ('KB_PW_PRECLICK','src/adapters/playwright.ts',['act-nav','adapter-playwright'],['T-preclick-guard']),
 ('KB_CDP_PRECLICK','src/adapters/cdp.ts',['act-nav','adapter-cdp'],['T-cdp-preclick']),
 ('KB_OBS_RETRY','src/core/loop.ts',['loop','chain'],['a fast mid-navigation observe failure retries']),
 ('KB_PW_WAIT_GROWTH','src/adapters/playwright.ts',['act-nav','adapter-playwright'],['T-wait-growth','T-wait-static']),
 ('KB_CDP_WAIT_GROWTH','src/adapters/cdp.ts',['act-nav','adapter-cdp'],['T-wait-growth','T-wait-static']),
]
def sh(a): return subprocess.run(a,capture_output=True,text=True)
def kbtrue(): return sh(['grep','-rnE','(const|var) KB_[A-Z_]+ = true',  'src']).stdout.strip()
def titles(out): return sorted({m.group(1).strip() for m in re.finditer(r'^\s*not ok \d+ - (.+?)(?: #\w+)?\s*$',out,re.M)})
res={}; print('pre-grep kb=true:',repr(kbtrue()),flush=True)
for flag,src,files,mapped in FLAGS:
    orig=open(src,encoding='utf-8',newline='').read(); dig=hashlib.sha256(orig.encode()).hexdigest()
    pat=re.compile(r'((?:const|var) '+flag+r' = )false;')
    if len(pat.findall(orig))!=1: print(flag,'ANCHOR COUNT',len(pat.findall(orig)),flush=True); res[flag]={'error':'anchor'}; continue
    try:
        open(src,'w',encoding='utf-8',newline='').write(pat.sub(r'\1true;',orig))
        sh(['rm','-rf',OUT]); b=sh(['node','scripts/build.mjs','--out',OUT]+ENTRIES)
        if b.returncode!=0: print(flag,'BUILD FAIL',b.stderr[-300:],flush=True); res[flag]={'error':'build'}; continue
        failed={}
        for f in files:
            t=sh(['node','scripts/run-tests.mjs','--dist',OUT,f]); txt=t.stdout+t.stderr
            open(f'{LOG}/{flag}.{f}.log','w').write(txt); failed[f]=titles(txt); sh(['pkill','-x','chrome'])
        allfail=[(f,t) for f,ts in failed.items() for t in ts]
        mapped_red=[m for m in mapped if any(t.startswith(m) for _,t in allfail)]
        extras=[(f,t) for f,t in allfail if not any(t.startswith(m) for m in mapped)]
        res[flag]={'mapped':mapped,'mapped_red':mapped_red,'mapped_missing':[m for m in mapped if m not in mapped_red],'extras':extras}
        print(flag,'mapped red',len(mapped_red),'/',len(mapped),'missing',res[flag]['mapped_missing'],'extras',len(extras),extras,flush=True)
    finally:
        open(src,'w',encoding='utf-8',newline='').write(orig)
        ok=hashlib.sha256(open(src,encoding='utf-8',newline='').read().encode()).hexdigest()==dig
        res.setdefault(flag,{})['restored']=ok
        print(flag,'restored byte-identical:',ok,flush=True)
print('post-grep kb=true:',repr(kbtrue()),flush=True)
json.dump(res,open(f'{LOG}/result.json','w'),indent=1)
print('MUTDONE',flush=True)
