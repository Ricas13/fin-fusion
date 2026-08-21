'use strict';

const express = require('express');
const { layout, esc } = require('./admin-html');
const { setupReadiness } = require('./setup-readiness');
const { health: configurationHealth } = require('./admin-configuration-health');
const runtimeSettings = require('./runtime-settings');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function stateLabel(state) { return String(state || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function stateKind(state) {
    if (['configured', 'enabled', 'available'].includes(state)) return 'good';
    if (state === 'disabled') return '';
    return 'warn';
}
function checklistItem(item) {
    return `<a class="setupStep ${item.configured ? 'complete' : ''}" href="${esc(item.href)}"><span class="setupStepMark" aria-hidden="true">${item.configured ? '✓' : '○'}</span><span class="setupStepBody"><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></span><span class="pill ${item.configured ? 'good' : ''}">${item.configured ? 'Ready' : 'Optional'}</span></a>`;
}
function moduleRow(module) {
    return `<tr><td><strong>${esc(module.name)}</strong></td><td><span class="pill ${stateKind(module.state)}">${esc(stateLabel(module.state))}</span></td><td class="muted">${esc(module.detail || '')}</td></tr>`;
}
function healthRow(issue){return `<tr><td><span class="pill ${issue.severity==='critical'?'bad':issue.severity==='warning'?'warn':''}">${esc(issue.severity)}</span></td><td>${esc(issue.area)}</td><td><strong>${esc(issue.name)}</strong></td><td>${esc(issue.message)}</td><td>${issue.href?`<a class="button secondary btn-sm" href="${esc(issue.href)}">Fix / review</a>`:''}</td></tr>`;}
function suggestedStep(data){
    const priority=['jellyfin','plans','direct-payments','email','automation','storefront','notifications','requests','affiliates'];
    for(const key of priority){const item=data.checklist.find(row=>row.key===key&&!row.configured);if(item)return item;}
    return data.checklist.find(row=>!row.configured)||null;
}
function page(data, health) {
    const critical=health.issues.filter(i=>i.severity==='critical').length,warnings=health.issues.filter(i=>i.severity==='warning').length;
    const next=suggestedStep(data),percent=data.totalCount?Math.round((Number(data.configuredCount||0)/Number(data.totalCount))*100):100;
    const nextCard=next
        ? `<div class="setupNext"><div><span class="eyebrow">Suggested next optional step</span><strong>${esc(next.label)}</strong><small>${esc(next.detail)}</small></div><a class="button" href="${esc(next.href)}">Continue setup</a></div>`
        : `<div class="setupNext complete"><div><span class="eyebrow">Setup status</span><strong>Everything on the checklist is configured</strong><small>You can still change any capability later from its normal admin page.</small></div><span class="pill good">Ready</span></div>`;
    const healthSection=health.issues.length
        ? `<section class="card setupHealth"><div class="card-header"><div><h2 class="card-title">Configuration & dependency health</h2><div class="muted">These are live issues worth reviewing; routine setup choices stay separate below.</div></div><div class="buttonRow"><span class="pill ${critical?'bad':'good'}">${critical} critical</span><span class="pill ${warnings?'warn':''}">${warnings} warning${warnings===1?'':'s'}</span><a class="button secondary" href="/admin/attention">Needs Attention</a></div></div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Severity</th><th>Area</th><th>Object</th><th>Issue / impact</th><th></th></tr></thead><tbody>${health.issues.map(healthRow).join('')}</tbody></table></div></section>`
        : `<div class="statusBanner setupHealthy"><strong>No configuration or live dependency issues detected.</strong> Setup can stay incremental; nothing needs attention right now.</div>`;
    const body = `<section class="setupHero"><div class="setupHeroTop"><div><span class="pill good">GETTING STARTED</span><h2>Configure CAPTAiNFiN at your own pace</h2><p>${esc(data.configuredCount)} of ${esc(data.totalCount)} optional capabilities are configured. The admin portal remains usable while the rest are left off.</p></div><strong class="setupPercent">${esc(percent)}%</strong></div><div class="setupProgress" role="progressbar" aria-label="Optional setup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(percent)}"><span style="width:${esc(percent)}%"></span></div>${nextCard}</section>
        <section class="card setupChecklist"><div class="card-header"><div><h2 class="card-title">Choose what to configure</h2><div class="muted">You do not need to complete every item. Open only the capabilities you plan to use.</div></div></div><div class="card-body setupSteps">${data.checklist.map(checklistItem).join('')}</div></section>
        ${healthSection}
        <details class="card setupAdvanced"><summary><span><strong>Readiness & advanced setup</strong><small>Feature states, portability and clean-install guarantees</small></span><span class="pill">Details</span></summary><div class="setupAdvancedBody">
          <section><div class="sectionHead"><div><h3>Feature readiness</h3><div class="muted">Pages remain safe to open even when their integration is not configured.</div></div></div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Module</th><th>State</th><th>Detail</th></tr></thead><tbody>${data.modules.map(moduleRow).join('')}</tbody></table></div></section>
          <section><div class="sectionHead"><div><h3>Installation portability</h3><div class="muted">Move business configuration without moving users or secrets.</div></div><a class="button secondary" href="/admin/configuration">Configuration transfer</a></div><div class="setupMiniGrid"><div><strong>Safe export</strong><small>Plans, storefront settings, non-secret payment references, notifications, schedules and policy settings are exported in versioned JSON.</small></div><div><strong>Preview before import</strong><small>Imports show create/update counts before confirmation. Secrets, identities and provider credentials are never expected in the file.</small></div></div></section>
          <section><div class="sectionHead"><h3>Clean-install guarantees</h3></div><div class="setupMiniGrid"><div><strong>Zero business objects are valid</strong><small>No server, plan, customer or payment provider is required for the admin UI to run.</small></div><div><strong>Customer-facing features start off</strong><small>Storefront, public registration and referrals are opt-in on a genuinely blank database.</small></div><div><strong>Upgrades preserve existing installs</strong><small>Fresh-install cleanup is migration-marker gated and never applied during an upgrade.</small></div></div></section>
        </div></details>
        <style>.setupHero{padding:20px;margin-bottom:16px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.setupHeroTop{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.setupHero h2{margin:8px 0 6px}.setupHero p{margin:0;color:var(--muted);max-width:760px}.setupPercent{font-size:28px}.setupProgress{height:8px;margin:16px 0;border-radius:999px;background:var(--panel2);overflow:hidden}.setupProgress span{display:block;height:100%;background:var(--accent);border-radius:inherit}.setupNext{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px;border:1px solid var(--border);border-radius:10px;background:var(--panel2)}.setupNext>div{display:grid;gap:3px}.setupNext small,.setupStep small,.setupAdvanced summary small,.setupMiniGrid small{color:var(--muted)}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.setupChecklist,.setupHealth,.setupAdvanced{margin-top:16px}.setupSteps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.setupStep{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px;border:1px solid var(--border);border-radius:9px;background:var(--panel2);color:inherit;text-decoration:none}.setupStep:hover{border-color:var(--accent)}.setupStepBody{display:grid;gap:3px;min-width:0}.setupStepMark{font-weight:800}.setupHealthy{margin-top:16px}.setupAdvanced>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;cursor:pointer;list-style:none}.setupAdvanced>summary::-webkit-details-marker{display:none}.setupAdvanced>summary>span:first-child{display:grid;gap:3px}.setupAdvancedBody{display:grid;gap:20px;padding:0 16px 16px;border-top:1px solid var(--border)}.setupAdvancedBody>section{padding-top:16px}.setupMiniGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.setupMiniGrid>div{display:grid;gap:5px;padding:11px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}@media(max-width:760px){.setupSteps,.setupMiniGrid{grid-template-columns:1fr}.setupHeroTop,.setupNext{flex-direction:column}.setupPercent{font-size:22px}}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'setup', title: 'Setup', subtitle: 'Start with the essentials; everything else stays optional', body });
}

function createAdminSetupRouter() {
    const router = express.Router();
    router.use('/admin/setup', gate, noStore);
    router.get('/admin/setup', async (_req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const [readiness,health]=await Promise.all([setupReadiness(),configurationHealth()]);
            return res.send(page(readiness,health));
        }
        catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminSetupRouter, page, suggestedStep };
