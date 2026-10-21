import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({window:{},URL});
vm.runInContext(fs.readFileSync(new URL('../static/experiments.js',import.meta.url),'utf8'),context);
const atlas=context.window.ExperimentAtlas;
const native=value=>JSON.parse(JSON.stringify(value));
const gd=overrides=>({...native(atlas.defaultExperiment().config),...overrides});
const vi=overrides=>({...native(atlas.defaultExperiment('value-iteration').config),...overrides});
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
let passed=0;
function check(label,test){test();passed++;console.log(`✓ ${label}`);}
function singleton({reward=1,discount=.9,initialValue=0,terminal=false,...overrides}={}){return vi({states:[{id:'s',label:'State',terminal,initialValue}],actions:[{id:'a',label:'Action'}],transitions:terminal?[]:[{stateId:'s',actionId:'a',outcomes:[{nextStateId:'s',probability:1,reward}]}],discount,...overrides});}
function mockForm(experiment){
  function node(value,kind,config){
    const fields=[],nested=[];
    const owner={dataset:{},closest:selector=>selector==='[data-experiment-config]'?config:owner,querySelectorAll:selector=>{
      if(selector==='[data-experiment-field]')return [...fields,...nested.flatMap(n=>n.querySelectorAll(selector))];
      const match=selector.match(/^\[data-experiment-row="([^"]+)"\]$/);return match?nested.flatMap(n=>[...(n.kind===match[1]?[n]:[]),...n.querySelectorAll(selector)]):[];
    }};owner.kind=kind;
    if(kind==='config')config=owner;
    for(const [key,item] of Object.entries(value)){
      if(['states','actions','transitions','outcomes'].includes(key)){const childKind={states:'state',actions:'action',transitions:'transition',outcomes:'outcome'}[key];nested.push(...item.map(entry=>node(entry,childKind,config)));}
      else {const numeric=typeof item==='number'||['a','b','c','startX','startY','learningRate','maxIterations','tolerance','discount','initialValue','probability','reward'].includes(key);fields.push({dataset:{experimentField:key},type:typeof item==='boolean'?'checkbox':numeric?'number':'text',checked:item,value:String(item),closest:()=>owner});}
    }
    return owner;
  }
  const {config,comparisonConfig,...metadata}=experiment,form=node(metadata,'experiment'),a=node(config,'config'),b=comparisonConfig?node(comparisonConfig,'config'):null;
  form.querySelector=selector=>selector==='[data-experiment-config="A"]'?a:selector==='[data-experiment-config="B"]'?b:selector==='[data-experiment-comparison]'?{checked:!!b}:null;
  return {form,editor:{matches:selector=>selector==='[data-experiment-editor]',querySelectorAll:selector=>selector==='[data-experiment-row="experiment"]'?[form]:[]}};
}

