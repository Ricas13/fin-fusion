'use strict';

const assert = require('assert');
const sync = require('../src/integrations/request-user-sync');

(async()=>{
  const indexes = sync.indexesFor([]);
  const created = { id: 77, email: 'race@example.test', username: 'race-user' };
  let refreshCalls = 0;
  const recovered = await sync.createExternalUserConvergently({
    candidate: { customer_id: '00000000-0000-4000-8000-000000000001' },
    indexes,
    email: 'race@example.test',
    username: 'race-user',
    password: 'irrelevant-test-password',
    createUser: async()=>{ throw new Error('User already exists with submitted email.'); },
    listUsers: async()=>{ refreshCalls++; return [created]; }
  });
  assert.strictEqual(recovered.created,false);
  assert.strictEqual(recovered.recoveredConcurrentCreate,true);
  assert.strictEqual(Number(recovered.external.id),77);
  assert.strictEqual(indexes.byId.get('77'),created);
  assert.strictEqual(indexes.byEmail.get('race@example.test'),created);
  assert.strictEqual(refreshCalls,1);

  const original = new Error('upstream create failed');
  await assert.rejects(()=>sync.createExternalUserConvergently({
    candidate: {},
    indexes: sync.indexesFor([]),
    email: 'missing@example.test',
    username: 'missing',
    password: 'irrelevant-test-password',
    createUser: async()=>{ throw original; },
    listUsers: async()=>[]
  }),error=>error===original);

  let refreshedAfterSuccess = false;
  const success = await sync.createExternalUserConvergently({
    candidate: {},
    indexes: sync.indexesFor([]),
    email: 'new@example.test',
    username: 'new-user',
    password: 'irrelevant-test-password',
    createUser: async()=>({ id: 88, email: 'new@example.test', username: 'new-user' }),
    listUsers: async()=>{ refreshedAfterSuccess=true; return []; }
  });
  assert.strictEqual(success.created,true);
  assert.strictEqual(success.recoveredConcurrentCreate,false);
  assert.strictEqual(refreshedAfterSuccess,false);
  console.log('request user sync race static smoke: ok');
})().catch(error=>{console.error(error);process.exitCode=1;});
