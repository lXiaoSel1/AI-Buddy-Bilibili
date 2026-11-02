import test from 'node:test';
import assert from 'node:assert/strict';

// The actual client entry with light fakes for the page globals, DSH's ModuleLoader, slots, layout and React hooks.
// It checks the host contract for showing this page inside AI Buddy's window; it is not a visual acceptance.
const PLUGIN='@ai-buddy/bilibili-companion',KEY='bilibili-companion',EVENT='ai-buddy:open-plugin-page';
const ORIGINAL={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};
const restore=()=>{for(const [key,value] of Object.entries(ORIGINAL))if(value===undefined)delete globalThis[key];else globalThis[key]=value;};
let loads=0;

function fakeReact(){
  let frame=null;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useRef:current=>({current}),
    useState(init){const f=frame,value=typeof init==='function'?init():init;f.states.push(value);return[value,next=>f.sets.push(typeof next==='function'?next(value):next)];},
    useEffect(effect){frame.effects.push(effect);}};
  const mount=Component=>{const f=frame={states:[],sets:[],effects:[]};const tree=Component({});const cleanups=f.effects.map(effect=>effect()).filter(value=>typeof value==='function');return{...f,tree,unmount:()=>cleanups.forEach(cleanup=>cleanup())};};
  return{React,mount};
}

async function load(t,{openPlugin,selectFails=false}={}){
  const events=new EventTarget(),hooked=new Set(),styles=[],dataset={};
  if(openPlugin)dataset.buddyOpenPlugin=openPlugin;
  let entry;
  const window={location:{href:'https://local.invalid/bilibili'},__ModuleLoader__:{load(value){entry=value;}},dispatchEvent:event=>events.dispatchEvent(event),
    addEventListener(type,listener){if(type===EVENT)hooked.add(listener);events.addEventListener(type,listener);},
    removeEventListener(type,listener){if(type===EVENT)hooked.delete(listener);events.removeEventListener(type,listener);}};
  const document={documentElement:{dataset},getElementById:()=>null,createElement:tag=>({tag}),head:{append:element=>styles.push(element)}};
  globalThis.window=window;globalThis.document=document;globalThis.fetch=()=>new Promise(()=>{});
  t.after(restore);
  await import('../src/client/index.mjs?embedded-'+(++loads));
  assert.equal(entry.id,PLUGIN);
  const {React,mount}=fakeReact(),plugin=entry.factory(id=>{assert.equal(id,'react');return React;});
  assert.ok(plugin.inject.includes('layout'));
  const callbacks=new Map(),registered=new Map(),calls=[];
  plugin.apply({
    slots:{inject(name,callback){callbacks.set(name,callback);},register(spec,component){const id=spec.key??spec.id;registered.set(id,component);calls.push(['register',spec.name,id]);return()=>{registered.delete(id);calls.push(['unregister',id]);};}},
    layout:{selectPanel(id){if(selectFails||!registered.has(id))throw Object.assign(Error('Unknown panel '+id),{code:'LAYOUT_PANEL_UNKNOWN'});calls.push(['select',id]);}},
  });
  const open=detail=>window.dispatchEvent(new CustomEvent(EVENT,{detail}));
  return{callbacks,registered,calls,dataset,hooked,styles,open,mount,selects:()=>calls.filter(call=>call[0]==='select').length};
}

test('the page answers only its own open request: selects its panel, then sets data-buddy-panel',async t=>{
  const page=await load(t);
  assert.equal(page.calls.length,0,'nothing happens before the main slot exists');
  page.callbacks.get('main')();
  assert.deepEqual(page.calls,[['register','main',KEY]],'no request was named, so DSH stays on its own panel');
  assert.equal(page.hooked.size,1);
  page.open({pluginId:'@ai-buddy/qq-connect'});page.open(undefined);page.open({});
  assert.equal(page.selects(),0);assert.equal(page.dataset.buddyPanel,undefined);
  page.open({pluginId:PLUGIN});
  assert.deepEqual(page.calls.at(-1),['select',KEY]);assert.equal(page.dataset.buddyPanel,PLUGIN);
});

