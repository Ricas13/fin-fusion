'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const planComponents=require('../access/plan-components');
const {esc}=require('./admin-html');

const LEASE_PAGE_SIZE=25;

function pageNumber(value){const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>0?n:1;}
function date(value){if(!value)return'Never';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB');}
function pill(label,kind=''){return `<span class="pill ${kind}">${esc(label)}</span>`;}
function networkLabel(value){const raw=String(value||'').trim();if(raw.startsWith('ipv4:'))return raw.slice(5);if(raw.startsWith('ipv6:'))return raw.slice(5);return raw||'Unknown network';}
function leaseState(row){const expiry=new Date(row.expires_at).getTime(),remaining=expiry-Date.now();if(!Number.isFinite(expiry)||remaining<=0)return{label:'Expired',kind:'warn'};if(remaining<=60*60*1000)return{label:'Expiring soon',kind:'warn'};return{label:'Active',kind:'good'};}
function leaseKey(body={}){
  const subjectKey=String(body.subjectKey||'').trim(),networkHash=String(body.networkHash||'').trim().toLowerCase();
  if(!subjectKey||subjectKey.length>200)throw new Error('Invalid Stremio lease subject.');
  if(!/^[a-f0-9]{64}$/.test(networkHash))throw new Error('Invalid Stremio lease network.');
  return{subjectKey,networkHash};
}

async function list(page=1,pageSize=LEASE_PAGE_SIZE){
  const requested=pageNumber(page),size=Math.max(10,Math.min(100,Number(pageSize)||LEASE_PAGE_SIZE));
  const totalResult=await query(`SELECT COUNT(*)::int n FROM access_network_leases WHERE tenant_key='default' AND scope='stremio' AND expires_at>NOW()`),total=Number(totalResult.rows[0]?.n||0),pages=Math.max(1,Math.ceil(total/size)),current=Math.min(requested,pages),offset=(current-1)*size;
  const result=await query(`SELECT l.subject_key,l.customer_id,l.network_hash,l.network_family,l.network_descriptor,l.first_seen_at,l.last_seen_at,l.expires_at,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.email customer_email,
      s.id subscription_id,s.plan_id,p.name plan_name,p.code plan_code
    FROM access_network_leases l
    LEFT JOIN customers c ON c.id=l.customer_id
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN subscriptions s ON s.id::text=l.subject_key
    LEFT JOIN plans p ON p.id=s.plan_id
    WHERE l.tenant_key='default' AND l.scope='stremio' AND l.expires_at>NOW()
    ORDER BY l.expires_at ASC,l.last_seen_at DESC,l.first_seen_at DESC
    LIMIT $1 OFFSET $2`,[size,offset]);
  return{rows:result.rows,total,pages,page:current,pageSize:size};
}

function actionForm(req,row,action,label,buttonClass){
  return `<form method="post" action="/admin/servers/stremio/leases/${action}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="subjectKey" value="${esc(row.subject_key)}"><input type="hidden" name="networkHash" value="${esc(row.network_hash)}"><button class="button ${buttonClass} btn-sm" type="submit">${esc(label)}</button></form>`;
}

function section(req,leases){
  const rows=leases.rows||[],previous=leases.page>1?leases.page-1:null,next=leases.page<leases.pages?leases.page+1:null;
  const table=rows.length?`<div class="capabilityTableWrap"><table class="capabilityTable"><thead><tr><th>Customer</th><th>Plan</th><th>Household network</th><th>First seen</th><th>Last seen</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(row=>{const state=leaseState(row),actions=[actionForm(req,row,'renew','Renew','secondary'),actionForm(req,row,'release','Release','danger'),row.customer_id?`<a class="button secondary btn-sm" href="/admin/users/${esc(row.customer_id)}">Open customer</a>`:''].filter(Boolean).join('');return `<tr><td class="sourceIdentity"><strong>${esc(row.customer_name||'Customer')}</strong><small>${esc(row.customer_email||'')}</small></td><td><strong>${esc(row.plan_name||'Unmatched subscription')}</strong>${row.plan_code?`<div class="subText">${esc(row.plan_code)}</div>`:''}</td><td><strong>${esc(networkLabel(row.network_descriptor))}</strong><div class="subText">${esc(row.network_family||'network')}</div></td><td>${esc(date(row.first_seen_at))}</td><td>${esc(date(row.last_seen_at))}</td><td>${esc(date(row.expires_at))}</td><td>${pill(state.label,state.kind)}</td><td class="rowActions">${actions}</td></tr>`;}).join('')}</tbody></table></div>`:'<div class="capabilityEmpty">No active Stremio household IP leases.</div>';
  return `<section class="capabilitySection" id="leases"><div class="capabilitySectionHead"><div class="capabilitySectionTitle"><h2>Household IP leases</h2><p>Active household connections currently consuming Stremio plan slots. Renew extends only this lease using the subscriber's effective plan timing; Release frees only this connection.</p></div><span class="pill">${leases.total.toLocaleString('en-GB')} active lease${leases.total===1?'':'s'}</span></div>${table}<div class="capabilityPagination"><span>Page ${leases.page} of ${leases.pages}</span><div class="capabilityPaginationActions">${previous?`<a class="button secondary btn-sm" href="/admin/servers/stremio?leasePage=${previous}#leases">Previous</a>`:''}${next?`<a class="button secondary btn-sm" href="/admin/servers/stremio?leasePage=${next}#leases">Next</a>`:''}</div></div></section>`;
}

async function lockTarget(client,subjectKey,networkHash){
  const result=await client.query(`SELECT l.subject_key,l.customer_id,l.network_hash,l.network_family,l.network_descriptor,l.first_seen_at,l.last_seen_at,l.expires_at,
      s.id subscription_id,s.plan_id,COALESCE(l.customer_id,s.customer_id) effective_customer_id,
      p.stremio_household_lease_minutes,
      COALESCE(s.stremio_household_network_limit_snapshot,p.stremio_household_network_limit) stremio_household_network_limit,
      COALESCE(s.stremio_ip_replacement_policy_snapshot,p.stremio_ip_replacement_policy) stremio_ip_replacement_policy,
      COALESCE(s.stremio_ip_replacement_cooldown_minutes_snapshot,p.stremio_ip_replacement_cooldown_minutes) stremio_ip_replacement_cooldown_minutes
    FROM access_network_leases l
    LEFT JOIN subscriptions s ON s.id::text=l.subject_key
    LEFT JOIN plans p ON p.id=s.plan_id
    WHERE l.tenant_key='default' AND l.scope='stremio' AND l.subject_key=$1 AND l.network_hash=$2
    FOR UPDATE OF l`,[subjectKey,networkHash]);
  if(!result.rowCount)throw new Error('Stremio household lease no longer exists.');
  return result.rows[0];
}

async function writeAudit(client,req,action,row,metadata={}){
  const entityId=row.subscription_id||crypto.randomUUID();
  await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,[
    req.session?.authUserId||null,action,row.subscription_id?'subscription':'stremio_household_lease',entityId,
    JSON.stringify({subjectKey:row.subject_key,customerId:row.effective_customer_id||row.customer_id||null,networkFamily:row.network_family||null,networkDescriptor:row.network_descriptor||null,...metadata})
  ]);
}

