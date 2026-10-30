import http from 'node:http';
import { createServer } from './src/app.js';
import { startScheduler } from './src/services/scheduler.js';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const server = http.createServer(createServer());
const stopScheduler = startScheduler();
server.listen(port, host, () => console.log(`Campus NOC ready at http://localhost:${port}`));
function shutdown(){ stopScheduler(); server.close(()=>process.exit(0)); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
