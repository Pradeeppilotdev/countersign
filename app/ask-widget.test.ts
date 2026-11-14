import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAskWidget} from './public/ask-widget.js';
import {askCard, applyAsk, questionBox, splitAnswer, createAskHistory, showHistory, HISTORY_KEY, HISTORY_MAX} from './public/ask-shared.js';
import {readFileSync} from 'node:fs';

// Exercise the real browser modules with HTTP mocked, without a model or chain.
class Element {
  tag:string; children:Element[]=[]; parent:Element|null=null;
  attributes:Record<string,string>={}; handlers:Record<string,Function>={};
  className=''; value=''; hidden=false; disabled=false; id=''; private text='';
  style:{height:string}={height:''}; scrollHeight=42; submission:unknown;
  constructor(tag:string){this.tag=tag;}
  get childElementCount(){return this.children.length;}
  get lastElementChild(){return this.children.at(-1)!;}
  get isConnected():boolean{return this === (globalThis as any).document.body || !!this.parent?.isConnected;}
  get classList(){return {
    add:(name:string)=>{this.className+=' '+name;},
    remove:(name:string)=>{this.className=this.className.split(' ').filter(n=>n!==name).join(' ');},
  };}
  get textContent():string{return this.text+this.children.map(n=>n.textContent).join('');}
  set textContent(value:string){this.replaceChildren();this.text=String(value);}
  append(...nodes:Element[]){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
  prepend(n:Element){n.remove();n.parent=this;this.children.unshift(n);}
  insertBefore(n:Element,before:Element){n.remove();n.parent=this;this.children.splice(this.children.indexOf(before),0,n);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
  replaceChildren(...nodes:Element[]){for(const n of [...this.children])n.remove();this.text='';this.append(...nodes);}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
  addEventListener(name:string,handler:Function){this.handlers[name]=handler;}
  contains(n:Element):boolean{return this===n || this.children.some(child=>child.contains(n));}
  getClientRects():object[]{return this.hidden || !this.isConnected || this.parent?.getClientRects().length===0 ? [] : [{}];}
  focus(){(globalThis as any).document.activeElement=this;}
  requestSubmit(){this.submission=this.event('submit');}
  find(predicate:(n:Element)=>boolean):Element|undefined{
    if(predicate(this))return this;
    for(const n of this.children){const found=n.find(predicate);if(found)return found;}
  }
  event(name:string,extra={}){return this.handlers[name]?.({currentTarget:this,preventDefault(){},...extra});}
}
function setup(t:any,history=createAskHistory({storage:null})){
  const body=new Element('body'), handlers:Record<string,Function>={};
  const dom={body,activeElement:body,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag),
    querySelector:(selector:string)=>selector==='[data-view="ask-dave"]'?body.find(n=>n.attributes['data-view']==='ask-dave'):null,addEventListener:(name:string,fn:Function)=>handlers[name]=fn};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{value:dom,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;});
  const fullInput=new Element('input');body.append(fullInput);
  const navLink=new Element('a');navLink.setAttribute('data-view','ask-dave');body.append(navLink);
  const widget=createAskWidget({history,onNavigate:()=>{widget.setOnAskDaveView(true);fullInput.focus();}});
  const panel=widget.panel as Element, button=widget.button as Element;
  const input=panel.find(n=>n.tag==='textarea')!, form=panel.find(n=>n.tag==='form')!;
  const answers=panel.find(n=>n.className.includes('ask-widget-answers '))!;
  const bill=new Element('button');body.append(bill);
  return {widget,panel,button,input,form,answers,bill,dom,handlers,fullInput,navLink,history};
}
const reply=(text:string,ok=true)=>({ok,json:async()=>ok?{ok:true,text}:{ok:false,error:text}} as Response);

