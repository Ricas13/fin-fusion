'use strict';

const assert = require('assert');
const net = require('net');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const emailSettings = require('../src/integrations/email-settings');
const outbox = require('../src/integrations/email-outbox');
const customers = require('../src/customers');

function startFakeSmtp() {
    const messages = [];
    let connections = 0;
    const server = net.createServer(socket => {
        connections += 1;
        socket.setEncoding('utf8');
        let buffer = '';
        let dataMode = false;
        let dataBuffer = '';
        socket.write('220 fake-smtp ESMTP ready\r\n');

        function reply(text) { socket.write(text); }
        function command(line) {
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO ')) return reply('250-fake-smtp\r\n250 AUTH PLAIN LOGIN\r\n');
            if (upper.startsWith('AUTH PLAIN ')) {
                const encoded = line.slice('AUTH PLAIN '.length).trim();
                const decoded = Buffer.from(encoded, 'base64').toString('utf8');
                return decoded === '\0smtp-user\0smtp-password' ? reply('235 2.7.0 authenticated\r\n') : reply('535 5.7.8 bad credentials\r\n');
            }
            if (upper.startsWith('MAIL FROM:')) return reply('250 2.1.0 sender ok\r\n');
            if (upper.startsWith('RCPT TO:')) return reply('250 2.1.5 recipient ok\r\n');
            if (upper === 'DATA') { dataMode = true; dataBuffer = ''; return reply('354 End data with <CR><LF>.<CR><LF>\r\n'); }
            if (upper === 'QUIT') { reply('221 2.0.0 bye\r\n'); return socket.end(); }
            return reply('250 2.0.0 ok\r\n');
        }

        socket.on('data', chunk => {
            if (dataMode) {
                dataBuffer += chunk;
                const end = dataBuffer.indexOf('\r\n.\r\n');
                if (end >= 0) {
                    messages.push(dataBuffer.slice(0, end));
                    const remainder = dataBuffer.slice(end + 5);
                    dataMode = false;
                    dataBuffer = '';
                    reply('250 2.0.0 queued\r\n');
                    if (remainder) buffer += remainder;
                }
                if (dataMode) return;
            } else {
                buffer += chunk;
            }
            for (;;) {
                const index = buffer.indexOf('\r\n');
                if (index < 0) break;
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (line) command(line);
                if (dataMode) {
                    if (buffer) { dataBuffer += buffer; buffer = ''; }
                    break;
                }
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                messages,
                get connections() { return connections; },
                close: () => new Promise(done => server.close(done))
            });
        });
    });
}

