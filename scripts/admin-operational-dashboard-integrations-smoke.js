'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const dashboardSource=read('src/platform/admin-dashboard.js');
const dashboardDataSource=read('src/platform/admin-dashboard-data.js');
const dashboardMainSource=read('src/platform/admin-dashboard-main.js');
const controlCenterSource=read('src/platform/admin-dashboard-control-center.js');
const freeBackfillSource=read('src/automation/free-capacity-backfill.js');
const dashboardPageSource=read('src/platform/admin-dashboard-page.js');
const billingControlSource=read('src/payments/billing-control.js');
const dashboardCss=read('public/css/admin-profit-dashboard.css');
const liveStreamSource=read('src/platform/admin-dashboard-live-streams.js');
const liveStreamClient=read('public/js/admin-dashboard-live-streams.js');
const liveStreamCss=read('public/css/admin-dashboard-live-streams.css');
const routeComposition=read('src/platform/admin-route-composition.js');
const paymentSource=read('src/platform/admin-payment-settings.js');
const emailSource=read('src/platform/admin-email.js');
const cardSource=read('src/platform/admin-integration-card.js');
const cardCss=read('public/css/admin-integration-cards.css');
const personalNotificationsSource=read('src/platform/admin-personal-notification-preferences-v2.js');
const formFeedbackSource=read('public/js/admin-form-feedback.js');
const dashboard=require('../src/platform/admin-dashboard');
const controlCenter=require('../src/platform/admin-dashboard-control-center');
const liveStreams=require('../src/platform/admin-dashboard-live-streams');
const cards=require('../src/platform/admin-integration-card');

