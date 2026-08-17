from pathlib import Path
import re

def change(path, transform):
    p=Path(path); old=p.read_text(); new=transform(old)
    if new==old: raise SystemExit(f'no change in {path}')
    p.write_text(new)

change('src/platform/admin-plan-create-v2.js',lambda s:s.replace('The setup follows the same product → commercial terms → playback → policy → libraries flow used by Reseller Plans.','The setup follows one consistent product → commercial terms → playback → policy → libraries flow.').replace('Reseller products are configured separately under Reseller Plans and no longer consume retail-plan credits.','Plans created here are sold directly by CAPTAiNFiN to customer accounts.'))
def dashboard(s):
    s=s.replace('<h2>Refer a friend</h2>','<h2>Affiliate programme</h2>')
    s=re.sub(r'<p>Invite a friend and CAPTAiNFiN will add <strong><%= portal\.referralRewardDays %> days</strong>.*?</p>','<p>Share your referral code and earn CAPTAiNFiN service credit from qualifying referred payments. You do not need an active subscription to participate.</p>',s,flags=re.S)
    if '/account/affiliate' not in s:s=s.replace('<a class="button secondary" href="/account/security">Account security</a>','<a class="button secondary" href="/account/security">Account security</a><a class="button secondary" href="/account/affiliate">Affiliate programme</a>')
    return s
change('views/customer/dashboard.ejs',dashboard)
def app_routes(s):
    old="app.get('/reseller*',(_req,res)=>res.redirect(302,'/account?error='+encodeURIComponent('The reseller programme has been retired. Use the affiliate programme instead.')));\n app.get('/admin/reseller*',(_req,res)=>res.redirect(302,'/admin/referrals?message='+encodeURIComponent('The reseller programme has been retired and replaced by Affiliates.')));"
    new="app.use(/^\\/reseller(?:\\/|$)/,(_req,res)=>res.redirect(302,'/account?error='+encodeURIComponent('The reseller programme has been retired. Use the affiliate programme instead.')));\n app.use(/^\\/admin\\/reseller(?:\\/|$)/,(_req,res)=>res.redirect(302,'/admin/referrals?message='+encodeURIComponent('The reseller programme has been retired and replaced by Affiliates.')));"
    return s.replace(old,new)
change('src/application.js',app_routes)
