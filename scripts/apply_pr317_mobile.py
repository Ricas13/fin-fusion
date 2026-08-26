from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'patch target not found in {path}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1))

# Billing tables: opt into the shared responsive card-table contract and label
# every value so phone layouts remain understandable when the header is hidden.
replace_once(
    'src/platform/admin-billing.js',
    '''        <td><a href="/admin/users/${esc(row.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(row.email || '')}</div></td>\n        <td><strong>${esc(row.plan_name)}</strong><div class="subText">${esc(money(row))}</div></td>\n        <td>${pill(providerLabel(row.source), row.source === 'stripe' ? 'accent' : '')}<div class="subText">${row.recurring ? 'Recurring' : 'One-time'}</div></td>\n        <td>${statusPill(row.status)}${row.cancel_at_period_end ? `<div class="subText">Ends after current period</div>` : ''}</td>\n        <td>${esc(date(row.current_period_end))}</td><td>${remote}</td><td>${syncState}</td><td class="right">${subscriptionActions(req, row)}</td>''',
    '''        <td data-label="Customer"><a href="/admin/users/${esc(row.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(row.email || '')}</div></td>\n        <td data-label="Plan"><strong>${esc(row.plan_name)}</strong><div class="subText">${esc(money(row))}</div></td>\n        <td data-label="Provider">${pill(providerLabel(row.source), row.source === 'stripe' ? 'accent' : '')}<div class="subText">${row.recurring ? 'Recurring' : 'One-time'}</div></td>\n        <td data-label="Billing state">${statusPill(row.status)}${row.cancel_at_period_end ? `<div class="subText">Ends after current period</div>` : ''}</td>\n        <td data-label="Paid through">${esc(date(row.current_period_end))}</td><td data-label="Provider state">${remote}</td><td data-label="Sync">${syncState}</td><td data-label="Actions" class="right">${subscriptionActions(req, row)}</td>'''
)
replace_once(
    'src/platform/admin-billing.js',
    'class="dataTable billingTable"',
    'class="dataTable responsiveTable billingTable"'
)
replace_once(
    'src/platform/admin-billing.js',
    '''return `<tr><td>${esc(providerLabel(row.provider))}</td><td><code class="tinyCode">${esc(row.event_type)}</code></td><td>${state}</td><td>${esc(date(row.created_at))}</td><td>${row.processing_error ? `<span class="errorText">${esc(row.processing_error)}</span>` : '—'}</td></tr>`;''',
    '''return `<tr><td data-label="Provider">${esc(providerLabel(row.provider))}</td><td data-label="Event"><code class="tinyCode">${esc(row.event_type)}</code></td><td data-label="Status">${state}</td><td data-label="Received">${esc(date(row.created_at))}</td><td data-label="Error">${row.processing_error ? `<span class="errorText">${esc(row.processing_error)}</span>` : '—'}</td></tr>`;'''
)
replace_once(
    'src/platform/admin-billing.js',
    '''return `<tr><td><a href="/admin/users/${encodeURIComponent(local.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(local.email||'')}</div></td><td><strong>${esc(local.plan_name||local.plan_code||'Premium')}</strong><div class="subText">${esc(local.plan_code||'')}</div></td><td>${provider}</td><td>${providerState}</td><td>${discoveryStatePill(item.state)}</td><td>${esc(item.reason||'')}</td></tr>`;''',
    '''return `<tr><td data-label="Premium user"><a href="/admin/users/${encodeURIComponent(local.customer_id)}?tab=billing"><strong>${esc(identity)}</strong></a><div class="subText">${esc(local.email||'')}</div></td><td data-label="Local plan"><strong>${esc(local.plan_name||local.plan_code||'Premium')}</strong><div class="subText">${esc(local.plan_code||'')}</div></td><td data-label="Provider subscription">${provider}</td><td data-label="Provider state">${providerState}</td><td data-label="Match">${discoveryStatePill(item.state)}</td><td data-label="Reason">${esc(item.reason||'')}</td></tr>`;'''
)
replace_once(
    'src/platform/admin-billing.js',
    'class="dataTable discoveryTable"',
    'class="dataTable responsiveTable discoveryTable"'
)
replace_once(
    'src/platform/admin-billing.js',
    'class="dataTable eventTable"',
    'class="dataTable responsiveTable eventTable"'
)
replace_once(
    'src/platform/admin-billing.js',
    '''.discoveryApply{margin-top:12px}</style>''',
    '''.discoveryApply{margin-top:12px}@media(max-width:600px){.billingToolbar,.buttonRow,.billingActions{display:grid;grid-template-columns:1fr;width:100%}.billingToolbar form,.buttonRow form,.billingActions form{width:100%}.billingToolbar .button,.buttonRow .button,.billingActions .button,.discoveryApply .button{width:100%;justify-content:center}.billingToolbar>a.button{width:100%;justify-content:center}.sectionHead{align-items:flex-start}.sectionHead>div:last-child{display:flex;gap:6px;flex-wrap:wrap}.tinyCode{white-space:normal;overflow-wrap:anywhere}.discoveryApply .checkRow{align-items:flex-start}}</style>'''
)