test('bubble and bill buttons only open/prefill; an open panel accepts the next bill',async t=>{
  const {widget,panel,button,input,bill,dom}=setup(t);
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('Opening must not request a model');});
  assert.equal(button.textContent,'Ask Dave');
  assert.equal(button.find(n=>n.tag==='svg')?.attributes['aria-hidden'],'true');
  button.event('click');
  assert.equal(panel.hidden,false);assert.equal(input.value,'');assert.equal(dom.activeElement,input);
  assert.equal(button.attributes['aria-controls'],panel.id);assert.equal(button.attributes['aria-expanded'],'true');
  assert.equal(panel.attributes.role,'dialog');assert.equal(panel.attributes['aria-modal'],undefined);
  widget.askForBill({id:'INV-1',outcome:'blocked'},bill);
  assert.equal(input.value,'Why was INV-1 blocked?');
  widget.askForBill({id:'INV-2',outcome:'paid'},bill);
  assert.equal(input.value,'Was INV-2 paid?');assert.equal(fetch.mock.callCount(),0);
  panel.find(n=>n.className.includes('ask-widget-close'))!.event('click');
  assert.equal(dom.activeElement,bill);assert.equal(panel.hidden,true);
});

test('non-modal Escape preserves outside focus, returns inside focus, and navigation hides the bubble',t=>{
  const {widget,panel,button,input,bill,dom,handlers,fullInput}=setup(t);
  widget.askForBill({id:'INV-1',outcome:'blocked'},bill);
  let prevented=false;
  handlers.keydown({key:'Tab',preventDefault(){prevented=true;}});assert.equal(prevented,false);
  handlers.keydown({key:'Escape',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(dom.activeElement,bill);
  button.event('click');fullInput.focus();
  handlers.keydown({key:'Escape',preventDefault(){}});assert.equal(dom.activeElement,fullInput);
  button.event('click');assert.equal(dom.activeElement,input);
  panel.find(n=>n.tag==='a')!.event('click');
  assert.equal(panel.hidden,true);assert.equal(button.hidden,true);assert.equal(dom.activeElement,fullInput);
  assert.equal(button.parent!.hidden,true);assert.ok(!dom.body.className.includes('has-dave-launcher'));
  widget.setOnAskDaveView(false);assert.equal(button.hidden,false);
  assert.equal(button.parent!.hidden,false);assert.ok(dom.body.className.includes('has-dave-launcher'));
  widget.open();assert.equal(widget.setOnAskDaveView(true),true);
  assert.equal(panel.hidden,true);
});

test('closing Dave returns focus to navigation when the mobile launcher and old bill are unavailable',t=>{
  const {widget,panel,button,bill,navLink,dom}=setup(t);
  widget.askForBill({id:'INV-1',outcome:'paid'},bill);
  bill.remove();button.hidden=true;
  panel.find(n=>n.className.includes('ask-widget-close'))!.event('click');
  assert.equal(panel.hidden,true);assert.equal(dom.activeElement,navLink);
});

test('429 is an error card; submitted text remains available to retry and is never HTML',async t=>{
  const {widget,input,form,answers,dom}=setup(t);widget.open();
  const message='Ask Dave is busy, try again in a moment. <img src=x onerror=alert(1)>';
  const fetch=t.mock.method(globalThis,'fetch',async()=>reply(message,false));
  input.value='Why was INV-1 blocked?';form.find(n=>n.tag==='button')!.focus();await form.event('submit');
  assert.equal(dom.activeElement,input);
  assert.equal(fetch.mock.callCount(),1);
  assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1]!.body as string),{kind:'question',text:input.value});
  assert.ok(answers.find(n=>n.className.includes('has-error')));
  assert.ok(answers.textContent.includes(message));assert.equal(answers.find(n=>n.tag==='img'),undefined);
});