assert(dashboardDataSource.includes('attention.list().catch(() => [])'),'Legacy dashboardData compatibility must keep the canonical Needs Attention source instead of recreating operational queries');
assert(!dashboardDataSource.includes('attention.openSummary().catch'),'Dashboard must not query the same attention source once for summary and again for detail');
assert(dashboardDataSource.includes('items: sources.slice(0, 5)'),'Dashboard must cap attention detail while preserving the total count');
assert(dashboardSource.includes('dashboardAnalyticsDisclosure')&&dashboardSource.includes('${dashboardHero(ctx)}${controlCenter.renderControlCenter(control)}${renderLiveStreamsPanel(req)}${analytics}'),'Operational control-centre state and live streams must remain above progressively disclosed historical analytics');
assert(!dashboardSource.includes('function attentionOverview')&&!dashboardSource.includes('setupCompact'),'Home must not reintroduce separate Needs Attention or setup tiles outside the target hero + live streams + three-widget layout');
assert(!dashboardSource.includes('function operationalAlerts'),'Legacy duplicate operational alert counters must not remain as a second dashboard exception model');
assert(!dashboardMainSource.includes("require('./admin-dashboard-data')")&&!dashboardMainSource.includes('dashboardData(range,reporting)'),'Live /admin must not execute the retired full legacy dashboard analytics stack beside the current growth/server analytics');
assert(dashboardMainSource.includes("showFinancialWarning:false")&&dashboardSource.includes("${financialWarningBanner(ctx)}${dashboardHero(ctx)}"),'Financial integrity warnings must stay above the headline cards instead of being hidden inside collapsed analytics');
assert(dashboardPageSource.includes('showFinancialWarning = options?.showFinancialWarning !== false')&&dashboardPageSource.includes('financialWarningBanner'),'Shared widget dashboards must preserve financial warnings by default while allowing Home to place them outside its disclosure');
assert(dashboardMainSource.includes("SELECT EXISTS(SELECT 1 FROM plans) AS has_plans"),'Home setup action must use a minimal prerequisite read instead of loading full setup-readiness diagnostics');
assert(!dashboardSource.includes('Needs attention'),'Home must rely on the persistent Alerts header instead of duplicating Needs Attention as another hero card');
assert(dashboardSource.includes("require('./admin-dashboard-control-center')")&&dashboardSource.includes('controlCenter.controlCenterData()'),'Dashboard must aggregate the control-centre snapshot through the dedicated read-only module');
assert(dashboardSource.includes('${dashboardHero(ctx)}${controlCenter.renderControlCenter(control)}${renderLiveStreamsPanel(req)}'),'Operational control-centre state must sit between the headline hero and live playback, before historical analytics');
assert(controlCenterSource.includes("require('../automation/job-health')")&&controlCenterSource.includes("require('../automation/free-places-digest')")&&controlCenterSource.includes("require('../entitlements/plan-capacity')"),'Control centre must reuse canonical automation, Free digest and capacity authorities');
assert(controlCenterSource.includes("require('./operations-settings')")&&controlCenterSource.includes('publicBaseUrlConfigured'),'Free advert status must mirror the digest worker public-base-URL prerequisite without making an external request');
assert(controlCenterSource.includes("require('../payments/subscription-discovery')")&&controlCenterSource.includes("s.billing_mode='subscription'")&&controlCenterSource.includes("NULLIF(BTRIM(processing_error),'') IS NOT NULL"),'Billing integrity must reuse canonical provider-link coverage and count all recurring sync/event exceptions without dashboard row limits');
assert(!controlCenterSource.includes("require('../payments/billing-control')")&&!controlCenterSource.includes('billing.dashboardData()'),'Billing integrity must not derive global health from the Billing page\'s intentionally limited 500-subscription / 50-event display rows');
assert(billingControlSource.includes("ORDER BY CASE WHEN s.billing_mode='subscription'")&&billingControlSource.includes("ORDER BY CASE WHEN processed_at IS NULL"),'Bounded Billing reference lists must prioritise unresolved subscription/event problems before recent healthy history');
assert(controlCenterSource.includes("actor_user_id IS NULL")&&controlCenterSource.includes("'customer.inactivity.remove_jellyfin'"),'Recent automation feed must prefer durable automated outcomes rather than admin click history');
assert(controlCenterSource.includes('freeBackfill.pendingClaimCandidates(500, { planId: plan.id })')&&controlCenterSource.includes('freeBackfill.waitingCandidates(500, { planId: plan.id })'),'Free Server waiting count must include both backlog types while staying scoped to the same canonical Free plan as capacity');
assert(freeBackfillSource.includes('pendingClaimCandidates(limit = 100, options = {})')&&freeBackfillSource.includes('waitingCandidates(limit = 100, options = {})')&&freeBackfillSource.includes('const planId = options?.planId || null'),'Backfill candidate readers must support optional plan scoping while tolerating legacy unscoped/null-style callers');
assert(freeBackfillSource.includes("const planFilter = planId ? 'AND r.plan_id=$2::uuid' : ''")&&freeBackfillSource.includes("const planFilter = planId ? 'AND p.id=$2::uuid' : ''"),'Free backlog plan scoping must be enforced in SQL rather than filtered after a capped read');
assert(freeBackfillSource.includes("planId ? [bounded, planId] : [bounded]"),'Unscoped automation reads must preserve the original one-parameter SQL shape instead of adding an OR-null planner branch');
assert(controlCenter.RECENT_JOB_KEYS.has('free_capacity_backfill')&&!controlCenter.RECENT_JOB_KEYS.has('health')&&!controlCenter.RECENT_JOB_KEYS.has('free_places_digest'),'Recent automation feed must keep meaningful customer-impacting work and exclude high-frequency heartbeat/digest noise');
assert(!controlCenterSource.includes('UPDATE ')&&!controlCenterSource.includes('DELETE FROM')&&!controlCenterSource.includes('INSERT INTO'),'Dashboard control-centre module must remain read-only');
assert(dashboardCss.includes('.dashboardControlCenter')&&dashboardCss.includes('.dashboardAutomationFeed'),'Dashboard control-centre presentation must use the compact shared dashboard stylesheet');

