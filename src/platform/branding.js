'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');

const LEGACY_BRAND_DIR = path.resolve(__dirname, '../../db/branding');
const DEFAULT_LOGO = path.resolve(__dirname, '../../public/logo.jpg');
const LOGO_MAX = 1024 * 1024;
const FAVICON_MAX = 256 * 1024;

const types = {
    logo: { max: LOGO_MAX, allowed: new Set(['png', 'jpg', 'webp']) },
    favicon: { max: FAVICON_MAX, allowed: new Set(['png', 'ico']) }
};

function detectImageType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
    return null;
}

function mimeFor(ext) {
    return ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' })[ext] || 'application/octet-stream';
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function legacyExisting(kind) {
    const cfg = types[kind];
    if (!cfg) return null;
    for (const ext of cfg.allowed) {
        const file = path.join(LEGACY_BRAND_DIR, `${kind}.${ext}`);
        if (fs.existsSync(file)) return { file, ext };
    }
    return null;
}

function removeLegacy(kind) {
    const cfg = types[kind];
    if (!cfg) return;
    for (const ext of cfg.allowed) {
        try { fs.unlinkSync(path.join(LEGACY_BRAND_DIR, `${kind}.${ext}`)); }
        catch (error) { if (error.code !== 'ENOENT') console.warn(`Legacy branding cleanup failed for ${kind}.${ext}:`, error.message); }
    }
}

async function importLegacy(kind) {
    const existing = legacyExisting(kind);
    if (!existing) return null;
    try {
        const content = fs.readFileSync(existing.file);
        const ext = detectImageType(content);
        if (!ext || !types[kind].allowed.has(ext) || content.length > types[kind].max) return null;
        const result = await query(`
            INSERT INTO branding_assets(kind,mime_type,file_ext,content,size_bytes,sha256)
            VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(kind) DO NOTHING
            RETURNING kind,mime_type,file_ext,size_bytes,sha256,updated_at
        `, [kind, mimeFor(ext), ext, content, content.length, sha256(content)]);
        if (result.rowCount) console.log(`Imported legacy ${kind} branding asset into PostgreSQL.`);
        return result.rows[0] || null;
    } catch (error) {
        // During the migration window an old install may start before migration
        // 040 has been applied. Serving the legacy file is safer than breaking
        // branding; the next request after migrations will retry the import.
        if (error.code !== '42P01') console.warn(`Legacy branding import failed for ${kind}:`, error.message);
        return null;
    }
}

async function asset(kind, { includeContent = true } = {}) {
    if (!types[kind]) return null;
    try {
        const columns = includeContent
            ? 'kind,mime_type,file_ext,content,size_bytes,sha256,updated_at'
            : 'kind,mime_type,file_ext,size_bytes,sha256,updated_at';
        let result = await query(`SELECT ${columns} FROM branding_assets WHERE kind=$1`, [kind]);
        if (!result.rowCount && legacyExisting(kind)) {
            await importLegacy(kind);
            result = await query(`SELECT ${columns} FROM branding_assets WHERE kind=$1`, [kind]);
        }
        return result.rows[0] || null;
    } catch (error) {
        if (error.code !== '42P01') throw error;
        return null;
    }
}

async function metadata(kind) {
    const row = await asset(kind, { includeContent: false });
    if (row) return { ...row, source: 'database' };
    const legacy = legacyExisting(kind);
    return legacy ? { kind, file_ext: legacy.ext, mime_type: mimeFor(legacy.ext), source: 'legacy_file' } : null;
}

function assetUrl(kind) {
    if (!types[kind]) return '/logo.jpg';
    return `/branding/${kind}`;
}

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

async function audit(req, action, kind, metadata = {}) {
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,$2,'branding',$3,$4::jsonb)`,
        [req.session.authUserId, action, kind, JSON.stringify({ kind, ...metadata })]
    );
}

async function sendAsset(kind, _req, res) {
    try {
        const item = await asset(kind);
        if (item?.content) {
            const etag = `"${item.sha256}"`;
            if (res.req.headers['if-none-match'] === etag) return res.status(304).end();
            res.setHeader('Content-Type', item.mime_type);
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
            res.setHeader('ETag', etag);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.send(item.content);
        }
        const legacy = legacyExisting(kind);
        if (legacy) {
            res.setHeader('Content-Type', mimeFor(legacy.ext));
            res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return fs.createReadStream(legacy.file).pipe(res);
        }
        if (!fs.existsSync(DEFAULT_LOGO)) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return fs.createReadStream(DEFAULT_LOGO).pipe(res);
    } catch (error) {
        console.error(`Branding asset read failed for ${kind}:`, error.message);
        return res.status(500).end();
    }
}

function createBrandingRouter() {
    const r = express.Router();

    r.get('/branding/logo', (req, res) => sendAsset('logo', req, res));
    r.get('/branding/favicon', (req, res) => sendAsset('favicon', req, res));

    const raw = express.raw({ type: () => true, limit: LOGO_MAX });

    r.post('/admin/settings/branding/:kind', gate, raw, async (req, res) => {
        const kind = String(req.params.kind || '');
        const cfg = types[kind];
        if (!cfg) return res.status(404).json({ ok: false, error: 'Unknown branding asset.' });
        if (!csrf.verify(req)) return res.status(403).json({ ok: false, error: 'Invalid security token.' });
        try {
            if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'No file received.' });
            if (req.body.length > cfg.max) return res.status(413).json({ ok: false, error: 'File is too large.' });
            const ext = detectImageType(req.body);
            if (!ext || !cfg.allowed.has(ext)) {
                return res.status(415).json({ ok: false, error: kind === 'logo' ? 'Logo must be PNG, JPEG or WebP.' : 'Favicon must be PNG or ICO.' });
            }
            const digest = sha256(req.body);
            await query(`
                INSERT INTO branding_assets(kind,mime_type,file_ext,content,size_bytes,sha256,updated_by)
                VALUES($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT(kind) DO UPDATE SET
                  mime_type=EXCLUDED.mime_type,file_ext=EXCLUDED.file_ext,content=EXCLUDED.content,
                  size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256,updated_by=EXCLUDED.updated_by,updated_at=NOW()
            `, [kind, mimeFor(ext), ext, req.body, req.body.length, digest, req.session.authUserId]);
            removeLegacy(kind);
            await audit(req, 'admin.branding.upload', kind, { sizeBytes: req.body.length, sha256: digest });
            return res.json({ ok: true, url: `/branding/${kind}?v=${encodeURIComponent(digest.slice(0,12))}` });
        } catch (error) {
            console.error('Branding upload failed:', error.message);
            return res.status(500).json({ ok: false, error: 'Branding asset could not be saved safely.' });
        }
    });

    r.post('/admin/settings/branding/:kind/remove', gate, async (req, res) => {
        const kind = String(req.params.kind || '');
        if (!types[kind]) return res.status(404).send('Unknown branding asset.');
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await query('DELETE FROM branding_assets WHERE kind=$1', [kind]);
            removeLegacy(kind);
            await audit(req, 'admin.branding.remove', kind);
            return res.redirect('/admin/settings/branding?message=' + encodeURIComponent(`${kind === 'logo' ? 'Logo' : 'Favicon'} reset to default.`));
        } catch (error) {
            return res.redirect('/admin/settings/branding?error=' + encodeURIComponent('Branding asset could not be removed safely.'));
        }
    });

    return r;
}

module.exports = { createBrandingRouter, assetUrl, metadata, asset, legacyExisting };