test('both question boxes send on Enter, add a line on Shift+Enter, and grow',t=>{
  const {input,form}=setup(t);
  assert.equal(input.tag,'textarea');
  const html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
  assert.match(html,/<textarea\s+id="ask-text"[\s\S]*?<\/textarea>/);
  const pageInput=new Element('textarea'),pageForm=new Element('form');
  const page=questionBox(pageInput,pageForm);
  for(const [box,owner] of [[input,form],[pageInput,pageForm]] as const){
    let prevented=false,submitted=0;
    owner.addEventListener('submit',()=>{submitted++;});
    box.value='First line';box.event('keydown',{key:'Enter',shiftKey:true,preventDefault(){prevented=true;}});
    assert.equal(prevented,false);assert.equal(submitted,0);
    box.value+='\nSecond line';box.scrollHeight=72;box.event('input');assert.equal(box.style.height,'74px');
    box.event('keydown',{key:'Enter',shiftKey:false,preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.equal(submitted,1);
  }
  page.clear();assert.equal(pageInput.value,'');
});

test('verified reply folds records and Sources; plain facts stay visible',t=>{
  setup(t);
  const text='Dave says hello.\nAnother line.\n\n[INV-1] Paid.\nSources: vault at block 9';
  assert.deepEqual(splitAnswer(text),{reply:'Dave says hello.\nAnother line.',records:'[INV-1] Paid.\nSources: vault at block 9'});
  const {head,body}=askCard('Question');
  assert.equal(applyAsk(new Element('article'),head,body,{ok:true,text}),true);
  const toggle=body.find(n=>n.className==='ask-records-toggle')!,records=body.find(n=>n.className==='ask-records')!;
  assert.equal(body.children[0].textContent,'Dave says hello.');
  assert.equal(toggle.textContent,'Show the vault records');
  assert.equal(toggle.attributes['aria-expanded'],'false');
  assert.equal(toggle.attributes['aria-controls'],records.id);
  assert.equal(records.hidden,true);assert.match(records.textContent,/Sources: vault at block 9/);
  toggle.event('click');assert.equal(records.hidden,false);assert.equal(toggle.attributes['aria-expanded'],'true');
  toggle.event('click');assert.equal(records.hidden,true);assert.equal(toggle.attributes['aria-expanded'],'false');
  const plain=askCard('Plain');
  const facts='[INV-1] Paid.\nSources: vault at block 9';
  applyAsk(plain.card,plain.head,plain.body,{ok:true,text:facts});
  assert.equal(splitAnswer(facts),null);
  assert.equal(plain.body.find(n=>n.className==='ask-records-toggle'),undefined);
  assert.deepEqual(plain.body.children.map(n=>n.textContent),facts.split('\n'));
});

test('successful Ask clears its question; a failed Ask keeps it for retry',async t=>{
  const {widget,input,form}=setup(t);widget.open();
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>++calls===1?reply('No answer.',false):reply('A verified answer.'));
  input.value='Why did it fail?';await form.event('submit');
  assert.equal(input.value,'Why did it fail?');
  await form.event('submit');
  assert.equal(input.value,'');assert.equal(calls,2);
});

test('history stays at three during requests, duplicate submits are ignored, and newer drafts survive',async t=>{
  const {widget,input,form,answers,bill}=setup(t);widget.open();
  let finish:(r:Response)=>void=()=>{};
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return calls===4?new Promise<Response>(r=>finish=r):reply('Answer');});
  for(let i=1;i<=3;i++){input.value=`Question ${i}`;await form.event('submit');}
  input.value='Question 4';const pending=form.event('submit');
  assert.equal(answers.children.length,3);assert.doesNotMatch(answers.textContent,/Question 1/);
  await form.event('submit');assert.equal(calls,4);
  widget.askForBill({id:'NEW-BILL',outcome:'blocked'},bill);
  finish(reply('Fourth answer'));await pending;
  assert.equal(input.value,'Why was NEW-BILL blocked?');assert.equal(answers.children.length,3);
});

test('panel follow-ups use the question API and retain focus when old cards are removed',async t=>{
  const {widget,input,form,answers,dom}=setup(t);widget.open();
  const fetch=t.mock.method(globalThis,'fetch',async()=>reply('[INV-3] beans, 0.5 NEAR: Blocked.\nSources: inbox'));
  input.value='How is my agent doing?';await form.event('submit');
  const chip=answers.find(n=>n.tag==='button')!;assert.equal(chip.textContent,'Why was INV-3 blocked?');
  chip.focus();chip.event('click');await new Promise(r=>setImmediate(r));
  assert.equal(fetch.mock.callCount(),2);assert.equal(dom.activeElement,input);
  assert.equal(answers.children[0].find(n=>n.tag==='h3')!.textContent,'Why was INV-3 blocked?');
  assert.equal(answers.children[0].find(n=>n.tag==='button'),undefined);
});

