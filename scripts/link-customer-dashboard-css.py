from pathlib import Path
p=Path('views/customer/dashboard.ejs')
s=p.read_text()
needle='  <link rel="stylesheet" href="/css/customer-portal.css">\n'
if needle not in s: raise SystemExit('stylesheet marker missing')
s=s.replace(needle,needle+'  <link rel="stylesheet" href="/css/customer-dashboard.css">\n',1)
p.write_text(s)
