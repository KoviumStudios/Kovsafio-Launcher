'use strict';
// Source-only here. Execute on the remote CI worker, never on the owner's PC.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createAdminRunnerProfiles}=require(path.join(process.env.KOVIUM_ADMIN_TEST_SOURCE||path.join(__dirname,'admin-app-v193'),'admin-runner-profiles'));
const id='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222';
test('administrator bridge addresses stable account IDs and encodes searches without a credential renderer API',async()=>{
 const calls=[],service=createAdminRunnerProfiles({request:async(...args)=>{calls.push(args);return {ok:true};}});
 await service.list({q:'name & user',cursor:'page:2'});await service.get(id);await service.audit(id,'audit:2');
 assert.equal(calls[0][0],'/v1/admin/runner/profiles?q=name+%26+user&cursor=page%3A2');
 assert.deepEqual(calls[1],['/v1/admin/runner/profiles/'+id,{method:'GET'}]);
 assert.equal(calls[2][0],'/v1/admin/runner/profiles/'+id+'/audit?cursor=audit%3A2');
 await assert.rejects(service.get('username'),/perfil válido/);
 await assert.rejects(service.get(id+'/../../publishing/sign'),/perfil válido/);
 assert.deepEqual(Object.keys(service).sort(),['adjust','audit','get','list']);
});
test('absolute balance, monotonic revision and operation ID travel unchanged on retry',async()=>{
 const calls=[],service=createAdminRunnerProfiles({request:async(...args)=>{calls.push(args);return {ok:true};}}),payload={accountId:id,bestScore:100000001,coinsTotal:1000000001,reason:'Compensación por conexión perdida',expectedRevision:7,operationId:op,unrelatedSecret:'never forwarded'};
 await service.adjust(payload);await service.adjust(payload);
 assert.equal(calls[0][0],'/v1/admin/runner/profiles/'+id);assert.equal(calls[0][1].method,'PATCH');assert.equal(calls[0][1].body,calls[1][1].body);
 const body=JSON.parse(calls[0][1].body);assert.equal(body.coinsTotal,payload.coinsTotal);assert.equal(body.expectedRevision,7);assert.equal(body.operationId,op);assert(!('unrelatedSecret' in body));assert(!('accountId' in body));
 for(const bad of [{bestScore:-1},{coinsTotal:1.5},{coinsTotal:Number.MAX_SAFE_INTEGER+1},{expectedRevision:'7'},{reason:'abc'},{operationId:'arbitrary'},{accountId:'../../auth'}])await assert.rejects(service.adjust({...payload,...bad}));
 assert.equal(calls.length,2,'invalid operations must not reach the network');
});
test('server authentication and conflict errors reach the guarded main handler with their status',async()=>{
 for(const httpStatus of [401,403,409]){
  const error=Object.assign(Error('server refused'),{httpStatus}),service=createAdminRunnerProfiles({request:async()=>{throw error;}});
  await assert.rejects(service.get(id),value=>value===error&&value.httpStatus===httpStatus);
 }
});