test('account check keeps its account visible beside yes/no/not yet, with details folded',t=>{
  setup(t);
  for(const [verdict,tone,opening] of [['STOP','danger','No —'],['WARN','warning','Not yet —'],['PAY','success','Yes —']] as const){
    const {card,head,body}=askCard('beans.test.near');
    assert.equal(head.children[0].className,'ask-card-title');
    assert.equal(head.children[0].textContent,'beans.test.near');
    assert.equal(applyAsk(card,head,body,{ok:true,text:`${verdict}: Account not pinned.\n- Exists: yes.\nSources: chain`},true),true);
    assert.ok(head.find((n:Element)=>n.className===`badge ${tone}`));
    assert.equal(body.children[0].textContent.startsWith(opening),true);
    const details=body.find((n:Element)=>n.tag==='details')!;
    assert.equal(details.children[0].textContent,'Show account checks');
    assert.equal(details.attributes.open,undefined);
    assert.match(details.textContent,/Sources: chain/);
    assert.equal(body.find((n:Element)=>n.tag==='script'),undefined);
  }
});


test('Ask immediately empties the composer while waiting; an error restores the question for retry',async t=>{
  const {widget,input,form,answers}=setup(t);widget.open();
  let resolveRequest:(response:Response)=>void=()=>{};
  t.mock.method(globalThis,'fetch',async()=>new Promise<Response>(r=>{resolveRequest=r;}));
  input.value='How much do I have?';
  const pending=form.event('submit');
  assert.equal(input.value,''); // No manual deletion while Dave is thinking.
  assert.equal(answers.children[0].find(n=>n.tag==='h3')!.textContent,'How much do I have?');
  assert.equal(answers.children[0].find(n=>n.tag==='h3')!.className,'ask-card-title');
  assert.equal(form.hidden,false); // Keep the composer available, don't hide it.
  resolveRequest(reply('Temporary failure',false));
  await pending;
  assert.equal(input.value,'How much do I have?');
  assert.equal(answers.children[0].find(n=>n.tag==='h3')!.textContent,'How much do I have?');
  assert.match(answers.textContent,/Temporary failure/);
});

test('Ask leaves newly typed draft alone when the previous answer completes',async t=>{
  const {widget,input,form}=setup(t);widget.open();
  let resolveRequest:(response:Response)=>void=()=>{};
  t.mock.method(globalThis,'fetch',async()=>new Promise<Response>(r=>{resolveRequest=r;}));
  input.value='How much do I have?';
  const pending=form.event('submit');
  assert.equal(input.value,'');
  input.value='What are my rules?';
  resolveRequest(reply('Your vault holds 4.6 NEAR.'));
  await pending;
  assert.equal(input.value,'What are my rules?');
});

// --- One shared answer history ------------------------------------------------
class MemoryStorage{data=new Map<string,string>();getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,String(v));}removeItem(k:string){this.data.delete(k);}}
const titles=(list:Element)=>list.children.map(c=>c.find(n=>n.tag==='h3')?.textContent);
function page(history:any){const list=new Element('div'),empty=new Element('p');empty.textContent='Ask a question or check an account to see an answer here.';showHistory(history,list,{empty});return {list,empty};}

