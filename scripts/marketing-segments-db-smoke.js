'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query } = require('../src/db');
const segments = require('../src/marketing/segments');
const campaigns = require('../src/marketing/campaigns');

async function main() {
    const tag = `segment-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    let segment = null;
    let campaign = null;
    const originalFilters = { status: 'expired', accountAgeDays: 30, inactivePlaybackDays: 21 };

    try {
        segment = await segments.save({
            name: `${tag} winback`,
            audienceFilters: originalFilters,
            adminUserId: null
        });
        assert(segment?.id, 'saved segment was not created');
        assert.deepStrictEqual(segment.audience_filters, originalFilters, 'saved segment filters were not persisted');

        campaign = await campaigns.create({
            name: `${tag} campaign`,
            subject: 'Saved segment snapshot smoke',
            bodyText: 'Snapshot test message',
            discountCodeId: null,
            segmentId: segment.id,
            audienceFilters: { status: 'none' },
            adminUserId: null
        });
        assert(campaign?.id, 'campaign was not created from saved segment');
        assert.strictEqual(String(campaign.segment_id), String(segment.id), 'campaign did not retain the saved segment source reference');
        assert.deepStrictEqual(campaign.audience_filters, originalFilters, 'saved segment must override one-off filters and be copied into the campaign');

        await segments.save({
            id: segment.id,
            name: `${tag} winback updated`,
            audienceFilters: { status: 'none', lapsedDays: 60 },
            adminUserId: null
        });
        let persisted = (await query(`SELECT segment_id,audience_filters FROM marketing_campaigns WHERE id=$1`, [campaign.id])).rows[0];
        assert.deepStrictEqual(persisted.audience_filters, originalFilters, 'editing a saved segment changed an existing campaign snapshot');

        await segments.remove({ id: segment.id, adminUserId: null });
        segment = null;
        persisted = (await query(`SELECT segment_id,audience_filters FROM marketing_campaigns WHERE id=$1`, [campaign.id])).rows[0];
        assert.strictEqual(persisted.segment_id, null, 'deleting a saved segment must clear only the campaign source reference');
        assert.deepStrictEqual(persisted.audience_filters, originalFilters, 'deleting a saved segment changed the campaign audience snapshot');

        console.log('Marketing saved segments DB smoke: ok');
    } finally {
        if (campaign?.id) await query(`DELETE FROM marketing_campaigns WHERE id=$1`, [campaign.id]).catch(() => {});
        if (segment?.id) await query(`DELETE FROM marketing_segments WHERE id=$1`, [segment.id]).catch(() => {});
    }
}

main().then(() => process.exit(0)).catch(error => { console.error(error.stack || error); process.exit(1); });
