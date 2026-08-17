from pathlib import Path


def replace_once(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'missing pattern in {path}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1))

# 092: admin cleanup protection + up to four marketing features per plan.
Path('db/migrations/092_admin_customer_protection_and_plan_marketing.sql').write_text("""BEGIN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS marketing_features TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_marketing_features_max_four;
ALTER TABLE plans ADD CONSTRAINT plans_marketing_features_max_four CHECK (COALESCE(cardinality(marketing_features),0) <= 4);
COMMIT;
""")

# Storefront: remove active reseller surface, use admin-configured plan features, simplify Free copy.
p='src/platform/storefront.js'; s=Path(p).read_text()
s=s.replace("const monthly=require('../resellers/monthly');\n",'')
start=s.find('async function resellerInventory(')
if start!=-1:
    end=s.find('\nfunction serviceType(',start)
    s=s[:start]+s[end+1:]
start=s.find('function resellerAvailability(')
if start!=-1:
    end=s.find('\nfunction planFeatures(',start)
    s=s[:start]+s[end+1:]
old="function planFeatures(plan){const kind=serviceType(plan),features=[`${Number(plan.streams||1)} concurrent stream${Number(plan.streams||1)===1?'':'s'}`];if(['jellyfin','bundle'].includes(kind)){features.push(plan.allow_downloads?'Downloads enabled':'Streaming only');features.push(plan.allow_video_transcoding?'Video transcoding enabled':'Direct-play focused');if(plan.library_access_mode&&plan.library_access_mode!=='all')features.push('Custom library access');}if(['stremio','bundle'].includes(kind))features.push('Stremio access');return features;}"
new="function planFeatures(plan){const configured=Array.isArray(plan.marketing_features)?plan.marketing_features.map(v=>String(v||'').trim()).filter(Boolean).slice(0,4):[];if(configured.length)return configured;const kind=serviceType(plan),features=[`${Number(plan.streams||1)} concurrent stream${Number(plan.streams||1)===1?'':'s'}`];if(['jellyfin','bundle'].includes(kind)){features.push(plan.allow_downloads?'Downloads enabled':'Streaming only');features.push(plan.allow_video_transcoding?'Video transcoding enabled':'Direct-play focused');if(plan.library_access_mode&&plan.library_access_mode!=='all')features.push('Custom library access');}if(['stremio','bundle'].includes(kind))features.push('Stremio access');return features.slice(0,4);}"
if old not in s: raise SystemExit('storefront planFeatures pattern missing')
s=s.replace(old,new,1)
s=s.replace('<div class="freeTierKicker">Permanent free tier</div>','<div class="freeTierKicker">Free access</div>')
start=s.find('function resellerSection(')
if start!=-1:
    end=s.find('\nfunction heroVisual(',start)
    s=s[:start]+s[end+1:]
s=s.replace("function renderStorefront({site,plans,store,registrationOpen,logged,resellerTiers=[],support={},currency='GBP',currencies=['GBP']})", "function renderStorefront({site,plans,store,registrationOpen,logged,support={},currency='GBP',currencies=['GBP']})")
s=s.replace("${resellerTiers.length?'<a href=\"#resellers\">Resellers</a>':''}",'')
s=s.replace("${resellerSection(resellerTiers,supportEmail)}",'')
Path(p).write_text(s)

# Plan overview: editable marketing features; remove stale reseller/Permanent-facing language.
p='src/platform/admin-plans.js'; s=Path(p).read_text()
old="return{name,description,audience:plan.audience,billing,duration:n(body.durationDays,1,3650,30),serverClass:['premium','free','custom'].includes(body.serverClass)?body.serverClass:'premium',visible:plan.is_free_tier?true:b(body.visible),active:plan.is_free_tier?true:b(body.active),sort:plan.is_free_tier?0:n(body.sortOrder,0,10000,100)};"
new="const features=[body.feature1,body.feature2,body.feature3,body.feature4].map(v=>t(v,90)).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,4);return{name,description,audience:plan.audience,billing,duration:n(body.durationDays,1,3650,30),serverClass:['premium','free','custom'].includes(body.serverClass)?body.serverClass:'premium',visible:plan.is_free_tier?true:b(body.visible),active:plan.is_free_tier?true:b(body.active),sort:plan.is_free_tier?0:n(body.sortOrder,0,10000,100),features};"
if old not in s: raise SystemExit('plan overview input pattern missing')
s=s.replace(old,new,1)
s=s.replace('The permanent Free Access plan cannot be converted into a trial.','The Free Access plan cannot be converted into a trial.')
s=s.replace('<strong>Permanent Free Access</strong>','<strong>Free Access</strong>')
s=s.replace("subtitle:free?'Permanent Free Access · product and policy':'Customer plan overview and impact'", "subtitle:free?'Free Access · product and policy':'Customer plan overview and impact'")
s=s.replace("<span class=\"pill good\">Permanent free tier</span>","<span class=\"pill good\">Free tier</span>")
s=s.replace('Same policy vocabulary used by Reseller Plans.','Controls the actual Jellyfin permissions applied to customers on this plan.')
s=s.replace('Resellers now use separate monthly Reseller Plans with their own Jellyfin policy and managed-user allowance.','This is a direct customer plan. Configure what customers see and receive here.')
s=s.replace("The permanent Free Access plan cannot be archived.","The Free Access plan cannot be archived.")
s=s.replace("The permanent Free Access plan cannot be disabled or archived.","The Free Access plan cannot be disabled or archived.")
# Insert marketing feature fields after description.
needle='<div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(plan.description||\'\')}</textarea></div>'
feature="""<div class=\"formGroup\"><label>Description</label><textarea class=\"input\" name=\"description\" maxlength=\"500\">${esc(plan.description||'')}</textarea></div><div class=\"formGroup\"><label>Homepage features <span class=\"muted\">(up to 4)</span></label><div class=\"inlineHelp\">Use simple customer-facing benefits, e.g. “3 concurrent streams”, “Downloads included”, “Unlimited requests”. Leave all four empty to use automatic plan features.</div><div class=\"formGrid\">${[0,1,2,3].map(i=>`<input class=\"input\" name=\"feature${i+1}\" maxlength=\"90\" value=\"${esc((plan.marketing_features||[])[i]||'')}\" placeholder=\"Feature ${i+1}\">`).join('')}</div></div>"""
if needle not in s: raise SystemExit('plan description pattern missing')
s=s.replace(needle,feature,1)
oldsql="await client.query(`UPDATE plans SET name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,server_class=$7,visible=$8,active=$9,sort_order=$10,updated_at=NOW() WHERE id=$1`,[plan.id,p.name,p.description,p.audience,p.billing,p.duration,p.serverClass,p.visible,p.active,p.sort]);"
newsql="await client.query(`UPDATE plans SET name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,server_class=$7,visible=$8,active=$9,sort_order=$10,marketing_features=$11::text[],updated_at=NOW() WHERE id=$1`,[plan.id,p.name,p.description,p.audience,p.billing,p.duration,p.serverClass,p.visible,p.active,p.sort,p.features]);"
if oldsql not in s: raise SystemExit('plan update SQL pattern missing')
s=s.replace(oldsql,newsql,1)
Path(p).write_text(s)

# Plan list/order language + retire reseller order section.
p='src/platform/admin-plans-list.js'; s=Path(p).read_text().replace('Free Access is permanently pinned above homepage plan cards','Free Access is pinned above homepage plan cards').replace("' <span class=\"planTypeTag\">Free tier · pinned</span>'","' <span class=\"planTypeTag\">Free tier · pinned</span>'")
Path(p).write_text(s)
p='src/platform/admin-plan-order.js'; s=Path(p).read_text()
s=s.replace("const [plans,resellers]=await Promise.all([query(`SELECT id,name,code,service_type,is_free_tier,is_addon,sort_order,active,visible,archived_at FROM plans ORDER BY is_free_tier DESC,sort_order,name`),query(`SELECT id,name,sort_order,active,visible,archived_at FROM reseller_tiers ORDER BY sort_order,name`)]);return{plans:plans.rows,resellers:resellers.rows};", "const plans=await query(`SELECT id,name,code,service_type,is_free_tier,is_addon,sort_order,active,visible,archived_at FROM plans ORDER BY is_free_tier DESC,sort_order,name`);return{plans:plans.rows};")
# remove reseller UI section if clearly delimited
idx=s.find("<section class=\"section\"><div class=\"sectionHead\"><div><h2>Reseller")
if idx!=-1:
    end=s.find('</section>',idx)
    if end!=-1:s=s[:idx]+s[end+10:]
s=s.replace('Permanent Free Access','Free Access')
s=s.replace('Drag the paid plans and Stremio products into the order customers should see.','Drag plans into the order customers should see on the homepage. Free Access stays pinned above them.')
# remove reseller update SQL occurrences conservatively
s=s.replace("for(let i=0;i<resellerIds.length;i++)await client.query('UPDATE reseller_tiers SET sort_order=$2,updated_at=NOW() WHERE id=$1',[resellerIds[i],(i+1)*10]);",'')
s=s.replace("const resellerIds=list(req.body.resellerIds);",'')
Path(p).write_text(s)

# Customer data includes protection fields.
p='src/platform/customer-360.js'; s=Path(p).read_text()
s=s.replace('c.referral_source,c.tags,c.marketing_opt_in,c.note,c.created_at', 'c.referral_source,c.tags,c.marketing_opt_in,c.note,c.automation_protected,c.automation_protected_reason,c.automation_protected_at,c.created_at')
Path(p).write_text(s)

# Customer 360: remove stale reseller link and add explicit admin overrides.
p='src/platform/admin-customer-360.js'; s=Path(p).read_text()
s=s.replace("const resellerLink=detail.customer.reseller_id?`<a class=\"button secondary\" href=\"/admin/reseller-management/${encodeURIComponent(detail.customer.reseller_id)}\">Reseller 360 · ${esc(detail.customer.reseller_username||'account')}</a>`:'';", "const resellerLink='';")
# add routes before return router
marker='  return router;\n}'
insert="""  router.post('/admin/users/:customerId/email/verify',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await transaction(async client=>{const row=await client.query(`SELECT c.user_id,u.email_verified_at FROM customers c JOIN app_users u ON u.id=c.user_id WHERE c.id=$1 FOR UPDATE`,[req.params.customerId]);if(!row.rowCount)throw new Error('Customer not found.');await client.query(`UPDATE app_users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1`,[row.rows[0].user_id]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.email.verify','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({manual:true,wasVerified:Boolean(row.rows[0].email_verified_at)})]);});return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?message=${encodeURIComponent('Email marked as verified by administrator.')}`);}catch(error){return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?error=${encodeURIComponent(error.message)}`);}});
  router.post('/admin/users/:customerId/automation-protection',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const enabled=['1','true','on'].includes(String(req.body.enabled||'').toLowerCase()),reason=String(req.body.reason||'').trim().slice(0,500);await transaction(async client=>{const updated=await client.query(`UPDATE customers SET automation_protected=$2,automation_protected_reason=$3,automation_protected_at=CASE WHEN $2 THEN NOW() ELSE NULL END,automation_protected_by=CASE WHEN $2 THEN $4::uuid ELSE NULL END,updated_at=NOW() WHERE id=$1 RETURNING id`,[req.params.customerId,enabled,enabled?(reason||'Protected by administrator'):null,req.session.authUserId]);if(!updated.rowCount)throw new Error('Customer not found.');await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.automation_protection','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({enabled,reason:enabled?(reason||null):null})]);});return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?message=${encodeURIComponent(enabled?'Customer protected from automatic Jellyfin cleanup.':'Automatic cleanup protection removed.')}`);}catch(error){return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?error=${encodeURIComponent(error.message)}`);}});
  return router;
}"""
if marker not in s: raise SystemExit('admin customer return marker missing')
s=s.replace(marker,insert,1)
Path(p).write_text(s)

# Customer 360 view: obvious verification/protection controls + migration shortcut + stream stop reasons.
p='src/platform/customer-360-view-v2.js'; s=Path(p).read_text()
old="${kv('Email verified',c.email_verified_at?dt(c.email_verified_at):'No')}"
new="${kv('Email verified',c.email_verified_at?`<span class=\"pill good\">Verified</span> ${dt(c.email_verified_at)}`:'<span class=\"pill bad\">Not verified</span>')}"
s=s.replace(old,new)
# overview add admin controls after profile grid
needle="</div>${c.note?`<section class=\"section\"><div class=\"sectionHead\"><h2>Admin note</h2></div><div class=\"formPanel\">${esc(c.note)}</div></section>`:''}"
replacement="""</div><section class=\"section\"><div class=\"sectionHead\"><div><h2>Administrator overrides</h2><div class=\"muted\">Explicit support controls. Every change is audited.</div></div></div><div class=\"profileGrid\"><section class=\"profileCard\"><div class=\"profileCardHead\"><h2>Email verification</h2>${c.email_verified_at?'<span class=\"pill good\">Verified</span>':'<span class=\"pill bad\">Not verified</span>'}</div><div class=\"profileCardBody\"><p class=\"subText\">Use this only when you have independently confirmed the customer owns the email address.</p>${c.email_verified_at?'':`<form method=\"post\" action=\"/admin/users/${encodeURIComponent(c.id)}/email/verify\">${csrfHidden(d.csrfToken||'')}<button class=\"button\">Mark email verified</button></form>`}</div></section><section class=\"profileCard\"><div class=\"profileCardHead\"><h2>Automatic cleanup</h2><span class=\"pill ${c.automation_protected?'good':'bad'}\">${c.automation_protected?'Protected':'Normal rules'}</span></div><div class=\"profileCardBody\"><p class=\"subText\">Protection stops inactivity automation from disabling or deleting this customer's Jellyfin access. Billing and plan dates are unchanged.</p><form method=\"post\" action=\"/admin/users/${encodeURIComponent(c.id)}/automation-protection\">${csrfHidden(d.csrfToken||'')}<label class=\"toggleRow\"><input type=\"checkbox\" name=\"enabled\" ${c.automation_protected?'checked':''}><span><strong>Protect from automatic Jellyfin cleanup</strong><small>${c.automation_protected?esc(c.automation_protected_reason||'Protected by administrator'):'Customer follows normal lifecycle rules'}</small></span></label><input class=\"input\" name=\"reason\" maxlength=\"500\" value=\"${esc(c.automation_protected_reason||'')}\" placeholder=\"Reason (optional)\"><button class=\"button\">Save protection</button></form></div></section></div></section>${c.note?`<section class=\"section\"><div class=\"sectionHead\"><h2>Admin note</h2></div><div class=\"formPanel\">${esc(c.note)}</div></section>`:''}"""
if needle in s:s=s.replace(needle,replacement,1)
# migration shortcut in access section
s=s.replace('<h2>Reconcile access</h2></div><form', '<h2>Reconcile / move access</h2><div class="muted">Reconcile repairs the current assignment. Use controlled migration to choose another eligible Jellyfin server.</div></div><div class="buttonRow"><a class="button secondary" href="/admin/provisioning/migrations">Move to another server</a></div><form',1)
# stream stop table in activity
activity_marker="<section class=\"section\"><div class=\"sectionHead\"><h2>Downloads</h2>"
policy_section="""<section class=\"section\"><div class=\"sectionHead\"><div><h2>Stream-limit decisions</h2><div class=\"muted\">Why CAPTAiNFiN allowed, warned or stopped this customer's playback.</div></div></div>${table(['When','Decision','Streams','Limit','Reason'],(d.policyEvents||[]).slice(0,50).map(e=>tr([td('When',esc(dt(e.created_at))),td('Decision',pill(e.decision,e.decision==='stopped'?'bad':e.decision==='warned'?'warn':'good')),td('Streams',esc(e.stream_count??'—')),td('Limit',esc(e.stream_limit??'—')),td('Reason',`<strong>${esc(e.reason||'No reason recorded')}</strong>`)])))}</section>"""
if activity_marker in s:s=s.replace(activity_marker,policy_section+activity_marker,1)
Path(p).write_text(s)

# Pass csrf into data object used by overview controls.
p='src/platform/admin-customer-360.js'; s=Path(p).read_text()
# common detail call render - inject if simple data assignment appears
s=s.replace("const detail=await customer360.load(req.params.customerId);", "const detail=await customer360.load(req.params.customerId);detail.csrfToken=csrf.token(req);")
Path(p).write_text(s)

# Automatic lifecycle rules must respect explicit admin protection.
p='src/automation/customer-inactivity.js'; s=Path(p).read_text()
s=s.replace("COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,", "COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,")
s=s.replace("const eligible=!row.currently_playing&&!row.already_held&&(noPlaybackEligible||usageEligible);", "const eligible=!row.automation_protected&&!row.currently_playing&&!row.already_held&&(noPlaybackEligible||usageEligible);")
s=s.replace("reasons:eligible?triggers:[row.currently_playing?'currently playing':null,row.already_held?'already held':null,!noPlaybackEligible&&!usageEligible?'usage requirements currently satisfied':null].filter(Boolean)", "reasons:eligible?triggers:[row.automation_protected?'admin protected':null,row.currently_playing?'currently playing':null,row.already_held?'already held':null,!noPlaybackEligible&&!usageEligible?'usage requirements currently satisfied':null].filter(Boolean)")
s=s.replace("js.name server_name,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,", "js.name server_name,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.automation_protected,")
s=s.replace("eligible:!row.currently_playing&&!row.already_held,reasons:[row.currently_playing?'currently playing':null,row.already_held?'cleanup already recorded':null].filter(Boolean)", "eligible:!row.automation_protected&&!row.currently_playing&&!row.already_held,reasons:[row.automation_protected?'admin protected':null,row.currently_playing?'currently playing':null,row.already_held?'cleanup already recorded':null].filter(Boolean)")
Path(p).write_text(s)

# Needs Attention: multi-select + bulk update.
p='src/platform/admin-attention.js'; s=Path(p).read_text()
s=s.replace('<thead><tr><th>Severity</th>', '<thead><tr><th><input type="checkbox" data-attention-select-all aria-label="Select all"></th><th>Severity</th>')
s=s.replace("${items.map(i=>`<tr><td data-label=\"Severity\">", "${items.map(i=>`<tr><td data-label=\"Select\"><input type=\"checkbox\" form=\"attentionBulkForm\" name=\"itemKey\" value=\"${esc(i.key)}\" aria-label=\"Select ${esc(i.title)}\"></td><td data-label=\"Severity\">")
# insert bulk form before table
s=s.replace("${items.length?`<div class=\"tableWrap\">", "${items.length?`<form id=\"attentionBulkForm\" class=\"formPanel attentionBulkBar\" method=\"post\" action=\"/admin/attention/bulk\"><input type=\"hidden\" name=\"_csrf\" value=\"${esc(csrf.token(req))}\"><strong>Bulk edit selected</strong><select class=\"input compact\" name=\"status\"><option value=\"acknowledged\">Acknowledge</option><option value=\"open\">Re-open</option></select><select class=\"input compact\" name=\"assignedTo\"><option value=\"\">Unassigned</option>${admins.rows.map(a=>`<option value=\"${esc(a.id)}\">${esc(a.username)}</option>`).join('')}</select><input class=\"input compact\" name=\"note\" maxlength=\"2000\" placeholder=\"Optional note for all selected\"><button class=\"button secondary\">Apply to selected</button></form><div class=\"tableWrap\">")
s=s.replace('</section>`;return layout', "</section><script>document.addEventListener('change',e=>{if(e.target.matches('[data-attention-select-all]'))document.querySelectorAll('input[form=attentionBulkForm][name=itemKey]').forEach(x=>x.checked=e.target.checked);});</script>`;return layout")
route_marker="function createAdminAttentionRouter(){const r=express.Router();r.use('/admin/attention',gate,noStore);"
route_new=route_marker+"r.post('/admin/attention/bulk',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const keys=[...new Set((Array.isArray(req.body.itemKey)?req.body.itemKey:[req.body.itemKey]).map(String).filter(Boolean))].slice(0,100);if(!keys.length)throw new Error('Select at least one attention item.');for(const key of keys)await attention.setState(key,{status:req.body.status,assignedTo:req.body.assignedTo||null,note:req.body.note||null},req.session.authUserId);return res.redirect('/admin/attention?message='+encodeURIComponent(`${keys.length} item(s) updated.`));}catch(e){return res.redirect('/admin/attention?error='+encodeURIComponent(e.message));}});"
if route_marker not in s:raise SystemExit('attention router pattern missing')
s=s.replace(route_marker,route_new,1)
Path(p).write_text(s)

# Settings: clearer categories and wording.
p='src/platform/admin-original-settings.js'; s=Path(p).read_text()
s=s.replace('Staff/reseller session lifetime','Staff session lifetime')
s=s.replace('General settings','General & branding')
s=s.replace('Integrations','Connected services')
Path(p).write_text(s)

# Visual semantics in shared admin CSS: green checked, red unchecked, blue card hover.
p='public/css/admin-visual-refinement.css'; s=Path(p).read_text()
s += """
/* Product coherence: explicit state and discoverable cards */
.toggleRow{transition:border-color .15s ease,background .15s ease}.toggleRow:has(input[type=checkbox]){border:1px solid rgba(224,108,117,.28);background:rgba(224,108,117,.055)}.toggleRow:has(input[type=checkbox]:checked){border-color:rgba(53,201,135,.42);background:rgba(53,201,135,.09)}.toggleRow:has(input[type=checkbox])::after{content:'OFF';margin-left:auto;color:#e58a92;font-size:10px;font-weight:900;letter-spacing:.08em}.toggleRow:has(input[type=checkbox]:checked)::after{content:'ON';color:#69dda8}.card,.profileCard,.summaryCard,.metric,.formPanel{transition:border-color .15s ease,background-color .15s ease,box-shadow .15s ease}.card:hover,.profileCard:hover,.summaryCard:hover,.metric:hover{border-color:rgba(87,190,230,.42);background-color:rgba(24,42,54,.82);box-shadow:0 0 0 1px rgba(87,190,230,.05)}.attentionBulkBar{display:grid;grid-template-columns:auto minmax(130px,180px) minmax(150px,220px) minmax(220px,1fr) auto;gap:8px;align-items:center;margin-bottom:10px}@media(max-width:850px){.attentionBulkBar{grid-template-columns:1fr 1fr}.attentionBulkBar>strong,.attentionBulkBar>input{grid-column:1/-1}}
"""
Path(p).write_text(s)

# Regression smoke.
Path('scripts/admin-coherence-user-overrides-smoke.js').write_text("""'use strict';
const assert=require('assert'),fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const storefront=read('src/platform/storefront.js'),plans=read('src/platform/admin-plans.js'),customer=read('src/platform/admin-customer-360.js'),view=read('src/platform/customer-360-view-v2.js'),inactivity=read('src/automation/customer-inactivity.js'),attention=read('src/platform/admin-attention.js'),migration=read('db/migrations/092_admin_customer_protection_and_plan_marketing.sql');
assert(!/Managed Jellyfin user plans/.test(storefront),'retired reseller storefront copy remains');
assert(!/resellerSection\(/.test(storefront),'retired reseller storefront section remains active');
assert(/marketing_features/.test(plans)&&/Homepage features/.test(plans),'plan marketing features missing');
assert(/Free access/.test(storefront)&&!/Permanent free tier/.test(storefront),'free tier customer copy must be simple');
assert(/email\/verify/.test(customer),'manual email verification override missing');
assert(/automation-protection/.test(customer)&&/automation_protected/.test(inactivity),'automatic cleanup protection missing');
assert(/Move to another server/.test(view)&&/admin\/provisioning\/migrations/.test(view),'controlled server move shortcut missing');
assert(/Stream-limit decisions/.test(view)&&/e\.reason/.test(view),'stream stop reason missing from Customer 360');
assert(/attention\/bulk/.test(attention)&&/data-attention-select-all/.test(attention),'Needs Attention bulk edit missing');
assert(/marketing_features/.test(migration)&&/automation_protected/.test(migration),'migration missing coherence columns');
console.log('admin coherence user overrides smoke: ok');
""")

# Add smoke to fast check.
p='package.json'; s=Path(p).read_text(); marker='node scripts/free-access-customer-portal-smoke.js &&'
if marker in s and 'admin-coherence-user-overrides-smoke.js' not in s:s=s.replace(marker,marker+' node scripts/admin-coherence-user-overrides-smoke.js &&',1)
Path(p).write_text(s)
