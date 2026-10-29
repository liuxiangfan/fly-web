# Quaternion Attitude Estimation · Interactive Learning Device

[简体中文](README.md) | **English**

> A browser-only interactive teaching device: feed it a simulated **or real (serial / Bluetooth) IMU**, watch
> **five attitude-estimation algorithms** compete on the same screen, operate a real 3D **gimbal-lock rig**,
> compare spherical interpolation against Euler interpolation, and explore a **4D stereographic projection**.
> Everything is documented in-app too — from raw sensor data to an **error-state Kalman filter**
> (9 modules / full-text search / live canvas demos / self-test questions / troubleshooting / references).
>
> **Note:** the in-app UI and documentation are written in **Simplified Chinese** — the device is built for
> Chinese-language classrooms. This file describes what is inside it, in English.

**Live demo**: [fly_web.070616.xyz](https://fly_web.070616.xyz)　(backup: [workers.dev](https://quaternion-attitude-demo.liu06167492.workers.dev))

Every push to `master` builds and deploys automatically: type-check → 105 static assertions → bundle-size budget → 51 browser end-to-end checks → Cloudflare Workers (pull requests run the same verification, they just don't deploy).

---

## What problem does it solve?

Attitude estimation answers one question: **given three contradictory sensor readings, which way is the aircraft pointing?**

A gyroscope is precise over short times but drifts; an accelerometer is stable over long times but lies during motion;
a magnetometer gives you north but hates metal. This device turns those three "each has its own lie" sensors,
the five algorithms that reconcile them, and every way those algorithms can fail, into an adjustable,
observable, reproducible laboratory.

---

## Features

### 1. Quadcopter attitude view (main view)

**Sensor simulation** — gyro bias / noise / random walk, accelerometer noise / cross-axis sensitivity /
nonlinearity, manoeuvre-induced linear acceleration / motor vibration, magnetometer noise / hard-iron offset /
alternating interference / quantization. All adjustable live. Four device presets (MPU-9250 / ICM-42688-P /
BNO055 / custom) write datasheet noise densities converted to per-sample σ.
Five further **device-level imperfections**: gyro range saturation, scale-factor error, tri-axis
misalignment, sensor group delay, and solver rate. Saturation makes the attitude run away badly during
aggressive manoeuvres while *looking* fine; scale/misalignment are rate-dependent errors that a bias
estimator cannot absorb; group delay produces an ω·τ attitude lag.

**Magnetometer calibration** — the calibration panel fits a sphere (hard iron) and applies diagonal soft-iron
scaling; the simulator can produce both **hard-iron offset** and **soft-iron distortion** (the latter including
cross terms, which is what shows the ceiling of diagonal calibration) plus alternating interference.
Theory, an eight-step procedure, how to judge the four readouts, and **line-by-line code you can lift into
firmware** live on their own page: [Hardware & firmware · Magnetometer calibration](https://fly_web.070616.xyz/#magcal)
(in-app, Chinese).

**Real IMU input** — Web Serial connects directly to a GY-87-class device (28-byte frame protocol, firmware
reference in [`firmware/`](firmware/README.md)).
**Three protocols, two transports**: data arrives over **USB serial** or **Bluetooth LE**, in one of three
protocols — this device's binary frame (28 bytes, you assemble it) / **text lines** (just `Serial.print` a line
of numbers: 6/9/10 columns, several separators, optional timestamp) / **MAVLink v2 · RAW_IMU** (connect a
PX4 or ArduPilot flight controller directly, with an invert switch for mounting orientation).
On the BLE side four verified service UUIDs are preset (HM-10 / Nordic UART / ABF0 / 1000 series) and
notification characteristics are discovered via `properties.notify` after connecting.
Every combination feeds exactly the same downstream path (one frame queue, one "no ground truth" semantics);
BLE's 20-byte ATT fragmentation is reassembled by the streaming parser. **Selectable baud rate** (9600–2 000 000,
default 921 600; locked while connected, because Web Serial fixes port parameters at `open()`).
Integration step adapts to firmware tick deltas (100–200 Hz, u32 wrap and gaps handled), with CRC checking,
sequence-loss statistics, backlog protection and a 1.5 s stall watchdog. Without ground truth the error curves
switch to Mahony as reference, the ghost model hides, and simulation controls are greyed out.

**Offline replay (a third data source)** — import a timestamped **raw IMU** CSV and feed it to all five
algorithms at the recorded rate, with exactly the same semantics as the serial path (no truth → Mahony is the
reference). Three formats are accepted: CSVs exported by this device (tick "raw IMU" in the export dialog —
closing the export→import loop), generic CSVs with headers (`t / gx… / ax… / mx…`, with automatic `rad/s` and
`g` conversion), and headerless 7/10-column files. Playback at 1×–10× or "all at once"; parse failures give
actionable messages and a success prints the detected column mapping and unit assumptions to the console.

**Five algorithms side by side** — pure gyro integration (the drift control group), complementary filter,
Mahony, Madgwick, and a Kalman filter (error-state ESKF, 6 states `[δθ, δb]`, estimating gyro bias online).
α / Kp / Ki / β / Q / R are all adjustable live. **Solver rate** can drop to 50 Hz (the simulation still runs
at 500 Hz; the algorithms just consume every Nth step).

**Two magnetic correction modes** — simplified (magnetometer constrains yaw only) and **full MARG**
(magnetic-dip compensation: the reference field is built from the measurement itself, so the whole field vector
contributes to the error). The two are equivalent in a clean field; under alternating interference the full
version drops mean error from 8.5° to 1.0°.

**Observation-trust management** — two-layer rejection: magnitude gating (‖a‖ deviating from g) and
direction gating (angle to the predicted gravity). **Both thresholds are sliders** (too loose and contamination
slips through, too tight and normal manoeuvres get rejected), plus an optional **hysteresis recovery window**
(release observations after prolonged rejection; the same mechanism industrial libraries use, off by default —
it is itself a worthwhile engineering trade-off to discuss).

**Initial alignment** — tick "random initial attitude offset" and all five algorithms start from the same
20–35° error: complementary / Mahony / Madgwick recover through a start-up gain ramp (6× → 1× within 2.5 s),
the Kalman filter through a large initial covariance, and pure integration stays wrong forever.
A stillness detector (3 s) also triggers coarse alignment.

**Attitude → velocity → position** — the "inertial navigation" panel runs each algorithm's attitude estimate
through strapdown mechanization and draws north-east drift tracks: with a 1°/s gyro bias over 30 s, pure
integration drifts ≈700 m while the Kalman filter drifts ≈1.6 m — the same attitude problem amplified by two
orders of magnitude in the position channel. Horizontal and vertical drift are listed separately (the vertical
channel is unstable in pure inertial navigation, which is exactly why barometers exist).

**And also** — eight manoeuvre scenarios (hover jitter / manual control / 360° roll / pitch sweep / composite /
violent / **gimbal lock parked at 90°** / **sweeping through ±90°**), A/B parameter snapshots, a closed-loop
control demo (driving the airframe from the estimate), a 3D ghost model with equivalent-rotation-axis arrow,
the glass-box dual gravity arrows, and the Kalman filter's **uncertainty ellipsoid** (eigen-decomposition of the
3×3 attitude covariance: it shrinks while converged at rest, stretches along one direction when observations are
gated out, and snaps back the moment they return — what the gain looks like geometrically).

