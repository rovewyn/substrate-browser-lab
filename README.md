# substrate-browser-lab

Experiment scripts for browser actors on [Substrate](https://github.com/agent-substrate/substrate): Playwright MCP, SuspendActor/ResumeActor behavior, and capacity workloads.

This repository holds experiment scripts and their required image recipes, configuration, and dependencies. Reports and all measured results remain local. Future publication on [rovewyn.github.io](https://rovewyn.github.io/) is a separate task.

## Contributor Setup

Install [Gitleaks](https://github.com/gitleaks/gitleaks#installing) with support for the `git` command, then enable the repository hooks after cloning:

```sh
brew install gitleaks # macOS; see the link above for other platforms
sh scripts/install-hooks.sh
```

The versioned `.githooks/pre-commit` hook scans staged changes before every commit. Findings, scan errors, or a missing Gitleaks executable block the commit. Scan output redacts secret values. Fix the issue, stage the corrected files, and retry. Do not bypass the hook with `--no-verify`.

Hook activation is local to each clone; repeat the setup for new clones. The installer preserves existing hooks by refusing to switch from another configured hooks path or active default hooks. Resolve those conflicts before retrying.

Work on `codex/` feature branches. Follow [AGENTS.md](AGENTS.md). This lab does not add CI or automated test suites. Validate changes through direct experiments and manual output inspection.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `experiments/browser/image/` | ARM64 Chromium + Playwright MCP image, dependency lockfile, HTTP service, and synthetic browser state page |
| `experiments/browser/scripts/` | Browser workload driver, MCP client, loopback gateway, deployment, and node restart experiment |
| `experiments/browser/client-sdk/` | External MCP SDK experiment and dependency lockfile |
| `experiments/browser/config/` | Recorded ActorTemplate, WorkerPool, gVisor configuration, and egress policy |
| `experiments/playground/actors.py` | Counter and Sandbox lifecycle experiments on actual Substrate Actors |
| `experiments/ram/` | Memory-only Go process and Worker replacement experiment |
| `experiments/agent-chat/` | Actor-local Codex chat service, loopback console, image recipe, and deployment helper |
| `scripts/`, `config/`, `play.sh` | Reusable local playground setup and lifecycle helpers |

## Manual Playground Setup

Run from the repository root. This manual setup targets macOS ARM64, Docker Desktop context `desktop-linux`, and available loopback ports 5001, 8000, and 8931. It requires Bash, Python 3, Go, Kind, and kubectl. Host Node/npm is optional for the external SDK script. The reference configuration uses one ARM64 Kind node and two Browser Workers; configure Docker Desktop resources separately. Existing resources with conflicting names or ownership are preserved.

```bash
mkdir -p src bin
git clone https://github.com/agent-substrate/substrate.git src/substrate
git -C src/substrate checkout --detach 288694ef2297bb5d6fab30eca328ddaa89015f91
source config/env.sh
(cd src/substrate && go build -o "$PLAY_ROOT/bin/kubectl-ate" ./cmd/kubectl-ate)
python3 scripts/capture-baseline.py
./scripts/create-cluster.sh
./scripts/install.sh
./experiments/browser/build.sh

image="$(docker --context desktop-linux image inspect localhost:5001/substrate-browser:playwright-0.0.83 --format '{{index .RepoDigests 0}}')"
python3 experiments/browser/scripts/deploy.py "$image"
./play.sh ate create egress-policy browser-1 -a ate-demo-browser -f experiments/browser/config/egress-policy.json
./play.sh start
```

Expected outputs are a ready `substrate-play` Kind node, core Substrate services, Counter/Sandbox Workers, two Browser Workers, a ready browser template snapshot, and `ate-demo-browser/browser-1`. Inspect them with `./play.sh status` and `./experiments/browser/browser.sh status` before beginning an experiment.

The scripts fix the project kubeconfig at `state/kubeconfig`, Kubernetes context `kind-substrate-play`, Docker context `desktop-linux`, and owned container names. `KUBECTL_ATE_BIN` can select a CLI executable. `config/env.sh` also selects checkout-local Go/ko/build caches. These environment settings apply only to the shell where the file is sourced and its child processes.

The image digests in example manifests refer to the **local registry**. Build a new digest before deployment. The Browser Worker image is obtained from the installed Sandbox WorkerPool. Deployment preserves an existing `browser-1` and rejects an existing template name. ActorTemplates are immutable; image changes require a new template and a deliberate choice of Actor lifecycle.

The browser Actor uses the separate `browser-gvisor-20261005` SandboxConfig. Counter and Sandbox keep their original runtime configuration. The egress policy allows only `example.com` on HTTP port 80 and TLS passthrough port 443; certificate verification remains enabled.

## Browser Operations and Workload

```bash
./experiments/browser/browser.sh start
./experiments/browser/browser.sh status
./experiments/browser/browser.sh call browser_snapshot '{}'
./experiments/browser/browser.sh screenshot
./experiments/browser/browser.sh suspend
./experiments/browser/browser.sh resume
```

The MCP endpoint is `http://127.0.0.1:8931/mcp`; agent client configuration is in [mcp-client.json](experiments/browser/config/mcp-client.json). The calling agent supplies its own model. These scripted browser operations do not need a model API key. Clients share one Actor's browser context and tabs. Separate agent state requires separate Actors and routing.

Screenshots are written to ignored `outputs/substrate-browser-current.png`. Headless Chromium renders the page without a desktop browser window. The pinned MCP tools use element references from `browser_snapshot` as the `target` argument; screenshots accept `scale: "css"`.

```bash
# Initialize two synthetic browser pages and record their state.
./experiments/browser/browser.sh verify

# SuspendActor, replace its original Worker Pod, ResumeActor, then read state.
./experiments/browser/browser.sh suspend-resume

# Collect 10 browser launch samples and 10 sequential lifecycle samples.
./experiments/browser/browser.sh benchmark --iterations 10

# Suspend all Actors, stop/start the owned node and registry, and inspect state.
python3 experiments/browser/scripts/restart-check.py
```

`verify` navigates to the Actor-local `http://127.0.0.1/fixture` page and replaces the shared context with two fixture tabs. It creates memory-only identity markers, a counter, an unsaved input value, a transient DOM element, storage values, and a synthetic cookie. These constitute the experimental workload rather than mocked browser behavior.

The suspend/resume experiment must preserve each page's URL, `performance.timeOrigin`, memory marker, counter, unsaved input, transient DOM marker, and storage/cookie state. It reuses the original MCP session and reads existing pages after ResumeActor. It does not navigate or inject replacement page state during that comparison. A subsequent click must advance the saved counter by one. It also requires actual `SNAPSHOT_FIDELITY_MEMORY`; preferred snapshot fidelity alone is insufficient evidence.

The original Worker is deleted only after checking it serves no other Actor. The driver waits for both Pod readiness and Substrate Worker registration. Worker replacement is within the same Kind node; this does not establish migration between machines or CPU models.

`benchmark` creates and deletes temporary Actors for Chromium launch samples. The primary Actor supplies sequential SuspendActor/ResumeActor samples. It changes the primary counter to 100 and advances it once per cycle. `browserLaunchSeconds` measures navigation after Actor resume and MCP initialization. `resumeToFirstToolSeconds` measures ResumeActor plus reading all existing pages. These are different workloads. The 10-sample nearest-rank p95 is the maximum sample; it is not a production latency or throughput estimate. Local JSON keys such as `checkpointCycles` retain the script schema; CLI operations use Substrate's suspend/resume names.

For the optional external SDK observation, use a host Node/npm installation:

```bash
npm ci --prefix experiments/browser/client-sdk
node experiments/browser/client-sdk/verify.mjs
```

This discovers tools and reads the existing page through standard Streamable HTTP. It writes ignored `outputs/substrate-browser-mcp-client.json` and closes only its connection, retaining the shared browser context. Both npm dependency manifests and lockfiles are committed.

The optional `experiments/browser/image/probe.mjs` provides a direct Chromium process observation helper. It is not copied into the standard image. Its loopback port 8090 belongs to the Actor, not the host MCP endpoint.

## Supporting Actor Experiments

The following operations create or change demo Actors. Run them once on prepared Counter/Sandbox state and inspect `state/verification.json` after each stage.

```bash
python3 experiments/playground/actors.py actors
python3 experiments/playground/actors.py cycle
```

The first phase records Counter memory/file continuity, Worker replacement, six Counter Actors reusing three Workers, and Sandbox output/exit codes/file persistence. The second phase performs an owned node stop/start and records unrelated-container and ambient-kubeconfig preservation. These are actual infrastructure experiments; they do not use mock services.

The separate RAM workload generates a random identifier once in process memory. Expected continuity is counter 42 before SuspendActor and after Worker replacement, then 43 after another request, with the same process identity.

```bash
source config/env.sh
GOOS=linux GOARCH=arm64 go build -o bin/ram-demo experiments/ram/main.go
python3 experiments/ram/ram-demo.py prepare
python3 experiments/ram/ram-demo.py move
```

## Actor Chat Console

This experiment reuses the existing `substrate-play` Kind cluster and its gVisor Sandbox Workers. It creates a separate `ate-demo-agent` Atespace, an immutable ActorTemplate, and `chat-1`/`chat-2` in suspended state. Existing Actors and WorkerPools are preserved. The template's unauthenticated golden snapshot contains no conversation or login credentials.

The host requires Node.js 24, Docker Desktop, kubectl, and the playground's `kubectl-ate`. The Actor image uses the pinned Node base image and Codex App Server **0.162.1**, with the committed npm lockfile. No host npm installation is needed. The helpers default to the existing playground at `/Users/liuyue/Documents/Codex/substrate-play`; set `AGENT_PLAY_ROOT` to another prepared playground root if necessary. Both helpers fix `state/kubeconfig` under that root and context `kind-substrate-play`. `KUBECTL_ATE_BIN` can select a CLI executable. The ambient Kubernetes context is never used.

```bash
bash experiments/agent-chat/build.sh
node experiments/agent-chat/deploy.mjs
node experiments/agent-chat/console.mjs
```

Open `http://127.0.0.1:4189/`. An occupied port stops startup and preserves its existing listener. Select an Actor, explicitly click **Resume**, and then click **Sign in with ChatGPT**. Complete the device-code flow once in your browser. Device-code login must be available for your ChatGPT account. For another unsigned Actor, explicitly Resume both it and the signed-in source, select the source, and click **Reuse sign-in**. The console relays the login cache in memory between the Actors, without writing it locally or sending it to the browser. Each Actor retains its own credentials, Codex session files, and conversation; only account access and subscription quota are shared. No source Actor is automatically resumed. You can still sign in separately when needed. Inference uses ChatGPT subscription access rather than an API key; the first completed reply establishes actual account/model access. The model is the account's default catalog entry. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for device login and copying an authentication cache.

The console offers dynamic Actor creation/deletion, Actor state, Resume, Suspend, history, sign-in, and one reply at a time. Enter a unique lowercase name and click **Create actor** to clone the same unauthenticated template; the new Actor stays suspended and has independent state. **Delete** asks for confirmation, blocks content requests, and deletes that Actor from any lifecycle state. Deletion removes its conversation and login state and cannot be undone. Worker capacity still limits how many Actors can run at once. The console displays user messages, streamed replies, reasoning summaries when returned by the model, process items, and completion/error status. It does not expose command execution or additional MCP tools.

**Control and content use different paths.** The console issues ResumeActor only in response to its Resume control. History and chat bypass the auto-resuming ingress router: the console reads the current Worker assignment, port-forwards directly to that Pod's atunnel port, and uses mTLS with the router's projected client certificate. It verifies the CA chain and exact Worker Pod identity. The default ingress router is not changed. Requests to suspended, transitioning, or not-explicitly-enabled Actors are rejected instead of parked or retried through ResumeActor.

The Actor's HTTP adapter exposes `/health`, `/status`, `/login`, `/history`, `/messages`, and `/events`. Codex uses stdio internally; `/events` is SSE with an Actor-local sequence cursor. The adapter writes each displayed event to its Actor-local journal before publishing it. History and Codex sessions are stored under `/state` and must remain present after memory-fidelity SuspendActor/ResumeActor. Stream disconnection does not call Codex turn interruption.

The page displays the conversation's model and reasoning effort separately from the account catalog's suggested default effort. A null conversation effort is shown as **Not set**. The console reads these metadata fields inside an already-running Actor through its assigned gVisor Worker's exec channel, using a short-lived App Server client with `thread/read` (without loading or resuming the Codex thread) and `model/list`. Only the three settings fields leave the Actor; credentials, thread previews, and turn content remain inside it. Metadata is reused in console memory for up to one minute, and lifecycle operations invalidate it. Suspended or not-explicitly-enabled Actors reject settings reads before any exec command.

**Suspend does not wait for a reply.** The console immediately blocks new content requests and invokes SuspendActor. It shows the actual Substrate state while the snapshot is being saved. Resume reacquires the current Worker and reads history from the Actor. An in-progress inference connection can continue or fail across suspension; inspect the observed outcome. The console never resubmits the user message automatically. Authentication, quota, and network errors are displayed without an automatic Actor resume.

The console stores only metadata and cluster connection credentials under ignored `state/agent-chat/`. Its client certificate and CA files have mode `0600`; projected credentials are reloaded before expiry. Neither console logs nor local files store conversation bodies. Responses use `Cache-Control: no-store`; the browser does not use localStorage, IndexedDB, or a Service Worker. Already displayed content may remain in the current page after suspension. A refresh while suspended shows only Actor metadata; explicit Resume is required to read history again.

For direct manual observation, check both Actors independently: reject history/message requests before Resume; authenticate and complete a reply; suspend during a streamed reply; refresh the page while suspended; explicitly resume; inspect history continuity, Actor isolation, actual snapshot fidelity, and the resulting in-progress-turn status. Keep observation records in ignored `outputs/agent-chat/`, and record metadata/check outcomes only, without copying conversation content out of Actors. This repository adds no automated tests or CI.

Deployment rejects existing Atespace/deployment metadata rather than replacing resources. Stop the console with Ctrl-C; this closes local connections and does not change Actor lifecycle. Suspend the Actors explicitly in the console before stopping when suspension is desired. Image changes need a new immutable template and a deliberate Actor lifecycle choice.

## Local State and Results

`state/`, `outputs/`, `cache/`, `bin/`, the upstream checkout, and `node_modules/` are ignored. Scripts write measurements, failures, diagnostics, and screenshots to ignored local files. These files can contain kubeconfig credentials, session identifiers, logs, browser state, and profiles. Keep them locally.

Do not commit or push any experiment report or result, including redacted JSON/CSV, screenshots, traces, logs, browser profiles, snapshots, or measured findings embedded in documentation. Root-level `data/`, `results/`, `reports/`, `artifacts/`, and `logs/` are also ignored to prevent accidental staging. Publishing an article or result requires a separate explicit instruction. Preserve local output files during code cleanup.

The full playground start/stop commands also manage the loopback router and the browser gateway when local deployment metadata exists:

```bash
./play.sh start
./play.sh stop
```

`stop` saves all active Actors before stopping owned containers; a suspend failure aborts the stop. It retains database, registry, and snapshot data. Incoming MCP requests can resume a suspended Actor while its gateway runs. Use `./experiments/browser/browser.sh stop` to suspend just the browser and stop its gateway.

`./play.sh destroy --confirm-delete-data` deletes the owned cluster, registry, and experiment data. PostgreSQL and RustFS volumes inside the Kind node are not cross-cluster backups.
