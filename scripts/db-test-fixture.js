'use strict';

const {skipIfNoDatabase}=require('./smoke-db');
const {getPool}=require('../src/db');

async function runDbSmoke(label,fn){
  if(skipIfNoDatabase(label))return;
  try{
    await fn();
    console.log(`${label}: ok`);
  }finally{
    await getPool().end();
  }
}

async function withRollback(fn){
  const client=await getPool().connect();
  await client.query('BEGIN');
  try{
    return await fn(client);
  }finally{
    try{await client.query('ROLLBACK');}finally{client.release();}
  }
}

async function withTimezones(zones,fn){
  const original=process.env.TZ;
  try{
    for(const zone of zones){
      process.env.TZ=zone;
      await fn(zone);
    }
  }finally{
    if(original===undefined)delete process.env.TZ;
    else process.env.TZ=original;
  }
}

module.exports={runDbSmoke,withRollback,withTimezones};