const criticalSnapshot=controlCenter.automationSnapshot([{job_key:'health',enabled:true,interval_seconds:300,last_completed_at:new Date().toISOString(),last_success_at:new Date().toISOString(),last_outcome:'success'}]);
assert(criticalSnapshot.total>1&&criticalSnapshot.healthy===1&&criticalSnapshot.warningCount===criticalSnapshot.total-1,'Missing critical automation jobs must be visible as dashboard warnings rather than silently treated as healthy');
const advertCfg={discordFreePlacesDigestEnabled:true,discordConfigured:true,discordFreePlacesChannelId:'123456789012345678',discordFreePlacesTimezone:'Europe/London',discordFreePlacesTime1:'12:00',discordFreePlacesTime2:'00:00'};
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T12:00'},new Date('2026-09-18T15:00:00+01:00')).includes('00:00 tomorrow'),'Free availability card must expose the next configured batched advert slot');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:true}).includes('Due now'),'A publishable buffered increase must show the current unprocessed advert slot as due');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:false}).includes('00:00 tomorrow'),'An unprocessed scheduler slot with no buffered increase must not masquerade as an advert');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:null},new Date('2026-09-18T15:00:00+01:00'),{pending:true}).includes('00:00 tomorrow'),'A fresh or legacy digest baseline must not falsely claim the current slot is due for an advert');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:true}).includes('00:00 tomorrow'),'A stored digest with no channel identity must be treated as stale because the worker will reset it');
assert(controlCenter.nextAdvertLabel({...advertCfg,discordFreePlacesChannelId:'999999999999999999'},{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:true}).includes('00:00 tomorrow'),'Changing the advert channel must invalidate the old slot baseline rather than advertising immediately');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'987654321098765432',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:true,publicBaseUrlConfigured:false})==='Public URL not configured','Dashboard Free advert readiness must mirror the worker public-base-URL prerequisite');
assert(controlCenter.nextAdvertLabel(advertCfg,{channelId:'123456789012345678',messageId:'',lastAdvertSlot:'2026-09-18T00:00'},new Date('2026-09-18T15:00:00+01:00'),{pending:true}).includes('00:00 tomorrow'),'A missing persistent Discord status message must force baseline recovery instead of claiming an advert is due');
const controlHtml=controlCenter.renderControlCenter({
  free:{configured:true,available:7,used:13,limit:20,waiting:2,waitingCapped:false,bufferedPlaces:3,nextAdvert:'00:00 tomorrow · Europe/London',inactivityEnabled:true,inactivityDryRun:false,inactivityState:'healthy',inactivityLastCompletedAt:new Date().toISOString()},
  commerce:{needsReview:true,missing:1,syncProblems:0,pastDue:0,providerEventErrors:0},
  recent:[{kind:'good',label:'Free Jellyfin account removed',detail:'FREE · inactivity policy',at:new Date().toISOString(),href:'/admin/users/example'}]
});
for(const token of ['Free Server','Billing integrity','What Fin Fusion just did','Buffered advert','Missing link'])assert(controlHtml.includes(token),`Dashboard control centre missing ${token}`);
assert(!controlHtml.includes('<form'),'Dashboard control centre must remain summary/navigation only; mutations stay on their owning pages');
const pausedFreeHtml=controlCenter.renderControlCenter({
  free:{configured:true,available:2,used:8,reserved:1,limit:11,waiting:800,waitingCapped:true,bufferedPlaces:0,nextAdvert:'Advertising disabled',inactivityEnabled:false,inactivityDryRun:false,inactivityState:'disabled',inactivityLastCompletedAt:null},
  commerce:{needsReview:false,missing:0,syncProblems:0,pastDue:0,providerEventErrors:0},
  recent:[]
});
assert(pausedFreeHtml.includes('dashboardControlCard neutral')&&pausedFreeHtml.includes('Inactivity:</strong> Paused'),'Intentionally paused Free inactivity must be neutral rather than a false warning');
assert(pausedFreeHtml.includes('800+')&&pausedFreeHtml.includes('used / eligible capacity'),'Free waiting lower bounds and capacity labels must stay numerically honest when candidate reads are capped');
const brokenFreeHtml=controlCenter.renderControlCenter({
  free:{configured:true,available:2,used:8,reserved:0,limit:10,waiting:0,waitingCapped:false,bufferedPlaces:0,nextAdvert:'12:00 today · Europe/London',inactivityEnabled:true,inactivityDryRun:false,inactivityState:'disabled',inactivityLastCompletedAt:null},
  commerce:{needsReview:false,missing:0,syncProblems:0,pastDue:0,providerEventErrors:0},
  recent:[]
});
assert(brokenFreeHtml.includes('dashboardControlCard warn')&&brokenFreeHtml.includes('Inactivity:</strong> disabled'),'Enabled Free inactivity with a disabled worker must remain visible as an operational problem');
const failedAction=controlCenter.recentJobActions([{job_key:'billing',enabled:true,last_completed_at:new Date().toISOString(),last_outcome:'failed',last_error:'boom',last_failed_count:1,last_processed_count:99}],5)[0];
assert(failedAction&&failedAction.detail==='1 failed','A failed automation run must not reuse the previous successful run\'s processed count');

