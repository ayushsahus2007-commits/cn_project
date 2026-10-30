import os from 'node:os';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { rankProbes, entropy, bayesUpdate, simulatedOutcome } from '../server/src/services/uafloc.js';

function build(size) {
  const nodes = Array.from({ length: size }, (_, i) => `node_${i}`);
  const links = nodes.slice(1).map((target, i) => ({ source: nodes[i], target, directed: true, knowledge: i % 5 === 0 ? 'unknown' : 'observed' }));
  const hypotheses = [...nodes.map((id) => ({ id: `node:${id}`, prior: 1 / (size * 2) })), ...links.map((_, i) => ({ id: `link:${i}`, prior: 1 / (size * 2) }))];
  const probes = [];
  for (const node of nodes) {
    const likelihoods = Object.fromEntries(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.id === `node:${node}` ? { node_down: 1 } : { reachable: 1 }]));
    probes.push({ id: `node_check:${node}`, label: `Node ${node} check`, cost: 1, likelihoods });
  }
  for (let i = 0; i < links.length; i++) {
    const likelihoods = Object.fromEntries(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.id === `link:${i}` ? { link_down: 1 } : { link_up: 1 }]));
    probes.push({ id: `link_check:${i}`, label: `Link ${i} check`, cost: 1.2, likelihoods });
  }
  return { id: `benchmark_${size}`, nodes, links, hypotheses, probes, truth: hypotheses[0].id, activeRoute: nodes, topology: { knownNodes: nodes, knownLinks: links, unknownLinks: links.filter((link) => link.knowledge === 'unknown') } };
}

const rows = [];
for (const size of [10, 50, 100]) {
  const heapBefore = process.memoryUsage().heapUsed;
  let t = performance.now();
  const scenario = build(size);
  const modelConstructionMs = performance.now() - t;
  t = performance.now();
  const beliefs = Object.fromEntries(scenario.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.prior]));
  const priorEntropyBits = entropy(beliefs);
  const hypothesisDistributionMs = performance.now() - t;
  t = performance.now();
  const ranked = rankProbes(scenario, beliefs);
  const candidateEvaluationMs = performance.now() - t;
  t = performance.now();
  const selected = ranked[0];
  const observation = simulatedOutcome(scenario, selected.id);
  const update = bayesUpdate(beliefs, selected.id, observation.outcome, scenario);
  const posteriorEntropyBits = entropy(update.posterior);
  const simulatedProbeIterationMs = performance.now() - t;
  rows.push({ nodes: size, directedLinks: scenario.links.length, unknownLinks: scenario.topology.unknownLinks.length, hypotheses: scenario.hypotheses.length, candidates: scenario.probes.length, modelConstructionMs: +modelConstructionMs.toFixed(3), hypothesisDistributionMs: +hypothesisDistributionMs.toFixed(3), candidateEvaluationMs: +candidateEvaluationMs.toFixed(3), simulatedProbeIterationMs: +simulatedProbeIterationMs.toFixed(3), priorEntropyBits: +priorEntropyBits.toFixed(3), posteriorEntropyBits: +posteriorEntropyBits.toFixed(3), selectedProbe: selected.id, topUtility: +selected.utility.toFixed(4), heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
}
console.log(JSON.stringify({ runtime: process.version, platform: `${os.platform()} ${os.arch()}`, cpuCount: os.cpus().length, method: 'Synthetic directed chain, deterministic likelihoods, one node and link check per target; measures model construction, entropy, probe ranking, and one simulated Bayesian update. Single-process microbenchmark; no network I/O.', rows }, null, 2));
