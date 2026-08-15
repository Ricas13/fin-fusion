'use strict';

const OPERATIONAL_STALE_SECONDS=120;
const BACKUP_STALE_SECONDS=180;

function thresholdSeconds(workerKey){
    return String(workerKey||'')==='database_backup'?BACKUP_STALE_SECONDS:OPERATIONAL_STALE_SECONDS;
}
function ageSeconds(lastHeartbeatAt,now=Date.now()){
    if(!lastHeartbeatAt)return Infinity;
    const then=new Date(lastHeartbeatAt).getTime();
    return Number.isFinite(then)?Math.max(0,Math.floor((now-then)/1000)):Infinity;
}
function isStale(workerKey,lastHeartbeatAt,now=Date.now()){
    return ageSeconds(lastHeartbeatAt,now)>thresholdSeconds(workerKey);
}
function describe(workerKey,lastHeartbeatAt,now=Date.now()){
    const age=ageSeconds(lastHeartbeatAt,now),threshold=thresholdSeconds(workerKey);
    return{ageSeconds:age,thresholdSeconds:threshold,stale:age>threshold};
}

module.exports={OPERATIONAL_STALE_SECONDS,BACKUP_STALE_SECONDS,thresholdSeconds,ageSeconds,isStale,describe};
