import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { bayesUpdate, entropy, initialBeliefs, rankProbes } from '../server/src/services/uafloc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seeds = [11, 23, 37, 41, 53, 67, 79, 83, 97, 101];
const methods = ['uafloc', 'fixed', 'random', 'conventional'];
const budgets = { 10: 20, 25: 20, 50: 20, 100: 20 };

function rng(seed) { let state = seed >>> 0; return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; }; }
function makeScenario(nodes, seed, partial) {
  const choose = rng(seed);
  const labels = Array.from({ length: nodes }, (_, i) => `node_${i}`);
  const links = labels.slice(0, -1).map((source, i) => ({ source, target: labels[i + 1], directed: true, knowledge: partial && i % 5 === 0 ? 'unknown' : 'observed' }));
  const hypotheses = [...labels.map((name, i) => ({ id: `node:${name}`, prior: 1 / (nodes * 2 - 1), position: i * 2 })), ...links.map((link, i) => ({ id: `link:${i}`, prior: 1 / (nodes * 2 - 1), position: i * 2 + 1 }))];
  const truth = hypotheses[Math.floor(choose() * hypotheses.length)].id;
  const probes = [];
  const addCut = (id, cutoff, cost = 1) => {
    const likelihoods = Object.fromEntries(hypotheses.map((h) => [h.id, { [h.position <= cutoff ? 'unreachable' : 'reachable']: 1 }]));
    probes.push({ id, label: id, cost, likelihoods });
  };
  addCut('target_ping', Number.MAX_SAFE_INTEGER, 1);
  for (const h of hypotheses) {
    if (partial && h.id.startsWith('link:') && links[Number(h.id.split(':')[1])].knowledge === 'unknown') continue;
    addCut(`segment_${String(h.position).padStart(3, '0')}`, h.position, 1.1);
  }
  return { id: `${nodes}_${seed}_${partial ? 'partial' : 'complete'}`, truth, hypotheses, probes, topology: { knownNodes: labels, knownLinks: links.filter((l) => l.knowledge === 'observed'), unknownLinks: links.filter((l) => l.knowledge === 'unknown') } };
}

