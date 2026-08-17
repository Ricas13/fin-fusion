from pathlib import Path

p=Path('src/platform/admin-customer-360.js')
s=p.read_text()
old="const {query}=require('../db');"
new="const {query,transaction}=require('../db');"
if old not in s:
    raise SystemExit('admin-customer-360 db import pattern missing')
p.write_text(s.replace(old,new,1))

p=Path('src/platform/admin-attention.js')
s=p.read_text()
old="</section><script>document.addEventListener('change',e=>{if(e.target.matches('[data-attention-select-all]'))document.querySelectorAll('input[form=attentionBulkForm][name=itemKey]').forEach(x=>x.checked=e.target.checked);});</script>`;return layout"
new="</section><script src=\"/js/admin-attention-bulk.js\" defer></script>`;return layout"
if old not in s:
    raise SystemExit('admin attention inline bulk script pattern missing')
p.write_text(s.replace(old,new,1))

Path('public/js/admin-attention-bulk.js').write_text("""'use strict';
document.addEventListener('change',event=>{
  if(!event.target.matches('[data-attention-select-all]'))return;
  document.querySelectorAll('input[form="attentionBulkForm"][name="itemKey"]').forEach(input=>{input.checked=event.target.checked;});
});
""")

p=Path('scripts/admin-coherence-user-overrides-smoke.js')
s=p.read_text()
s=s.replace("const assert=require('assert'),fs=require('fs');", "const assert=require('assert'),fs=require('fs');")
insert="assert(/\\{query,transaction\\}=require\\('..\\/db'\\)/.test(customer),'Customer 360 override routes must import transaction');\nassert(!/<script>document\\.addEventListener/.test(attention)&&/admin-attention-bulk\\.js/.test(attention),'Needs Attention bulk selection must use external CSP-safe JS');\n"
marker="console.log('admin coherence user overrides smoke: ok');"
if insert.strip() not in s:
    s=s.replace(marker,insert+marker)
p.write_text(s)
