'use strict';

// Behaviour smoke for reconciliation locking without PostgreSQL. `pg` is replaced
// by an in-memory session advisory-lock table which, like PostgreSQL, grants a
// session its own lock again.
//
// RECONCILIATION_LOCK_SMOKE_MODULE=<path> --nesting-only runs the nesting case
// against another copy of the lock module (for example an earlier revision).

const assert = require('assert');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const advisory = new Map();
const clients = [];
let overlappingQueries = 0;
let deepestHold = 0;
let queryFault = null;
let delayResponse = null;

function runAdvisory(client, text, params) {
    const key = params.join(':');
    const hold = advisory.get(key);
    if (text.includes('pg_try_advisory_lock(')) {
        if (hold && hold.client !== client) return { rows: [{ locked: false }], rowCount: 1 };
        const next = { client, count: (hold?.count || 0) + 1 };
        deepestHold = Math.max(deepestHold, next.count);
        advisory.set(key, next);
        return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_unlock(')) {
        if (hold?.client !== client) return { rows: [{ pg_advisory_unlock: false }], rowCount: 1 };
        hold.count -= 1;
        if (!hold.count) advisory.delete(key);
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
}

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.busy = false;
        this.ended = false;
        this.released = undefined;
        clients.push(this);
    }

    async connect() {}

    async query(text, params = []) {
        if (this.ended) throw new Error('Client was closed and is not queryable');
        if (this.busy) overlappingQueries += 1;
        this.busy = true;
        try {
            await new Promise(resolve => setImmediate(resolve));
            if (queryFault?.(this, text, params)) throw new Error('injected query failure');
            const result = runAdvisory(this, text, params);
            // The server has acted; only its reply is still on the way.
            await delayResponse?.(this, text, params);
            return result;
        } finally {
            this.busy = false;
        }
    }

    async end() {
        this.ended = true;
        for (const [key, hold] of advisory) if (hold.client === this) advisory.delete(key);
    }
}

class FakePool extends EventEmitter {
    async connect() {
        const client = new FakeClient();
        client.release = discard => {
            client.released = discard;
            if (discard) client.end();
        };
        return client;
    }
}

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
    if (request === 'pg') return { Client: FakeClient, Pool: FakePool };
    return originalLoad.call(this, request, ...rest);
};

process.env.DATABASE_URL = 'postgres://steamfusion_automation:x@127.0.0.1:1/db';
for (const name of ['DB_POOL_SIZE', 'AUTOMATION_MAINTENANCE_LOCK_POOL_MAX', 'MAINTENANCE_LOCK_POOL_MAX', 'DB_SSL']) {
    delete process.env[name];
}

const modulePath = require.resolve(process.env.RECONCILIATION_LOCK_SMOKE_MODULE
    ? path.resolve(process.env.RECONCILIATION_LOCK_SMOKE_MODULE)
    : '../src/jellyfin/reconciliation-lock');
let lock;

