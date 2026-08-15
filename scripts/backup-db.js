'use strict';

require('dotenv').config();
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');
const {pipeline}=require('stream/promises');
const {createEncryptionContext,requireBackupKey}=require('../src/backup/encrypted-stream');
const {postgresProcessEnv}=require('../src/backup/postgres-env');
const {query,getPool}=require('../src/db');

async function sha256File(file){const hash=crypto.createHash('sha256');await pipeline(fs.createReadStream(file),hash);return hash.digest('hex');}
async function beginRun(){try{return (await query(`INSERT INTO backup_runs(status,backup_type) VALUES('running','database') RETURNING id`)).rows[0]?.id||null;}catch(error){console.warn('Backup history unavailable:',error.message);return null;}}
async function finishRun(id,fields){if(!id)return;try{await query(`UPDATE backup_runs SET status=$2,file_name=$3,file_path=$4,size_bytes=$5,checksum_sha256=$6,completed_at=NOW(),error=$7,metadata=$8::jsonb WHERE id=$1`,[id,fields.status,fields.fileName||null,fields.filePath||null,fields.sizeBytes??null,fields.checksum||null,fields.error||null,JSON.stringify(fields.metadata||{})]);}catch(error){console.warn('Backup history finalization failed:',error.message);}}

async function main(){requireBackupKey();const runId=await beginRun(),outDir=path.resolve(process.env.BACKUP_DIR||'./backups');fs.mkdirSync(outDir,{recursive:true,mode:0o700});const stamp=new Date().toISOString().replace(/[:.]/g,'-'),finalPath=path.join(outDir,`captainfin-${stamp}.pgdump.enc`),tempPath=`${finalPath}.tmp-${process.pid}`,{header,cipher}=createEncryptionContext(),out=fs.createWriteStream(tempPath,{flags:'wx',mode:0o600});out.write(header);const child=spawn(process.env.PG_DUMP_BIN||'pg_dump',['--format=custom','--no-owner','--no-privileges'],{env:postgresProcessEnv(),stdio:['ignore','pipe','pipe']}),childExit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});try{await pipeline(child.stdout,cipher,out,{end:false});const exitCode=await childExit;if(exitCode!==0)throw new Error(`pg_dump failed with exit code ${exitCode}: ${stderr.trim()}`);out.write(cipher.getAuthTag());await new Promise((resolve,reject)=>{out.once('error',reject);out.end(resolve);});fs.renameSync(tempPath,finalPath);const stat=fs.statSync(finalPath),checksum=await sha256File(finalPath);await finishRun(runId,{status:'succeeded',fileName:path.basename(finalPath),filePath:finalPath,sizeBytes:stat.size,checksum,metadata:{format:'pgdump.enc',authenticatedEncryption:true}});console.log(`Encrypted database backup created: ${finalPath}`);console.log(`SHA-256: ${checksum}`);return finalPath;}catch(error){child.kill('SIGTERM');out.destroy();try{fs.unlinkSync(tempPath);}catch(_){}await finishRun(runId,{status:'failed',error:String(error.message||error).slice(0,4000),metadata:{stderr:stderr.slice(-1500)}});throw error;}finally{try{await getPool().end();}catch(_){}}}

main().catch(error=>{console.error(`Backup failed: ${error.message}`);process.exit(1);});
