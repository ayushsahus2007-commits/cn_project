import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uafloc-test-'));
process.env.DATA_FILE=path.join(dir,'state.json');
const engine=await import('../server/src/services/uafloc.js');
const diagnosis=await import('../server/src/services/diagnosis.js');
const experiments=await import('../server/src/services/experiments.js');
const store=await import('../server/src/store.js');
const {route}=await import('../server/src/routes.js');
const monitoring=await import('../server/src/services/monitoring.js');
const scheduler=await import('../server/src/services/scheduler.js');
const url=p=>new URL(`http://localhost/api${p}`);

test('entropy handles normalized values and zero probability',()=>{
 assert.equal(engine.entropy({a:.5,b:.5}),1);
 assert.equal(engine.entropy({a:2,b:2,c:0}),1);
 assert.equal(engine.entropy({a:1,b:0}),0);
});
test('normalization rejects invalid weights and is stable for extremely large and small finite values',()=>{
 assert.deepEqual(engine.normalize({a:1e308,b:1e308}),{a:.5,b:.5});
 assert.deepEqual(engine.normalize({a:1e-300,b:2e-300}),{a:1/3,b:2/3});
 assert.throws(()=>engine.normalize({a:-1,b:2}),/finite and non-negative/);
 assert.throws(()=>engine.normalize({a:Infinity}),/finite and non-negative/);
 assert.throws(()=>engine.normalize({a:0,b:0}),/no positive mass/);
});
test('IG uses hand-calculable binary split; cost and utility are explicit',()=>{
 const probe={id:'split',cost:2,likelihoods:{a:{yes:1},b:{no:1}}};
 const x=engine.evaluateProbe([], {a:.5,b:.5},probe);
 assert.equal(x.entropyBefore,1);assert.equal(x.expectedEntropyAfter,0);assert.equal(x.informationGain,1);assert.equal(x.utility,.5);
 assert.equal(engine.evaluateProbe([], {a:.5,b:.5},{...probe,cost:0}).utility,0);
 assert.equal(engine.evaluateProbe([], {a:.5,b:.5},{...probe,cost:-1}).informative,false);
});
test('candidate order uses deterministic ID tie break and excludes zero-IG probes',()=>{
 const scenario={probes:[{id:'z',cost:1,likelihoods:{a:{same:1},b:{same:1}}},{id:'b',cost:1,likelihoods:{a:{a:1},b:{b:1}}},{id:'a',cost:1,likelihoods:{a:{a:1},b:{b:1}}}]};
 assert.deepEqual(engine.rankProbes(scenario,{a:.5,b:.5}).map(x=>x.id),['a','b']);
});
test('Bayesian update handles zero likelihood and reports total model inconsistency',()=>{
 const s={probes:[{id:'p',likelihoods:{a:{up:1},b:{down:1}}}]};
 assert.deepEqual(engine.bayesUpdate({a:.4,b:.6},'p','up',s).posterior,{a:1});
 const x=engine.bayesUpdate({a:.4,b:.6},'p','unknown',s);assert.equal(x.inconsistent,true);assert.equal(x.posterior,null);
});
test('Bayes update uses normalized categorical likelihoods and a manual posterior',()=>{
 const s={probes:[{id:'p',likelihoods:{a:{yes:9,no:1},b:{yes:1,no:3}}}]};
 const result=engine.bayesUpdate({a:.6,b:.4},'p','yes',s);
 // P(yes|a)=.9, P(yes|b)=.25; evidence=.6*.9 + .4*.25=.64.
 assert.ok(Math.abs(result.evidenceProbability-.64)<1e-12);
 assert.ok(Math.abs(result.posterior.a-.84375)<1e-12);
 assert.ok(Math.abs(result.posterior.b-.15625)<1e-12);
 assert.ok(Math.abs(Object.values(result.posterior).reduce((a,b)=>a+b,0)-1)<1e-12);
});
test('scenarios provide normalized priors and explicit partial directed topology without truth leakage',()=>{
 for(const safe of engine.listScenarios()){
  const s=engine.getScenario(safe.id),prior=engine.initialBeliefs(s);
  assert.ok(Math.abs(Object.values(prior).reduce((a,b)=>a+b,0)-1)<1e-12);
  for(const l of [...safe.topology.knownLinks,...safe.topology.unknownLinks]){assert.ok(safe.topology.knownNodes.includes(l.source));assert.ok(safe.topology.knownNodes.includes(l.target));assert.equal(l.directed,true);}
  assert.equal(Object.hasOwn(safe,'truth'),false);assert.equal(Object.hasOwn(safe,'activeRoute'),false);
 }
 const amb=engine.getScenario('ambiguous_unknown_hop');assert.equal(amb.topology.unknownLinks.length,1);
});
test('custom scenario creation validates links, persists the scenario, and withholds truth from its API view',()=>{
 store.resetState();
 const created=engine.createScenario({name:'Custom server outage',symptom:'Monitor sees target unreachable from the core switch.',faultClass:'node_failure',nodes:['Monitor','Core switch','Server'],knownLinks:[{source:'Monitor',target:'Core switch'}],unknownLinks:[{source:'Core switch',target:'Server'}]});
 assert.equal(created.custom,true);assert.equal(Object.hasOwn(created,'truth'),false);assert.equal(engine.getScenario(created.id).truth,'node_failure');assert.equal(engine.listScenarios().length,7);
 assert.throws(()=>engine.createScenario({name:'Bad',symptom:'short',faultClass:'node_failure',nodes:['A','B'],knownLinks:[{source:'A',target:'C'}]}),e=>e.status===400);
 assert.throws(()=>engine.createScenario({name:'Duplicate links',symptom:'Monitor sees the endpoint become unreachable.',faultClass:'node_failure',nodes:['A','B'],knownLinks:[{source:'A',target:'B'},{source:'A',target:'B'}]}),e=>e.status===400);
 assert.throws(()=>engine.createScenario({name:'Contradictory links',symptom:'Monitor sees the endpoint become unreachable.',faultClass:'node_failure',nodes:['A','B'],knownLinks:[{source:'A',target:'B'}],unknownLinks:[{source:'A',target:'B'}]}),e=>e.status===400);
 const disconnected=engine.createScenario({name:'Disconnected hosts',symptom:'Monitor cannot reach an isolated endpoint at all.',faultClass:'link_failure',nodes:['Monitor','Switch','Isolated server']});assert.deepEqual(disconnected.topology.knownLinks,[]);assert.deepEqual(disconnected.topology.unknownLinks,[]);assert.deepEqual(disconnected.topology.knownNodes,['Monitor','Switch','Isolated server']);
 const started=diagnosis.startSession({scenarioId:created.id,probeBudget:5}),done=diagnosis.runToCompletion(started.id);assert.equal(done.diagnosis,'node_failure');
});
test('simulator outputs repeat deterministically and routing scenario records a path change',()=>{
 const s=engine.getScenario('routing_change');
 const one=engine.simulatedOutcome(s,'route_observe',0),two=engine.simulatedOutcome(s,'path_trace',1);
 assert.equal(one.outcome,'configured_route');assert.equal(two.outcome,'alternate_route');assert.notDeepEqual(one.activeRoute,two.activeRoute);
 assert.deepEqual(one,engine.simulatedOutcome(s,'route_observe',0));
});
test('diagnosis adaptively resolves endpoint case and explicitly stops on ambiguity',()=>{
 store.resetState();
 let s=diagnosis.startSession({scenarioId:'adaptive_endpoint',probeBudget:5});assert.equal(s.status,'active');assert.ok(Math.abs(Object.values(s.beliefs).reduce((a,b)=>a+b,0)-1)<1e-12);
 s=diagnosis.runToCompletion(s.id);assert.equal(s.status,'stopped');assert.equal(s.stop.reason,'confidence_threshold');assert.equal(s.diagnosis,'node_failure');assert.equal(s.observations.length,2);assert.ok(s.observations[0].utility>0);
 const a=diagnosis.startSession({scenarioId:'ambiguous_unknown_hop',probeBudget:5});assert.equal(a.status,'stopped');assert.equal(a.stop.reason,'not_identifiable');assert.equal(a.stop.message,'Not uniquely localizable with the available observations.');assert.equal(a.diagnosis,null);
});
test('probe budget exhausts cleanly and all previously used probes are excluded',()=>{
 let s=diagnosis.startSession({scenarioId:'adaptive_endpoint',probeBudget:1});
 const first=s.candidates[0].id;s=diagnosis.stepSession(s.id);
 assert.equal(s.status,'stopped');assert.equal(s.stop.reason,'probe_budget_exhausted');assert.equal(s.observations.length,1);assert.ok(!s.candidates.some(p=>p.id===first));
 assert.throws(()=>diagnosis.stepSession(s.id),e=>e.status===409);
});
test('routing diagnosis retains the route observed at each step',()=>{
 let s=diagnosis.startSession({scenarioId:'routing_change',probeBudget:5});s=diagnosis.runToCompletion(s.id);assert.equal(s.diagnosis,'routing_change');assert.ok(s.observations.length>=2);assert.notDeepEqual(s.observations[0].activeRoute,s.observations[1].activeRoute);
});
test('API validates starts, executes and persists observations, and reports missing IDs',()=>{
 store.resetState();
 assert.equal(route('GET',url('/diagnostics/health')).body.status,'ready');
 assert.equal(route('GET',url('/diagnostics/scenarios')).body.length,6);
 assert.throws(()=>route('POST',url('/diagnostics/sessions'),{scenarioId:'nope'}),e=>e.status===404);
 assert.throws(()=>route('POST',url('/diagnostics/sessions'),{scenarioId:'node_failure',probeBudget:0}),e=>e.status===400);
 const start=route('POST',url('/diagnostics/sessions'),{scenarioId:'adaptive_endpoint',probeBudget:4});assert.equal(start.status,201);const id=start.body.id;
 const stepped=route('POST',url(`/diagnostics/sessions/${id}/step`));assert.equal(stepped.body.observations.length,1);assert.equal(store.getState().diagnosisSessions[0].observations.length,1);
 const restored=diagnosis.findSession(id);assert.equal(restored.observations.length,1);assert.deepEqual(restored.beliefs,stepped.body.beliefs);assert.equal(restored.status,'active');const continued=diagnosis.stepSession(id);assert.equal(continued.observations.length,2);
 const child=execFileSync(process.execPath,['--input-type=module','-e',`import {findSession} from './server/src/services/diagnosis.js';const s=findSession(${JSON.stringify(id)});console.log(JSON.stringify({observations:s.observations.length,beliefs:s.beliefs,status:s.status}));`],{cwd:process.cwd(),env:{...process.env,DATA_FILE:process.env.DATA_FILE},encoding:'utf8'});const snapshot=JSON.parse(child);assert.equal(snapshot.observations,2);assert.equal(snapshot.status,'stopped');assert.deepEqual(snapshot.beliefs,continued.beliefs);
 assert.throws(()=>route('GET',url('/diagnostics/sessions/missing')),e=>e.status===404);
 assert.throws(()=>route('POST',url('/diagnostics/sessions/missing/step')),e=>e.status===404);
 const reset=route('POST',url(`/diagnostics/sessions/${id}/reset`));assert.equal(reset.body.ok,true);assert.equal(store.getState().diagnosisSessions.length,0);
});
test('topology API supports every device type, saved positions, undirected connections and cleanup',()=>{
 store.resetState();const supported=['Router','Switch','Server','Access point','PC','Other','Desktop PC','Laptop','Smartphone','Tablet','Printer','CCTV Camera','IoT Device','Network Switch','Wireless Access Point','Modem','Gateway','Firewall','Physical Server','Database Server','Application Server','Storage/NAS'];const made=[];
 for(let i=0;i<supported.length;i++){const r=route('POST',url('/devices'),{name:`Validation ${i}`,address:`topology-${i}.example`,type:supported[i],status:'degraded',simulated:true});assert.equal(r.status,201);assert.equal(r.body.type,supported[i]);assert.equal(r.body.simulated,true);made.push(r.body);}
 const id=made[0].id,updated=route('PATCH',url(`/devices/${id}`),{position:{x:420,y:180}}).body;assert.deepEqual(updated.position,{x:420,y:180});assert.deepEqual(route('GET',url(`/devices/${id}`)).body.position,{x:420,y:180});assert.throws(()=>route('PATCH',url(`/devices/${id}`),{position:{x:-1,y:3}}),e=>e.status===400);assert.equal(route('PATCH',url(`/devices/${id}`),{position:null}).body.position,null);
 const edge=route('POST',url('/topology/connections'),{source:made[0].id,target:made[1].id});assert.equal(edge.status,201);assert.equal(route('POST',url('/topology/connections'),{source:made[1].id,target:made[0].id}).status,409);assert.equal(route('POST',url('/topology/connections'),{source:made[0].id,target:made[0].id}).status,400);assert.equal(route('POST',url('/topology/connections'),{source:made[0].id,target:'missing'}).status,400);
 route('DELETE',url(`/devices/${made[0].id}`));assert.equal(route('GET',url('/topology')).body.edges.some(e=>e.id===edge.body.id),false);route('DELETE',url(`/devices/${made[1].id}`));
});
test('monitoring keeps degraded status when telemetry exceeds thresholds and scheduler rotates fairly',()=>{
 store.resetState();const device=store.getState().devices[0];
 monitoring.runScenario(device.id,'latency');assert.equal(device.status,'degraded');
 monitoring.record(device,true,device.thresholdLatency+1,0);assert.equal(device.status,'degraded');
 monitoring.record(device,true,device.thresholdLatency,0);assert.equal(device.status,'online');
 monitoring.record(device,true,20,device.thresholdLoss+1);assert.equal(device.status,'degraded');
 const devices=Array.from({length:9},(_,i)=>({id:String(i)})),first=scheduler.selectScheduledBatch(devices,8,0),second=scheduler.selectScheduledBatch(devices,8,first.cursor);
 assert.equal(first.batch.length,8);assert.ok(first.batch.some(x=>x.id==='0'));assert.ok(second.batch.some(x=>x.id==='8'));assert.equal(new Set(second.batch.map(x=>x.id)).size,8);
});
test('corrupted or incomplete persisted sessions are identified and cannot continue',()=>{
 store.resetState();const session=diagnosis.startSession({scenarioId:'adaptive_endpoint',probeBudget:4}),raw=store.getState().diagnosisSessions.find(x=>x.id===session.id);delete raw.beliefs;
 assert.equal(diagnosis.listSessions().find(x=>x.id===session.id).status,'invalid');assert.throws(()=>diagnosis.findSession(session.id),e=>e.status===409);assert.throws(()=>diagnosis.stepSession(session.id),e=>e.status===409);
});
test('experiment runner records actual baseline metrics with repeatable seeded outcomes',()=>{
 store.resetState();const a=experiments.runExperiment({seed:23,probeBudget:5}),b=experiments.runExperiment({seed:23,probeBudget:5});
 assert.equal(a.scenarioCount,6);assert.deepEqual(a.rows.map(x=>[x.scenarioId,x.method,x.diagnosis,x.probesUsed,x.cumulativeCost]),b.rows.map(x=>[x.scenarioId,x.method,x.diagnosis,x.probesUsed,x.cumulativeCost]));
 assert.deepEqual(a.summary.map(x=>x.method),['uafloc','fixed','random','conventional']);assert.ok(a.elapsedMs>=0);assert.ok(a.summary.every(x=>x.meanAlgorithmMs>=0));
 for(const scenarioId of new Set(a.rows.map(x=>x.scenarioId)))assert.equal(new Set(a.rows.filter(x=>x.scenarioId===scenarioId).map(x=>x.truth)).size,1);
 assert.ok(experiments.getExperiment(a.id));assert.throws(()=>experiments.getExperiment('missing'),e=>e.status===404);
});