function loadLock(limit) {
    process.env.AUTOMATION_RECONCILIATION_MAX_CONCURRENCY = String(limit);
    delete require.cache[modulePath];
    lock = require(modulePath);
    assert.strictEqual(lock.MAX_CONCURRENCY, limit);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const holderOf = id => advisory.get(`${lock.LOCK_NAMESPACE}:${id}`)?.client || null;

function gate() {
    let open;
    const wait = new Promise(resolve => { open = resolve; });
    return { open, wait };
}

// Stands in for another process holding a key.
async function foreignHold(id) {
    const client = new FakeClient();
    assert.strictEqual(await lock.acquire(client, id, 0), true, `${id} must be free before a foreign hold`);
    return client;
}

async function captureConsole(method, run) {
    const original = console[method];
    const lines = [];
    console[method] = (...args) => lines.push(args);
    try { await run(); } finally { console[method] = original; }
    return lines;
}

// Another process must not be able to take any of these keys.
async function assertExcluded(...ids) {
    const foreign = new FakeClient();
    for (const id of ids) {
        assert.strictEqual(await lock.acquire(foreign, id, 0), false, `${id} must stay exclusively held`);
    }
}

// Starts a nested lock that stays held until finish() is called.
function heldNested(id) {
    const entered = gate();
    const release = gate();
    const state = { done: false, entered: entered.wait, finish: release.open };
    state.start = () => {
        state.promise = lock.withDatabaseLock(id, async () => {
            entered.open();
            await release.wait;
            state.done = true;
        });
        return state.promise;
    };
    return state;
}

function tracked(promise) {
    const state = { settled: false };
    state.promise = promise.finally(() => { state.settled = true; });
    state.promise.catch(() => {});
    return state;
}

function assertIdle() {
    const snapshot = lock.concurrencySnapshot();
    assert.strictEqual(snapshot.active, 0, 'no process slot may remain held');
    assert.strictEqual(snapshot.queued, 0, 'no waiter may remain queued');
    assert.deepStrictEqual([...advisory.keys()], [], 'no advisory lock may remain held');
}

async function scenario(name, run, limitMs = 10000) {
    let timer;
    const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
            `${name}: did not finish within ${limitMs}ms; slots=${JSON.stringify(lock.concurrencySnapshot())}`
        )), limitMs);
    });
    try {
        await Promise.race([run(), watchdog]);
        console.log(`  ok - ${name}`);
    } finally {
        clearTimeout(timer);
    }
}

async function concurrentNesting() {
    const before = clients.length;
    const nest = name => lock.withDatabaseLock(`customer-${name}`, async () => {
        await sleep(20);
        return lock.withDatabaseLock(`captainfin:stremio:install-credential:${name}`, async () => name);
    });
    assert.deepStrictEqual(await Promise.all([nest('a'), nest('b')]), ['a', 'b']);
    assert.strictEqual(clients.length - before, 2, 'nested locks must not open their own connections');
    assertIdle();
}

