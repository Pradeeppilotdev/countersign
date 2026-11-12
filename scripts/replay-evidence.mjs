// Build-time checks over committed public records. Never reads a vault or signs.
export function near(value) {
  if (!/^\d+$/.test(String(value))) throw Error('Invalid recorded amount');
  const n=BigInt(value), unit=10n**24n;
  return `${n/unit}.${String(n%unit).padStart(24,'0').replace(/0+$/,'').padEnd(2,'0')}`;
}
function check(value,message){if(!value)throw Error('Invalid replay evidence: '+message);}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const decoded=tx=>JSON.parse(Buffer.from(tx.status.SuccessValue,'base64').toString('utf8'));
function receipt(tx,vault,executor){
  check(/^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(tx.hash),'transaction hash');
  check(tx.link===`https://testnet.nearblocks.io/txns/${tx.hash}`,'explorer destination');
  check(tx.signer===executor&&tx.receiver===vault,'transaction accounts');
  return {hash:tx.hash,link:tx.link,signer:tx.signer,receiver:tx.receiver,status:tx.status,
    receipts:tx.receipts.map(r=>({id:r.id,executor:r.executor,status:r.status}))};
}
export function compileEvidence(local,cafe,verification){
  check(local.result==='PASS'&&local.network==='LOCAL_SANDBOX','local run');
  const w=local.weekly, win=w.final.records.find(r=>r.id===w.winner), paid=w.paid.records.find(r=>r.id===w.winner);
  check(w.billIds.length===2&&new Set(w.billIds.map(b=>b.bill)).size===2&&new Set(w.billIds.map(b=>b.invoice)).size===2,'two different bills');
  check(w.billIds.some(b=>b.invoice===w.winner)&&w.billIds.some(b=>b.invoice===w.loser)&&w.winner!==w.loser,'winner and blocked bill');
  check(win?.payment.state==='Settled'&&win.auth?.payload_hash&&same(win,paid),'settled signed receipt unchanged');
  check(win.payment.invoice.amount==='40000000000000000000000'&&win.payment.invoice.payee===local.payee,'weekly payment terms');
  check(w.final.records.find(r=>r.id===w.loser)?.payment===null,'loser never paid');
  check(w.base.claim===null&&w.paid.claim===w.winner&&w.final.claim===w.winner,'service claim');
  check(w.signal==='SIGKILL'&&w.stateAtCrash==='claimed','recorded crash');
  check(w.finalAttempts.length===1&&w.finalAttempts[0].state==='settled'&&w.finalAttempts[0].attempt_id===w.attempt&&win.payment.attempt_id===w.attempt,'one settled attempt');
  const delta=BigInt(w.paid.merchantBalance)-BigInt(w.base.merchantBalance);
  check(delta===BigInt(win.payment.invoice.amount)&&w.final.merchantBalance===w.paid.merchantBalance,'merchant credited once');
  check(BigInt(w.base.available)-BigInt(w.paid.available)===delta&&w.final.available===w.paid.available,'vault debited once');
  check(w.merchantDeltaNEAR===near(delta)&&w.retryDeltaNEAR==='0.00','reported balance deltas');
  check(cafe.network==='testnet'&&cafe.live_model_calls===0,'testnet fixture run');
  const descriptions={paid:['Valid signed bill','The pinned supplier’s signed bill met the policy. The vault settled it once.'],
    tampered:['Tampered payee','The signed bill was edited to pay another account. The contract rejected the invalid signature.'],
    duplicate:['Duplicate bill','A different invoice ID reused a supplier bill ID that had already been paid. The contract rejected it.'],
    over_budget:['Over budget','This bill would exceed the saved rolling budget. The contract rejected it.'],
    restart:['Crash & resume','The worker was killed after reservation. A fresh worker resumed the same attempt, settled it, then retried without extra credit.']};
  const expectedErrors={tampered:'invalid merchant signature',duplicate:'merchant bill already used',over_budget:'rolling daily budget exceeded'};
  const cases=Object.entries(descriptions).map(([id,[title,explanation]])=>{
    const c=cafe.cases[id], success=id==='paid'||id==='restart';
    const tx=receipt(c.outcome,cafe.accounts.vault,cafe.accounts.executor);
    let payment=null, credited='0.00', replay=null, reserve=null;
    if(success){
      payment=decoded(c.outcome);
      check(payment.state==='Settled'&&same(payment.invoice,c.invoice),'testnet settled invoice');
      check(BigInt(c.merchant_after.amount)-BigInt(c.merchant_before.amount)===BigInt(c.invoice.amount),'testnet credited amount');
      check(c.credited_yocto===c.invoice.amount&&c.extra_on_replay_yocto==='0'&&c.merchant_after.amount===c.merchant_after_replay.amount,'testnet replay balance');
      check(same(decoded(c.replay),payment),'same replay receipt');
      credited=near(c.credited_yocto);replay=receipt(c.replay,cafe.accounts.vault,cafe.accounts.executor);
      if(id==='restart'){
        check(c.killed.signal==='SIGKILL'&&c.observed_before_kill.payment.state==='Reserved'&&c.observed_before_kill.payment.attempt_id===payment.attempt_id,'testnet reservation crash');
        reserve=receipt(c.reserve,cafe.accounts.vault,cafe.accounts.executor);
      }
    }else check(c.outcome.status.Failure&&JSON.stringify(c.outcome.status).includes(expectedErrors[id]),'recorded rejection reason');
    return {id,title,explanation,invoice:c.invoice,amount:near(c.invoice.amount),state:success?'Settled':'Blocked',credited,retry:success?'0.00':null,
      reason:success?'Transfer confirmed by the vault callback.':expectedErrors[id],payment,transaction:tx,replay,reserve};
  });
  check(verification.network==='testnet'&&Number.isFinite(Date.parse(verification.checked_at)),'verification record');
  for(const c of cases)for(const tx of [c.transaction,c.replay,c.reserve].filter(Boolean))
    check(verification.transactions.some(v=>v.hash===tx.hash&&v.status_matches_record===true&&v.final_execution_status==='FINAL'),'verified public receipt');
  return {mode:'RECORDED_DEMO',newPayments:false,liveModelCalls:0,
    weekly:{vault:local.vault,payee:local.payee,service:w.service,week:new Date(Number(w.service.period_start_ms)).toISOString().slice(0,10),
      bills:w.billIds,winner:w.winner,loser:w.loser,amount:near(delta),attempt:w.attempt,reason:w.reason,
      before:{block:w.base.height,available:near(w.base.available),received:'0.00'},
      paid:{block:w.paid.height,available:near(w.paid.available),received:near(delta)},
      final:{block:w.final.height,available:near(w.final.available),received:near(delta)},receipt:win},
    cafe:{network:'testnet',recordedAt:cafe.completed_at,vault:cafe.accounts.vault,merchant:cafe.accounts.merchant,cases},verification};
}
