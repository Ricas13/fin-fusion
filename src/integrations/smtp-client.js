'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function header(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}
function address(value) {
    const email = String(value || '').trim();
    if (!email || !email.includes('@') || /[\r\n<>]/.test(email)) throw new Error('Invalid email address.');
    return email;
}
function dotStuff(value) {
    return String(value || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}
function b64(value) { return Buffer.from(String(value || ''), 'utf8').toString('base64'); }
function messageId(domain) {
    const safeDomain = String(domain || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    return `<${crypto.randomBytes(16).toString('hex')}@${safeDomain}>`;
}

function buildMessage({ fromName, fromEmail, replyTo, to, subject, text, html }) {
    const sender = address(fromEmail);
    const recipient = address(to);
    const safeName = header(fromName);
    const safeSubject = header(subject);
    const from = safeName ? `"${safeName.replace(/"/g, "'")}" <${sender}>` : `<${sender}>`;
    const headers = [
        `From: ${from}`,
        `To: <${recipient}>`,
        `Subject: ${safeSubject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId(sender.split('@')[1])}`,
        'MIME-Version: 1.0'
    ];
    if (replyTo) headers.push(`Reply-To: <${address(replyTo)}>`);

    if (html) {
        const boundary = `cf_${crypto.randomBytes(12).toString('hex')}`;
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        return `${headers.join('\r\n')}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${dotStuff(text || '')}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${dotStuff(html)}\r\n--${boundary}--\r\n`;
    }
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit');
    return `${headers.join('\r\n')}\r\n\r\n${dotStuff(text || '')}\r\n`;
}

class SmtpSession {
    constructor(config) {
        this.config = config;
        this.socket = null;
        this.buffer = '';
        this.waiters = [];
    }

    bind(socket) {
        this.socket = socket;
        this.buffer = '';
        socket.setTimeout(this.config.timeoutMs || 10000);
        socket.setEncoding('utf8');
        socket.on('data', chunk => this.onData(chunk));
        socket.on('timeout', () => this.failAll(new Error('SMTP connection timed out.')));
        socket.on('error', error => this.failAll(error));
        socket.on('close', () => this.failAll(new Error('SMTP connection closed unexpectedly.')));
    }

    onData(chunk) {
        this.buffer += chunk;
        for (;;) {
            const lines = this.buffer.split('\r\n');
            if (lines.length < 2) return;
            let endIndex = -1;
            let code = null;
            for (let i = 0; i < lines.length - 1; i += 1) {
                const match = lines[i].match(/^(\d{3})([ -])(.*)$/);
                if (!match) continue;
                if (code == null) code = Number(match[1]);
                if (Number(match[1]) === code && match[2] === ' ') { endIndex = i; break; }
            }
            if (endIndex < 0) return;
            const responseLines = lines.slice(0, endIndex + 1);
            this.buffer = lines.slice(endIndex + 1).join('\r\n');
            const waiter = this.waiters.shift();
            if (waiter) waiter.resolve({ code, lines: responseLines, text: responseLines.join('\n') });
        }
    }

    failAll(error) {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter.reject(error);
    }

    response() {
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    async expect(codes) {
        const response = await this.response();
        const allowed = Array.isArray(codes) ? codes : [codes];
        if (!allowed.includes(response.code)) throw new Error(`SMTP ${response.code}: ${response.text.replace(/\n/g, ' | ')}`);
        return response;
    }

    async command(command, codes) {
        this.socket.write(`${command}\r\n`);
        return this.expect(codes);
    }

    async connect() {
        const { host, port, secureMode } = this.config;
        const socket = secureMode === 'tls'
            ? tls.connect({ host, port, servername: host, rejectUnauthorized: this.config.rejectUnauthorized !== false })
            : net.connect({ host, port });
        this.bind(socket);
        await new Promise((resolve, reject) => {
            const onConnect = () => { cleanup(); resolve(); };
            const onError = error => { cleanup(); reject(error); };
            const cleanup = () => { socket.off(secureMode === 'tls' ? 'secureConnect' : 'connect', onConnect); socket.off('error', onError); };
            socket.once(secureMode === 'tls' ? 'secureConnect' : 'connect', onConnect);
            socket.once('error', onError);
        });
        await this.expect(220);
        await this.ehlo();
        if (secureMode === 'starttls') await this.startTls();
        await this.authenticate();
        return this;
    }

    async ehlo() {
        const name = header(this.config.clientName || 'captainfin.local') || 'captainfin.local';
        const response = await this.command(`EHLO ${name}`, 250);
        this.capabilities = response.lines.map(line => line.replace(/^250[ -]/, '').trim().toUpperCase());
    }

    async startTls() {
        if (!this.capabilities?.some(line => line.startsWith('STARTTLS'))) throw new Error('SMTP server does not advertise STARTTLS.');
        await this.command('STARTTLS', 220);
        const raw = this.socket;
        raw.removeAllListeners('data');
        raw.removeAllListeners('timeout');
        raw.removeAllListeners('error');
        raw.removeAllListeners('close');
        const secure = tls.connect({ socket: raw, servername: this.config.host, rejectUnauthorized: this.config.rejectUnauthorized !== false });
        this.bind(secure);
        await new Promise((resolve, reject) => {
            secure.once('secureConnect', resolve);
            secure.once('error', reject);
        });
        await this.ehlo();
    }

    async authenticate() {
        const username = String(this.config.username || '');
        const password = String(this.config.password || '');
        if (!username && !password) return;
        if (!username || !password) throw new Error('SMTP username and password must both be configured.');
        const authLine = (this.capabilities || []).find(line => line.startsWith('AUTH ')) || '';
        if (authLine.includes('PLAIN')) {
            await this.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, 235);
            return;
        }
        if (authLine.includes('LOGIN')) {
            await this.command('AUTH LOGIN', 334);
            await this.command(b64(username), 334);
            await this.command(b64(password), 235);
            return;
        }
        throw new Error('SMTP server does not advertise AUTH PLAIN or AUTH LOGIN.');
    }

    async send(message) {
        const sender = address(message.fromEmail);
        const recipient = address(message.to);
        await this.command(`MAIL FROM:<${sender}>`, 250);
        await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
        await this.command('DATA', 354);
        this.socket.write(`${buildMessage(message)}\r\n.\r\n`);
        await this.expect(250);
    }

    async close() {
        if (!this.socket || this.socket.destroyed) return;
        try { await this.command('QUIT', 221); } catch (_) {}
        this.socket.end();
    }
}

async function verify(config) {
    const session = new SmtpSession(config);
    try { await session.connect(); return true; }
    finally { await session.close(); }
}

async function send(config, message) {
    const session = new SmtpSession(config);
    try { await session.connect(); await session.send(message); return true; }
    finally { await session.close(); }
}

module.exports = { SmtpSession, buildMessage, verify, send, address, header };