const clear=dashboard.dashboardHero({reporting:{currency:'GBP'},data:{profitability:{currency:'GBP',current:{profitMinor:10000},previous:{profitMinor:5000},ytd:{profitMinor:30000}},userGauge:{active:2,capacity:10}}});
assert(clear.includes('Profit this month')&&clear.includes('Profit YTD')&&clear.includes('Customers / capacity')&&clear.includes('Automation'),'Dashboard hero must expose profit, customer capacity and automation health');
assert(clear.includes('2 / 10')&&clear.includes('managed customers / configured user capacity'),'Dashboard hero must show managed users against configured server user capacity');
assert(!clear.includes('Needs attention')&&!clear.includes('/admin/attention'),'Dashboard hero must not duplicate the persistent Alerts/Needs Attention signal');
const problems=dashboard.dashboardHero({reporting:{currency:'GBP'},data:{profitability:{currency:'GBP',current:{profitMinor:-1000},previous:{profitMinor:500},ytd:{profitMinor:2000}},userGauge:{active:4,capacity:8}}});
assert(problems.includes('profitHeroCard--profit bad'),'Negative profit must retain meaningful danger styling in the hero');

const livePanel=liveStreams.renderLiveStreamsPanel({session:{authUserId:'admin-smoke',authRole:'admin',adminId:'admin-smoke'}});
assert(livePanel.includes('data-admin-live-streams')&&livePanel.includes('Now Playing')&&livePanel.includes('/js/admin-dashboard-live-streams.js')&&livePanel.includes('/css/admin-dashboard-live-streams.css'),'Dashboard live streams must use the dedicated asynchronous row surface');
assert(routeComposition.includes('createAdminDashboardLiveStreamsRouter')&&routeComposition.includes('app.use(createAdminDashboardLiveStreamsRouter())'),'Admin live-stream routes must be mounted in the canonical admin composition');
assert(liveStreamSource.includes("'/Sessions?activeWithinSeconds=180'")&&liveStreamSource.includes("COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'"),'Live dashboard must query current managed Jellyfin/Emby sessions while excluding hidden Stremio delivery identities');
for(const endpoint of ['/Playing/Pause','/Playing/Unpause','/Playing/Stop','/Message'])assert(liveStreamSource.includes(endpoint),`Live stream controls must support ${endpoint}`);
assert(liveStreamSource.includes('csrf.verify(req)')&&liveStreamSource.includes("scope:'admin-dashboard-live-streams-control'")&&liveStreamSource.includes("const surfaceLimit=rateLimit(")&&liveStreamSource.includes("'admin.live_stream.stop'")&&liveStreamSource.includes("'admin.live_stream.message'"),'Live stream mutations must be CSRF protected, persistently rate limited, framework-rate-limited and audited');
assert(!liveStreamSource.includes('/primary-image')&&!liveStreamSource.includes('apiKey'),'Dense Infinidysk-style live rows must not add an unnecessary artwork/API-key proxy surface');
assert(liveStreamClient.includes("window.confirm(`Stop ${stream.user}'s playback")&&liveStreamClient.includes("post(stream,'control'")&&liveStreamClient.includes("post(messageTarget,'message'"),'Dashboard rows must provide explicit stop confirmation, pause/resume control and custom per-stream messaging');
assert(liveStreamClient.includes("window.setInterval(refresh,10000)")&&liveStreamClient.includes("document.addEventListener('visibilitychange'") ,'Live rows must refresh automatically without polling while the tab is hidden');
assert(liveStreamClient.includes("function streamRow(stream)")&&liveStreamCss.includes('.adminLiveStreamRow+.adminLiveStreamRow')&&liveStreamCss.includes('.adminLiveStreamProgress')&&!liveStreamCss.includes('grid-template-columns:repeat(3'),'Live stream presentation must use the requested dense full-width Infinidysk-style row list rather than Tracearr poster cards');
assert(liveStreamSource.includes('/Devices?id=')&&liveStreamSource.includes('another active stream is using the same device'),'Manual Stop must revalidate and use the safe same-device-aware logout fallback when a client ignores playback Stop');
const normalized=liveStreams.normalizeLiveSession({id:'server-1',name:'CAPTAiNFiN',media_server_type:'jellyfin'},{customer_id:'customer-1',display_name:'Viewer',email:'viewer@example.invalid'},{Id:'session-1',UserId:'user-1',Client:'Jellyfin Web',DeviceName:'Chrome',RemoteEndPoint:'::ffff:203.0.113.20',SupportsMediaControl:true,PlayState:{PlayMethod:'Transcode',PositionTicks:600000000,IsPaused:false},TranscodingInfo:{Bitrate:12000000,Width:3840,Height:2160,TranscodeReasons:['VideoCodecNotSupported']},NowPlayingItem:{Id:'item-1',Type:'Episode',SeriesName:'Example Show',Name:'Example Episode',ParentIndexNumber:2,IndexNumber:4,RunTimeTicks:36000000000,MediaStreams:[{Type:'Video',Codec:'hevc',Width:3840,Height:2160},{Type:'Audio',Codec:'aac',Channels:6}]}});
assert(normalized.title==='Example Show'&&normalized.subtitle==='S02 E04 · Example Episode'&&normalized.resolution==='4K'&&normalized.method==='Transcode'&&normalized.remoteAddress==='203.0.113.20'&&normalized.videoCodec==='HEVC'&&normalized.audioChannels===6,'Live-session normalization must retain Tracearr-style user/media/quality/network detail without leaking credentials');

