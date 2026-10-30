# UAFLoc: Uncertainty-Aware Adaptive Fault Localization

A locally runnable, full-stack demonstration of adaptive diagnosis for partially observed network topologies. It combines a dependency-free Node.js REST backend, a browser dashboard, a deterministic simulator, persistent diagnosis sessions, and repeatable comparisons against baseline probe-selection strategies.

## Run locally

Requires Node.js 20 or newer. No package installation or frontend build is needed.

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). The server binds to `127.0.0.1`; set `PORT` or `HOST` to override. Application state is stored in `data/state.json` (or `DATA_FILE`). The demo scheduler is simulated and can be paused in the app.

Useful commands:

```sh
npm test
npm run benchmark
npm run validate
```

## Public preview deployment (Render)

The root `render.yaml` configures a free, read-only demo service. To deploy it, open Render, choose **New → Blueprint**, connect this GitHub repository, and apply the `uafloc-demo` service. Render builds with `npm install`, starts with `npm start`, and checks `/api/health`.

The hosted preview is read-only: visitors can inspect the dashboard and topology, while API writes are rejected. The free service uses an ephemeral filesystem, so its sample data can reset after a restart or redeploy, and it may take about a minute to wake after 15 minutes idle. For persistent, editable shared data, use a paid persistent disk or move state to a managed database and add user authentication before enabling writes.

## Use the app

- **Run diagnosis:** choose a simulated symptom scenario, inspect the prior fault probabilities and available probes, then step once or run until the stopping rule is reached. Each step shows the observation, updated probabilities, and remaining useful probes.
- **Create scenario:** define a symptom, fault class, nodes, and known or unknown directed links. Unknown links remain explicitly marked as unknown in the model. The custom scenario is stored locally.
- **Experiments:** set a seed and probe budget, then run repeated comparisons across UAFLoc, fixed order, random order, and conventional target-ping-first probe selection. Each scenario-method-repeat is retained in the experiment record.
- **Reset:** reset a diagnosis session to its initial beliefs. The dashboard's demo reset resets the seeded campus demo data; it does not erase diagnostic scenarios or experiment history.

## Model

The implementation uses a finite hypothesis set and explicit outcome likelihoods. It normalizes priors, computes Shannon entropy in bits, evaluates each unused probe by expected information gain, and ranks by information gain divided by positive probe cost. Equal utilities are broken by probe ID for deterministic selection. After an observation, Bayes' rule updates the posterior. The engine stops at 85% confidence, when the probe budget is exhausted, or when no informative probe remains. The latter is reported as **not uniquely localizable** rather than forcing a diagnosis.

Probe costs are abstract units. Likelihood tables, hypotheses, and scenario outcomes are declared assumptions for this demo; they are not learned from production traces. The experiment simulator uses known hidden truth to generate observations; ordinary diagnosis responses do not expose that truth. Random baseline behavior is reproducible from the experiment seed.

## Architecture

- `server/index.js` starts the HTTP server and simulated monitoring scheduler.
- `server/src/app.js` serves static assets and JSON API responses.
- `server/src/routes.js` provides dashboard, device/topology, diagnostics, and experiment endpoints with input validation.
- `server/src/store.js` persists seeded demo records, custom scenarios, sessions, and experiments in local JSON.
- `server/src/services/uafloc.js` contains the entropy, information-gain, Bayesian update, scenario, and stopping-rule logic.
- `server/src/services/diagnosis.js` runs and persists stepwise sessions.
- `server/src/services/experiments.js` performs seeded repeated comparisons.
- `server/src/services/monitoring.js` and `scheduler.js` support the separate simulated campus-health dashboard.
- `public/` contains the plain HTML, CSS, and JavaScript frontend.
- `test/uafloc.test.js` contains built-in Node test-runner checks; `scripts/benchmark.js` is a synthetic microbenchmark.
- `scripts/validate-experiments.js` regenerates the seeded multi-size baseline study and `reports/uafloc-validation.md` with raw JSON results.

## API

All endpoints are served from the same origin:

- `GET /api/diagnostics/health`
- `GET|POST /api/diagnostics/scenarios`; `GET /api/diagnostics/scenarios/:id`
- `GET|POST /api/diagnostics/sessions`; `GET /api/diagnostics/sessions/:id`
- `POST /api/diagnostics/sessions/:id/step|run|reset`
- `POST /api/diagnostics/reset`
- `GET|POST /api/experiments`; `POST /api/experiments/run`; `GET /api/experiments/:id`

The existing campus-monitoring API also covers health, dashboard summary/activity, devices, metrics, analytics, topology, incidents, settings, and demo controls. Errors return JSON with an `error` field and an HTTP status.

## Scope and limitations

Everything is a local simulation. The app does not perform ICMP, SNMP, packet capture, or any live network operation. Device checks without simulated demo data return an explicit “Live ICMP is not configured” response. The JSON store is suitable for a single-user local demonstration, not concurrent multi-process deployment. Results demonstrate the mechanics of one finite-model implementation and do not establish research novelty or production diagnostic accuracy.
