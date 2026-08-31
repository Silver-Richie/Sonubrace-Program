# Sonubrace

**Continuous Doppler ultrasound monitoring and early screening for non-communicable diseases.**

Sonubrace is a wrist-worn Doppler ultrasound band. This repository is its web platform: it
receives baseband I/Q over Bluetooth Low Energy, computes the Doppler spectrogram, reports the
three haemodynamic parameters the method is built on, and explains what they mean in ordinary
language.

The three main parameters are **blood-flow velocity**, **blood-flow direction** and **blood-flow
pattern**. Everything else — PSV, EDV, mean velocity, RI, PI, S/D ratio, acceleration time, heart
rate — is derived from those three and presented as supporting evidence.

> **Sonubrace is a screening and monitoring aid, not a diagnostic device.** It cannot diagnose any
> condition and does not replace clinical assessment. Its risk output is a *priority for review*,
> not a probability of disease.

---

## Quick start

The site is plain HTML, CSS and JavaScript. There is no build step and nothing to install.

```bash
git clone https://github.com/YOUR-USERNAME/sonubrace.git
```

Open `index.html` in a browser, or serve the folder over HTTP (Web Bluetooth and the Web Crypto
password hashing both need `https://` or `localhost`). Create an account, fill in the health
questionnaire, then open the Monitor and press **Run a 6-second recording** — the simulator works
with no hardware attached.

### Publishing to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Replace the canonical URL placeholder everywhere:

```bash
grep -rl "YOUR-USERNAME" . | xargs sed -i 's|YOUR-USERNAME|your-github-username|g'
```

`.nojekyll` is already present so GitHub Pages serves the files verbatim.

---

## Connecting a real backend

Out of the box, accounts and recordings live **in the browser only**: passwords are hashed with
PBKDF2-SHA256 (600 000 iterations, per-user salt) and nothing leaves the device. That makes the
platform usable immediately and keeps health data local — but the account will not exist on the
user's other devices, and clearing site data erases it.

