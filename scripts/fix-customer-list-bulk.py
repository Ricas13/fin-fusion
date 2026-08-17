from pathlib import Path

p=Path('src/platform/admin-customers-list.js')
s=p.read_text()

# Retired reseller filters no longer belong on the live customer list.
s=s.replace("    if(q.reseller&&customerFilters.isUuid(q.reseller))f.resellerId=q.reseller;\n","")
s=s.replace("reseller:filters.resellerId,","")
s=s.replace("        query(`SELECT r.id,au.username AS name FROM resellers r JOIN app_users au ON au.id=r.user_id ORDER BY au.username`)\n    ]);\n    return {servers,plans:plans.rows,resellers:resellers.rows};", "    ]);\n    return {servers,plans:plans.rows};")
s=s.replace("    const [servers,plans,resellers]=await Promise.all([", "    const [servers,plans]=await Promise.all([")
s=s.replace("        <div class=\"formGroup\"><label>Reseller</label><select class=\"input\" name=\"reseller\"><option value=\"\">Any</option>${optionList(options.resellers,filters.resellerId)}</select></div>\n","")
s=s.replace("${x.reseller_username?`<div class=\"subText\">via ${esc(x.reseller_username)}</div>`:''}","")
s=s.replace(",{key:'reseller_username',label:'Reseller'}","")

# Row checkboxes must belong to the bulk form even though the table sits above it.
s=s.replace('class="rowCheck" name="customerId"', 'class="rowCheck" form="bulkForm" name="customerId"')
s=s.replace('<input type="checkbox" id="checkAllPage">', '<input type="checkbox" id="checkAllPage" aria-label="Select all customers on this page">')

# Load one CSP-safe helper for select-all and the selected-count affordance.
s=s.replace("${result.total?bulkBar(req,filters,result.total):''}`;", "${result.total?bulkBar(req,filters,result.total):''}<script src=\"/js/admin-customers-bulk.js\" defer></script>`;")

p.write_text(s)

Path('public/js/admin-customers-bulk.js').write_text("""'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  const all=document.getElementById('checkAllPage');
  const rows=()=>Array.from(document.querySelectorAll('.rowCheck'));
  const button=document.querySelector('#bulkForm button[type="submit"],#bulkForm button:not([type])');
  const sync=()=>{
    const selected=rows().filter(x=>x.checked).length;
    if(button)button.textContent=selected?`Continue with ${selected} selected`:'Continue';
    if(all){all.checked=rows().length>0&&selected===rows().length;all.indeterminate=selected>0&&selected<rows().length;}
  };
  all?.addEventListener('change',()=>{rows().forEach(x=>x.checked=all.checked);sync();});
  rows().forEach(x=>x.addEventListener('change',sync));
  sync();
});
""")

p=Path('scripts/admin-coherence-user-overrides-smoke.js')
s=p.read_text()
if "customersList=read('src/platform/admin-customers-list.js')" not in s:
    s=s.replace("const storefront=read('src/platform/storefront.js')", "const storefront=read('src/platform/storefront.js'),customersList=read('src/platform/admin-customers-list.js')")
marker="console.log('admin coherence user overrides smoke: ok');"
extra="assert(/form=\\\"bulkForm\\\" name=\\\"customerId\\\"/.test(customersList),'customer row selections must submit with the bulk form');\nassert(!/label>Reseller<\\/label>/.test(customersList),'retired reseller filter remains on Customers');\n"
if extra.strip() not in s:s=s.replace(marker,extra+marker)
p.write_text(s)