check('factories create independent stable configurations and reviewed primary-source references',()=>{
  const a=atlas.defaultExperiment(),b=atlas.defaultExperiment(),v=atlas.defaultExperiment('value-iteration');assert.notEqual(a.id,b.id);a.config.a=10;assert.equal(b.config.a,4);assert.ok(v.sourceUrl.includes('berkeley.edu'));assert.ok(atlas.validateExperiment(v));assert.throws(()=>atlas.defaultExperiment('eval'),/type/);
});
check('the default gradient run reaches convergence and records iteration zero',()=>{
  const result=atlas.runGradientDescent(gd());assert.equal(result.status,'converged');assert.equal(result.records[0].iteration,0);assert.equal(result.records[0].value,20);assert.ok(result.records.at(-1).gradientNorm<=1e-8);assert.equal(result.iterations,result.records.length-1);
});
check('diagonal quadratic matches an independent closed-form recurrence at every iterate',()=>{
  const config=gd({a:4,c:1,learningRate:.2,maxIterations:12,tolerance:1e-12}),result=atlas.runGradientDescent(config);
  for(const record of result.records){near(record.x,3*.2**record.iteration);near(record.y,2*.8**record.iteration);near(record.value,.5*(4*record.x**2+record.y**2));}
});
check('coupled quadratic takes simultaneous full-gradient updates',()=>{
  const result=atlas.runGradientDescent(gd({a:3,b:1,c:2,startX:2,startY:-1,learningRate:.1,maxIterations:1}));const r=result.records[1];near(r.x,1.5);near(r.y,-1);near(r.gradientX,3.5);near(r.gradientY,-.5);
});
check('zero initial gradient converges at iteration zero even with a large learning rate',()=>{
  const r=atlas.runGradientDescent(gd({startX:0,startY:0,learningRate:10}));assert.equal(r.status,'converged');assert.equal(r.iterations,0);assert.equal(r.stability.convergesForEveryStart,false);
});
check('exact spectral threshold is strict and oscillation at the boundary is not convergence',()=>{
  const r=atlas.runGradientDescent(gd({startX:1,startY:0,learningRate:.5,maxIterations:5}));near(r.stability.lambdaMax,4);near(r.stability.learningRateLimit,.5);assert.equal(r.stability.convergesForEveryStart,false);assert.equal(r.status,'iteration-limit');near(r.records[5].x,-1);
});
check('an outside-interval special starting point can still converge',()=>{
  const r=atlas.runGradientDescent(gd({startX:0,startY:1,learningRate:.6,maxIterations:100}));assert.equal(r.stability.convergesForEveryStart,false);assert.equal(r.status,'converged');
});
check('a divergent mode stops before a numeric limit and is never marked converged',()=>{
  const r=atlas.runGradientDescent(gd({learningRate:10,maxIterations:500}));assert.equal(r.status,'numeric-limit');assert.ok(r.records.length<501);assert.ok(r.records.every(record=>Object.values(record).every(value=>Number.isFinite(value)&&Math.abs(value)<=1e12)));assert.match(r.reason,/not convergence/);
});
check('the iteration cap is explicit and does not imply convergence',()=>{
  const r=atlas.runGradientDescent(gd({maxIterations:1}));assert.equal(r.status,'iteration-limit');assert.equal(r.records.length,2);assert.ok(r.records[1].gradientNorm>r.config.tolerance);
});
check('invalid SPD matrices, nonfinite numbers, numeric strings, and ranges are rejected',()=>{
  for(const config of [gd({b:2}),gd({a:0}),gd({b:Infinity}),gd({learningRate:0}),gd({maxIterations:1.5}),gd({startX:101}),gd({tolerance:1e-13}),gd({a:'4'})])assert.throws(()=>atlas.runGradientDescent(config));
});
check('a scalar self-loop approaches its known closed-form fixed point',()=>{
  const r=atlas.runValueIteration(singleton({reward:2,discount:.8,tolerance:1e-10,maxIterations:300}));assert.equal(r.status,'converged');near(r.records.at(-1).values.s,10,1e-9);for(const record of r.records)near(record.values.s,10*(1-.8**record.iteration),1e-10);
});
check('Bellman residual and current Q are computed from displayed values, not the previous delta',()=>{
  const r=atlas.runValueIteration(singleton({reward:1,discount:.5,maxIterations:1}));assert.equal(r.records[0].residual,1);assert.equal(r.records[1].values.s,1);assert.equal(r.records[1].qValues.s.a,1.5);assert.equal(r.records[1].residual,.5);assert.equal(r.records[1].errorBound,1);
});
check('synchronous updates do not read an earlier state update from the same sweep',()=>{
  const config=vi({states:[{id:'a',label:'A',terminal:false,initialValue:0},{id:'b',label:'B',terminal:false,initialValue:0}],actions:[{id:'move',label:'Move'}],transitions:[{stateId:'a',actionId:'move',outcomes:[{nextStateId:'a',probability:1,reward:2}]},{stateId:'b',actionId:'move',outcomes:[{nextStateId:'a',probability:1,reward:0}]}],discount:.5,maxIterations:1});const r=atlas.runValueIteration(config);assert.equal(r.records[1].values.a,2);assert.equal(r.records[1].values.b,0);
});
check('stochastic transition rewards are weighted per branch, including repeated next states',()=>{
  const config=singleton({discount:0,maxIterations:1});config.transitions[0].outcomes=[{nextStateId:'s',probability:.25,reward:8},{nextStateId:'s',probability:.75,reward:-4}];const r=atlas.runValueIteration(config);assert.equal(r.records[0].qValues.s.a,-1);assert.equal(r.records[1].values.s,-1);assert.equal(r.status,'converged');
});
check('discount zero requires one expected-reward update and has a valid error bound',()=>{
  const r=atlas.runValueIteration(singleton({reward:3,discount:0}));assert.equal(r.iterations,1);assert.equal(r.records[0].errorBound,3);assert.equal(r.records[1].residual,0);
});
check('all-terminal MDP converges at zero and omits outgoing actions',()=>{
  const r=atlas.runValueIteration(singleton({terminal:true}));assert.equal(r.status,'converged');assert.equal(r.iterations,0);assert.equal(r.records[0].values.s,0);assert.equal(r.records[0].policy.s,null);assert.deepEqual(native(r.records[0].qValues.s),{});
});
check('unavailable actions never contribute a fake zero when every real action is negative',()=>{
  const config=singleton({reward:-2,discount:0});config.actions.unshift({id:'unavailable',label:'Unavailable'});const r=atlas.runValueIteration(config);assert.equal(r.records[0].policy.s,'a');assert.equal(r.records[1].values.s,-2);assert.ok(!Object.hasOwn(r.records[0].qValues.s,'unavailable'));
});
check('deterministic exact ties follow declared action order rather than transition order',()=>{
  const config=singleton({discount:0});config.actions.unshift({id:'b',label:'First declared'});config.transitions.push({stateId:'s',actionId:'b',outcomes:[{nextStateId:'s',probability:1,reward:1}]});assert.equal(atlas.runValueIteration(config).records[0].policy.s,'b');config.actions.reverse();assert.equal(atlas.runValueIteration(config).records[0].policy.s,'a');
});
check('built-in MDP has the independently solved optimal value and displayed greedy policy',()=>{
  const r=atlas.runValueIteration(vi()),last=r.records.at(-1);near(last.values.bridge,5,1e-7);near(last.values.start,3.6/.82,2e-6);assert.equal(last.policy.start,'move');assert.equal(last.policy.bridge,'move');assert.equal(last.values.goal,0);assert.equal(r.status,'converged');
});
check('accepted row rounding is preserved and the conservative bound covers its implemented fixed point',()=>{
  const p=.50000000025,config=singleton({discount:.999,maxIterations:500});config.transitions[0].outcomes=[{nextStateId:'s',probability:p,reward:1},{nextStateId:'s',probability:p,reward:1}];const r=atlas.runValueIteration(config),mass=2*p,exact=mass/(1-.999*mass);assert.equal(r.config.transitions[0].outcomes[0].probability,p);near(r.maxProbabilityMass,mass);near(r.contractionFactor,.999*mass);assert.ok(r.probabilityMassError>0);for(const record of r.records)assert.ok(Math.abs(exact-record.values.s)<=record.errorBound*(1+1e-12));
});
check('unit-mass rows reduce the bound to residual divided by one minus discount',()=>{
  const r=atlas.runValueIteration(singleton({discount:.8}));assert.equal(r.contractionFactor,.8);assert.equal(r.probabilityMassError,0);for(const record of r.records)near(record.errorBound,record.residual/(1-.8));
});
check('lower-than-unit accepted mass uses at least gamma as its conservative contraction factor',()=>{
  const config=singleton();config.transitions[0].outcomes=[{nextStateId:'s',probability:.5-2e-10,reward:1},{nextStateId:'s',probability:.5,reward:1}];const r=atlas.runValueIteration(config);assert.equal(r.maxProbabilityMass,1);assert.equal(r.contractionFactor,.9);
});
check('probabilities are never silently normalized and invalid mass gets an actionable row location',()=>{
  const config=singleton();config.transitions[0].outcomes[0].probability=.8;assert.throws(()=>atlas.runValueIteration(config),/transition 1.*probabilities add to 0.8/);config.transitions[0].outcomes[0].probability=1.1;assert.throws(()=>atlas.runValueIteration(config),/outcome 1 probability/);
});
check('MDP integrity rejects duplicates, missing references, unavailable states, and terminal rows',()=>{
  let c=singleton();c.states.push({...c.states[0]});assert.throws(()=>atlas.runValueIteration(c),/unique/);c=singleton();c.actions.push({...c.actions[0]});assert.throws(()=>atlas.runValueIteration(c),/unique/);c=singleton();c.transitions.push({...c.transitions[0]});assert.throws(()=>atlas.runValueIteration(c),/already have/);c=singleton();c.transitions[0].outcomes[0].nextStateId='missing';assert.throws(()=>atlas.runValueIteration(c),/next state/);c=singleton();c.transitions=[];assert.throws(()=>atlas.runValueIteration(c),/at least one/);c=singleton();c.states[0].terminal=true;assert.throws(()=>atlas.runValueIteration(c),/outgoing/);c=singleton({terminal:true,initialValue:1});assert.throws(()=>atlas.runValueIteration(c),/initial value 0/);
});
check('MDP limits reject nonfinite values, malformed rows, and uncontractive discounts',()=>{
  for(const c of [singleton({discount:1}),singleton({discount:-.1}),singleton({initialValue:NaN}),singleton({reward:10001}),singleton({maxIterations:501}),vi({states:[]}),vi({actions:Array.from({length:5},(_,i)=>({id:`a${i}`,label:'Action'}))})])assert.throws(()=>atlas.runValueIteration(c));
});
check('VI cap remains explicit for a slow contraction without a false convergence claim',()=>{
  const r=atlas.runValueIteration(singleton({discount:.999,maxIterations:1}));assert.equal(r.status,'iteration-limit');assert.equal(r.records.length,2);assert.ok(r.records[1].residual>r.config.tolerance);
});
check('configuration validation is canonical, nonmutating, and rejects unknown types and versions',()=>{
  const e=native(atlas.defaultExperiment());delete e.description;delete e.sourceUrl;delete e.sourceLocation;delete e.comparisonConfig;const before=JSON.stringify(e),v=atlas.validateExperiment(e);assert.equal(JSON.stringify(e),before);assert.equal(v.description,'');assert.equal(v.comparisonConfig,null);for(const invalid of [{...e,type:'python'},{...e,algorithmVersion:2},{...e,id:'bad/key'},{...e,title:''},{...e,sourceUrl:'javascript:alert(1)'}])assert.throws(()=>atlas.validateExperiment(invalid));
});
check('prototype names are not accepted as algorithm types or default factories',()=>{
  for(const type of ['constructor','toString','__proto__']){assert.throws(()=>atlas.validateExperiment({...native(atlas.defaultExperiment('value-iteration')),type}),/type/);assert.throws(()=>atlas.defaultExperiment(type),/type/);}
});
check('friendly forms read both complete configurations without changing nested order or IDs',()=>{
  const e=native(atlas.defaultExperiment('value-iteration'));e.comparisonConfig=vi({discount:.5});assert.deepEqual(native(atlas.readEditor(mockForm(e).editor)),{experiments:[e]});
});
check('unfinished nested numeric and text rows survive draft reads and fail actionable save validation',()=>{
  const e=native(atlas.defaultExperiment('value-iteration'));e.config.states.push({id:'unfinished',label:'',terminal:false,initialValue:''});e.config.transitions[0].outcomes.push({nextStateId:'',probability:'',reward:''});const form=mockForm(e).editor,draft=atlas.readEditor(form,{validate:false});assert.equal(draft.experiments[0].config.states.at(-1).label,'');assert.equal(draft.experiments[0].config.states.at(-1).initialValue,'');assert.equal(draft.experiments[0].config.transitions[0].outcomes.at(-1).probability,'');assert.throws(()=>atlas.readEditor(form),/state 4 label/);
});
check('the form reader retains blank gradient inputs for drafts instead of turning them into zero',()=>{
  const e=native(atlas.defaultExperiment());e.config.startX='';const form=mockForm(e).editor;assert.equal(atlas.readEditor(form,{validate:false}).experiments[0].config.startX,'');assert.throws(()=>atlas.readEditor(form),/starting x/);
});
check('both comparison configurations receive the same typed validation',()=>{
  const e=native(atlas.defaultExperiment());e.comparisonConfig=gd({learningRate:0});assert.throws(()=>atlas.validateExperiment(e),/Configuration B.*learning rate/);e.comparisonConfig=gd({learningRate:.1});assert.equal(atlas.validateExperiment(e).comparisonConfig.learningRate,.1);
});
check('rendered lab is runnable, explanatory, and does not expose a raw configuration editor',()=>{
  const html=atlas.renderLab();for(const phrase of ['Run simulation','One update','Add to new shard','Configuration A','Current residual','Current values, Q','every starting point','no random sampling'])assert.ok(html.includes(phrase));assert.ok(!html.includes('data-action='));assert.ok(!html.includes('JSON'));assert.ok(!/NaN|Infinity/.test(html));
});
check('read-only previews have no save or attach control, but retain exploration controls',()=>{
  const html=atlas.renderDetail({id:'s',experiments:[atlas.defaultExperiment()]},{readOnly:true});assert.ok(!html.includes('data-experiment-command="save"'));assert.ok(!html.includes('data-experiment-command="attach"'));assert.ok(html.includes('data-experiment-command="run"'));assert.ok(html.includes('data-experiment-command="copy"'));
});
check('rendering escapes authored labels and unsafe sources even on rejected incoming metadata',()=>{
  const e=native(atlas.defaultExperiment('value-iteration'));e.title='<script>bad()</script>';e.sourceUrl='javascript:bad()';e.config.states[0].label='<img src=x onerror=bad()>';const html=atlas.renderDetail({id:'s',experiments:[e]});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src='));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('&lt;script&gt;'));
});
check('malformed incoming arrays never throw while import validation can report their defects',()=>{
  for(const value of [{experiments:[null,{}]},{experiments:[{type:'value-iteration',config:{states:[null],actions:[null],transitions:[null]}}]},{experiments:[{type:'gradient-descent',config:null}]}]){assert.doesNotThrow(()=>atlas.renderDetail(value));assert.doesNotThrow(()=>atlas.renderEditor(value));}
});
check('comparison plots share axes and remain finite for bounded divergent trajectories',()=>{
  const e=native(atlas.defaultExperiment());e.comparisonConfig=gd({learningRate:10});const html=atlas.renderDetail({id:'s',experiments:[e]});assert.ok(html.includes('A/B plots share numerical axes'));assert.ok(!/NaN|Infinity/.test(html));assert.equal((html.match(/Objective contours &amp; trajectory/g)||[]).length,2);
});
check('nested input IDs are unique and useful labels cover all editable MDP settings',()=>{
  const html=atlas.renderEditor({experiments:[atlas.defaultExperiment('value-iteration'),atlas.defaultExperiment('value-iteration')]});const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);for(const label of ['State label','Initial value V₀','Terminal','Action label','From state','Next state','Probability','Reward on this branch','Discount γ','Compare with configuration B'])assert.ok(html.includes(label));
});
check('search includes saved comparison state/action labels and source context',()=>{
  const e=native(atlas.defaultExperiment('value-iteration'));e.comparisonConfig=vi();e.comparisonConfig.states[0].label='AlternativeStateToken';e.comparisonConfig.actions[0].label='AlternativeActionToken';const result=atlas.searchText({experiments:[e]});for(const token of [e.title,e.sourceLocation,'AlternativeStateToken','AlternativeActionToken'])assert.ok(result.includes(token));assert.doesNotThrow(()=>atlas.searchText({experiments:[null]}));
});

console.log(`${passed} experiment engine and rendering checks passed.`);
