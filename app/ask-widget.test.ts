import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAskWidget} from './public/ask-widget.js';
import {askCard, applyAsk} from './public/ask-shared.js';

// Exercise the real browser modules with HTTP mocked, without a model or chain.
class Element {
  tag:string; children:Element[]=[]; parent:Element|null=null;
  attributes:Record<string,string>={}; handlers:Record<string,Function>={};
  className=''; value=''; hidden=false; disabled=false; id=''; private text='';
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
  find(predicate:(n:Element)=>boolean):Element|undefined{
    if(predicate(this))return this;
    for(const n of this.children){const found=n.find(predicate);if(found)return found;}
  }
  event(name:string,extra={}){return this.handlers[name]?.({currentTarget:this,preventDefault(){},...extra});}
}
function setup(t:any){
  const body=new Element('body'), handlers:Record<string,Function>={};
  const dom={body,activeElement:body,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag),
    querySelector:(selector:string)=>selector==='[data-view="ask-dave"]'?body.find(n=>n.attributes['data-view']==='ask-dave'):null,addEventListener:(name:string,fn:Function)=>handlers[name]=fn};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{value:dom,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;});
  const fullInput=new Element('input');body.append(fullInput);
  const navLink=new Element('a');navLink.setAttribute('data-view','ask-dave');body.append(navLink);
  const widget=createAskWidget({onNavigate:()=>{widget.setOnAskDaveView(true);fullInput.focus();}});
  const panel=widget.panel as Element, button=widget.button as Element;
  const input=panel.find(n=>n.tag==='input')!, form=panel.find(n=>n.tag==='form')!;
  const answers=panel.find(n=>n.className.includes('ask-widget-answers '))!;
  const bill=new Element('button');body.append(bill);
  return {widget,panel,button,input,form,answers,bill,dom,handlers,fullInput,navLink};
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

test('shared account answers keep verdict colors and Sources text without parsing markup',t=>{
  setup(t);
  for(const [verdict,tone] of [['STOP','danger'],['WARN','warning'],['PAY','success']]){
    const {card,head,body}=askCard('Account');
    assert.equal(applyAsk(card,head,body,{ok:true,text:`${verdict}: <script>unsafe</script>\nSources: chain`},true),true);
    assert.ok(head.find((n:Element)=>n.className===`badge ${tone}`));
    assert.ok(body.find((n:Element)=>n.className==='ask-sources'));
    assert.equal(body.find((n:Element)=>n.tag==='script'),undefined);
  }
});