test('an answer asked in the panel appears on the full page, newest first, with the same card',async t=>{
  const history=createAskHistory({storage:new MemoryStorage()});
  const {widget,input,form,answers}=setup(t,history);widget.open();
  const full=page(history);
  assert.deepEqual(full.list.children,[full.empty]);
  t.mock.method(globalThis,'fetch',async(_u:string,o:any)=>reply('Answer to '+JSON.parse(o.body).text+'\nSources: vault at block 9'));
  input.value='How much do I have?';await form.event('submit');
  input.value='What are my rules?';await form.event('submit');
  assert.deepEqual(titles(full.list),['What are my rules?','How much do I have?']);
  assert.deepEqual(titles(answers),titles(full.list));
  assert.equal(full.list.children[0].textContent,answers.children[0].textContent);
  // And the other way round: an answer recorded from the full page shows in the panel.
  const id=history.begin('account','Account: beans.test.near');
  history.finish(id,{ok:true,text:'PAY: Pinned supplier.\nSources: chain'});
  assert.equal(titles(answers)[0],'Account: beans.test.near');assert.equal(titles(full.list)[0],'Account: beans.test.near');
});

test('a reload keeps the history; in-flight answers are not saved; it is capped at 30',async t=>{
  const storage=new MemoryStorage(),history=createAskHistory({storage});
  t.mock.method(globalThis,'fetch',async()=>reply('[INV-1] Paid.\nSources: vault'));
  const {input,form,widget}=setup(t,history);widget.open();
  input.value='Was INV-1 paid?';await form.event('submit');
  history.begin('question','Still waiting');
  const reloaded=createAskHistory({storage}),full=page(reloaded);
  assert.deepEqual(titles(full.list),['Was INV-1 paid?']);
  assert.match(full.list.textContent,/\[INV-1\] Paid\./);
  for(let i=0;i<HISTORY_MAX+5;i++){const n=reloaded.begin('question','Q'+i);reloaded.finish(n,{ok:true,text:'A'+i});}
  assert.equal(reloaded.entries().length,30);assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)!).length,30);
  assert.equal(titles(full.list)[0],'Q34');
  // Saved data is never trusted as markup, and junk entries are dropped.
  storage.setItem(HISTORY_KEY,JSON.stringify([{kind:'question',label:'<b>x</b>',data:{ok:true,text:'<img src=x>'}},{kind:'evil',label:'y',data:{}},null]));
  const odd=page(createAskHistory({storage}));
  assert.deepEqual(titles(odd.list),['<b>x</b>']);assert.equal(odd.list.find(n=>n.tag==='img'||n.tag==='b'),undefined);
});

test('Clear empties both the page and the panel, and the saved copy',async t=>{
  const storage=new MemoryStorage(),history=createAskHistory({storage});
  const {input,form,answers,widget}=setup(t,history);widget.open();const full=page(history);
  t.mock.method(globalThis,'fetch',async()=>reply('Answer'));
  input.value='How is my agent doing?';await form.event('submit');
  assert.equal(answers.children.length,1);
  history.clear();
  assert.equal(answers.children.length,0);assert.deepEqual(full.list.children,[full.empty]);
  assert.equal(storage.getItem(HISTORY_KEY),null);
  assert.deepEqual(createAskHistory({storage}).entries(),[]);
  const html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('./public/app.js',import.meta.url),'utf8');
  assert.match(html,/<button id="ask-clear"[^>]*type="button">Clear<\/button>/);
  assert.match(app,/#ask-clear"\)\.addEventListener\("click", \(\) => askHistory\.clear\(\)\)/);
});

test('storage that throws never breaks asking: the history falls back to memory',async t=>{
  const broken={getItem(){throw Error('denied');},setItem(){throw Error('quota');},removeItem(){throw Error('denied');}};
  for(const storage of [broken,()=>{throw Error('SecurityError');}]){
    const history=createAskHistory({storage});
    const {input,form,answers,widget}=setup(t,history);widget.open();const full=page(history);
    t.mock.method(globalThis,'fetch',async()=>reply('Your vault holds 4.6 NEAR.'));
    input.value='How much do I have?';await form.event('submit');
    assert.equal(input.value,'');
    assert.deepEqual(titles(answers),['How much do I have?']);assert.deepEqual(titles(full.list),['How much do I have?']);
    assert.match(full.list.textContent,/4\.6 NEAR/);
    history.clear();assert.deepEqual(full.list.children,[full.empty]);
    (globalThis.fetch as any).mock.restore();
  }
});
