/* ============================================================================
 * simulate.js — synthetic Doppler generator.
 *
 * Produces the baseband I/Q that the Sonubrace receive chain would deliver
 * after quadrature demodulation and truncated-long-code decoding, for a chosen
 * haemodynamic scenario. It exists so the platform can be demonstrated,
 * validated and taught without a physical probe attached.
 *
 * The generator works forwards through the physics: a velocity waveform v(t)
 * is defined, converted to an instantaneous Doppler frequency with
 * fD = 2 f0 v cos(theta) / c, and the phase is integrated to build the complex
 * signal. dsp.js then has to recover v(t) from it — so a scenario's declared
 * PSV is genuine ground truth for the pipeline.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var DSP = global.SonubraceDSP;

  /* Deterministic PRNG so a given seed always reproduces a recording. */
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }
  function gauss(rand) {
    var u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------------------------------------------------------- scenarios --- */
  /*
   * Each scenario names a haemodynamic state and the waveform shape that
   * produces it. `psv`/`edv` are in m/s at the radial artery scale.
   * `note` is shown in the UI; it describes the physiology, never a diagnosis.
   */
  var SCENARIOS = {
    normal: {
      label: 'Normal resting flow',
      note: 'Regular triphasic waveform, narrow spectrum, clear systolic window.',
      psv: 0.75, edv: 0.14, hr: 72, turbulence: 0.05, jitterMs: 12,
      reverse: 0.10, accelFrac: 0.14, damping: 0
    },
    hypertensive: {
      label: 'High-velocity / high-resistance',
      note: 'Raised peak velocity with a sharp upstroke and very low diastolic flow — the pattern associated with stiff, high-resistance vessels.',
      psv: 1.35, edv: 0.06, hr: 84, turbulence: 0.10, jitterMs: 14,
      reverse: 0.16, accelFrac: 0.10, damping: 0
    },
    hypotensive: {
      label: 'Low-velocity flow',
      note: 'Reduced peak velocity with a preserved shape — seen with low perfusion pressure.',
      psv: 0.34, edv: 0.07, hr: 66, turbulence: 0.06, jitterMs: 16,
      reverse: 0.06, accelFrac: 0.16, damping: 0
    },
    turbulent: {
      label: 'Turbulent / post-stenotic',
      note: 'Spectral broadening fills the systolic window: velocities spread widely instead of moving together.',
      psv: 1.55, edv: 0.30, hr: 78, turbulence: 0.55, jitterMs: 15,
      reverse: 0.04, accelFrac: 0.12, damping: 0
    },
    damped: {
      label: 'Damped (tardus–parvus)',
      note: 'Slow upstroke and blunted peak — the downstream signature of a proximal obstruction.',
      psv: 0.42, edv: 0.20, hr: 74, turbulence: 0.18, jitterMs: 14,
      reverse: 0.0, accelFrac: 0.30, damping: 0.7
    },
    irregular: {
      label: 'Irregular rhythm',
      note: 'Cycle length and peak height vary beat to beat, lowering the periodicity score.',
      psv: 0.80, edv: 0.12, hr: 88, turbulence: 0.12, jitterMs: 140,
      reverse: 0.10, accelFrac: 0.14, damping: 0, amplitudeJitter: 0.30
    },
    viscous: {
      label: 'High-viscosity flow',
      note: 'Broadened spectrum with a slower diastolic runoff — the profile associated with raised blood viscosity.',
      psv: 0.62, edv: 0.22, hr: 76, turbulence: 0.34, jitterMs: 18,
      reverse: 0.02, accelFrac: 0.20, damping: 0.35
    }
  };

  /* --------------------------------------------------- velocity waveform --- */
  /*
   * Arterial velocity as a function of cycle phase (0..1). Shape parameters
   * come from the scenario so one function covers all of them:
   *   accelFrac  fraction of the cycle spent on the systolic upstroke
   *   reverse    depth of the early-diastolic reverse notch, as a fraction of PSV
   *   damping    0 = sharp peak, 1 = fully rounded (tardus–parvus)
   */
  function cycleVelocity(phase, sc) {
    var psv = sc.psv, edv = sc.edv;
    var acc = sc.accelFrac;
    var dec = acc + 0.16;
    var notchEnd = dec + 0.12;

    if (phase < acc) {
      /* The upstroke rises FROM the end-diastolic level, not from zero. Real
         arterial flow is continuous across the cycle boundary, and starting
         each beat at zero would put a false minimum at the foot of every
         upstroke — which is precisely where end-diastolic velocity is read. */
      var u = phase / acc;
      var shape = sc.damping > 0
        ? Math.pow(Math.sin(0.5 * Math.PI * u), 1 + 2 * sc.damping)
        : Math.sin(0.5 * Math.PI * u);
      return edv + (psv - edv) * shape;
    }
    if (phase < dec) {
      var d = (phase - acc) / (dec - acc);
      var floorV = sc.reverse > 0 ? -sc.reverse * psv : edv;
      return psv + (floorV - psv) * (1 - Math.cos(Math.PI * d)) / 2;
    }
    if (phase < notchEnd) {
      var m = (phase - dec) / (notchEnd - dec);
      var from = sc.reverse > 0 ? -sc.reverse * psv : edv;
      var to = edv * 1.6;
      return from + (to - from) * m;
    }
    /* Diastolic runoff, decaying ASYMPTOTICALLY TO edv rather than through it.
       The scenario's declared EDV is the ground truth the pipeline is checked
       against, so the waveform has to actually end there — a tail that decays
       past it would make a correct measurement look like a 40% under-read. */
    var r = (phase - notchEnd) / (1 - notchEnd);
    return edv * (1 + 0.6 * Math.exp(-2.5 * r));
  }

  /* ------------------------------------------------------------ generate --- */
  /*
   * Returns { I, Q, truth } where truth carries the values the pipeline is
   * expected to recover, so the calibration page can show recovery error.
   */
  function generateIQ(cfg, options) {
    options = options || {};
    var key = options.scenario && SCENARIOS[options.scenario] ? options.scenario : 'normal';
    var base = SCENARIOS[key];

    /* Scenario values can be overridden — the simulation page exposes PSV,
       heart rate, turbulence and angle as live sliders. */
    var sc = {
      psv:        options.psv        !== undefined ? options.psv        : base.psv,
      edv:        options.edv        !== undefined ? options.edv        : base.edv,
      hr:         options.hr         !== undefined ? options.hr         : base.hr,
      turbulence: options.turbulence !== undefined ? options.turbulence : base.turbulence,
      jitterMs:   options.jitterMs   !== undefined ? options.jitterMs   : base.jitterMs,
      reverse:    base.reverse,
      accelFrac:  base.accelFrac,
      damping:    base.damping,
      amplitudeJitter: base.amplitudeJitter || 0.04
    };

    var durationS = options.durationS || 6.0;
    var n = Math.max(cfg.fftSize * 2, Math.round(durationS * cfg.fs));
    var rand = rng(options.seed || 20260831);

    var I = new Float64Array(n);
    var Q = new Float64Array(n);

    /* Flow direction: -1 renders the whole waveform on the reverse side of
       the baseline, which is exactly what the I/Q sign convention encodes. */
    var sense = options.reverseFlow ? -1 : 1;

    /* Pre-compute beat boundaries with beat-to-beat jitter. */
    var beats = [];
    var t = 0;
    while (t < durationS + 2) {
      var period = 60 / sc.hr + (gauss(rand) * sc.jitterMs) / 1000;
      period = Math.max(0.25, period);
      var amp = 1 + gauss(rand) * sc.amplitudeJitter;
      beats.push({ start: t, period: period, amp: Math.max(0.3, amp) });
      t += period;
    }

    function beatAt(time) {
      for (var b = 0; b < beats.length; b++) {
        if (time >= beats[b].start && time < beats[b].start + beats[b].period) return beats[b];
      }
      return beats[beats.length - 1];
    }

    /* Turbulence is modelled as a population of scatterers whose velocities
       are spread around the mean — this is what widens the spectrum rather
       than merely adding noise to the envelope. */
    var nScat = 24;
    var phases = new Float64Array(nScat);
    var offsets = new Float64Array(nScat);
    for (var s = 0; s < nScat; s++) {
      phases[s] = rand() * 2 * Math.PI;
      offsets[s] = gauss(rand);
    }

    var noise = options.noise !== undefined ? options.noise : 0.06;

    for (var k = 0; k < n; k++) {
      var time = k / cfg.fs;
      var beat = beatAt(time);
      var phase = (time - beat.start) / beat.period;
      var v = cycleVelocity(phase, sc) * beat.amp * sense;

      var re = 0, im = 0;
      for (var j = 0; j < nScat; j++) {
        /* Parabolic flow profile: scatterers near the wall move slower.
           The sample volume covers only the central part of the lumen, not the
           whole vessel wall to wall, so the profile spread is narrow — about
           18%. Widening it here would fill the systolic window on every trace
           and make laminar flow indistinguishable from turbulent, which is the
           one discrimination the pattern parameter exists to make. Turbulence
           adds a random spread on top. */
        var profile = 0.82 + 0.18 * (1 - Math.pow((j / (nScat - 1)) * 2 - 1, 2));
        var vj = v * profile * (1 + sc.turbulence * offsets[j]);
        var fd = DSP.velocityToDoppler(cfg, vj);
        phases[j] += 2 * Math.PI * fd / cfg.fs;
        var a = 1 / nScat;
        re += a * Math.cos(phases[j]);
        im += a * Math.sin(phases[j]);
      }

      /* Wall clutter: strong, near-stationary echo the wall filter must remove. */
      var clutter = 0.35 * Math.cos(2 * Math.PI * 6 * time);
      var clutterQ = 0.35 * Math.sin(2 * Math.PI * 6 * time);

      I[k] = re * 6 + clutter + noise * gauss(rand);
      Q[k] = im * 6 + clutterQ + noise * gauss(rand);
    }

    /* Ground truth for the pipeline to be checked against. */
    var truth = {
      scenario: key,
      label: base.label,
      note: base.note,
      psv: sc.psv * (sense > 0 ? 1 : 1),
      edv: sc.edv,
      hr: sc.hr,
      direction: sense,
      turbulence: sc.turbulence,
      ri: sc.psv > 0 ? (sc.psv - sc.edv) / sc.psv : 0,
      durationS: n / cfg.fs
    };

    return { I: I, Q: Q, truth: truth };
  }

  /* Convenience: generate and run the full pipeline in one call. */
  function simulate(cfg, options) {
    var sig = generateIQ(cfg, options);
    var result = DSP.processIQ(cfg, sig.I, sig.Q);
    if (result) {
      result.truth = sig.truth;
      result.source = 'simulation';
    }
    return result;
  }

  /* Rolling buffer for live/streaming mode: keeps the last `seconds` of I/Q
     and re-runs the pipeline on demand. Used by both the simulator's live
     mode and the BLE stream so they share one code path. */
  function StreamBuffer(cfg, seconds) {
    this.cfg = cfg;
    this.capacity = Math.max(cfg.fftSize * 4, Math.round((seconds || 6) * cfg.fs));
    this.I = new Float64Array(this.capacity);
    this.Q = new Float64Array(this.capacity);
    this.filled = 0;
  }
  StreamBuffer.prototype.push = function (i, q) {
    var n = i.length;
    if (n >= this.capacity) {
      this.I.set(i.subarray(n - this.capacity));
      this.Q.set(q.subarray(n - this.capacity));
      this.filled = this.capacity;
      return;
    }
    var keep = this.capacity - n;
    this.I.copyWithin(0, n);
    this.Q.copyWithin(0, n);
    this.I.set(i, keep);
    this.Q.set(q, keep);
    this.filled = Math.min(this.capacity, this.filled + n);
  };
  StreamBuffer.prototype.process = function () {
    if (this.filled < this.cfg.fftSize * 2) return null;
    var start = this.capacity - this.filled;
    var I = this.I.slice(start).slice();
    var Q = this.Q.slice(start).slice();
    return DSP.processIQ(this.cfg, I, Q);
  };

  global.SonubraceSim = {
    SCENARIOS: SCENARIOS,
    generateIQ: generateIQ,
    simulate: simulate,
    cycleVelocity: cycleVelocity,
    StreamBuffer: StreamBuffer
  };
})(window);