test('a request named on <html> before registration is answered as soon as the main panel exists',async t=>{
  const page=await load(t,{openPlugin:PLUGIN});
  page.callbacks.get('main')();
  assert.deepEqual(page.calls,[['register','main',KEY],['select',KEY]]);assert.equal(page.dataset.buddyPanel,PLUGIN);
  const other=await load(t,{openPlugin:'@ai-buddy/qq-connect'});
  other.callbacks.get('main')();
  assert.equal(other.selects(),0);assert.equal(other.dataset.buddyPanel,undefined);
});

test('disposing the main slot removes the open listener with the panel',async t=>{
  const page=await load(t),dispose=page.callbacks.get('main')();
  assert.equal(typeof dispose,'function');assert.equal(page.hooked.size,1);
  dispose();
  assert.equal(page.hooked.size,0);assert.equal(page.registered.has(KEY),false);
  page.open({pluginId:PLUGIN});
  assert.equal(page.selects(),0);assert.equal(page.dataset.buddyPanel,undefined);
});

test('a selection DSH refuses never claims the panel, and the event does not throw',async t=>{
  const page=await load(t,{selectFails:true});
  page.callbacks.get('main')();
  page.dataset.buddyPanel=PLUGIN;
  assert.doesNotThrow(()=>page.open({pluginId:PLUGIN}));
  assert.equal(page.dataset.buddyPanel,undefined,'a stale answer of ours is withdrawn');
  page.dataset.buddyPanel='@ai-buddy/qq-connect';page.open({pluginId:PLUGIN});
  assert.equal(page.dataset.buddyPanel,'@ai-buddy/qq-connect','another plugin’s answer is left alone');
});

test('an activity asked for before the page mounts opens with it; a mounted page keeps handling its own requests',async t=>{
  const page=await load(t);
  page.callbacks.get('main')();
  const App=page.registered.get(KEY);
  page.open({pluginId:PLUGIN,activityId:'activity-7'});
  assert.equal(page.dataset.buddyPanel,PLUGIN);
  const first=page.mount(App);
  assert.ok(first.states.includes('activity-7'),'the page starts on the requested activity');
  assert.ok(first.sets.includes('history'),'and on the history tab');
  first.sets.length=0;
  page.open({pluginId:PLUGIN,activityId:'activity-8'});
  assert.deepEqual(first.sets,['activity-8','history'],'the component listener still selects the activity');
  first.unmount();
  const second=page.mount(App);
  assert.ok(!second.states.includes('activity-7')&&!second.states.includes('activity-8'),'a handled request is not replayed on the next mount');
  second.unmount();
  page.open({pluginId:PLUGIN,activityId:'activity-9'});page.open({pluginId:PLUGIN});
  const third=page.mount(App);
  assert.ok(third.states.includes('activity-9'),'a request without an activity keeps the earlier one');
  third.unmount();
});

test('embedded header CSS hides the logo, title and subtitle and moves the actions to the tab row',async t=>{
  const page=await load(t);
  page.callbacks.get('main')();
  page.mount(page.registered.get(KEY)).unmount();
  const style=page.styles.find(element=>element.id==='bili-style');
  assert.ok(style,'the page injects its style sheet');
  const css=style.textContent;
  for(const rule of [
    '.bili-head{display:flex;',
    '.bili-tabrow>.bili-acts,.bili-tabrow.bare{display:none}',
    'html[data-buddy-embedded] .bili-head{display:none}',
    'html[data-buddy-embedded] .bili-tabrow.bare{display:flex;justify-content:flex-end}',
    'html[data-buddy-embedded] .bili-tabrow>.bili-acts{display:flex;flex:none;flex-wrap:nowrap;',
    'html[data-buddy-embedded] .bili-tabs+.bili-acts{border-bottom:1px solid var(--b-line)}',
    'html[data-buddy-embedded] .bili-tabrow>.bili-tabs{flex-wrap:wrap}',
  ])assert.ok(css.includes(rule),rule);
});
