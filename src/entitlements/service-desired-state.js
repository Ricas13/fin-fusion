'use strict';

const serviceAdminControl = require('./service-admin-control');
const permanentAccess = require('./permanent-access');

// The one canonical decision point for "should this customer have <service>
// access right now": evaluate active admin authority first; only fall
// through to automatic commercial/free-tier rules when no admin directive
// exists. Every reconciliation worker should consult this before making its
// own access decision, instead of re-deriving admin intent independently
// (the fragmentation this replaces: Jellyfin admin-control + permanent-access
// were two separate signals the UI/reconciler had to merge ad hoc, and
// Stremio/Overseerr had no admin-authority signal at all).
//
// Returns either:
//   { authority:'admin', desiredState:'present'|'absent', serverId, reason, overriddenAt }
//   { authority:'automatic', desiredState:null, reason:'no_admin_directive' }
// "automatic" means: no admin directive exists, so the caller's normal
// entitlement/free-tier/plan-configuration logic is authoritative. This
// function deliberately does not re-implement that logic (payment validity,
// free-server capacity/inactivity policy, plan bundling) - it already lives,
// tested, in subscription-state.js/customer-access-desired-state.js/plan-capacity.js,
// and duplicating it here would be exactly the kind of unnecessary secondary
// decision-maker this refactor removes.
async function resolveServiceDesiredState(customerId, service, { client = null } = {}) {
    const admin = await serviceAdminControl.state(customerId, service, { client });
    if (admin) {
        if (admin.mode === 'admin_removed') {
            return { authority: 'admin', desiredState: 'absent', serverId: null, reason: 'admin_removed', overriddenAt: admin.updated_at || null };
        }
        if (admin.mode === 'admin_present') {
            return { authority: 'admin', desiredState: 'present', serverId: null, reason: 'admin_present', overriddenAt: admin.updated_at || null };
        }
        if (admin.mode === 'admin_server_pin') {
            return { authority: 'admin', desiredState: 'present', serverId: admin.server_id || null, reason: 'admin_server_pin', overriddenAt: admin.updated_at || null };
        }
    }
    if (service === 'jellyfin') {
        // Legacy signal, still authoritative: an admin who used "Make permanent"
        // before the canonical admin-authority table existed must not lose that
        // protection. New admin actions write the canonical table above instead.
        const legacy = await permanentAccess.status(customerId, { client });
        if (legacy?.active) {
            return { authority: 'admin', desiredState: 'present', serverId: null, reason: 'permanent_access', overriddenAt: legacy.updated_at || null };
        }
    }
    return { authority: 'automatic', desiredState: null, reason: 'no_admin_directive' };
}

module.exports = { resolveServiceDesiredState };