For real server accounts and a real database, point it at [Supabase](https://supabase.com):

1. Create a free project.
2. Run [`sql/schema.sql`](sql/schema.sql) once in the SQL editor. It creates the two tables and the
   row-level-security policies that make the public anon key safe to publish — every policy checks
   `auth.uid() = user_id`, so a user can only ever read or write their own rows.
3. Paste the Project URL and the **anon public** key into
   [`assets/js/config.js`](assets/js/config.js).

Nothing else changes: [`assets/js/db.js`](assets/js/db.js) exposes one API and switches backends
behind it.

> GitHub Pages is static hosting — it cannot run a server process. Supabase is what supplies the
> hosted Postgres and auth that a static frontend cannot provide on its own.

---

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | Landing page (public, indexed) |
| `methods.html` | Full method and every equation (public, indexed) |
| `register.html` / `login.html` | Account creation and sign-in |
| `profile.html` | Health questionnaire — the non-signal input to the analysis |
| `app.html` | **Monitor**: BLE, simulator, spectrogram, IMU, all parameters |
| `calibration.html` | **Recordings**: named sessions, rename, notes, trend, export |
| `analysis.html` | Spectrogram explanation, findings, NCD risk, AI chat |
| `assets/js/dsp.js` | Signal-processing core (JS mirror of the C) |
| `assets/js/simulate.js` | Physically-modelled Doppler generator |
| `assets/js/spectrogram.js` | Spectrogram, envelope and autocorrelation rendering |
| `assets/js/imu.js` | IMU illustration and angle guidance |
| `assets/js/ble.js` | Web Bluetooth link and wire format |
| `assets/js/ai.js` | Expert analyst, NCD risk model, optional Claude |
| `assets/js/db.js` | Accounts, profile, recordings (Supabase or local) |
| `firmware/sonubrace_dsp.c/.h` | **The C signal-processing core** |
| `firmware/main.c` | Native self-test with ground-truth recovery check |
| `sql/schema.sql` | Postgres schema + row-level security |

---

## The C core

`firmware/sonubrace_dsp.c` is the reference implementation of the microcontroller flowchart, in
C99 with no dependency beyond `libm`. `assets/js/dsp.js` mirrors it function for function with the
same equations, constants and classification thresholds, so a result computed in the browser
matches one computed on the device.

```bash
cd firmware
make test          # builds and runs the self-test
```

The self-test synthesises a Doppler signal with a known PSV and EDV, runs the whole chain, and
fails if the recovered PSV is more than 15% off.

To run the C in the browser instead of the JS mirror:

```bash
cd firmware
./build_wasm.sh    # needs the Emscripten SDK
```

then set `useWasm: true` in `assets/js/config.js`.

### Signal chain

```
Phase 0   clock → code generator → pulse × code → × carrier → DAC → T/R → transducer
Phase 1   transducer → T/R → amplifier → TGC → band-pass → ADC
          → 0 and π/2 mixers (I, Q) → matched-filter decode → Doppler signal
          → STFT → P(f,t) → spectrogram → envelope → cardiac segmentation
          → velocity | direction | pattern  (+ PSV, EDV, RI, PI)
```

### Equations

| Quantity | Expression |
|---|---|
| Doppler shift | `fD = 2·f₀·v·cos θ / c` |
| Velocity | `v(t) = c·fD(t) / (2·f₀·cos θ)` |
| Envelope | `fD(t) = argmax_f P(f, t)` |
| Periodicity | `Rxx(τ) = Σ_t x(t)·x(t+τ)` |
| Bandwidth | `BW = f_high − f_low` |
| Resistive index | `RI = (PSV − EDV) / PSV` |
| Pulsatility index | `PI = (PSV − EDV) / mean velocity` |

Direction comes from the *sign* of `fD`, which survives because the receiver keeps in-phase and
quadrature channels rather than taking a magnitude.

---

## Verification

The simulator generates each scenario forwards through the physics — a velocity waveform is
defined, converted to instantaneous Doppler frequency, and the phase integrated — so the declared
PSV, EDV and heart rate are genuine ground truth that the pipeline has to recover.

Measured on a 6-second recording per scenario, default configuration (5 MHz, 60°, 16 kHz
slow-time, 256-point Hann STFT):

| Scenario | PSV (measured / true) | EDV | RI | HR | Classified |
|---|---|---|---|---|---|
| Normal resting | 0.74 / 0.75 | 0.14 / 0.14 | 0.82 / 0.81 | 72 / 72 | Laminar ✓ |
| High-velocity | 1.39 / 1.35 | 0.05 / 0.06 | 0.96 / 0.96 | 83 / 84 | Pulsatile ✓ |
| Low-velocity | 0.35 / 0.34 | 0.06 / 0.07 | 0.82 / 0.79 | 65 / 66 | Laminar ✓ |
| Turbulent | 2.07 / 1.55¹ | 0.36 / 0.30 | 0.83 / 0.81 | 76 / 78 | Turbulent ✓ |
| Damped | 0.46 / 0.42 | 0.18 / 0.20 | 0.61 / 0.52 | 74 / 74 | Damped ✓ |
| Irregular | 0.77 / 0.80 | 0.12 / 0.12 | 0.85 / 0.85 | 79 / 88² | Irregular ✓ |
| High-viscosity | 0.75 / 0.62¹ | 0.18 / 0.22 | 0.76 / 0.65 | 74 / 76 | Turbulent ✓ |

¹ Turbulence genuinely introduces scatterers faster than the mean flow, so the measured peak
velocity exceeding the declared mean-flow PSV is the expected physical result, not an error.
² The irregular scenario varies its own cycle length by design, so a single mean rate under-states it.

**These figures verify the JavaScript implementation, which is what the website runs.** The C core
carries the identical algorithms but **has not been compiled or executed** — no C toolchain was
available on the machine where it was written. Run `make test` before relying on it.

---

## Accessibility

Built to WCAG 2.1 AA:

- Every text/background pair meets 4.5:1 (3:1 for large text and UI borders); the tokens in
  `assets/css/sonubrace.css` are annotated with their measured ratios.
- Full keyboard operation with a visible focus ring on every control, in both themes.
- Skip link, landmark regions, one `h1` per page, and an ordered heading hierarchy.
- Every canvas carries `role="img"` and an `aria-label` describing the *finding*, not the picture —
  a screen-reader user gets "peak systolic velocity 0.78 metres per second… the pattern is
  classified as laminar", not "canvas".
- Form errors use `aria-invalid`, `aria-describedby` and a focused error summary listing every
  problem as a link to its field.
- Status messages go to polite live regions, so nothing steals focus.
- Touch targets are at least 44×44 px.
- `prefers-reduced-motion` and `forced-colors` are both honoured.
- Light and dark themes, following the system by default and overridable.

## SEO

- Unique title and meta description per page; canonical URLs.
- Open Graph and Twitter Card metadata.
- JSON-LD structured data: `WebSite`, `SoftwareApplication`, `MedicalWebPage`, `FAQPage` on the
  landing page and `TechArticle` on the methods page.
- `sitemap.xml` and `robots.txt`, with every signed-in page `noindex` in both — they carry personal
  health data and have no business in a search index.
- Semantic HTML, descriptive link text, and a web app manifest.

---

## Limitations

Stated plainly, because a screening tool that overstates itself does harm.

- **Angle dependence.** Every velocity is scaled by `1/cos θ`. An unmeasured or misjudged angle is
  the largest single source of error in the system. This is why the IMU guidance exists.
- **Reference ranges are defaults, not truth.** Those in `assets/js/ai.js` are for a peripheral
  wrist artery and are drawn from the general literature. They have **not** been calibrated against
  duplex ultrasound in a clinical cohort. Adjust `REFERENCE` for your study population and report
  the values you used.
- **Pattern thresholds were calibrated against the simulator**, where the underlying flow state is
  known — not against patients. Re-check them on real data.
- **Single sample volume.** A normal reading says nothing about a vessel elsewhere.
- **Aliasing.** Doppler shifts beyond half the PRF wrap around, so very high velocities can be
  under-read.
- **The C core is uncompiled.** See Verification above.
- **Browser-side Claude keys are not production-safe.** The optional Claude integration stores a key
  in `localStorage` and calls the API directly from the page. Anyone with access to that browser
  profile can read it. For a public deployment, proxy the request through a server function.

## Ethics and data

These tables hold health information. Before collecting real data: obtain whatever ethics approval
your institution requires, enable point-in-time recovery on the database, keep the service-role key
out of every client, and make sure participants understand what is stored and how to delete it. The
Recordings page offers full export and per-recording deletion.

## Reference

Qin, et al. (2012) — truncated long code for detecting dynamic signals such as Doppler and shear
wave in the ultrasound field.