### 2. Gimbal-lock view

A structurally faithful **three-axis gimbal**: three metal rings (band width / wall thickness / bevelled
highlight) with connecting axles and bearings passing through the clearances (outer ring carries the middle,
middle carries the inner), and the three rotation axes extended as dashed lines outside the rings, labelled
"yaw axis ψ / pitch axis θ / roll axis φ".

- Dragging a slider makes the rings follow with **exponential damping**, never jumping; the dashed axes follow
  only their parent stage, exactly like a real gimbal
- Pitch at ±90°: outer and inner axes geometrically coincide → both rings and both axles turn red and a
  **red pulsing ring** appears at the centre
- One-click demo: record an attitude with roll +60°, reset, then reproduce it with yaw −60° → angle between
  them 0.000°, proving with "two different operations, one attitude" that a degree of freedom is genuinely lost;
  pausable at any time

The payload is a quadcopter with body-axis arrows whose world attitude always equals the main view's
`toDisplay(qFromEuler(φ,θ,ψ))` (asserted by `scenecheck`).

### 3. Quaternion view

The reference sphere is the space of possible nose directions (lat/long grid + marked poles).

- **White arc** Slerp (geodesic on the rotation group, constant axis, constant speed) compared live against the
  **magenta arc** of per-component Euler interpolation
- A **purple deviation band** between them, as wide as the angular distance there; panel readouts for
  "endpoint rotation / accumulated Euler path / midpoint divergence" — 51.6° at the midpoint of the multi-axis
  preset