# Transactions: same responsive contract, labelled fields, and phone-first
# controls/pagination without horizontal page overflow.
replace_once(
    'src/platform/admin-transactions.js',
    '''      <td>${esc(dateTime(row.occurred_at))}</td>\n      <td><strong>${esc(providerLabel(row.provider))}</strong><div class="subText">${esc(row.transaction_type || '—')}</div></td>\n      <td>${kindPill(row.kind)}<div class="subText">${esc(row.transaction_status || '—')}</div></td>\n      <td>${row.customer_id?`<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(identity(row))}</strong></a>`:`<strong>${esc(identity(row))}</strong>`}<div class="subText">${esc(row.customer_email || '')}</div></td>\n      <td><strong>${esc(normalized)}</strong>${String(row.currency).toUpperCase()!==reportCode?`<div class="subText">Original ${esc(original)}</div>`:''}</td>\n      <td>${esc(money(row.fee_amount_minor,row.currency))}</td>\n      <td><code class="transactionId">${esc(refBits[0] || '—')}</code>${refBits.length>1?`<details><summary>More IDs</summary>${refBits.slice(1).map(v=>`<div><code class="transactionId">${esc(v)}</code></div>`).join('')}</details>`:''}</td>''',
    '''      <td data-label="When">${esc(dateTime(row.occurred_at))}</td>\n      <td data-label="Provider / type"><strong>${esc(providerLabel(row.provider))}</strong><div class="subText">${esc(row.transaction_type || '—')}</div></td>\n      <td data-label="Classification / status">${kindPill(row.kind)}<div class="subText">${esc(row.transaction_status || '—')}</div></td>\n      <td data-label="Customer">${row.customer_id?`<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing"><strong>${esc(identity(row))}</strong></a>`:`<strong>${esc(identity(row))}</strong>`}<div class="subText">${esc(row.customer_email || '')}</div></td>\n      <td data-label="Amount (${esc(reportCode)})"><strong>${esc(normalized)}</strong>${String(row.currency).toUpperCase()!==reportCode?`<div class="subText">Original ${esc(original)}</div>`:''}</td>\n      <td data-label="Original fee">${esc(money(row.fee_amount_minor,row.currency))}</td>\n      <td data-label="Provider IDs"><code class="transactionId">${esc(refBits[0] || '—')}</code>${refBits.length>1?`<details><summary>More IDs</summary>${refBits.slice(1).map(v=>`<div><code class="transactionId">${esc(v)}</code></div>`).join('')}</details>`:''}</td>'''
)
replace_once(
    'src/platform/admin-transactions.js',
    'class="dataTable transactionTable"',
    'class="dataTable responsiveTable transactionTable"'
)
replace_once(
    'src/platform/admin-transactions.js',
    '''@media(max-width:850px){.transactionFilters .formGrid{grid-template-columns:1fr}.transactionSearch{grid-column:auto}}</style>''',
    '''@media(max-width:850px){.transactionFilters .formGrid{grid-template-columns:1fr}.transactionSearch{grid-column:auto}}@media(max-width:600px){.transactionFilters{padding:12px}.transactionFilters .buttonRow{display:grid;grid-template-columns:1fr}.transactionFilters .buttonRow .button{width:100%;justify-content:center}.transactionPager{display:grid;grid-template-columns:1fr;text-align:center}.transactionPager .button{width:100%;justify-content:center}.transactionId{overflow-wrap:anywhere;word-break:break-word}.operatorCallout{overflow-wrap:anywhere}}</style>'''
)

# Static mobile regression: these two payment surfaces must remain opted into
# the shared responsive table contract with labels and phone-specific controls.
p = ROOT / 'scripts/admin-accessibility-mobile-smoke.js'
text = p.read_text()
needle = "const attention=read('src/platform/admin-attention.js');\n"
addition = """const billing=read('src/platform/admin-billing.js');\nfor(const contract of ['responsiveTable billingTable','responsiveTable discoveryTable','responsiveTable eventTable','data-label=\\\"Customer\\\"','data-label=\\\"Premium user\\\"','data-label=\\\"Provider subscription\\\"','@media(max-width:600px)'])assert(billing.includes(contract),`Billing mobile contract missing ${contract}`);\nconst transactions=read('src/platform/admin-transactions.js');\nfor(const contract of ['responsiveTable transactionTable','data-label=\\\"When\\\"','data-label=\\\"Provider / type\\\"','data-label=\\\"Customer\\\"','data-label=\\\"Provider IDs\\\"','@media(max-width:600px)'])assert(transactions.includes(contract),`Transactions mobile contract missing ${contract}`);\n"""
if addition not in text:
    if needle not in text:
        raise SystemExit('mobile smoke insertion point not found')
    text = text.replace(needle, addition + needle, 1)
    p.write_text(text)

# Real Chromium mobile crawl: cover both new payment surfaces at 390x844.
replace_once(
    'tests/admin-browser-regression.js',
    "'/admin/servers/operations','/admin/backups']",
    "'/admin/servers/operations','/admin/backups','/admin/billing','/admin/payments/transactions']"
)

print('PR317 mobile hardening applied')