assert(cardSource.includes('Enabled')&&cardSource.includes('Configured')&&cardSource.includes('Current state')&&cardSource.includes('Last verified'),'Shared integration cards must answer the standard operator health questions');
assert(cardSource.includes('detailsHtml'),'Shared integration cards must support optional inline configuration without changing existing callers');
const rendered=cards.renderIntegrationCard({name:'Example',statusLabel:'Connected',statusKind:'good',enabled:true,configured:true,workingLabel:'Delivery observed',workingKind:'good',lastVerifiedAt:'2026-08-21T20:00:00Z',fixHint:'Retest the connection.',actionsHtml:'<a href="#manage">Manage</a>',detailsHtml:'<details class="integrationConfig"><summary>Configure</summary></details>'});
assert(rendered.includes('integrationCard')&&rendered.includes('Connected')&&rendered.includes('Delivery observed')&&rendered.includes('Retest the connection.')&&rendered.includes('Manage')&&rendered.includes('integrationConfig'),'Shared integration card renderer must carry status, evidence, recovery guidance, actions and optional inline detail');
assert(cardCss.includes('.integrationCardGrid')&&cardCss.includes('.integrationDetails')&&cardCss.includes('.integrationConfig'),'Shared integration styles must live outside individual page templates');

assert(paymentSource.includes("require('./admin-integration-card')"),'Payments must use the shared integration-card renderer');
for(const provider of ['stripe','paypal','plisio'])assert(paymentSource.includes(`providerHealthCard(req,'${provider}'`),`${provider} must use the same provider health-card path`);
assert(paymentSource.includes("providerEvents=(events||[]).filter(event=>event.provider===provider)"),'Payment working state must be derived from existing provider events');
assert(paymentSource.includes("latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)"),'Payment last verification must use a successfully processed provider event');
assert(paymentSource.includes('Test connection')&&paymentSource.includes('Configure ${esc(label)}'),'Payment cards must provide test and inline configure actions');
assert(paymentSource.includes('payment-provider-config'),'Payment provider configuration details must share an exclusive native details group so only one provider is expanded at a time');
assert(paymentSource.includes('detailsHtml:providerConfigDetails(req,provider,status,url)'),'Provider credentials and callback/webhook setup must render inside the matching health card');
assert(!paymentSource.includes("title:'Stripe, PayPal & Plisio credentials'"),'The duplicate lower combined credentials disclosure must not remain');
assert(!paymentSource.includes('function providerMetric'),'Old provider-specific metric cards must not remain alongside the shared integration cards');

assert(emailSource.includes("require('./admin-integration-card')"),'Email must use the shared integration-card renderer');
assert(emailSource.includes("(recent || []).find(row => row.status === 'sent')"),'Email last verification must use an observed successful delivery');
assert(emailSource.includes('Test connection')&&emailSource.includes('href="#email-gateway">Manage</a>'),'Email card must provide test and manage actions');
assert(emailSource.includes("statusLabel = 'Needs attention'")&&emailSource.includes('failed message'),'Email card must surface queued delivery failures as an operational warning on the dedicated delivery page');

assert(formFeedbackSource.includes("if (form.dataset.nativeSubmit === 'true') return false;"),'Admin AJAX form enhancement must preserve native-submit escape hatches for browser-owned redirects');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/telegram/start" data-native-submit="true"'),'Telegram account linking must use a native browser submission so the t.me redirect is not followed by fetch/CORS');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/discord/start" data-native-submit="true"'),'Discord OAuth linking must use a native browser submission so the discord.com redirect is not followed by fetch/CORS');

console.log('operational dashboard and integration cards smoke: ok');
require('./admin-integrations-inline-management-smoke');