- **Wireframe quadcopters** at both endpoints, outside the sphere: what is interpolated is an attitude,
  not a point on the sphere
- The four-keyframe preset additionally draws a **Squad amber arc** (tangent-continuous multi-keyframe interpolation)
- **q and −q side by side**: all four numbers flip sign, the attitude is identical
- **4D stereographic projection mode**: q inside the ball (cyan), −q outside (magenta), reciprocal points
  (`|p(q)|·|p(−q)| = 1`). Press "left-multiply by i" twice = 360° total: the 3D attitude is restored while q
  has changed sign; only four presses (720°) truly return to +1. An S³ cross-section inset (the great circle
  plane containing +1 and the current q, horizontal axis always the real direction, vertical axis q's imaginary
  direction, annotated live with the half-angle θ and the actual 2θ rotation) gives the three-stage
  "lift → rotate → project" view

### 4. In-app documentation ("文档" button, top right)

Light three-column layout (module navigation / body / on-page table of contents), **9 modules / 16 pages /
100+ sections**, 16 diagrams (10 inline SVGs + 6 live canvas demos), with **full-text search (Ctrl/⌘+K)**.

**Control manual** — an encyclopaedia entry for every slider / switch / marker: what it is · what it does ·
what changes when you move it.

**Mathematics (19 chapters)** — two "intuition first" tracks you can read before any derivation:
- **Four intuitions for quaternions**: axis + half-angle / multiplication = composition / double cover /
  measurable attitude (with an "intuition → maths → device behaviour → common misconception" table)
- **Three layers of intuition for Kalman filtering**: optimal weighting of two scales → covariance ellipse →
  error-state ESKF

Main line: maths toolbox → why exactly four numbers → four attitude representations (including Hamilton vs JPL
conventions) → i, j, k → sensor measurement model (including "specific force ≠ acceleration") →
step-by-step derivation of `q̇ = ½q⊗ω` (including **integrator choice** and **coning / sculling**) →
cross-product error (including **observability**) → correction law → magnetometer and MARG (including
**declination and true north**) → **algorithmic consequences of gimbal lock** → quaternion intuition →
Kalman intuition (with a **1-D optimal-weighting interactive demo**) → Slerp → stereographic projection →
inside one frame → engineering practice notes (with an **error budget for group delay / sample rate / range
saturation**) → **from attitude to position: why the error grows as t³**.
Includes three interactive demos (**non-commutativity of rotation order**, **1-D Kalman playground**,
**complementary filter in the frequency domain**), the gimbal lock **matrix evidence**, the **magnetometer
calibration dance**, and a **measured data table** for the algorithmic consequences of gimbal lock.

**The other six modules** — "Experiments & exercises" (three learning paths + 17 indexed experiments +
12 self-test questions whose answers are experiments), "Hardware & firmware" (frame-protocol table / wiring /
sign conventions / real-mode semantics / debugging steps), "Troubleshooting" (wrong curves / cannot connect /
page problems / performance — four symptom tables), "Terminology & symbols" (quaternion · sensor · algorithm ·
coordinates, each entry citing where it is used), "References" (26 sources, each annotated with where in the
device it applies, 15 of them external links), "About this device" (**an honest list of simplifications and
deviations** / technical stance / changelog / acknowledgements).

**Filter explanations** — core idea / data flow / tuning phenomena / selection guide for each of the five
algorithms, plus **"how to read this plot: a diagnostic manual for the five curves"** (9 curve symptoms →
algorithm-level cause → how to reproduce).
Every algorithm gets its own from-scratch derivation page, and the Kalman page includes an item-by-item
comparison with the standard textbook formulation.

### 5. Interface and interaction

**Right-hand accordion console** — 13 collapsible sections (guided tour / data source / experiment library /
IMU / magnetic calibration / solvers / 3D display / glass box / evaluation / tuning challenges / inertial
navigation / quaternion / gimbal), each with a **live summary next to its title** (manoeuvre mode / bias and
noise / MARG and the three gains / model source / best RMSE this run / attitude pair / three ring angles /
course progress). Collapsed sections lose no information; expanded they show every control. Quick entries at
the top for "real IMU / expand all / collapse all".

**Guided tour (first section, shortcut `G`)** — 13 steps that walk through all the teaching content in order:
each step automatically puts the device into the right configuration (loads an experiment from the library,
switches the 3D view, expands the relevant panel) and explains in two paragraphs "what this step is about" and
"where to look". Steps that need derivation offer an "open documentation: …" button that *you* press — the docs
layer is a full-screen modal, and opening it programmatically would cover the "next" button, so the tour
deliberately does not do that. The tour only drives interfaces a user can see (clicking experiment buttons,
view segments, panel headers), so it imports no internal state from the app.

