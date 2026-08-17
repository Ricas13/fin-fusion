from pathlib import Path
p=Path('scripts/security-operator-clarity-smoke.js')
s=p.read_text()
old="""const referrals=text('src/referrals.js');
assert(/revisitRewardAfterAdversePayment/.test(referrals)&&/referral_reward_reversals/.test(referrals),'Referral rewards must support idempotent unused-day reversal.');

const bulk=text('src/platform/bulk-operations.js');
assert(/capacityLock\\.withCapacityLock\\(resellerId/.test(bulk),'Bulk reseller assignment must share the reseller capacity advisory lock.');
const capacity=text('src/resellers/capacity-lock.js');
assert(/new Pool\\(/.test(capacity)&&/connectionTimeoutMillis/.test(capacity),'Reseller capacity locks must use a bounded dedicated connection pool.');
"""
new="""const referrals=text('src/referrals.js'),affiliateCredits=text('src/affiliate-credits.js');
assert(/revisitRewardAfterAdversePayment/.test(referrals)&&/affiliateCredits\\.reverseReward/.test(referrals),'Adverse payments must revisit already-earned affiliate service credit.');
assert(/entry_type='reversed'/.test(affiliateCredits)&&/already-delivered service was preserved|already-delivered service/i.test(referrals),'Affiliate reward reversal must remove unspent credit without clawing back delivered service.');

const bulk=text('src/platform/bulk-operations.js');
assert(!/reseller_assign|reseller_detach/.test(bulk),'Retired reseller customer-assignment operations must not return to bulk administration.');
"""
if old not in s: raise SystemExit('expected legacy security smoke block not found')
p.write_text(s.replace(old,new,1))
print('updated security/operator smoke for affiliate model')
