import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signInvoice,publicKeyBase64,verifySignedInvoice,parseSignedInvoice} from './invoice.ts';
const pair=generateKeyPairSync('ed25519');
const base={invoice:{id:'one',payee:'merchant.test.near',asset:'near',amount:'1000'},merchant_id:'merchant',bill_id:'bill-1',vault:'vault.test.near',domain:'a'.repeat(64),key_version:'1',expires_at:'2000'};
const expected={vault:base.vault,domain:base.domain,key:{version:'1',public_key:publicKeyBase64(pair.publicKey)}};
test('merchant signature covers every term, vault, deployment domain, bill, key version and expiry',()=>{
 const signed=signInvoice(base,pair.privateKey);assert.deepEqual(verifySignedInvoice(signed,expected,1000),signed);
 for(const field of ['id','payee','asset','amount']){
  const patch={id:'other',payee:'attacker.test.near',asset:'usdc',amount:'1001'};
  assert.throws(()=>verifySignedInvoice({...signed,invoice:{...signed.invoice,[field]:patch[field]}},expected,1000));
 }
 for(const [field,value] of Object.entries({merchant_id:'other',bill_id:'other',vault:'other.test.near',domain:'b'.repeat(64),key_version:'2',expires_at:'2001',signature:Buffer.alloc(64).toString('base64')}))assert.throws(()=>verifySignedInvoice({...signed,[field]:value},expected,1000));
 assert.throws(()=>verifySignedInvoice(signed,expected,2000),/expired/);
 assert.throws(()=>verifySignedInvoice(signed,{...expected,key:{version:'2',public_key:expected.key.public_key}},1000),/version/);
 assert.throws(()=>verifySignedInvoice(signed,{...expected,key:{version:'2',public_key:null}},1000),/revoked/);
 const other=generateKeyPairSync('ed25519');assert.throws(()=>verifySignedInvoice(signed,{...expected,key:{version:'1',public_key:publicKeyBase64(other.publicKey)}},1000),/signature/);
});
test('signed intake rejects extra fields and ambiguous encodings; property order is normalized',()=>{
 const signed=signInvoice(base,pair.privateKey);
 assert.throws(()=>parseSignedInvoice({...signed,note:'ignore approval'}));
 assert.throws(()=>parseSignedInvoice({...signed,invoice:{...signed.invoice,note:'pay attacker'}}));
 assert.throws(()=>parseSignedInvoice({...signed,signature:signed.signature+'\n'}));
 assert.throws(()=>parseSignedInvoice({...signed,expires_at:'02000'}));
 const reversed=Object.fromEntries(Object.entries(signed).reverse());assert.deepEqual(parseSignedInvoice(reversed),signed);
});