**Browser capability notice** — Firefox and Safari still ship neither Web Serial nor Web Bluetooth. The top of
the IMU panel permanently states which API is missing and greys out the unusable connect buttons — a greyed
button is far easier to debug than "nothing happens when I click". The message distinguishes "this browser
lacks the API" from "the page is not a secure context (needs HTTPS or localhost)", because the two have
completely different fixes. Simulation, offline replay, all five algorithms and the entire documentation work
without either API.

**Three independently collapsible chart blocks** — toolbar chips and panel arrows are the same state.
The layout re-flows automatically (3 open = two side by side plus a full row, 2 open = side by side, 1 open =
full width and taller), and collapsed blocks sink to a thin title bar with live readouts.
The three blocks: attitude angles (six curves), total attitude error (including A/B dashed lines), raw IMU
waveforms (18 channels across three tabs).

**Parameter-tuning challenges** — three small tasks with uniquely verifiable answers (bias / strong vibration /
magnetic interference). Scoring reads the same RMSE as the evaluation table, you must run for 15 s before you
may submit, and thresholds were measured first with margin left on both sides. The goal is to train "knowing
which way to turn the knob", not brute-force search.

**And also** — experiment library (17 one-click experiments, each with a "what to look at" line, each
resetting to a common baseline first so results reproduce), an evaluation table for the current run
(current / mean / RMSE / peak / convergence time), interactive magnetometer calibration (sphere fit hard iron +
diagonal soft iron), CSV export (25 Hz records + parameter header, optionally including quaternion components;
the rolling window caps at 850 rows ≈ 34 s and the dialog shows how many rows are recorded),
a **colour-blind-friendly palette** (Okabe–Ito; in the default palette "pure-integration red × Madgwick green"
is the classic confusion pair for red-blind viewers, and 6–12 curves are on screen at once),
**text-table equivalents of the three charts** (canvases are unreadable to screen readers; collapsibles give
the same numbers), **error breakdown** in the glass box (per-axis φ/θ/ψ error plus total angle, answering
"which axis dominates"), deep-link sharing (parameters + view + chart state + collapsed panels) and PWA
offline use, **one-click formula copying** and **printing / PDF export of the current page only** (for
handouts), and keyboard shortcuts (space / R / 1-3 / D / **G guided tour** / **Ctrl+⌘+K doc search** / ?).

---

## Technology

| Layer | Choice |
|---|---|
| Build | TypeScript + Vite (three is split into its own vendor chunk) |
| 3D | Three.js r170 (the only runtime dependency; all models are procedural, no asset files) |
| Maths typesetting | A KaTeX font subset (**only 4 woff2 files from the KaTeX_Main family**, without the KaTeX runtime; importing the whole CSS would drag in 59 font files, ~1.17 MB) |
| Fonts | Self-hosted subsets of Fira Sans / Fira Code (13 woff2 files, no Google Fonts requests) |
| Charts | Hand-written Canvas 2D (no charting library) |
| Framework | None (plain DOM + event delegation) |
| Backend | None (fully static, zero keys; all computation happens in your browser) |

---

## Quick start

```bash
git clone https://github.com/liuxiangfan/fly-web.git
cd fly-web
npm install

npm run dev       # development server
npm run build     # type-check + build into dist/
npm run preview   # preview the built output
```

**Verification** (worth running in full before committing):

```bash
npx tsc --noEmit  # type check
npm run check     # 105 assertions: 80 numeric + 10 scene geometry + 15 HTML contracts
npm run budget    # bundle-size budget (9 ceilings: total / fonts / font count / HTML / app shell / docs / gzip / main JS / main JS gzip)
npm run smoke     # 51 real-browser end-to-end checks (export→import round trip, fake text/MAVLink serial
                  # ports, a fake BLE device, print media, accessibility, long-run stability, every slider's
                  # number box being typeable, connect re-entrancy, deep-link round trip; needs build+preview)
```

