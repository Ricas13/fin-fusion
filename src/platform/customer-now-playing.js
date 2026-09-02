'use strict';

const express=require('express');
const {query}=require('../db');

function requireCustomer(req,res,next){
  if(req.session?.customerId&&req.session?.customerUserId)return next();
  return res.status(401).json({error:'sign_in_required'});
}

function positionSeconds(value){
  const ticks=Number(value);
  if(!Number.isFinite(ticks)||ticks<0)return null;
  return Math.floor(ticks/10000000);
}

function serviceLabel(value){return String(value||'jellyfin').toLowerCase()==='emby'?'Emby':'Jellyfin';}
function methodLabel(value){
  const method=String(value||'unknown').toLowerCase();
  if(method==='directplay')return'Direct Play';
  if(method==='directstream')return'Direct Stream';
  if(method==='transcode')return'Transcode';
  return'Playing';
}

async function nowPlayingForCustomer(customerId){
  const result=await query(`
    SELECT aps.item_name,aps.item_type,aps.client_name,aps.device_name,
           aps.playback_method,aps.is_paused,aps.position_ticks,aps.first_seen_at,aps.last_seen_at,
           COALESCE(js.media_server_type,'jellyfin') AS media_server_type
    FROM active_playback_sessions aps
    JOIN jellyfin_servers js ON js.id=aps.server_id
    WHERE aps.customer_id=$1
      AND aps.last_seen_at>NOW()-INTERVAL '5 minutes'
    ORDER BY aps.is_paused ASC,aps.first_seen_at ASC
  `,[customerId]);
  return result.rows.map(row=>({
    title:row.item_name||'Playing media',
    type:row.item_type||'Media',
    service:serviceLabel(row.media_server_type),
    client:row.client_name||null,
    device:row.device_name||null,
    method:methodLabel(row.playback_method),
    paused:Boolean(row.is_paused),
    positionSeconds:positionSeconds(row.position_ticks),
    startedAt:row.first_seen_at||null,
    lastSeenAt:row.last_seen_at||null
  }));
}

function createCustomerNowPlayingRouter(){
  const router=express.Router();
  router.get('/account/now-playing.json',requireCustomer,async(req,res,next)=>{
    try{
      res.setHeader('Cache-Control','no-store, private, max-age=0');
      return res.json({streams:await nowPlayingForCustomer(req.session.customerId)});
    }catch(error){return next(error);}
  });
  return router;
}

module.exports={createCustomerNowPlayingRouter,nowPlayingForCustomer,positionSeconds,serviceLabel,methodLabel};
