'use strict';

const fs = require('fs');
const path = require('path');

const MEDIA_PATH = path.join(__dirname, 'assets', 'household-blocked.mp4');
const MEDIA = fs.readFileSync(MEDIA_PATH);
const MEDIA_SIZE = MEDIA.length;
const MEDIA_TYPE = 'video/mp4';

function playbackUrl({ origin, installToken, type, videoId }) {
  const base = String(origin || '').replace(/\/$/, '');
  if (!base || !installToken) throw new Error('Blocked Stremio playback URL is unavailable.');
  return `${base}/stremio/${encodeURIComponent(String(installToken))}/household-blocked/${encodeURIComponent(String(type || 'video'))}/${encodeURIComponent(String(videoId || 'blocked'))}.mp4`;
}

function rangeFor(header, size = MEDIA_SIZE) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  const match = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return false;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return false;
  if (start === null) {
    const suffix = end;
    if (!Number.isInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isInteger(start) || start < 0) return false;
    if (end === null) end = size - 1;
    if (!Number.isInteger(end) || end < start) return false;
    end = Math.min(end, size - 1);
  }
  if (start >= size) return false;
  return { start, end };
}

function commonHeaders(res, size = MEDIA_SIZE) {
  res.setHeader('Content-Type', MEDIA_TYPE);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'inline; filename="CAPTAiNFiN-household-IP-blocked.mp4"');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Length', String(size));
}

function send(req, res) {
  const range = rangeFor(req.get('range'), MEDIA_SIZE);
  if (range === false) {
    res.setHeader('Content-Range', `bytes */${MEDIA_SIZE}`);
    return res.status(416).end();
  }
  if (!range) {
    commonHeaders(res);
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).end(MEDIA);
  }
  const chunk = MEDIA.subarray(range.start, range.end + 1);
  commonHeaders(res, chunk.length);
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${MEDIA_SIZE}`);
  if (req.method === 'HEAD') return res.status(206).end();
  return res.status(206).end(chunk);
}

module.exports = { MEDIA_PATH, MEDIA_SIZE, MEDIA_TYPE, playbackUrl, rangeFor, send };