> `npm run budget` exists to catch regressions of the "one careless import added a megabyte of fonts" kind —
> bundle size never complains on its own.
> `npm run smoke` drives a real local browser through puppeteer-core. Besides functional cases (a **fake Web
> Serial port** emitting frames per the real protocol, a **fake BLE GATT device** fragmenting notifications,
> print media) it guards a few things that break silently:
> the **three animated doc demos must actually be animating** (canvas fingerprints must differ between two
> samples — their only repaint point is `step(dt)`, so a changed fingerprint proves the main loop really is
> connected; the other three demos are one-shot or slider-driven),
> **all on-screen text must meet WCAG AA contrast** (both the dark dashboard and the light documentation theme,
> with backgrounds alpha-composited up the ancestor chain, across all 14 doc pages),
> and **four rolling containers must stay capped during a long run** (it really pushes 40 s of simulated time
> through to prove the trimming logic runs, rather than just looking calm).
> Two further checks are *class-level*: **every slider's number box must accept typing** (two threshold boxes
> used to be dead), and **every UI control must survive a share-link round trip** (set-diff plus a per-control
> round trip; the protocol selector and an invert switch used to be missing).
> The fake devices are deliberately **faithful to reality** (the fake BLE characteristic accumulates listeners
> like a real `EventTarget`) — a mock more forgiving than reality hides real defects, a lesson learned the hard way.

**Other scripts**:

```bash
npm run selftest   # numeric self-tests only
npm run coverage   # code coverage of those tests (c8: statements/branches/functions, uncovered lines listed)
npm run scenecheck # 3D scene-geometry checks only (builds a real three.js scene graph under Node)
npm run htmlcheck  # HTML↔TS contracts / accessibility / static assets only
npm run icons      # regenerate PWA icons from favicon.svg
```

---

## Project layout

```
├── index.html              # page skeleton, panel UI and all documentation (9 modules / 16 pages inlined)
├── vite.config.ts          # build config (three vendor chunk)
├── src/
│   ├── main.ts             # assembly layer: simulation / solvers / scene / UI / docs / main loop
│   ├── fonts.css           # self-hosted font declarations (13 Fira subsets + 4 KaTeX_Main)
│   ├── style.css           # design system (dark dashboard + light documentation theme)
│   ├── core/               # pure logic, all testable under Node
│   │   ├── quat.ts         #   quaternion maths (exact exponential integration / DCM / Slerp / Squad / log / 3×3 symmetric eigendecomposition)
│   │   ├── imu.ts          #   IMU error-chain simulation (gyro / accelerometer / magnetometer)
│   │   ├── world.ts        #   simulation world: truth propagation + attitude-tracking controller
│   │   ├── scenarios.ts    #   eight manoeuvre scenarios
│   │   ├── serial.ts       #   serial frame parsing + firmware tick clock
│   │   ├── replay.ts       #   IMU log import (tolerant CSV parsing + unit/timebase inference)
│   │   ├── ins.ts          #   strapdown mechanization (attitude→velocity→position) + t³ drift law
│   │   ├── allan.ts        #   Allan variance (noise coefficients N/K → σ(τ) curve)
│   │   ├── magcal.ts       #   magnetometer sphere fitting (hard iron + diagonal soft iron)
│   │   ├── stats.ts        #   error statistics (mean / RMSE / convergence time)
│   │   ├── gimbal.ts       #   gimbal-lock kinematics + NED→display basis change
│   │   └── rng.ts          #   reproducible RNG
│   ├── estimators/index.ts # five estimators (pure gyro / complementary / Mahony / Madgwick / ESKF)
│   ├── scene/
│   │   ├── quad.ts         #   quadcopter model (PBR: glossy shell / navigation lights / propeller discs)
│   │   ├── gimbal.ts       #   gimbal rig (rings + bearings + dashed axes + damped following)
│   │   ├── quatview.ts     #   quaternion view (S² interpolation + 4D stereographic projection)
│   │   ├── labels.ts       #   text sprites
│   │   └── setup.ts        #   scene / lighting (IBL) / camera / per-view framing
│   └── ui/
│       ├── chart.ts        #   hand-written scrolling canvas chart (fixed-length Float64Array ring buffer)
│       ├── tour.ts         #   guided tour (13 steps: text + an executor that only drives visible UI)
│       ├── doc-demos.ts    #   six in-document demos (complementary / order / calibration / Allan / 1-D Kalman / frequency domain)
│       ├── challenges.ts   #   three parameter-tuning challenges (data-driven, same RMSE score)
│       ├── canvas-util.ts  #   inset canvas sizing / DPR sync
│       ├── ins-view.ts     #   inertial-navigation top-down map (stateless)
│       ├── experiments.ts  #   seventeen one-click experiments (data-driven)
│       ├── b64.ts          #   UTF-8 base64url deep-link encoding
│       └── mode.ts         #   view state and copy
├── scripts/
│   ├── selftest.ts         #   numeric self-tests (80)
│   ├── scenecheck.ts       #   scene-geometry self-tests (10)
│   ├── htmlcheck.ts        #   HTML↔TS contract self-tests (15)
│   ├── browser-smoke.mjs   #   real-browser end-to-end (51, incl. accessibility, long-run stability, deep-link round trip)
│   ├── distbudget.mjs      #   bundle-size budget (9 ceilings; HTML is split into app shell vs inlined docs)
│   ├── shot.mjs            #   developer screenshot tool (viewport/element shots + in-page scripts)
│   ├── make-icons.mjs      #   PWA icon generation
│   └── diag*.ts            #   convergence / violent-manoeuvre diagnostics
├── firmware/               # real IMU frame protocol + firmware reference (README + gy87.h)
├── public/                 # favicon / PWA icons / manifest / Service Worker / font subsets
└── wrangler.jsonc          # Cloudflare Workers deployment config (static assets only)
```

