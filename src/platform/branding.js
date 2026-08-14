'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');

const BRAND_DIR = path.resolve(__dirname, '../../db/branding');
const LOGO_MAX = 1024 * 1024;
const FAVICON_MAX = 256 * 1024;

const types = {
    logo: {
        max: LOGO_MAX,
        allowed: new Set(['png', 'jpg', 'webp'])
    },
    favicon: {
        max: FAVICON_MAX,
        allowed: new Set(['png', 'ico'])
    }
};

function ensureDir() {
    fs.mkdirSync(BRAND_DIR, { recursive: true, mode: 0o700 });
}

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

function existing(kind) {
    ensureDir();
    const cfg = types[kind];
    if (!cfg) return null;
    for (const ext of cfg.allowed) {
        const file = path.join(BRAND_DIR, `${kind}.${ext}`);
        if (fs.existsSync(file)) return { file, ext };
    }
    return null;
}

function removeExisting(kind) {
    const cfg = types[kind];
    if (!cfg) return;
    ensureDir();
    for (const ext of cfg.allowed) {
        try { fs.unlinkSync(path.join(BRAND_DIR, `${kind}.${ext}`)); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
}

function assetUrl(kind) {
    return existing(kind) ? `/branding/${kind}` : (kind === 'logo' ? '/logo.jpg' : '/favicon.ico');
}

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

async function requireStep(req) {
    return auth.verifySecondFactor(req.session.authUserId, req.get('x-2fa-code') || req.body?.code, req);
}

async function audit(req, action, kind) {
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,$2,'branding',$3,$4::jsonb)`,
        [req.session.authUserId, action, kind, JSON.stringify({ kind })]
    );
}

function sendAsset(kind, req, res) {
    const item = existing(kind);
    if (!item) return res.status(404).end();
    res.setHeader('Content-Type', mimeFor(item.ext));
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return fs.createReadStream(item.file).pipe(res);
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
            if (!(await requireStep(req))) return res.status(403).json({ ok: false, error: 'Verification failed.' });
            if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'No file received.' });
            if (req.body.length > cfg.max) return res.status(413).json({ ok: false, error: 'File is too large.' });
            const ext = detectImageType(req.body);
            if (!ext || !cfg.allowed.has(ext)) {
                return res.status(415).json({ ok: false, error: kind === 'logo' ? 'Logo must be PNG, JPEG or WebP.' : 'Favicon must be PNG or ICO.' });
            }
            ensureDir();
            const tmp = path.join(BRAND_DIR, `.${kind}.${process.pid}.${Date.now()}.tmp`);
            const target = path.join(BRAND_DIR, `${kind}.${ext}`);
            fs.writeFileSync(tmp, req.body, { mode: 0o600, flag: 'wx' });
            removeExisting(kind);
            fs.renameSync(tmp, target);
            await audit(req, 'admin.branding.upload', kind);
            return res.json({ ok: true, url: `/branding/${kind}?v=${Date.now()}` });
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
            if (!(await requireStep(req))) throw new Error('verification');
            removeExisting(kind);
            await audit(req, 'admin.branding.remove', kind);
            return res.redirect('/admin/settings?message=' + encodeURIComponent(`${kind === 'logo' ? 'Logo' : 'Favicon'} reset to default.`));
        } catch (error) {
            return res.redirect('/admin/settings?error=' + encodeURIComponent(error.message === 'verification' ? 'Verification failed.' : 'Branding asset could not be removed safely.'));
        }
    });

    return r;
}

module.exports = { createBrandingRouter, assetUrl, existing };
