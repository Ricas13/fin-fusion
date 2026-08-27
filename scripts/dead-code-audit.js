'use strict';

const fs=require('fs');
const path=require('path');

const root=path.resolve(__dirname,'..');
const posix=value=>value.split(path.sep).join('/');
const exists=file=>fs.existsSync(path.join(root,file));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

function walk(dir){
  const absolute=path.join(root,dir);
  if(!fs.existsSync(absolute))return[];
  const out=[];
  for(const entry of fs.readdirSync(absolute,{withFileTypes:true})){
    if(['node_modules','.git'].includes(entry.name))continue;
    const relative=posix(path.join(dir,entry.name));
    if(entry.isDirectory())out.push(...walk(relative));
    else out.push(relative);
  }
  return out;
}

const allFiles=[...walk('src'),...walk('scripts'),...walk('views'),...walk('public'),...walk('.github')];
const jsFiles=allFiles.filter(file=>file.endsWith('.js'));
const jsSet=new Set(jsFiles);
const sourceFiles=jsFiles.filter(file=>file.startsWith('src/'));
const scriptFiles=jsFiles.filter(file=>file.startsWith('scripts/'));
const contents=new Map(jsFiles.map(file=>[file,read(file)]));

function resolveLocal(fromFile,specifier){
  if(!specifier||!specifier.startsWith('.'))return null;
  const base=posix(path.normalize(path.join(path.dirname(fromFile),specifier)));
  for(const candidate of [base,`${base}.js`,`${base}/index.js`])if(jsSet.has(candidate))return candidate;
  return null;
}

function localDependencies(file){
  const text=contents.get(file)||'';
  const specs=[];
  const patterns=[
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for(const pattern of patterns){
    let match;
    while((match=pattern.exec(text)))specs.push(match[1]);
  }
  return [...new Set(specs.map(spec=>resolveLocal(file,spec)).filter(Boolean))];
}

const graph=new Map(jsFiles.map(file=>[file,localDependencies(file)]));
function reachableFrom(roots){
  const seen=new Set(),queue=[...roots].filter(file=>jsSet.has(file));
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file))continue;
    seen.add(file);
    for(const dependency of graph.get(file)||[])if(!seen.has(dependency))queue.push(dependency);
  }
  return seen;
}

const packageJson=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const packageEntries=new Map();
for(const [name,command] of Object.entries(packageJson.scripts||{})){
  const matches=[...String(command).matchAll(/(?:^|[;&|]\s*|\s)node\s+([^\s;&|]+\.js)\b/g)].map(match=>posix(match[1].replace(/^\.\//,'')));
  for(const file of matches)if(jsSet.has(file)){
    if(!packageEntries.has(file))packageEntries.set(file,[]);
    packageEntries.get(file).push(name);
  }
}

const infraFiles=[
  ...walk('.github').filter(file=>/\.ya?ml$/.test(file)),
  ...walk('scripts').filter(file=>/\.sh$/.test(file)),
  'Dockerfile','docker-compose.yml','docker-compose.yaml'
].filter(file=>exists(file));
const infraEntries=new Set();
for(const file of infraFiles){
  const text=read(file);
  for(const match of text.matchAll(/(?:^|[\s'"`])((?:\.\/)?scripts\/[A-Za-z0-9._/-]+\.js)\b/g)){
    const candidate=posix(match[1].replace(/^\.\//,''));
    if(jsSet.has(candidate))infraEntries.add(candidate);
  }
}

const allEntrypoints=new Set(['src/application.js',...packageEntries.keys(),...infraEntries]);
const nonProductionName=/(?:^|[-_.])(smoke|test|audit|check)(?:[-_.]|$)/i;
const productionScriptEntries=[...allEntrypoints].filter(file=>file.startsWith('scripts/')&&!nonProductionName.test(path.basename(file)));
const productionRoots=new Set(['src/application.js',...productionScriptEntries]);
const repositoryReachable=reachableFrom(allEntrypoints);
const productionReachable=reachableFrom(productionRoots);

const strongSourceOrphans=sourceFiles.filter(file=>!repositoryReachable.has(file));
const testOnlySource=sourceFiles.filter(file=>repositoryReachable.has(file)&&!productionReachable.has(file));
const strongScriptOrphans=scriptFiles.filter(file=>!repositoryReachable.has(file));

const referenceTextFiles=[
  ...sourceFiles,
  ...scriptFiles,
  ...allFiles.filter(file=>file.startsWith('views/')&&file.endsWith('.ejs')),
  ...allFiles.filter(file=>file.startsWith('public/')&&/\.(?:html|js|css)$/.test(file))
];
const referenceCorpus=referenceTextFiles.map(file=>({file,text:read(file)}));

const publicJs=allFiles.filter(file=>file.startsWith('public/js/')&&file.endsWith('.js'));
const orphanPublicJs=publicJs.filter(file=>{
  const relative=file.slice('public/'.length);
  const webPath=`/${relative}`;
  const bare=path.basename(file);
  return !referenceCorpus.some(row=>row.file!==file&&(row.text.includes(webPath)||row.text.includes(file)||row.text.includes(bare)));
});

const views=allFiles.filter(file=>file.startsWith('views/')&&file.endsWith('.ejs'));
const orphanViews=views.filter(file=>{
  const viewName=file.slice('views/'.length,-'.ejs'.length);
  const basename=path.basename(viewName);
  return !referenceCorpus.some(row=>row.file!==file&&(
    row.text.includes(`'${viewName}'`)||row.text.includes(`"${viewName}"`)||
    row.text.includes(`'${basename}'`)||row.text.includes(`"${basename}"`)
  ));
});

function duplicateBasenames(files){
  const groups=new Map();
  for(const file of files){const base=path.basename(file);if(!groups.has(base))groups.set(base,[]);groups.get(base).push(file);}
  return [...groups.values()].filter(group=>group.length>1);
}

const report={
  scanned:{js:jsFiles.length,source:sourceFiles.length,scripts:scriptFiles.length,views:views.length,publicJs:publicJs.length},
  roots:{all:[...allEntrypoints].sort(),production:[...productionRoots].sort()},
  strongSourceOrphans:strongSourceOrphans.sort(),
  testOnlySource:testOnlySource.sort(),
  strongScriptOrphans:strongScriptOrphans.sort(),
  orphanPublicJs:orphanPublicJs.sort(),
  orphanViews:orphanViews.sort(),
  duplicateJsBasenames:duplicateBasenames(jsFiles).sort((a,b)=>a[0].localeCompare(b[0]))
};

console.log('dead-code audit summary');
console.log(`  JS files: ${report.scanned.js} (${report.scanned.source} src, ${report.scanned.scripts} scripts)`);
console.log(`  views: ${report.scanned.views}; public JS: ${report.scanned.publicJs}`);
for(const [label,items] of [
  ['strong source orphans',report.strongSourceOrphans],
  ['production-unreachable/test-only source',report.testOnlySource],
  ['strong script orphans',report.strongScriptOrphans],
  ['unreferenced public JS candidates',report.orphanPublicJs],
  ['unreferenced view candidates',report.orphanViews]
]){
  console.log(`\n${label}: ${items.length}`);
  for(const item of items)console.log(`  - ${item}`);
}

if(process.argv.includes('--json'))console.log(`\n${JSON.stringify(report,null,2)}`);
if(process.argv.includes('--strict')&&(strongSourceOrphans.length||strongScriptOrphans.length))process.exitCode=1;
