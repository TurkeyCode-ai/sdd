# sdd-engine

The engine for Simulation Driven Development (SDD).

A test asks "is the code correct?" and answers pass or fail. A simulation asks
"does this work for the people it is for?" and answers with a score against a
threshold. This engine sends simulated visitors through an app running on your
machine, scores what happened, and writes a report.

It only measures. It never changes the app.

**The scores are not calibrated.** The simulated visitors have not been checked
against real people. A score lets you compare two versions of the same app. It
is not a prediction of what real visitors will do.

## Install

```bash
npm install -g sdd-engine
sdd setup          # downloads the browser the engine drives, once
```

Needs Node 24 or later, and the [Claude Code](https://claude.com/claude-code)
CLI installed and logged in. The engine calls models through `claude -p`, so a
run is billed to whatever that CLI is logged in with.

## Try it

```bash
git clone https://github.com/TurkeyCode-ai/sdd && cd sdd
node examples/waitlist/app.ts &          # a stand-in app on http://127.0.0.1:4180

sdd simulate --workdir examples/waitlist --target http://127.0.0.1:4180 \
  --run demo --runs 2 --budget-usd 1
```

The report lands in `examples/waitlist/reports/demo.md` and `demo.json`.

## The command

```
sdd simulate --workdir <dir> --target http://localhost:PORT --run <id> --budget-usd <n>
             [--entry /path] [--runs n] [--concurrency n] [--outside-requests fail|block]
```

| Flag | Meaning |
|---|---|
| `--workdir` | The work directory (below). Traces, screenshots and reports are written into it. |
| `--target` | The app to visit. It must be on this machine: `localhost`, `127.0.0.1` or `[::1]`. |
| `--run` | A name for this run. Using the same name again resumes it: finished visits are skipped. |
| `--budget-usd` | Stop starting new visits once this much is spent, at list prices. |
| `--entry` | The path visitors land on. Default `/`. |
| `--runs` | Visits per persona and viewport. Default: `personas.runs_per_persona` in the spec. |
| `--concurrency` | Visits at once. Default 6. |
| `--outside-requests` | `fail` (default): one request to another origin fails the run. `block`: such requests are refused and listed in the report, and the run carries on. Use `block` for apps that load fonts or scripts from elsewhere. Either way nothing outside the target is ever reached. |

Exit codes: `0` report written. `1` some visits failed, or the engine hit an
error; a report is written either way and says which. `2` bad arguments. `3`
budget reached; the report covers the visits that finished.

## The work directory

```
<workdir>/
  spec.yaml                 what is simulated and what counts as passing
  personas/working/*.yaml   visitors whose results are reported in full
  personas/holdout/*.yaml   visitors held back; only their pass rates are reported
```

The held-back set exists so that whoever revises the app cannot tune it to the
visitors they can see. Keep it away from them.

### spec.yaml

Two kinds. **Reader mode** (`kind: comprehension`): visitors skim the entry page
for a fixed time, the page is taken away, and they answer questions from what
they actually took in. A separate judge grades each answer against a rubric.
See `examples/sdd-site/spec.yaml`.

**Visitor mode** (`kind: task`): visitors act on the app. They can scroll, click,
type, or leave. Leaving is the default: any other action has to quote words that
are really on the screen. The model is never told what success is. The engine
checks it from what the browser did. See `examples/waitlist/spec.yaml`.

```yaml
experiment: waitlist-example
kind: task
goal: A visitor lands from an ad and joins the waitlist.
entry:
  from: a social media ad
  viewports: [mobile]            # mobile, desktop
task:
  goal: Join the waitlist
  instruction: ...               # optional: what the visitor was asked to try
  success:                       # any of these; never shown to the model
    request: { method: POST, path_includes: /api/waitlist }
    url_includes: /thanks
    text_visible: You are on the list
    outcome: A confirmation that the visitor is on the list   # judged from the final screen
visitor:
  patience_seconds: 75
  max_steps: 15
  screenshots: true
personas:
  runs_per_persona: 10
pass:
  task_rate: 0.25                # one <question id>_rate per question; a task's id is "task"
```

Visitors in task mode really submit forms. Point the engine only at a copy of
the app that is safe to act on.

### Personas

```yaml
id: collector
archetype: A man in his forties who collects sci-fi props
profile:
  role: IT manager
  experience: Builds replica props, comfortable with electronics kits
  tech_comfort: high
  already_uses: [3D printer, microcontroller kits]
arrival:
  source: Instagram ad
  saw: "The robot sidekick you wanted as a kid"     # all they saw before landing
needs: [what it looks like, whether it can be modified]
objections: [AI gadgets oversell, backed projects that never shipped]
dials: { reading_wpm: 270, skim_rate: 0.5 }          # mis_tap_rate is optional, default 0.03
```

## The report

`reports/<run>.json` has `schema: "sdd-report/1"`.

- `verdict`: `pass`, `not met`, `inside the noise`, or `incomplete`.
- A threshold is met only when the low end of its 95% interval clears it, on
  both the working set and the held-back set. A few visits rarely settle
  anything, and the report says so plainly.
- `working` has the detail: per question, per persona, what was missed, where
  visitors stopped, and a sample of failing answers. `holdout` has rates only.
- `costUsd` is the spend at list prices. `blockedRequests` lists outside origins
  that were refused. `error` is present when the engine could not finish.

## Models

Chosen by environment variable, with defaults:

| Variable | Role | Default |
|---|---|---|
| `SDD_MODEL_PERSONA` | the visitors | `claude-haiku-5-5` |
| `SDD_MODEL_JUDGE` | grades answers and outcomes | `claude-sonnet-5-5` |

## Develop

```bash
npm install
npm run typecheck
npm test          # offline: the model is scripted
npm run build     # compiles to dist/, which is what the published command runs
```

## License

MIT
