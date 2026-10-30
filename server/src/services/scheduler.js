import { getState, persist } from '../store.js';
import { record } from './monitoring.js';
export function selectScheduledBatch(devices, limit, cursor = 0) {
  if (!devices.length) return { batch: [], cursor: 0 };
  const size = Math.min(devices.length, Math.max(1, Math.floor(limit) || 8));
  const start = ((Math.floor(cursor) || 0) % devices.length + devices.length) % devices.length;
  const batch = Array.from({ length: size }, (_, i) => devices[(start + i) % devices.length]);
  return { batch, cursor: (start + size) % devices.length };
}
export function startScheduler(){let busy=false,cursor=0;const timer=setInterval(()=>{const s=getState();if(!s.demo.running||busy)return;busy=true;try{const eligible=s.devices.filter(x=>x.simulated&&x.monitoringEnabled&&x.status!=='offline'),selected=selectScheduledBatch(eligible,s.settings.concurrency||8,cursor);cursor=selected.cursor;for(const d of selected.batch)record(d,true,Math.max(3,Math.round((d.latency||20)+(Math.random()*12-6))),d.status==='degraded'?(d.packetLoss||0):0);}finally{busy=false;persist();}},30000);timer.unref();return()=>clearInterval(timer);}