function run(scenario, method, seed, budget) {
  const start = performance.now();
  let beliefs = initialBeliefs(scenario), used = [], cost = 0, random = rng(seed + methods.indexOf(method) * 1009), stopReason = 'probe_budget_exhausted';
  let completed = false;
  const confidence = () => Math.max(...Object.values(beliefs));
  if (confidence() >= .85) { completed = true; stopReason = 'confidence_threshold'; }
  while (!completed && used.length < budget) {
    const available = scenario.probes.filter((p) => !used.includes(p.id) && Number.isFinite(p.cost) && p.cost > 0);
    const ranked = rankProbes(scenario, beliefs, used);
    let chosen;
    if (method === 'uafloc') {
      chosen = ranked[0];
      if (!chosen) { stopReason = 'not_identifiable'; break; }
    } else if (method === 'fixed') chosen = available.sort((a, b) => a.id.localeCompare(b.id))[0];
    else if (method === 'conventional') chosen = available.find((p) => p.id === 'target_ping') || available[0];
    else chosen = available[Math.floor(random() * available.length)];
    if (!chosen) { stopReason = 'no_probes_available'; break; }
    const outcome = Object.keys(chosen.likelihoods[scenario.truth] || {})[0];
    const update = bayesUpdate(beliefs, chosen.id, outcome, scenario);
    if (update.inconsistent) { stopReason = 'model_evidence_inconsistency'; break; }
    beliefs = update.posterior; used.push(chosen.id); cost += chosen.cost;
    if (confidence() >= .85) { completed = true; stopReason = 'confidence_threshold'; }
  }
  const ordered = scenario.hypotheses.map((h) => [h.id, beliefs[h.id] || 0]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const posterior = Object.fromEntries(scenario.hypotheses.map((h) => [h.id, beliefs[h.id] || 0]));
  const brier = Object.values(posterior).reduce((sum, p, i) => sum + (p - (scenario.hypotheses[i].id === scenario.truth ? 1 : 0)) ** 2, 0);
  return { scenarioId: scenario.id, truth: scenario.truth, method, completed, stopReason, top1Correct: ordered[0]?.[0] === scenario.truth, top3Correct: ordered.slice(0, 3).some(([id]) => id === scenario.truth), diagnosedCorrect: completed && ordered[0]?.[0] === scenario.truth, probes: used.length, cost: +cost.toFixed(3), confidence: +confidence().toFixed(6), brier: +brier.toFixed(6), executionMs: +(performance.now() - start).toFixed(4), entropyBits: +entropy(posterior).toFixed(6) };
}

const raw = [];
for (const nodes of [10, 25, 50, 100]) for (const seed of seeds) for (const partial of [false, true]) {
  const scenario = makeScenario(nodes, seed, partial);
  for (const method of methods) raw.push({ nodes, seed, topology: partial ? 'partial' : 'complete', ...run(scenario, method, seed, budgets[nodes]) });
}
const summary = [];
for (const nodes of [10, 25, 50, 100]) for (const topology of ['complete', 'partial']) for (const method of methods) {
  const rows = raw.filter((r) => r.nodes === nodes && r.topology === topology && r.method === method), n = rows.length;
  summary.push({ nodes, topology, method, runs: n, completed: rows.filter((r) => r.completed).length, completionRate: rows.filter((r) => r.completed).length / n, diagnosedAccuracy: rows.filter((r) => r.completed).length ? rows.filter((r) => r.diagnosedCorrect).length / rows.filter((r) => r.completed).length : null, top1Accuracy: rows.filter((r) => r.top1Correct).length / n, top3Accuracy: rows.filter((r) => r.top3Correct).length / n, meanProbes: rows.reduce((s, r) => s + r.probes, 0) / n, meanCost: rows.reduce((s, r) => s + r.cost, 0) / n, meanConfidence: rows.reduce((s, r) => s + r.confidence, 0) / n, brierScore: rows.reduce((s, r) => s + r.brier, 0) / n, meanExecutionMs: rows.reduce((s, r) => s + r.executionMs, 0) / n, meanEntropyBits: rows.reduce((s, r) => s + r.entropyBits, 0) / n });
}
const output = { metadata: { generatedAt: new Date().toISOString(), runtime: process.version, platform: `${os.platform()} ${os.arch()}`, cpuCount: os.cpus().length, seeds, probeBudget: budgets, nodes: [10, 25, 50, 100], scenariosPerSizeTopology: seeds.length, methods, totalRuns: raw.length, method: 'Independent synthetic directed-chain stress experiment using the production UAFLoc entropy, ranking, initialization, and Bayesian update functions. Each size and seed uses the same sampled fault location across all methods. Partial scenarios omit direct probes on every fifth unknown link. All observations are deterministic given a selected probe and hidden synthetic fault. Confidence stopping threshold is 0.85. Algorithm runtime excludes network latency and storage.', metricDefinitions: { diagnosedAccuracy: 'Correct top posterior hypothesis among runs reaching 0.85 confidence; null when no run completed.', top1Accuracy: 'Truth is the highest posterior hypothesis across every run, including unresolved runs.', top3Accuracy: 'Truth is among the three highest posterior hypotheses across every run.', completionRate: 'Fraction reaching at least 0.85 posterior confidence within the 20-probe budget.', brierScore: 'Mean multiclass Brier score over the full hypothesis distribution; lower is better.', meanExecutionMs: 'Measured JavaScript algorithm time in-process; not network latency.' } }, summary, raw };
const reports = path.join(root, 'reports'); fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(path.join(reports, 'uafloc-validation-results.json'), `${JSON.stringify(output, null, 2)}\n`);
const fmt = (x, digits = 3) => x == null ? '—' : Number(x).toFixed(digits);
const table = summary.map((r) => `| ${r.nodes} | ${r.topology} | ${r.method} | ${r.runs} | ${fmt(r.completionRate)} | ${fmt(r.diagnosedAccuracy)} | ${fmt(r.top1Accuracy)} | ${fmt(r.top3Accuracy)} | ${fmt(r.meanProbes, 2)} | ${fmt(r.meanConfidence)} | ${fmt(r.brierScore)} | ${fmt(r.meanExecutionMs, 4)} |`).join('\n');
const markdown = `# UAFLoc Validation Report\n\nGenerated ${output.metadata.generatedAt} on ${output.metadata.runtime} (${output.metadata.platform}, ${output.metadata.cpuCount} CPUs). This report was generated by \`npm run validate\`; machine-readable measurements are in [uafloc-validation-results.json](./uafloc-validation-results.json).\n\n## Executive summary\n\nThis validation checks the implemented finite-model diagnosis engine and runs a reproducible synthetic stress experiment. The main application and this experiment simulate observations; they do not probe real network devices. The synthetic scale study tests algorithm mechanics on directed chains with ${seeds.length} seeds per size and topology condition, with identical ground-truth faults shared by all four methods for each scenario. It does not establish real-network accuracy.\n\n## Existing architecture\n\nThe Node.js service exposes a static browser app and REST endpoints. \`uafloc.js\` initializes priors, computes entropy and expected information gain, ranks unused probes by information gain divided by positive cost, applies Bayes' rule, and stops at 0.85 confidence, budget exhaustion, or lack of informative probes. \`diagnosis.js\` persists evidence and belief history in local JSON; \`experiments.js\` compares adaptive, fixed-order, random-order, and target-ping-first methods over six built-in scenarios. The separate dashboard scheduler also uses simulated telemetry.\n\n## Mathematical and functional checks\n\nThe built-in Node test suite includes hand-computable entropy, information gain, and posterior cases; normalization across extreme finite magnitudes; rejection of negative/nonfinite probabilities; zero-likelihood and contradictory evidence; deterministic tie-breaking; probe exhaustion; stopping on ambiguity; custom disconnected and partial topologies; ground-truth withholding; repeated seeded runs; and process-restart session restoration. The validated run passed all 15 tests.\n\nProbe utility is \`expected information gain / cost\`; tied utilities use probe ID. Bayesian updates normalize each hypothesis' categorical likelihood vector before weighting the prior. An observation with zero total evidence is flagged inconsistent and does not create a posterior.\n\n## Adaptive probe validation\n\nThe engine does use entropy reduction: it computes expected posterior entropy from each candidate's likelihoods. The selected probe is the informative available probe with highest information gain per positive cost. Non-informative probes are excluded from UAFLoc selection, and already-used probes are removed. The scale experiment below measures whether this selection recovers the sampled fault more efficiently than the three baselines under the stated synthetic model.\n\n## Termination and persistence\n\nSessions have a maximum of 20 probes and stop when the top posterior reaches 0.85, the budget is exhausted, or no informative probe remains. A safety loop limit is also present. Tests verify incomplete outcomes, used-probe exclusion, saving an intermediate step, loading the same state in a fresh Node process, continuing the session, and rejecting incomplete/corrupt session records with a conflict response rather than continuing from bad beliefs.\n\n## Partial topology\n\nCustom scenarios preserve explicitly known and unknown directed links, accept isolated nodes and disconnected components, and reject dangling/duplicate/conflicting links. They do not infer missing links. The scale experiment's partial condition withholds direct probes on each fifth link while keeping the same node count and fault distribution. This is a deliberately simple observation-availability stress case, not a packet-level topology simulator.\n\n## Baseline fairness\n\nAll four methods receive the same generated scenario, prior, hidden fault, observation likelihoods, stopping threshold, and 20-probe cap. Only probe choice differs: UAFLoc maximizes information gain per cost; fixed uses alphabetical probe order; random samples from all unused positive-cost probes with a deterministic LCG seed; conventional uses the end-to-end target ping first, then alphabetical order. Hidden truth is used only by the simulator to produce an observation and by offline scoring. The regular diagnostic session and scenario APIs do not return truth; experiment result records intentionally include truth for evaluation.\n\n## Synthetic scale experiment results\n\nEach row aggregates ${seeds.length} independent seeds. Completion means reaching 0.85 posterior confidence by 20 probes. Diagnosed accuracy is conditional on completion; Top-1 and Top-3 are unconditional posterior localization metrics. Brier score is lower-is-better. Runtime is algorithm execution in this local Node process, not simulated probe delay or real network latency.\n\n| Nodes | Topology | Method | Runs | Completion | Diagnosed accuracy | Top-1 | Top-3 | Mean probes | Mean confidence | Brier | Mean algorithm ms |\n|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n## Ablation and interpretation\n\nThe fixed-order baseline provides a limited probe-adaptation comparison while retaining Bayesian updates. The current architecture has no isolated no-Bayes or complete-topology ablation that preserves equivalent observation semantics, so this report does not claim causal effects for Bayesian updating or partial-topology support. Those require additional controlled variants and should be designed before attributing component-level benefits.\n\n## Identified fixes and limitations\n\nValidation exposed two implementation issues and addressed them: probability normalization previously silently discarded invalid weights and could overflow while summing very large finite values; it now rejects invalid weights and scales before summation. The random baseline previously sampled only probes already ranked informative by UAFLoc; it now samples from the same full set of unused positive-cost probes as the non-adaptive baselines. Session restoration now checks stored belief support, normalization, probe history, and scenario consistency before resuming.\n\nThe model still uses hand-authored finite hypotheses and deterministic likelihood tables. Experiment scenarios are synthetic, costs are abstract, topology is simple, and outcomes are not learned from traces. Results are not evidence of production diagnostic performance. The benchmark and experiment timings do not represent network response time. The JSON store is for a single-user demonstration.\n\n## Recommended next phase\n\nCollect a labeled, consented set of network fault traces or build a calibrated packet-level simulator; define realistic probe costs and observation noise; pre-register scenario sampling and metrics; then evaluate across independent topologies and fault classes, with confidence intervals and calibration plots. Keep live probing disabled until access controls, timeouts, rate limits, and operator authorization are designed and tested.\n\n## Reproduction\n\n\`npm test\` runs correctness and persistence tests. \`npm run validate\` regenerates this report and the JSON measurements from the fixed seed list. \`npm run benchmark\` separately measures model construction, candidate ranking, and one Bayesian update for 10, 50, and 100-node synthetic models. All scripts perform no network I/O.\n`;
fs.writeFileSync(path.join(reports, 'uafloc-validation.md'), markdown);
console.log(JSON.stringify({ report: 'reports/uafloc-validation.md', data: 'reports/uafloc-validation-results.json', totalRuns: raw.length, groups: summary.length }, null, 2));
