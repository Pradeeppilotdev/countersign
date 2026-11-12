export const weeklySteps=['Two signed bills','One payment','Worker crashes','Retry both bills'];
export function weeklyFrame(evidence,index){
  if(!Number.isInteger(index)||index<0||index>=weeklySteps.length)throw Error('Unknown replay checkpoint');
  const w=evidence.weekly, balance=index===0?w.before:index===3?w.final:w.paid;
  const descriptions=[
    `Two different signed bills request ${w.amount} NEAR each for the same enrolled service week. No payment has been made at this checkpoint.`,
    `${w.winner} claimed the week and settled. ${w.loser} was blocked: the service period was already claimed.`,
    'The transfer had settled on chain, but the worker journal still said “claimed”. The recorded test killed the worker with SIGKILL at this point.',
    `A fresh worker recovered the original attempt. Both bills were retried: ${w.winner} remained settled and ${w.loser} remained blocked. Extra credit: 0.00 NEAR.`
  ];
  return {title:weeklySteps[index],description:descriptions[index],balance,
    worker:index===0?'Not started':index===1?'Awaiting acknowledgement':index===2?'Stopped · journal: claimed':'Reconciled · settled',
    bills:w.bills.map(b=>({...b,state:index===0?'Received':b.invoice===w.winner?'Settled':'Blocked'})),
    attempt:index===0?null:w.attempt,extra:index===3?'0.00':null};
}
