import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.resolve(process.env.DATA_FILE || path.join(root, 'data/state.json'));
const now = () => new Date().toISOString();
const names=['Campus Gateway Router','Core Switch','Library Access Point','Computer Lab Server','Library PC','Computer Lab PC','Administration Server','Wireless Access Point'];
const types=['Router','Switch','Access point','Server','PC','PC','Server','Access point'];
const ips=['192.168.1.1','192.168.1.2','192.168.1.10','192.168.1.20','192.168.1.31','192.168.1.32','192.168.1.40','192.168.1.11'];
export function seed(){
 const devices=names.map((name,i)=>({id:randomUUID(),name,address:ips[i],type:types[i],description:'Simulated campus network device',monitoringEnabled:true,mode:'simulation',status:i===5?'offline':'online',latency:i===2?68:8+i*3,packetLoss:i===5?100:0,lastChecked:now(),lastSuccess:i===5?null:now(),simulated:true,interval:30,thresholdLatency:100,thresholdLoss:5}));
 const metrics=[]; for(let n=23;n>=0;n--)for(const d of devices){const timestamp=new Date(Date.now()-n*300000).toISOString(),success=!(d.status==='offline'&&n<5);metrics.push({id:randomUUID(),deviceId:d.id,timestamp,success,latency:success?Math.max(1,d.latency+Math.round(Math.random()*8-4)):null,packetLoss:success?d.packetLoss:100,source:'simulation'});}
 const failed=devices[5];
 return {devices,metrics,incidents:[{id:randomUUID(),deviceId:failed.id,deviceName:failed.name,type:'connectivity',severity:'critical',description:'Repeated connectivity failures detected in simulation.',status:'active',detectedAt:new Date(Date.now()-420000).toISOString(),resolvedAt:null,source:'simulation'}],events:[{id:randomUUID(),type:'incident',message:`Connectivity incident opened for ${failed.name}`,timestamp:new Date(Date.now()-420000).toISOString(),source:'simulation'}],connections:[[0,1],[1,2],[1,3],[2,4],[3,5],[1,6],[2,7]].map(([a,b])=>({id:randomUUID(),source:devices[a].id,target:devices[b].id})),settings:{refreshSeconds:15,latencyThreshold:100,packetLossThreshold:5,defaultInterval:30,timeoutMs:1500,concurrency:8},demo:{running:true}};
}
fs.mkdirSync(path.dirname(file),{recursive:true});let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{state=seed();persist();}
export function getState(){let changed=false;for(const key of ['diagnosisSessions','experimentRuns','customDiagnosticScenarios'])if(!Array.isArray(state[key])){state[key]=[];changed=true;}if(changed)persist();return state;}
export function persist(){const tmp=`${file}.tmp`;fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,file);}
export function resetState(){state=seed();persist();return state;}
export function timestamp(){return now();}