---

## Coordinates and conventions

- World frame **NED** (x north / y east / z down), body frame **x forward / y right / z down** — the z arrow
  pointing at the ground in the 3D view is a convention, not a bug
- The quaternion `q` represents the rotation **body → world**; the simulated accelerometer at rest outputs +g
  along the body's "down" axis
- Display coordinates X = north / Y = up / Z = east; NED→display uses the basis change `S = Rx(90°)`
- Simulation runs at a fixed 500 Hz (the "solver rate" dropdown only decides how often the algorithms consume
  data, not the simulation step); real serial mode adapts to firmware ticks (100–200 Hz); charts record one
  point every 40 ms
- Euler angles at pitch **±90°** (gimbal lock) follow the common convention `roll := 0` with all information
  folded into yaw; `qToEuler`'s reconstruction error there is guarded to the 1e-10 level in the self-tests
  (an earlier implementation returned **non-equivalent** triples, off by up to 60°)
- There are two time axes: `dt` (≤50 ms, physics) and `dtAnim` (≤250 ms, demos / playback / camera transitions)

---

## Debug entry point

`window.attitudeDemo` is available in the console:

```js
attitudeDemo.scene        // THREE.Scene
attitudeDemo.sceneHandles // { quad, ghost, gimbal, quatView, gravityArrows, ... }
attitudeDemo.ests         // the five estimator instances (with q / telemetry)
attitudeDemo.state        // view, data source, channel and other UI state
attitudeDemo.world        // simulation world (true attitude q, angular rate, scenario)
attitudeDemo.imuParams    // current IMU error-chain parameters (incl. range/scale/misalignment/delay)
attitudeDemo.solveState   // solver rate and the frame-skipping accumulator
attitudeDemo.replay       // offline replay: { import(csvText, name), stop(), info }
attitudeDemo.tour         // guided tour: { start, next, prev, goto(n), exit, info }
attitudeDemo.sizes()      // long-run check: current length and capacity of four rolling containers
```

---

## Deployment

The build output is purely static files (`dist/`), so any static host works.

**Cloudflare Workers** (already configured in this repository):

```bash
npm run build
npx wrangler deploy
```

**GitHub Pages / Vercel / Netlify / nginx**: upload the contents of `dist/`.
If you deploy under a sub-path, set `base: './'` in `vite.config.ts` and rebuild.

---

## References

External material checked against the maths and engineering conventions used here (lecture notes, papers,
open-source implementations) is collected in [`docs/RESEARCH-NOTES.md`](docs/RESEARCH-NOTES.md); the project's
architecture and change history are in [`docs/PROJECT-STATE.md`](docs/PROJECT-STATE.md); a full improvement
review with **per-item status** is in [`docs/IMPROVEMENT-PROPOSAL.md`](docs/IMPROVEMENT-PROPOSAL.md).
(The `docs/` files are in Chinese.)

Primary sources: i2Nav's *Inertial Navigation Attitude Algorithms* lecture notes and KF-GINS,
Madgwick's 2011 report, Solà's quaternion kinematics for the ESKF, Mahony's 2008 explicit complementary filter,
Shoemake 1985 (Slerp / Squad), Markley's writing on the MEKF, and the geometric intuition of
[eater.net/quaternions](https://eater.net/quaternions) and
[euclideanspace](https://www.euclideanspace.com/maths/algebra/realNormedAlgebra/quaternions/index.htm).
