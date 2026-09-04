'use strict';

const {query}=require('../db');
const planServers=require('./plan-servers');
const placement=require('./placement');
const userCapacity=require('./user-capacity');

function accessKind(plan){
  if(String(plan?.billing_interval||'')==='trial')return'trial';
  return Number(plan?.price_minor||0)===0?'free':'paid';
}

async function preview(planId,count=10){
  const plan=(await query('SELECT * FROM plans WHERE id=$1',[planId])).rows[0];
  if(!plan)throw new Error('Plan not found.');
  const kind=accessKind(plan);
  const eligible=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true}))
    .filter(server=>Boolean(server.allow_new_users))
    .filter(server=>kind==='trial'?Boolean(server.trial_enabled):kind==='paid'?Boolean(server.paid_enabled):true);
  const ids=eligible.map(server=>server.id);
  const requested=Math.max(1,Math.min(1000,Number.parseInt(count,10)||10));
  if(!ids.length)return{plan,requested,servers:[],unplaced:requested};

  const canonical=await userCapacity.decorateServers(eligible);
  const playback=await query(`
    SELECT server_id,COUNT(DISTINCT jellyfin_session_id)::int AS active_streams
    FROM active_playback_sessions
    WHERE server_id=ANY($1::uuid[])
    GROUP BY server_id
  `,[ids]);
  const streams=new Map(playback.rows.map(row=>[String(row.server_id),Number(row.active_streams||0)]));
  const candidates=canonical.map(server=>({...server,active_streams:streams.get(String(server.id))||0}));
  const originalUsers=new Map(candidates.map(server=>[String(server.id),Number(server.assigned_users||0)]));
  const assigned=new Map(candidates.map(server=>[String(server.id),0]));
  let unplaced=0;
  for(let i=0;i<requested;i+=1){
    const chosen=placement.selectServer(candidates,plan.placement_strategy);
    if(!chosen){unplaced=requested-i;break;}
    assigned.set(String(chosen.id),(assigned.get(String(chosen.id))||0)+1);
    chosen.assigned_users=Number(chosen.assigned_users||0)+1;
    chosen.capacity_users=chosen.assigned_users;
  }
  return{
    plan,requested,unplaced,
    servers:candidates.map(server=>({
      id:server.id,name:server.name,health:server.health_status,placementMode:server.placement_mode,
      existingUsers:originalUsers.get(String(server.id))||0,
      simulatedNewUsers:assigned.get(String(server.id))||0,
      maxUsers:server.max_users,strategy:plan.placement_strategy
    }))
  };
}

module.exports={preview};