async function renew(req){
  const key=leaseKey(req.body);
  return transaction(async client=>{
    const row=await lockTarget(client,key.subjectKey,key.networkHash);
    if(!row.subscription_id||!row.plan_id)throw new Error('This lease is not attached to a current Stremio subscription and cannot be renewed.');
    const config=planComponents.stremioHouseholdConfig(row),leaseMinutes=Number(config.leaseMinutes);
    const updated=await client.query(`UPDATE access_network_leases SET expires_at=NOW()+($3::int*INTERVAL '1 minute') WHERE tenant_key='default' AND scope='stremio' AND subject_key=$1 AND network_hash=$2 RETURNING expires_at`,[key.subjectKey,key.networkHash,leaseMinutes]);
    await writeAudit(client,req,'admin.stremio.lease.renew',row,{leaseMinutes,previousExpiresAt:row.expires_at,newExpiresAt:updated.rows[0]?.expires_at||null});
    return{leaseMinutes,expiresAt:updated.rows[0]?.expires_at||null};
  });
}

async function release(req){
  const key=leaseKey(req.body);
  return transaction(async client=>{
    const row=await lockTarget(client,key.subjectKey,key.networkHash);
    await client.query(`UPDATE access_network_leases SET expires_at=NOW() WHERE tenant_key='default' AND scope='stremio' AND subject_key=$1 AND network_hash=$2`,[key.subjectKey,key.networkHash]);
    await writeAudit(client,req,'admin.stremio.lease.release',row,{previousExpiresAt:row.expires_at});
    return true;
  });
}

function mount(router,mutationLimit){
  router.post('/admin/servers/stremio/leases/renew',mutationLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const result=await renew(req);return res.redirect(`/admin/servers/stremio?message=${encodeURIComponent(`Household IP lease renewed for ${result.leaseMinutes} minutes.`)}#leases`);}catch(error){return res.redirect(`/admin/servers/stremio?error=${encodeURIComponent(error.message||'Household IP lease could not be renewed.')}#leases`);}});
  router.post('/admin/servers/stremio/leases/release',mutationLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await release(req);return res.redirect(`/admin/servers/stremio?message=${encodeURIComponent('Household IP lease released. The connection slot is available immediately.')}#leases`);}catch(error){return res.redirect(`/admin/servers/stremio?error=${encodeURIComponent(error.message||'Household IP lease could not be released.')}#leases`);}});
  return router;
}

module.exports={LEASE_PAGE_SIZE,pageNumber,list,section,leaseKey,lockTarget,renew,release,mount};
