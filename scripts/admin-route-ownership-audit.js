'use strict';

// Runtime composition audit: exact method/path duplicates are almost always a
// shadow implementation when every router is mounted at the application root.
// A route that mounts first wins, leaving later code/tests misleadingly alive.

process.env.SESSION_SECRET=process.env.SESSION_SECRET||'route-ownership-audit-session-secret-2026-long-value';
process.env.NODE_ENV=process.env.NODE_ENV||'test';
const {createApplication}=require('../src/application');

function rowsForPath(path){return Array.isArray(path)?path:[path];}
function collect(stack,out=[],trail=[]){
  for(const layer of stack||[]){
    if(layer.route){
      for(const routePath of rowsForPath(layer.route.path)){
        for(const [method,enabled] of Object.entries(layer.route.methods||{})){
          if(enabled)out.push({method:method.toUpperCase(),path:String(routePath),trail:[...trail,layer.name||'<route>'].join(' > ')});
        }
      }
    }
    if(layer.handle?.stack)collect(layer.handle.stack,out,[...trail,layer.name||'<router>']);
  }
  return out;
}

function main(){
  const app=createApplication(),stack=app._router?.stack||app.router?.stack||[];
  const routes=collect(stack).filter(row=>row.path.startsWith('/admin'));
  const byKey=new Map();
  for(const row of routes){const key=`${row.method} ${row.path}`;if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(row);}
  const duplicates=[...byKey.entries()].filter(([,owners])=>owners.length>1);
  if(duplicates.length){
    console.error(`admin route ownership: ${duplicates.length} duplicate method/path route(s) found`);
    for(const [key,owners] of duplicates){console.error(`\n${key}`);owners.forEach((owner,index)=>console.error(`  ${index+1}. ${owner.trail}`));}
    process.exit(1);
  }
  console.log(`admin route ownership: ok (${routes.length} mounted admin method/path routes, no exact duplicates)`);
  process.exit(0);
}

try{main();}catch(error){console.error(error.stack||error);process.exit(1);}
