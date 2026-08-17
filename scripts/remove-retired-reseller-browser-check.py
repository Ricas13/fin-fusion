from pathlib import Path
p=Path('tests/admin-browser-regression.js')
s=p.read_text()
s=s.replace("  '/admin/users','/admin/reseller-management','/admin/activity',","  '/admin/users','/admin/activity',")
s=s.replace("  // Customer plans are customer-only. Reseller products are configured separately,\n  // so the old audience selector is intentionally absent from this shared workflow.\n","  // Customer plans are direct-customer products; the retired reseller audience is intentionally absent.\n")
if '/admin/reseller-management' in s:
    raise SystemExit('retired reseller-management browser target still present')
p.write_text(s)
print('retired reseller browser target removed')
