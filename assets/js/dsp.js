/* ============================================================================
 * dsp.js — Sonubrace signal-processing core for the browser.
 *
 * This is a faithful mirror of firmware/sonubrace_dsp.c: same equations, same
 * constants, same classification thresholds. Keep the two in step — the C file
 * is what runs on the microcontroller and what the paper describes; this file
 * is what the web platform runs so the site works before you build the WASM.
 *
 *   fD    = 2 f0 v cos(theta) / c
 *   v(t)  = c fD(t) / (2 f0 cos(theta))
 *   fD(t) = argmax_f P(f, t)
 *   Rxx(tau) = sum_t x(t) x(t+tau)
 *   BW    = f_high - f_low
 *   RI    = (PSV - EDV) / PSV
 *   PI    = (PSV - EDV) / Vmean
 *
 * Sign convention: fD > 0 = flow toward the transducer (forward).
 * ==========================================================================*/

(function (global) {
  'use strict';

  var EPS = 1e-12;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ------------------------------------------------------------- config --- */

  function defaultConfig() {
    var a = (global.SONUBRACE_CONFIG && global.SONUBRACE_CONFIG.acquisition) || {};
    return {
      f0:               a.f0 !== undefined ? a.f0 : 5.0e6,
      fs:               a.fs !== undefined ? a.fs : 16.0e3,
      c:                a.c !== undefined ? a.c : 1540.0,
      thetaDeg:         a.thetaDeg !== undefined ? a.thetaDeg : 60.0,
      prf:              a.prf !== undefined ? a.prf : 4000.0,
      codeLen:          a.codeLen || 32,
      nSegments:        a.nSegments || 16,
      chipRate:         a.chipRate || 2.0e6,
      fftSize:          a.fftSize || 256,
      hop:              a.hop || 64,
      window:           a.window || 'hann',
      wallFilterHz:     a.wallFilterHz !== undefined ? a.wallFilterHz : 60.0,
      dynRangeDb:       a.dynRangeDb !== undefined ? a.dynRangeDb : 45.0,
      envelopeThreshDb: a.envelopeThreshDb !== undefined ? a.envelopeThreshDb : -12.0
    };
  }

  /* ------------------------------------------------ truncated long code --- */
  /* 16-bit LFSR m-sequence, sliced into nSegments consecutive segments.
     Mirrors sb_generate_truncated_long_code().                              */

  function generateTruncatedLongCode(codeLen, nSegments, seed) {
    var lfsr = (seed || 0xACE1) & 0xFFFF;
    var total = codeLen * nSegments;
    var out = new Int8Array(total);
    for (var i = 0; i < total; i++) {
      var bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
      lfsr = ((lfsr >> 1) | (bit << 15)) & 0xFFFF;
      out[i] = (lfsr & 1) ? 1 : -1;
    }
    return out;
  }

  /* Peak-to-sidelobe ratio in dB — the margin a true echo has over code
     self-noise. Mirrors sb_code_psl_db().                                    */
  function codePslDb(code) {
    var n = code.length;
    if (n < 2) return 0;
    var peak = n, side = 0;
    for (var lag = 1; lag < n; lag++) {
      var acc = 0;
      for (var i = 0; i + lag < n; i++) acc += code[i] * code[i + lag];
      var a = Math.abs(acc);
      if (a > side) side = a;
    }
    if (side < EPS) side = EPS;
    return 20 * Math.log10(peak / side);
  }

  function segmentOf(codes, index, codeLen) {
    var start = (index % (codes.length / codeLen)) * codeLen;
    return codes.subarray(start, start + codeLen);
  }

  /* --------------------------------------------------------- filtering --- */

  /* Zero-phase one-pole low-pass (forward then backward). */
  function lowpass(x, fs, cutHz) {
    var n = x.length;
    if (n < 2 || cutHz <= 0) return x;
    var dt = 1 / fs, rc = 1 / (2 * Math.PI * cutHz), a = dt / (rc + dt);
    var y = x[0], k;
    for (k = 0; k < n; k++) { y += a * (x[k] - y); x[k] = y; }
    y = x[n - 1];
    for (k = n - 1; k >= 0; k--) { y += a * (x[k] - y); x[k] = y; }
    return x;
  }

  /* Complex high-pass removing vessel-wall and probe-motion clutter.
     Mirrors sb_wall_filter().                                                */
  function wallFilter(I, Q, fs, cutHz) {
    var n = I.length;
    if (n < 2 || cutHz <= 0) return;
    var dt = 1 / fs, rc = 1 / (2 * Math.PI * cutHz), a = rc / (rc + dt);
    var pi = I[0], pq = Q[0], yi = 0, yq = 0;
    for (var k = 1; k < n; k++) {
      var xi = I[k], xq = Q[k];
      yi = a * (yi + xi - pi);
      yq = a * (yq + xq - pq);
      pi = xi; pq = xq;
      I[k] = yi; Q[k] = yq;
    }
    I[0] = 0; Q[0] = 0;
  }

  /* -------------------------------------------------------- transmit/rx --- */

  /* Phase 0: pulse x code x carrier -> DAC. Mirrors sb_build_coded_burst(). */
  function buildCodedBurst(cfg, code) {
    var fsRf = 4 * cfg.f0;
    var spc = Math.max(1, Math.round(fsRf / cfg.chipRate));
    var n = code.length * spc;
    var out = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var chip = Math.min(code.length - 1, Math.floor(k / spc));
      out[k] = code[chip] * Math.sin(2 * Math.PI * cfg.f0 * (k / fsRf));
    }
    return out;
  }

  /* Phase 1: 0 and pi/2 mixers + low-pass. Mirrors sb_quadrature_demodulate(). */
  function quadratureDemodulate(cfg, rf) {
    var n = rf.length, fsRf = 4 * cfg.f0;
    var I = new Float64Array(n), Q = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var ph = 2 * Math.PI * cfg.f0 * (k / fsRf);
      I[k] = rf[k] * Math.cos(ph);
      Q[k] = -rf[k] * Math.sin(ph);
    }
    lowpass(I, fsRf, cfg.f0 * 0.25);
    lowpass(Q, fsRf, cfg.f0 * 0.25);
    return { I: I, Q: Q };
  }

  /* Matched-filter decoding of one truncated segment.
     Mirrors sb_decode_segment().                                             */
  function decodeSegment(I, Q, code, samplesPerChip) {
    var n = I.length;
    var spc = Math.max(1, samplesPerChip | 0);
    var taps = code.length * spc;
    var norm = 1 / taps;
    var Id = new Float64Array(n), Qd = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var ai = 0, aq = 0;
      for (var j = 0; j < taps; j++) {
        var idx = k - taps + 1 + j;
        if (idx < 0) continue;
        var chip = code[((taps - 1 - j) / spc) | 0];
        ai += I[idx] * chip;
        aq += Q[idx] * chip;
      }
      Id[k] = ai * norm; Qd[k] = aq * norm;
    }
    return { I: Id, Q: Qd };
  }

  /* -------------------------------------------------------------- FFT ----- */

  /* In-place radix-2 complex FFT. Mirrors sb_fft(). */
  function fft(re, im, dir) {
    var n = re.length, i, j, bit;
    for (i = 1, j = 0; i < n; i++) {
      for (bit = n >> 1; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (dir >= 0 ? -2 : 2) * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (j = 0; j < len / 2; j++) {
          var a = i + j, b = i + j + len / 2;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
          var nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
    if (dir < 0) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function windowValue(type, k, n) {
    var x = k / (n - 1);
    if (type === 'hamming')  return 0.54 - 0.46 * Math.cos(2 * Math.PI * x);
    if (type === 'blackman') return 0.42 - 0.5 * Math.cos(2 * Math.PI * x)
                                          + 0.08 * Math.cos(4 * Math.PI * x);
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * x);          /* hann */
  }

  /* --------------------------------------------------------------- STFT --- */
  /* Rows = time frames, columns = fftshift'd bins, so column index maps
     monotonically from the most negative to the most positive Doppler shift.
     Mirrors sb_stft().                                                       */
  function stft(cfg, I, Q) {
    var N = cfg.fftSize, hop = cfg.hop > 0 ? cfg.hop : (N >> 2), n = I.length;
    if (n < N) return { power: new Float64Array(0), frames: 0, bins: N };

    var win = new Float64Array(N);
    for (var k = 0; k < N; k++) win[k] = windowValue(cfg.window, k, N);

    var frames = 1 + Math.floor((n - N) / hop);
    var power = new Float64Array(frames * N);
    var re = new Float64Array(N), im = new Float64Array(N);

    for (var t = 0; t < frames; t++) {
      var start = t * hop, i;
      for (i = 0; i < N; i++) { re[i] = I[start + i] * win[i]; im[i] = Q[start + i] * win[i]; }
      fft(re, im, +1);
      var off = t * N;
      for (i = 0; i < N; i++) {
        var src = (i + (N >> 1)) % N;                     /* fftshift */
        power[off + i] = re[src] * re[src] + im[src] * im[src];
      }
    }
    return { power: power, frames: frames, bins: N };
  }

  function binToDopplerHz(cfg, bin) {
    return (bin - cfg.fftSize / 2) * (cfg.fs / cfg.fftSize);
  }

  function dopplerHzToBin(cfg, hz) {
    return hz / (cfg.fs / cfg.fftSize) + cfg.fftSize / 2;
  }

  /* Convert to dB relative to the global maximum, clamped to the display
     dynamic range. Mirrors sb_power_to_db().                                 */
  function powerToDb(power, dynRangeDb) {
    var mx = 0, k;
    for (k = 0; k < power.length; k++) if (power[k] > mx) mx = power[k];
    if (mx < EPS) mx = EPS;
    for (k = 0; k < power.length; k++) {
      power[k] = clamp(10 * Math.log10((power[k] + EPS) / mx), -dynRangeDb, 0);
    }
    return power;
  }

  /* ---------------------------------------------------------- velocity ---- */

  function dopplerToVelocity(cfg, fdHz) {
    var ct = Math.cos(cfg.thetaDeg * Math.PI / 180);
    if (Math.abs(ct) < 1e-6) return 0;                    /* 90 deg: blind */
    return (cfg.c * fdHz) / (2 * cfg.f0 * ct);
  }

  function velocityToDoppler(cfg, v) {
    return (2 * cfg.f0 * v * Math.cos(cfg.thetaDeg * Math.PI / 180)) / cfg.c;
  }

  /* ---------------------------------------------------------- envelope ---- */

  /* Median of a frame's dB values: a robust estimate of that frame's noise
     floor. Robustness matters here — the mean would be dragged up by the
     Doppler peak itself, which is the very thing we want the floor underneath. */
  var _sortScratch = null;
  function frameNoiseFloorDb(powerDb, off, N) {
    if (!_sortScratch || _sortScratch.length !== N) _sortScratch = new Float64Array(N);
    for (var k = 0; k < N; k++) _sortScratch[k] = powerDb[off + k];
    _sortScratch.sort();
    return _sortScratch[N >> 1];
  }

  /* Noise margin, in dB above the median, that a bin must clear to count as
     signal. For a few hundred noise bins the largest sample sits roughly 8-10 dB
     above the median, so 12 dB keeps noise peaks out without discarding a
     genuine weak echo. */
  var NOISE_MARGIN_DB = 12;

  /* fD(t) = argmax_f P(f,t), with parabolic sub-bin interpolation, plus the
     power-weighted mean frequency and the spectral bandwidth.
     Mirrors sb_extract_envelope().

     The argmax runs only over bins standing clear of the frame's own noise
     floor. Without that gate a frame carrying little flow signal has its peak
     picked out of the noise — landing at an arbitrary bin, often near Nyquist,
     and reporting an absurd velocity. Gating keeps the definition from the
     methods document intact while making it survive a weak echo.

     The bandwidth threshold is relative to each frame's own peak, not to the
     global maximum: BW asks how spread the velocities are *at that instant*,
     so measuring it against a loud systolic frame elsewhere in the recording
     would make every diastolic frame read as zero bandwidth.                 */
  function extractEnvelope(cfg, powerDb, frames, thresholdDb) {
    var N = cfg.fftSize;
    var env = {
      nFrames: frames,
      dt: (cfg.hop > 0 ? cfg.hop : N >> 2) / cfg.fs,
      fdPeak: new Float64Array(frames),
      fdMean: new Float64Array(frames),
      vPeak:  new Float64Array(frames),
      vMean:  new Float64Array(frames),
      bw:     new Float64Array(frames),
      power:  new Float64Array(frames),
      snr:    new Float64Array(frames),
      time:   new Float64Array(frames)
    };
    var relThr = thresholdDb !== undefined ? thresholdDb : cfg.envelopeThreshDb;

    for (var t = 0; t < frames; t++) {
      var off = t * N;
      var floorDb = frameNoiseFloorDb(powerDb, off, N);
      var gate = floorDb + NOISE_MARGIN_DB;
      var k, db;

      /* Pass 1 — peak, restricted to bins above the noise gate. */
      var peakBin = -1, peakDb = -1e9;
      for (k = 0; k < N; k++) {
        db = powerDb[off + k];
        if (db < gate) continue;
        if (db > peakDb) { peakDb = db; peakBin = k; }
      }

      if (peakBin < 0) {
        /* Nothing rose above the noise in this frame: report no flow rather
           than inventing a velocity from the noise. */
        env.fdPeak[t] = 0; env.fdMean[t] = 0;
        env.vPeak[t] = 0;  env.vMean[t] = 0;
        env.bw[t] = 0;
        env.power[t] = 0;
        env.snr[t] = 0;
        env.time[t] = t * env.dt;
        continue;
      }

      /* Pass 2 — weighted mean and spectral edges, over the signal bins only,
         thresholded relative to this frame's peak. */
      var edgeThr = Math.max(gate, peakDb + relThr);
      var sumW = 0, sumWF = 0, lo = -1, hi = -1;
      for (k = 0; k < N; k++) {
        db = powerDb[off + k];
        if (db < gate) continue;
        var lin = Math.pow(10, db / 10);
        sumW  += lin;
        sumWF += lin * binToDopplerHz(cfg, k);
        if (db >= edgeThr) { if (lo < 0) lo = k; hi = k; }
      }

      /* Parabolic interpolation for sub-bin resolution. */
      var binF = peakBin;
      if (peakBin > 0 && peakBin < N - 1) {
        var y0 = powerDb[off + peakBin - 1],
            y1 = powerDb[off + peakBin],
            y2 = powerDb[off + peakBin + 1];
        var den = y0 - 2 * y1 + y2;
        if (Math.abs(den) > EPS) binF += 0.5 * (y0 - y2) / den;
      }

      var fdPeak = (binF - N / 2) * (cfg.fs / N);
      var fdMean = sumW > EPS ? sumWF / sumW : 0;

      env.fdPeak[t] = fdPeak;
      env.fdMean[t] = fdMean;
      env.vPeak[t]  = dopplerToVelocity(cfg, fdPeak);
      env.vMean[t]  = dopplerToVelocity(cfg, fdMean);
      env.bw[t]     = (lo >= 0 && hi >= lo)
                      ? binToDopplerHz(cfg, hi) - binToDopplerHz(cfg, lo) : 0;
      env.power[t]  = sumW;
      env.snr[t]    = peakDb - floorDb;
      env.time[t]   = t * env.dt;
    }
    return env;
  }

  /* ----------------------------------------------------- periodicity ------ */

  /* Rxx(tau), normalised. Mirrors sb_autocorrelation(). */
  function autocorrelation(x, lag) {
    var n = x.length;
    if (n <= 1 || lag < 0 || lag >= n) return 0;
    var mean = 0, k;
    for (k = 0; k < n; k++) mean += x[k];
    mean /= n;
    var num = 0, den = 0;
    for (k = 0; k < n - lag; k++) num += (x[k] - mean) * (x[k + lag] - mean);
    for (k = 0; k < n; k++)       den += (x[k] - mean) * (x[k] - mean);
    return den > EPS ? num / den : 0;
  }

  /* Centred moving average, used only for landmark detection — never for
     reported values, so no measurement is biased by the smoothing. */
  function movingAverage(x, width) {
    var n = x.length, half = width >> 1;
    var out = new Float64Array(n);
    for (var k = 0; k < n; k++) {
      var sum = 0, cnt = 0;
      for (var j = Math.max(0, k - half); j <= Math.min(n - 1, k + half); j++) {
        sum += x[j]; cnt++;
      }
      out[k] = sum / cnt;
    }
    return out;
  }

  /* Physiological search window for the cardiac cycle, converted to frame lags.
     This bound is not a convenience: autocorrelation decays monotonically away
     from lag 0 for any smooth signal, so an unbounded search always returns the
     smallest lag offered and reports a heart rate in the thousands. Restricting
     the search to 35-220 bpm is what makes the returned lag a heartbeat rather
     than an artefact of smoothness.                                           */
  var HR_MIN_BPM = 35, HR_MAX_BPM = 220;

  function cycleLagBounds(dt, nFrames) {
    var minLag = Math.max(2, Math.floor((60 / HR_MAX_BPM) / dt));
    var maxLag = Math.min(nFrames - 2, Math.ceil((60 / HR_MIN_BPM) / dt));
    if (maxLag <= minLag) maxLag = Math.min(nFrames - 2, minLag + 1);
    return { min: minLag, max: maxLag };
  }

  /* Best lag in range plus its normalised peak. Mirrors sb_periodicity(). */
  function periodicity(x, minLag, maxLag) {
    var n = x.length;
    minLag = Math.max(1, minLag);
    maxLag = Math.min(maxLag, n - 2);
    var best = 0, bestLag = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var r = autocorrelation(x, lag);
      if (r > best) { best = r; bestLag = lag; }
    }
    return { value: clamp(best, 0, 1), lag: bestLag };
  }

  /* Full autocorrelation curve, for plotting on the analysis page. */
  function autocorrelationCurve(x, maxLag) {
    var out = new Float64Array(maxLag + 1);
    for (var lag = 0; lag <= maxLag; lag++) out[lag] = autocorrelation(x, lag);
    return out;
  }

  /* ------------------------------------------- cardiac cycle segmentation -- */
  /* Mirrors sb_segment_cardiac_cycles(). */
  function segmentCardiacCycles(env) {
    var n = env.nFrames;
    var res = { nCycles: 0, onset: [], systolicPeak: [], periodS: [],
                heartRateBpm: 0, hrVariabilityMs: 0 };
    if (n < 8) return res;

    var mag = new Float64Array(n), vmax = 0, k;
    for (k = 0; k < n; k++) { mag[k] = Math.abs(env.vPeak[k]); if (mag[k] > vmax) vmax = mag[k]; }
    if (vmax < EPS) return res;

    var b = cycleLagBounds(env.dt, n);
    var p = periodicity(mag, b.min, b.max);
    if (p.lag < 2) return res;

    var thr = 0.45 * vmax;
    var refr = Math.floor(0.6 * p.lag);
    var lastPeak = -refr;

    for (k = 1; k < n - 1; k++) {
      if (mag[k] < thr) continue;
      if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
      if (k - lastPeak < refr) {
        var last = res.nCycles - 1;
        if (last >= 0 && mag[k] > mag[res.systolicPeak[last]]) {
          res.systolicPeak[last] = k; lastPeak = k;
        }
        continue;
      }
      res.systolicPeak.push(k);
      res.nCycles++;
      lastPeak = k;
    }

    /* Cycle onset = the foot of the systolic upstroke: walk back from the peak
       on a smoothed envelope until the trace stops falling.
       Two details matter here.
       First, the walk runs on the SMOOTHED trace — on the raw envelope it stops
       at the first noise dip, landing almost anywhere on a slow, rounded
       upstroke, and that instability shows up directly as inflated beat-to-beat
       variability.
       Second, the foot is deliberately NOT the minimum of |v| across the cycle.
       When flow reverses in early diastole, |v| passes through zero at the
       crossing, and that zero is the global minimum — reading end-diastolic
       velocity there would report ~0 for every recording and drive RI to 1.
       The foot of the upstroke is the last point of diastole, which is what EDV
       is defined as. */
    var smooth = movingAverage(mag, Math.max(3, Math.round(0.04 / env.dt) | 1));
    for (k = 0; k < res.nCycles; k++) {
      var pk = res.systolicPeak[k];
      var limit = k > 0 ? res.systolicPeak[k - 1] : Math.max(0, pk - p.lag);

      /* Search the LAST 45% of the interval before the peak. Confining it to
         late diastole is what keeps the early-diastolic reverse notch out of
         the search: at the notch the flow crosses zero, so |v| has its global
         minimum there, and an unconfined search would read end-diastolic
         velocity as ~0 on every recording and drive RI to 1. */
      var from = Math.max(limit, pk - Math.round(0.45 * p.lag));
      var to   = Math.max(from, pk - Math.max(1, Math.round(0.03 * p.lag)));

      var onset = from, lowest = smooth[from];
      for (var m = from; m <= to; m++) {
        if (smooth[m] < lowest) { lowest = smooth[m]; onset = m; }
      }
      res.onset.push(onset);
    }

    if (res.nCycles < 2) {
      res.heartRateBpm = 60 / (p.lag * env.dt);
      return res;
    }

    /* Cycle length from peak to peak. The systolic peak is the sharpest,
       highest-contrast landmark in the envelope, so it localises far more
       precisely than the diastolic foot — which matters because this interval
       is what heart rate and its variability are computed from. */
    var sum = 0;
    for (k = 1; k < res.nCycles; k++) {
      var per = (res.systolicPeak[k] - res.systolicPeak[k - 1]) * env.dt;
      res.periodS.push(per);
      sum += per;
    }
    var mean = sum / res.periodS.length;
    var varr = 0;
    for (k = 0; k < res.periodS.length; k++) {
      var d = res.periodS[k] - mean; varr += d * d;
    }
    varr /= res.periodS.length;

    res.heartRateBpm    = mean > EPS ? 60 / mean : 0;
    res.hrVariabilityMs = Math.sqrt(varr) * 1000;
    return res;
  }

  /* --------------------------------------------------------- parameters --- */

  var PATTERN = {
    UNKNOWN:   { id: 0, name: 'Unknown',   key: 'unknown' },
    LAMINAR:   { id: 1, name: 'Laminar',   key: 'laminar' },
    PULSATILE: { id: 2, name: 'Pulsatile', key: 'pulsatile' },
    TURBULENT: { id: 3, name: 'Turbulent', key: 'turbulent' },
    IRREGULAR: { id: 4, name: 'Irregular', key: 'irregular' },
    DAMPED:    { id: 5, name: 'Damped',    key: 'damped' }
  };

  /* Pattern-classification thresholds. Calibrated against the simulator's
     scenarios, where the underlying flow state is known; re-check them against
     your own cohort before publishing, and report the values you used.       */
  var PATTERN_T = {
    irregularPeriodicity: 0.35,  /* below this the beats do not repeat reliably */
    irregularHrvMs:       120,   /* beat-to-beat variation                      */
    turbulentBroadening:  0.55,  /* laminar flow measures ~0.25, turbulent ~0.9 */
    dampedAccelS:         0.12,  /* slow upstroke to the systolic peak          */
    dampedRi:             0.70,  /* damped waveforms are also low-resistance    */
    pulsatilePi:          4.0,   /* normal peripheral flow measures ~2.5-3.0    */
    pulsatileRi:          0.92
  };

  function directionName(d) {
    if (d > 0) return 'Forward (toward transducer)';
    if (d < 0) return 'Reverse (away from transducer)';
    return 'Bidirectional';
  }

  /* The three main parameters plus the supporting indices.
     Mirrors sb_compute_params().                                             */
  function computeParams(cfg, env, cyc) {
    var n = env.nFrames, k;
    var out = {};

    /* ---- MAIN 1: velocity ---------------------------------------------- */
    var vabsMax = 0, vsum = 0;
    for (k = 0; k < n; k++) {
      var a = Math.abs(env.vPeak[k]);
      if (a > vabsMax) vabsMax = a;
      vsum += Math.abs(env.vMean[k]);
    }
    out.vMean = vsum / n;
    out.vMaxAbs = vabsMax;

    var psv, edv;
    out.accelerationTimeS = 0;
    out.heartRateBpm = cyc ? cyc.heartRateBpm : 0;

    if (cyc && cyc.nCycles >= 2) {
      var psvSum = 0, edvSum = 0, cnt = 0;
      for (k = 0; k + 1 < cyc.nCycles; k++) {
        var pk = cyc.systolicPeak[k];
        /* End-diastole is the foot of the NEXT upstroke: the last moment of
           this cycle before the next beat begins. */
        var e = Math.max(pk, cyc.onset[k + 1]);
        psvSum += Math.abs(env.vPeak[pk]);
        edvSum += Math.abs(env.vPeak[e]);
        cnt++;
      }
      psv = cnt ? psvSum / cnt : vabsMax;
      edv = cnt ? edvSum / cnt : 0;
      out.accelerationTimeS = (cyc.systolicPeak[0] - cyc.onset[0]) * env.dt;
    } else {
      psv = vabsMax;
      var vmin = Infinity;
      for (k = 0; k < n; k++) vmin = Math.min(vmin, Math.abs(env.vPeak[k]));
      edv = isFinite(vmin) ? vmin : 0;
    }
    out.psv = psv;
    out.edv = edv;

    /* ---- MAIN 2: flow direction ----------------------------------------- */
    var fwd = 0, rev = 0;
    for (k = 0; k < n; k++) {
      var w = env.power[k];
      if (env.fdPeak[k] > 0) fwd += w; else if (env.fdPeak[k] < 0) rev += w;
    }
    var tot = fwd + rev;
    out.forwardFraction = tot > EPS ? fwd / tot : 0;
    out.reverseFraction = tot > EPS ? rev / tot : 0;
    out.direction = out.forwardFraction > 0.85 ? 1
                  : (out.reverseFraction > 0.85 ? -1 : 0);
    out.directionName = directionName(out.direction);

    out.reverseFlowPresent = false;
    for (k = 0; k < n; k++) {
      var v = env.vPeak[k];
      if (out.forwardFraction >= 0.5 && v < -0.10 * psv) { out.reverseFlowPresent = true; break; }
      if (out.forwardFraction <  0.5 && v >  0.10 * psv) { out.reverseFlowPresent = true; break; }
    }

    /* ---- MAIN 3: flow pattern -------------------------------------------- */
    var mag = new Float64Array(n);
    for (k = 0; k < n; k++) mag[k] = Math.abs(env.vPeak[k]);
    var pb = cycleLagBounds(env.dt, n);
    var p = periodicity(mag, pb.min, pb.max);
    out.periodicity = p.value;
    out.periodicityLag = p.lag;

    var bwSum = 0, broadSum = 0;
    for (k = 0; k < n; k++) {
      bwSum += env.bw[k];
      var denom = Math.abs(env.fdPeak[k]);
      broadSum += denom > EPS ? clamp(env.bw[k] / (2 * denom), 0, 1) : 1;
    }
    out.bandwidthHz = bwSum / n;
    out.spectralBroadening = broadSum / n;

    var morph = out.periodicity;
    if (cyc && cyc.nCycles >= 3 && cyc.heartRateBpm > EPS) {
      var meanPeriodMs = 60000 / cyc.heartRateBpm;
      var cv = cyc.hrVariabilityMs / meanPeriodMs;
      morph = clamp(out.periodicity * (1 - clamp(cv, 0, 1)), 0, 1);
    }
    out.morphologyScore = morph;

    /* ---- SUPPORTING indices ---------------------------------------------- */
    out.ri = psv > EPS ? (psv - edv) / psv : 0;
    out.pi = out.vMean > EPS ? (psv - edv) / out.vMean : 0;
    out.sdRatio = edv > EPS ? psv / edv : 0;
    out.hrVariabilityMs = cyc ? cyc.hrVariabilityMs : 0;

    /* ---- Pattern classification (same order and thresholds as the C core) --
       These cut-offs are for CLASSIFYING the waveform shape, and are separate
       from the reference ranges in ai.js used to FLAG a value as unusual. The
       two answer different questions — "what shape is this?" versus "is this
       outside the expected range?" — and a value can be normal yet still be
       most accurately described as pulsatile.

       Order matters. Irregularity and turbulence are checked first because
       they are the findings that must not be masked by an otherwise
       normal-looking waveform.                                               */
    if (out.periodicity < PATTERN_T.irregularPeriodicity ||
        (cyc && cyc.hrVariabilityMs > PATTERN_T.irregularHrvMs))
      out.pattern = PATTERN.IRREGULAR;
    else if (out.spectralBroadening > PATTERN_T.turbulentBroadening)
      out.pattern = PATTERN.TURBULENT;
    else if (out.accelerationTimeS > PATTERN_T.dampedAccelS &&
             out.ri < PATTERN_T.dampedRi)
      out.pattern = PATTERN.DAMPED;
    else if (out.pi > PATTERN_T.pulsatilePi || out.ri > PATTERN_T.pulsatileRi)
      out.pattern = PATTERN.PULSATILE;
    else
      out.pattern = PATTERN.LAMINAR;

    out.patternName = out.pattern.name;
    out.patternKey  = out.pattern.key;

    /* ---- Signal quality --------------------------------------------------- */
    /* Per-frame SNR is how far that frame's Doppler peak stood above its own
       noise floor. The median across frames is the honest summary: a mean would
       be inflated by a handful of loud systolic frames in a recording that was
       otherwise noise. Frames with no signal at all count as zero, so a
       recording that only caught a few beats is scored down accordingly.      */
    var snrs = [];
    for (k = 0; k < n; k++) snrs.push(env.snr ? env.snr[k] : 0);
    snrs.sort(function (a, b) { return a - b; });
    var medSnr = snrs.length ? snrs[snrs.length >> 1] : 0;

    out.snrDb = medSnr;
    out.signalQuality = clamp(0.55 * clamp(medSnr / 25, 0, 1)
                            + 0.45 * out.periodicity, 0, 1);

    return out;
  }

  /* --------------------------------------------------------- pipeline ----- */
  /* Baseband I/Q in, full result out. This is the entry point the app uses
     for both simulated and BLE-streamed data.                                */
  function processIQ(cfg, I, Q, opts) {
    opts = opts || {};
    if (opts.wallFilter !== false) wallFilter(I, Q, cfg.fs, cfg.wallFilterHz);

    var s = stft(cfg, I, Q);
    if (!s.frames) return null;

    var powerDb = powerToDb(s.power, cfg.dynRangeDb);
    var env = extractEnvelope(cfg, powerDb, s.frames, cfg.envelopeThreshDb);
    var cyc = segmentCardiacCycles(env);
    var par = computeParams(cfg, env, cyc);

    return {
      config: cfg,
      spectrogram: { db: powerDb, frames: s.frames, bins: s.bins },
      envelope: env,
      cycles: cyc,
      params: par,
      durationS: env.nFrames * env.dt
    };
  }

  /* Full RF path, matching sb_process_rf(). Slower; used by the "raw signal"
     demonstration on the methods page.                                       */
  function processRF(cfg, rf, code) {
    var bb = quadratureDemodulate(cfg, rf);
    if (code && code.length) {
      var spc = Math.max(1, Math.round((4 * cfg.f0) / cfg.chipRate));
      bb = decodeSegment(bb.I, bb.Q, code, spc);
    }
    return processIQ(cfg, bb.I, bb.Q);
  }

  global.SonubraceDSP = {
    defaultConfig: defaultConfig,
    generateTruncatedLongCode: generateTruncatedLongCode,
    codePslDb: codePslDb,
    segmentOf: segmentOf,
    buildCodedBurst: buildCodedBurst,
    quadratureDemodulate: quadratureDemodulate,
    decodeSegment: decodeSegment,
    wallFilter: wallFilter,
    lowpass: lowpass,
    fft: fft,
    stft: stft,
    powerToDb: powerToDb,
    binToDopplerHz: binToDopplerHz,
    dopplerHzToBin: dopplerHzToBin,
    extractEnvelope: extractEnvelope,
    dopplerToVelocity: dopplerToVelocity,
    velocityToDoppler: velocityToDoppler,
    autocorrelation: autocorrelation,
    autocorrelationCurve: autocorrelationCurve,
    periodicity: periodicity,
    cycleLagBounds: cycleLagBounds,
    segmentCardiacCycles: segmentCardiacCycles,
    computeParams: computeParams,
    processIQ: processIQ,
    processRF: processRF,
    PATTERN: PATTERN,
    directionName: directionName
  };
})(window);
