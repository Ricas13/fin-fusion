'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

process.env.SESSION_SECRET=process.env.SESSION_SECRET||'visible-workflow-targets-smoke-secret-2026-long-value';
process.env.NODE_ENV=process.env.NODE_ENV||'test';

const root=path.join(__dirname,'..');
const {createApplication}=require('../src/application');
const {getPool}=require('../src/db');

function files(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())return files(full);
    return entry.isFile()&&/\.(js|ejs)$/.test(entry.name)?[full]:[];
  });
}
function routePaths(value){return Array.isArray(value)?value:[value];}
function collectRoutes(stack,out=[]){
  for(const layer of stack||[]){
    if(layer.route){
      for(const routePath of routePaths(layer.route.path)){
        for(const [method,enabled] of Object.entries(layer.route.methods||{})){
          if(enabled)out.push({method:method.toUpperCase(),path:String(routePath)});
        }
      }
    }
    if(layer.handle?.stack)collectRoutes(layer.handle.stack,out);
  }
  return out;
}
function canonicalSegments(value){
  const clean=String(value||'').split(/[?#]/)[0].replace(/\/+$/,'')||'/';
  return clean.split('/').filter(Boolean).map(segment=>segment.startsWith(':')?':':segment);
}
function sameShape(a,b){
  const x=canonicalSegments(a),y=canonicalSegments(b);
  if(x.length!==y.length)return false;
  return x.every((segment,index)=>segment===':'||y[index]===':'||segment===y[index]);
}
function attr(tag,name){
  const match=tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,'i'));
  return match?match[1]:'';
}
function staticLocalTarget(value){
  const target=String(value||'').trim();
  if(!target||target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:'))return null;
  if(target.includes('<%')||target.includes('${')||target.includes('{{'))return null;
  if(/^https?:\/\//i.test(target)||target.startsWith('//'))return null;
  if(!target.startsWith('/'))return null;
  if(/\.(css|js|png|jpg|jpeg|webp|gif|svg|ico|woff2?)($|[?#])/i.test(target))return null;
  return target.split('#')[0];
}
function dynamicLocalTarget(value){
  const normalized=String(value||'').replace(/\$\{[^}]+\}/g,':param');
  return staticLocalTarget(normalized);
}

async function main(){
  const app=createApplication();
  const routes=collectRoutes(app._router?.stack||app.router?.stack||[]);
  const sources=[...files(path.join(root,'src')), ...files(path.join(root,'views'))];
  const checks=[];
  for(const file of sources){
    const rel=path.relative(root,file),source=fs.readFileSync(file,'utf8');
    let match;
    const formRe=/<form\b[^>]*>/gi;
    while((match=formRe.exec(source))){
      const tag=match[0],action=dynamicLocalTarget(attr(tag,'action'));
      if(!action)continue;
      const method=(attr(tag,'method')||'GET').toUpperCase();
      checks.push({method,path:action,rel,kind:'form'});
    }
    const submitterRe=/<(?:button|input)\b[^>]*formaction\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while((match=submitterRe.exec(source))){
      const action=dynamicLocalTarget(match[1]);
      if(action)checks.push({method:'POST',path:action,rel,kind:'formaction'});
    }
    const hrefRe=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while((match=hrefRe.exec(source))){
      const href=dynamicLocalTarget(match[1]);
      if(href)checks.push({method:'GET',path:href,rel,kind:'href'});
    }
    const redirectRe=/res\.redirect\(\s*(?:\d{3}\s*,\s*)?(['"`])([\s\S]*?)\1/g;
    while((match=redirectRe.exec(source))){
      const target=dynamicLocalTarget(match[2]);
      if(target)checks.push({method:'GET',path:target,rel,kind:'redirect'});
    }
  }
  const missing=checks.filter(check=>!routes.some(route=>(route.method===check.method||route.method==='ALL')&&sameShape(check.path,route.path)));
  if(missing.length){
    console.error('Visible same-origin workflow targets without a mounted route:');
    for(const item of missing)console.error(` - ${item.method} ${item.path} (${item.kind} in ${item.rel})`);
  }
  assert.equal(missing.length,0,'Every visible same-origin workflow target, including dynamic customer actions, must have a mounted route');
  console.log(`visible workflow targets smoke: ok (${checks.length} static/dynamic targets checked)`);
}

main()
  .catch(error=>{console.error(error);process.exitCode=1;})
  .finally(async()=>{if(process.env.DATABASE_URL)await getPool().end().catch(()=>{});});