async function main() {
    loadLock(2);
    await scenario('two concurrent nested reconciliations complete with two slots', concurrentNesting, 8000);
    if (process.argv.includes('--nesting-only')) return;

    await scenario('triple nesting stays within two slots', async () => {
        const before = clients.length;
        const nest = name => lock.withDatabaseLock(`plan-${name}`, async () => {
            await sleep(20);
            return lock.withDatabaseLock(`source-${name}`, () =>
                lock.withDatabaseLock(`playback-${name}`, async () => {
                    assert.strictEqual(lock.concurrencySnapshot().active, 2);
                    assert.strictEqual(holderOf(`playback-${name}`), holderOf(`plan-${name}`));
                    await sleep(20);
                    return name;
                }));
        });
        assert.deepStrictEqual(await Promise.all([nest('a'), nest('b')]), ['a', 'b']);
        assert.strictEqual(clients.length - before, 2);
        assertIdle();
    });

    await scenario('nesting a key already held in the chain times out', async () => {
        let ran = false;
        const never = async () => { ran = true; };
        const started = Date.now();
        const attempts = await Promise.allSettled([
            lock.withDatabaseLock('direct', () => lock.withDatabaseLock('direct', never, { timeoutMs: 1000 })),
            lock.withDatabaseLock('outer', () => lock.withDatabaseLock('middle', () =>
                lock.withDatabaseLock('outer', never, { timeoutMs: 1000 })))
        ]);
        assert.deepStrictEqual(attempts.map(item => item.reason?.code),
            ['CUSTOMER_RECONCILIATION_LOCK_TIMEOUT', 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT']);
        assert.strictEqual(ran, false);
        assert(Date.now() - started >= 900, 'the same-key wait must use the normal lock deadline');
        assert.strictEqual(deepestHold, 1, 'PostgreSQL session reentrancy must never be relied upon');
        assertIdle();
    });

    await scenario('sibling calls for one key are serialised and other keys are not', async () => {
        const running = { same: 0, other: 0 };
        const peak = { same: 0, other: 0 };
        let completed = 0;
        const work = kind => async () => {
            running[kind] += 1;
            peak[kind] = Math.max(peak[kind], running[kind]);
            await sleep(60);
            running[kind] -= 1;
            completed += 1;
        };
        await lock.withDatabaseLock('sibling-parent', () => Promise.all([
            lock.withDatabaseLock('sibling', work('same')),
            lock.withDatabaseLock('sibling', work('same')),
            lock.withDatabaseLock('sibling', work('same'))
        ]));
        await lock.withDatabaseLock('sibling-parent', () => Promise.all([
            lock.withDatabaseLock('left', work('other')),
            lock.withDatabaseLock('right', work('other'))
        ]));
        assert.strictEqual(completed, 5);
        assert.strictEqual(peak.same, 1);
        assert.strictEqual(peak.other, 2);
        assert.strictEqual(deepestHold, 1);
        assertIdle();
    });

    await scenario('a failing nested callback releases only its own lock', async () => {
        await lock.withDatabaseLock('failure-parent', async () => {
            await assert.rejects(
                lock.withDatabaseLock('failure-child', async () => { throw new Error('child failed'); }),
                /child failed/
            );
            assert.strictEqual(holderOf('failure-child'), null);
            assert(holderOf('failure-parent'), 'the parent lock must survive');
            await lock.withDatabaseLock('failure-child', async () => {}, { timeoutMs: 1000 });
        });
        assertIdle();
    });

    await scenario('a nested lock still excludes other sessions', async () => {
        const foreign = await foreignHold('taken');
        await assert.rejects(
            lock.withDatabaseLock('exclusion-parent', () =>
                lock.withDatabaseLock('taken', async () => assert.fail('must not run'), { timeoutMs: 1000 })),
            { code: 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT' }
        );
        await foreign.end();
        assertIdle();
    });

    await scenario('a detached continuation uses a new connection', async () => {
        const parentClosed = gate();
        const before = clients.length;
        let late;
        await lock.withDatabaseLock('detached-parent', async () => {
            late = parentClosed.wait.then(() =>
                lock.withDatabaseLock('detached-child', async () => holderOf('detached-child')));
        });
        parentClosed.open();
        const holder = await late;
        assert.strictEqual(clients.length - before, 2);
        assert.strictEqual(holder, clients[before + 1]);
        assert(clients[before].ended && holder.ended);
        assertIdle();
    });

    await scenario('a nested waiter moves to its own connection when the parent closes', async () => {
        const foreign = await foreignHold('late-key');
        const before = clients.length;
        let late;
        await lock.withDatabaseLock('waiting-parent', async () => {
            late = lock.withDatabaseLock('late-key', async () => holderOf('late-key'));
            await sleep(150);
        });
        await sleep(150);
        await foreign.end();
        const holder = await late;
        assert.strictEqual(holder, clients[before + 1]);
        assertIdle();
    });

    await scenario('a late waiter cannot outlive the exclusion of a releasing level', async () => {
        const foreign = await foreignHold('late-grandchild');
        const inFlight = gate();
        let armed = false;
        delayResponse = async (_, text, params) => {
            if (!armed || !text.includes('pg_try_advisory_lock(') || params[1] !== 'late-grandchild') return;
            armed = false;
            inFlight.open();
            await sleep(30);
        };
        await lock.withDatabaseLock('race-root', async () => {
            const sharedClient = holderOf('race-root');
            let grandchild;
            await lock.withDatabaseLock('race-child', async () => {
                grandchild = lock.withDatabaseLock('late-grandchild', async () => {
                    await sleep(20);
                    return { holder: holderOf('late-grandchild'), childHeld: holderOf('race-child') !== null };
                });
                await sleep(50);
                // The next poll is granted, and this callback settles before the reply arrives.
                await foreign.end();
                armed = true;
                await inFlight.wait;
            });
            const outcome = await grandchild;
            assert(outcome.holder !== sharedClient || outcome.childHeld,
                'the grandchild kept running on the shared session after its parent level was released');
        });
        delayResponse = null;
        assertIdle();
    });

    await scenario('a parent keeps its lock until an un-awaited nested lock finishes', async () => {
        const child = heldNested('keep-child');
        const before = clients.length;
        const parent = tracked(lock.withDatabaseLock('keep-parent', async () => {
            child.start();
            await child.entered;
            return 'parent value';
        }));
        await child.entered;
        await sleep(150);
        assert.strictEqual(parent.settled, false, 'the parent must wait for its nested lock');
        assert.strictEqual(clients[before].ended, false);
        assert.strictEqual(lock.concurrencySnapshot().active, 1, 'the parent keeps its slot');
        await assertExcluded('keep-parent', 'keep-child');
        child.finish();
        assert.strictEqual(await parent.promise, 'parent value');
        await child.promise;
        assertIdle();
    });

    await scenario('a fail-fast Promise.all sibling does not drop a running nested lock', async () => {
        const slow = heldNested('slow-sibling');
        const parent = tracked(lock.withDatabaseLock('failfast-parent', () => Promise.all([
            slow.start(),
            slow.entered.then(() => { throw new Error('sibling failed'); })
        ])));
        await slow.entered;
        await sleep(150);
        assert.strictEqual(parent.settled, false);
        await assertExcluded('failfast-parent', 'slow-sibling');
        slow.finish();
        await assert.rejects(parent.promise, /sibling failed/);
        assert.strictEqual(slow.done, true);
        assertIdle();
    });

    await scenario('an intermediate level also waits for what is nested under it', async () => {
        const leaf = heldNested('leaf');
        const root = tracked(lock.withDatabaseLock('level-root', async () => {
            const middle = tracked(lock.withDatabaseLock('level-middle', () => Promise.all([
                leaf.start(),
                leaf.entered.then(() => { throw new Error('middle failed'); })
            ])));
            await leaf.entered;
            await sleep(150);
            assert.strictEqual(middle.settled, false);
            await assertExcluded('level-root', 'level-middle', 'leaf');
            leaf.finish();
            await assert.rejects(middle.promise, /middle failed/);
            assert.strictEqual(holderOf('level-middle'), null);
        }));
        await root.promise;
        assertIdle();
    });

    await scenario('a long wait for nested locks is logged', async () => {
        const realSetInterval = global.setInterval;
        global.setInterval = (callback, ms, ...rest) =>
            realSetInterval(callback, ms === lock.NESTED_WAIT_WARNING_MS ? 20 : ms, ...rest);
        try {
            const child = heldNested('long-child');
            const warnings = await captureConsole('warn', async () => {
                const parent = lock.withDatabaseLock('long-parent', async () => {
                    child.start();
                    await child.entered;
                });
                await sleep(120);
                child.finish();
                await parent;
            });
            assert(warnings.some(args => /still waiting for nested locks/.test(String(args[0]))
                && args[1].customerId === 'long-parent' && args[1].nestedLocks === 1));
        } finally {
            global.setInterval = realSetInterval;
        }
        assertIdle();
    });

    await scenario('runWithLockSession waits for nested locks before handing back the client', async () => {
        const external = new FakeClient();
        const child = heldNested('hosted-detached');
        let unsafe = 0;
        const run = tracked(lock.runWithLockSession(external, async () => {
            child.start();
            await child.entered;
        }, { onUnsafe: () => { unsafe += 1; } }));
        await child.entered;
        await sleep(150);
        assert.strictEqual(run.settled, false);
        await assertExcluded('hosted-detached');
        child.finish();
        await run.promise;
        assert.strictEqual(unsafe, 0);
        assertIdle();
    });

    await scenario('work detached from a closing parent takes its own session', async () => {
        const child = heldNested('closing-child');
        const parentSettled = gate();
        const before = clients.length;
        let detached;
        let nestedUnderChild;
        const parent = tracked(lock.withDatabaseLock('closing-parent', async () => {
            lock.withDatabaseLock('closing-holder', async () => {
                child.start();
                await child.entered;
                await parentSettled.wait;
                await sleep(20);
                // A callback still running under the parent keeps sharing its session.
                await lock.withDatabaseLock('under-holder', async () => { nestedUnderChild = holderOf('under-holder'); });
                await child.promise;
            });
            // Detached from the parent callback itself, resuming after it settled.
            detached = parentSettled.wait.then(() => sleep(10)).then(() => lock.withDatabaseLock('closing-detached',
                async () => ({ holder: holderOf('closing-detached'), active: lock.concurrencySnapshot().active })));
            await child.entered;
        }));
        await child.entered;
        parentSettled.open();
        const outcome = await detached;
        assert.notStrictEqual(outcome.holder, clients[before], 'detached work must not extend the closing session');
        assert.strictEqual(outcome.active, 2, 'it takes a slot of its own');
        await sleep(60);
        assert.strictEqual(nestedUnderChild, clients[before]);
        assert.strictEqual(parent.settled, false);
        await assertExcluded('closing-parent', 'closing-child');
        child.finish();
        await parent.promise;
        assertIdle();
    });

    await scenario('a failed nested unlock is logged and the session releases the lock', async () => {
        const failures = lock.metricsSnapshot().cleanupFailures;
        queryFault = (_, text, params) => text.includes('pg_advisory_unlock(') && params[1] === 'stuck-child';
        const errors = await captureConsole('error', () => lock.withDatabaseLock('stuck-parent', async () => {
            assert.strictEqual(await lock.withDatabaseLock('stuck-child', async () => 'value'), 'value');
        }));
        queryFault = null;
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(lock.metricsSnapshot().cleanupFailures, failures + 1);
        assertIdle();
    });

    await scenario('runWithLockSession uses the given client and no process slot', async () => {
        const release = gate();
        const occupants = ['busy-1', 'busy-2'].map(id => lock.withDatabaseLock(id, () => release.wait));
        await sleep(20);
        const external = new FakeClient();
        const before = clients.length;
        let unsafe = 0;
        await lock.runWithLockSession(external, () => lock.withDatabaseLock('hosted', () =>
            lock.withDatabaseLock('hosted-nested', async () => {
                assert.deepStrictEqual(lock.concurrencySnapshot(), { active: 2, queued: 0, limit: 2 });
                assert.strictEqual(holderOf('hosted'), external);
                assert.strictEqual(holderOf('hosted-nested'), external);
                assert.strictEqual(clients.length, before);
            })), { onUnsafe: () => { unsafe += 1; } });
        assert.strictEqual(unsafe, 0);
        assert.strictEqual(external.ended, false, 'a borrowed client must never be ended by the lock module');
        assert.strictEqual(external.listenerCount('error'), 0);
        assert.strictEqual(holderOf('hosted'), null);
        release.open();
        await Promise.all(occupants);
        assertIdle();
    });

    await scenario('runWithLockSession reports a client that cannot be reused', async () => {
        for (const failing of ['pg_advisory_unlock(', 'pg_try_advisory_lock(']) {
            const external = new FakeClient();
            let unsafe = 0;
            queryFault = (client, text) => client === external && text.includes(failing);
            await captureConsole('error', () => lock.runWithLockSession(external, async () => {
                const attempt = lock.withDatabaseLock('unsafe-key', async () => {});
                if (failing === 'pg_advisory_unlock(') await attempt;
                else await assert.rejects(attempt, /injected query failure/);
                // The failed session is abandoned for later locks.
                const before = clients.length;
                await lock.withDatabaseLock('after-failure', async () => {
                    assert.strictEqual(holderOf('after-failure'), clients[before]);
                });
            }, { onUnsafe: () => { unsafe += 1; } }));
            queryFault = null;
            assert.strictEqual(unsafe, 1);
            await external.end();
        }
        assertIdle();
    });

    await scenario('stremio_media_index style jobs lock on their own job client', async () => {
        const jobHealth = require('../src/automation/job-health');
        const operationLock = require('../src/stremio/operation-lock');
        const key = operationLock.key('managed-index:1');

        let before = clients.length;
        const jobRunning = gate();
        // Registered outside the job's async context, like a web-process caller.
        const webCaller = jobRunning.wait.then(() => assert.rejects(
            operationLock.withLock('managed-index:1', async () => assert.fail('must not run'), { timeoutMs: 1000 }),
            { code: 'STREMIO_OPERATION_LOCK_TIMEOUT' }
        ));
        const hosted = await jobHealth.runSingleton('stremio_media_index', () =>
            operationLock.withLock('managed-index:1', async () => {
                assert.strictEqual(holderOf(key), clients[before]);
                assert.strictEqual(lock.concurrencySnapshot().active, 0);
                jobRunning.open();
                await webCaller;
                return { processed: 1 };
            }), { hostLocks: true });
        assert.strictEqual(hosted.outcome, 'success');
        assert.strictEqual(clients[before].released, false, 'a clean job client returns to the pool');
        assertIdle();

        before = clients.length;
        await jobHealth.runSingleton('policy_drift', () => operationLock.withLock('managed-index:1', async () => {
            assert.strictEqual(holderOf(key), clients[before + 1], 'other jobs keep dedicated lock connections');
            assert.strictEqual(lock.concurrencySnapshot().active, 1);
        }));
        assertIdle();

        before = clients.length;
        queryFault = (client, text, params) => text.includes('pg_advisory_unlock(') && params[1] === key;
        await captureConsole('error', () => jobHealth.runSingleton('stremio_media_index', () =>
            operationLock.withLock('managed-index:1', async () => {}), { hostLocks: true }));
        queryFault = null;
        assert.strictEqual(clients[before].released, true, 'a job client still holding a lock must be destroyed');
        assertIdle();

    });

    loadLock(1);

    await scenario('a queued caller waits for a slot beyond its database lock timeout', async () => {
        const first = lock.withDatabaseLock('first', () => sleep(1400));
        const started = Date.now();
        await lock.withDatabaseLock('second', async () => {
            assert.strictEqual(holderOf('second').listenerCount('error'), 0,
                'a dropped lock connection must not be swallowed while its callback continues');
        }, { timeoutMs: 1000 });
        assert(Date.now() - started >= 1300, 'the slot queue must not apply the lock timeout');
        await first;
        const metrics = lock.metricsSnapshot();
        assert.strictEqual(metrics.failed, 0);
        assert.strictEqual(metrics.started, metrics.succeeded);
        assertIdle();
    });

    await scenario('the only slot is kept while nested work is still running', async () => {
        const child = heldNested('one-slot-child');
        const parent = lock.withDatabaseLock('one-slot-parent', async () => {
            child.start();
            await child.entered;
        });
        await child.entered;
        const next = tracked(lock.withDatabaseLock('one-slot-next', async () => {}));
        await sleep(100);
        assert.strictEqual(next.settled, false);
        assert.deepStrictEqual(lock.concurrencySnapshot(), { active: 1, queued: 1, limit: 1 });
        child.finish();
        await Promise.all([parent, next.promise]);
        assertIdle();
    });

    await scenario('nesting needs no second slot when only one exists', async () => {
        await lock.withDatabaseLock('single', () => lock.withDatabaseLock('single-child', async () => {}));
        assertIdle();
    });

    assert.strictEqual(overlappingQueries, 0, 'a shared client must never run two queries at once');
}

main().then(() => {
    console.log('reconciliation lock nesting smoke: ok');
    process.exit(0);
}).catch(error => {
    console.error('reconciliation lock nesting smoke: FAILED');
    console.error(error);
    process.exit(1);
});
