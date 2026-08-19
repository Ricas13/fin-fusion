'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const migration=read('db/migrations/016_marketing_segment_rules.sql');
const campaigns=read('src/marketing/campaigns.js');
const admin=read('src/platform/admin-marketing.js');
const browser=read('public/js/admin-marketing-scheduling.js');

assert(migration.includes("segment_rules jsonb DEFAULT '{}'::jsonb NOT NULL"),'campaign segment rules must be persisted as non-null jsonb');
assert(migration.includes("jsonb_typeof(segment_rules)='object'"),'segment rules storage must be constrained to an object');
assert(campaigns.includes("const PREVIOUS_SERVICES=new Set(['jellyfin','stremio','bundle'])"),'previous-service rule must use a fixed whitelist');
assert(campaigns.includes('function normalizeRules(input={})'),'segment rule normalization missing');
assert(campaigns.includes('accountAgeDays,0,3650')&&campaigns.includes('lapsedDays,0,3650'),'numeric audience rules must be bounded');
assert(campaigns.includes('params.push(rules.accountAgeDays)')&&campaigns.includes('params.push(rules.previousService)')&&campaigns.includes('params.push(rules.lapsedDays)'),'audience rules must be query parameters');
assert(campaigns.includes("$${params.length}"),'dynamic audience clauses must reference positional parameters rather than interpolate values');
assert(campaigns.includes('query(`SELECT c.id customer_id')&&campaigns.includes('built.params'),'eligible recipient query must execute with the validated parameter array');
assert(campaigns.includes('campaign.segment_rules||{}'),'queue-time recipient snapshot must reuse the campaign rules');
assert(campaigns.includes('segment_rules,created_by_user_id'),'campaign creation must persist normalized rules');
assert(admin.includes("router.get('/admin/marketing/audience-preview'"),'count-only audience preview endpoint missing');
assert(admin.includes('return res.json({ok:true,count:result.count})'),'audience preview endpoint must return count only');
assert(!admin.includes('res.json({ok:true,count:result.count,sample'),'audience preview must not return recipient samples');
for(const name of ['accountAgeDays','lapsedDays','previousService'])assert(admin.includes(`name=\"${name}\"`),`audience builder missing ${name}`);
assert(browser.includes('/admin/marketing/audience-preview?'),'browser audience preview must use the authenticated admin endpoint');
assert(browser.includes('setTimeout(refreshAudience,250)'),'live audience preview must be debounced');

console.log('marketing segment rules smoke: ok');