(async () => {
    const smtp = await startFakeSmtp();
    try {
        await emailSettings.save({
            enabled: true,
            host: '127.0.0.1',
            port: smtp.port,
            secureMode: 'plain',
            username: 'smtp-user',
            password: 'smtp-password',
            fromName: 'CAPTaINFiN Test',
            fromEmail: 'noreply@example.test',
            replyTo: 'support@example.test'
        });
        const status = await emailSettings.status();
        assert.strictEqual(status.source, 'browser');
        assert.strictEqual(status.enabled, true);
        assert.strictEqual(status.configured, true);
        assert.strictEqual(status.passwordConfigured, true);
        assert.strictEqual(status.host, '127.0.0.1');
        assert.strictEqual(Number(status.port), smtp.port);

        const storedSettings = (await query('SELECT password_encrypted FROM email_gateway_settings WHERE id=1')).rows[0];
        assert(storedSettings.password_encrypted, 'encrypted SMTP password missing');
        assert(!storedSettings.password_encrypted.includes('smtp-password'), 'SMTP password was stored in plaintext');

        const connectionTest = await emailSettings.testConnection();
        assert.strictEqual(connectionTest.ok, true);
        assert(connectionTest.latencyMs >= 0);

        const secretUrl = 'https://store.example.test/account/verify-email?token=VERY_SECRET_TOKEN';
        const queued = await outbox.enqueue({
            type: 'email_verification',
            to: 'alice@example.test',
            subject: 'Verify your account',
            text: `Use ${secretUrl}`,
            html: `<p><a href="${secretUrl}">Verify</a></p>`,
            dedupeKey: 'email-test-verification-1'
        });
        const rawQueued = (await query('SELECT payload_encrypted,status FROM notification_outbox WHERE id=$1', [queued.id])).rows[0];
        assert.strictEqual(rawQueued.status, 'pending');
        assert(!rawQueued.payload_encrypted.includes('VERY_SECRET_TOKEN'), 'verification token leaked into plaintext outbox storage');
        assert(!rawQueued.payload_encrypted.includes('Verify your account'), 'email body leaked into plaintext outbox storage');

        const delivered = await outbox.deliverDue({ limit: 5 });
        assert.strictEqual(delivered.sent, 1);
        assert.strictEqual(delivered.failed, 0);
        const sentRow = (await query('SELECT status,sent_at,last_error,attempts FROM notification_outbox WHERE id=$1', [queued.id])).rows[0];
        assert.strictEqual(sentRow.status, 'sent');
        assert(sentRow.sent_at);
        assert.strictEqual(sentRow.last_error, null);
        assert.strictEqual(Number(sentRow.attempts), 1);
        assert(smtp.messages.some(message => message.includes('Subject: Verify your account') && message.includes('VERY_SECRET_TOKEN')), 'fake SMTP server did not receive the queued message');

        const failed = await outbox.enqueue({
            type: 'password_reset',
            to: 'bob@example.test',
            subject: 'Reset password',
            text: 'Reset link body',
            dedupeKey: 'email-test-reset-failure'
        });
        const failedRun = await outbox.deliverDue({ limit: 1, sender: async () => { throw new Error('simulated SMTP outage'); } });
        assert.strictEqual(failedRun.failed, 1);
        const failedRow = (await query('SELECT status,last_error,next_attempt_at,attempts FROM notification_outbox WHERE id=$1', [failed.id])).rows[0];
        assert.strictEqual(failedRow.status, 'failed');
        assert(/simulated SMTP outage/.test(failedRow.last_error));
        assert(new Date(failedRow.next_attempt_at) > new Date());
        assert.strictEqual(Number(failedRow.attempts), 1);
        await outbox.retry(failed.id);
        const retried = await outbox.deliverDue({ limit: 1, sender: async message => {
            assert.strictEqual(message.to, 'bob@example.test');
            return true;
        }});
        assert.strictEqual(retried.sent, 1);
        assert.strictEqual((await query('SELECT status FROM notification_outbox WHERE id=$1', [failed.id])).rows[0].status, 'sent');

        const passwordHash = await bcrypt.hash('Original-Portal-Password-2026!', 12);
        const user = (await query(`
            INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at,password_changed_at)
            VALUES('reset@example.test','ResetUser',$1,'customer',TRUE,NOW(),NOW()) RETURNING id
        `, [passwordHash])).rows[0];
        await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,'Reset User','reset@example.test')`, [user.id]);

        const reset = await customers.createPasswordReset('ResetUser', 60);
        assert(reset?.token, 'password reset helper did not create a token');
        assert.strictEqual(reset.email, 'reset@example.test');
        const tokenRow = (await query(`SELECT token_hash,consumed_at,expires_at FROM account_tokens WHERE user_id=$1 AND token_type='password_reset'`, [user.id])).rows[0];
        assert(tokenRow.token_hash && !tokenRow.token_hash.includes(reset.token), 'password reset raw token must not be stored');
        assert.strictEqual(tokenRow.consumed_at, null);

        const resetOk = await customers.resetSitePassword(reset.token, 'Replacement-Portal-Password-2026!');
        assert.strictEqual(resetOk, true);
        const changedUser = (await query('SELECT password_hash,password_changed_at FROM app_users WHERE id=$1', [user.id])).rows[0];
        assert(await bcrypt.compare('Replacement-Portal-Password-2026!', changedUser.password_hash));
        assert(changedUser.password_changed_at);
        assert.strictEqual(await customers.resetSitePassword(reset.token, 'Another-Portal-Password-2026!'), false, 'password reset token replay was accepted');

        const noEmailHash = await bcrypt.hash('No-Email-Password-2026!', 12);
        const noEmailUser = (await query(`
            INSERT INTO app_users(username,password_hash,role,active,password_changed_at)
            VALUES('NoEmailUser',$1,'customer',TRUE,NOW()) RETURNING id
        `, [noEmailHash])).rows[0];
        await query(`INSERT INTO customers(user_id,display_name) VALUES($1,'No Email User')`, [noEmailUser.id]);
        assert.strictEqual(await customers.createPasswordReset('NoEmailUser', 60), null, 'password reset should not invent an email address');

        const counts = await outbox.counts();
        assert(Number(counts.sent) >= 2);
        console.log(`transactional email smoke: ok (smtp connections=${smtp.connections}, messages=${smtp.messages.length})`);
    } finally {
        await smtp.close();
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
