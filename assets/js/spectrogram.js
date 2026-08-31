/* ============================================================================
 * spectrogram.js — canvas rendering for the Doppler spectrogram, the velocity
 * envelope and the autocorrelation curve.
 *
 * Accessibility: every canvas here is drawn into a <canvas> that carries
 * role="img" and an aria-label describing what the reader would otherwise see.
 * describeSpectrogram() builds that sentence from the computed parameters, so
 * a screen-reader user gets the finding, not just "canvas".
 * ==========================================================================*/

(function (global) {
  'use strict';

  var DSP = global.SonubraceDSP;

  /* Colour ramp for spectral power, dark (quiet) -> bright (loud).
     Ordered by luminance as well as hue, so it survives greyscale printing
     and the common forms of colour-vision deficiency. */
  var RAMP = [
    [7, 26, 44], [18, 63, 107], [15, 114, 145],
    [184, 162, 0], [224, 90, 0], [255, 217, 160]
  ];

  function rampColor(t) {
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var x = t * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(x));
    var f = x - i;
    var a = RAMP[i], b = RAMP[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    ];
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function setupCanvas(canvas, cssHeight) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth || canvas.parentElement.clientWidth || 640;
    var h = cssHeight || 280;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* -------------------------------------------------------- spectrogram --- */
  /*
   * Draws P(f,t) with time on x and signed Doppler frequency on y. The zero
   * line is drawn explicitly because the whole point of the I/Q chain is that
   * above and below the baseline mean opposite flow directions.
   */
  function drawSpectrogram(canvas, result, opts) {
    opts = opts || {};
    if (!result || !result.spectrogram) return;

    var s = setupCanvas(canvas, opts.height || 300);
    var ctx = s.ctx, W = s.w, H = s.h;
    var padL = 56, padR = 12, padT = 10, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var spec = result.spectrogram;
    var cfg = result.config;
    var frames = spec.frames, bins = spec.bins;
    var dyn = cfg.dynRangeDb;

    /* Restrict the visible frequency band to what the data actually occupies,
       so a slow flow is not squeezed into a couple of pixels. */
    var maxFd = 0;
    for (var t = 0; t < frames; t++) maxFd = Math.max(maxFd, Math.abs(result.envelope.fdPeak[t]));
    var fdLimit = Math.min(cfg.fs / 2, Math.max(maxFd * 1.8, cfg.fs / 16));

    var loBin = Math.max(0, Math.floor(DSP.dopplerHzToBin(cfg, -fdLimit)));
    var hiBin = Math.min(bins - 1, Math.ceil(DSP.dopplerHzToBin(cfg, fdLimit)));
    var nBins = Math.max(1, hiBin - loBin + 1);

    /* Render the spectrogram into an offscreen image at data resolution, then
       let the canvas scale it — far faster than one fillRect per cell. */
    var img = ctx.createImageData(frames, nBins);
    for (var x = 0; x < frames; x++) {
      for (var y = 0; y < nBins; y++) {
        var db = spec.db[x * bins + (loBin + y)];
        var norm = (db + dyn) / dyn;                 /* -dyn..0  ->  0..1 */
        var col = rampColor(norm);
        /* y is flipped so positive Doppler is drawn upward. */
        var p = ((nBins - 1 - y) * frames + x) * 4;
        img.data[p] = col[0]; img.data[p + 1] = col[1];
        img.data[p + 2] = col[2]; img.data[p + 3] = 255;
      }
    }

    var off = document.createElement('canvas');
    off.width = frames; off.height = nBins;
    off.getContext('2d').putImageData(img, 0, 0);

    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, padL, padT, plotW, plotH);

    /* --- axes ------------------------------------------------------------ */
    var ink = cssVar('--ink-2', '#3d5364');
    var line = cssVar('--line', '#cfe0ea');
    ctx.font = '600 11px ' + cssVar('--font', 'system-ui');
    ctx.fillStyle = ink;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;

    function yForFd(fd) {
      var frac = (fd + fdLimit) / (2 * fdLimit);
      return padT + plotH - frac * plotH;
    }

    /* Velocity axis on the left (that is the quantity users care about). */
    var vLimit = DSP.dopplerToVelocity(cfg, fdLimit);
    var steps = 4;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var i = -steps; i <= steps; i++) {
      var v = (vLimit * i) / steps;
      var yy = yForFd(DSP.velocityToDoppler(cfg, v));
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(v.toFixed(2), padL - 8, yy);
    }
    ctx.save();
    ctx.translate(13, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('velocity (m/s)', 0, 0);
    ctx.restore();

    /* Zero-flow baseline — above it = forward, below it = reverse. */
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yForFd(0)); ctx.lineTo(W - padR, yForFd(0));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* Time axis. */
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var dur = result.durationS;
    for (var ti = 0; ti <= 6; ti++) {
      var tv = (dur * ti) / 6;
      var xx = padL + (plotW * ti) / 6;
      ctx.fillText(tv.toFixed(1) + 's', xx, padT + plotH + 8);
    }

    /* --- envelope overlay ------------------------------------------------- */
    if (opts.showEnvelope !== false) {
      ctx.strokeStyle = cssVar('--velocity', '#0c6b47');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var f = 0; f < frames; f++) {
        var px = padL + (plotW * f) / Math.max(1, frames - 1);
        var py = yForFd(result.envelope.fdPeak[f]);
        if (f === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    /* --- cardiac cycle markers -------------------------------------------- */
    if (opts.showCycles !== false && result.cycles && result.cycles.nCycles) {
      ctx.strokeStyle = cssVar('--pattern', '#6a35a8');
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      for (var ci = 0; ci < result.cycles.nCycles; ci++) {
        var cx = padL + (plotW * result.cycles.onset[ci]) / Math.max(1, frames - 1);
        ctx.beginPath();
        ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', describeSpectrogram(result));
  }

  /* ---------------------------------------------------- velocity trace ---- */
  /*
   * The Doppler envelope as a plain line chart. Systolic peaks and
   * end-diastolic points are marked, because those are the two samples every
   * supporting index (RI, PI, S/D) is computed from.
   */
  function drawEnvelope(canvas, result, opts) {
    opts = opts || {};
    if (!result || !result.envelope) return;

    var s = setupCanvas(canvas, opts.height || 220);
    var ctx = s.ctx, W = s.w, H = s.h;
    var padL = 56, padR = 12, padT = 14, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var env = result.envelope, n = env.nFrames;
    var vmax = 0;
    for (var k = 0; k < n; k++) vmax = Math.max(vmax, Math.abs(env.vPeak[k]));
    vmax = vmax || 1;
    var lim = vmax * 1.15;

    function yFor(v) { return padT + plotH / 2 - (v / lim) * (plotH / 2); }
    function xFor(i) { return padL + (plotW * i) / Math.max(1, n - 1); }

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--surface', '#fff');
    ctx.fillRect(0, 0, W, H);

    var ink = cssVar('--ink-2', '#3d5364');
    var line = cssVar('--line', '#cfe0ea');
    ctx.font = '600 11px ' + cssVar('--font', 'system-ui');

    /* grid + velocity labels */
    ctx.strokeStyle = line; ctx.fillStyle = ink;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = -2; g <= 2; g++) {
      var v = (lim * g) / 2, yy = yFor(v);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(v.toFixed(2), padL - 8, yy);
    }

    /* filled envelope */
    var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(12,107,71,.28)');
    grad.addColorStop(1, 'rgba(12,107,71,.02)');
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(0));
    for (var i = 0; i < n; i++) ctx.lineTo(xFor(i), yFor(env.vPeak[i]));
    ctx.lineTo(xFor(n - 1), yFor(0));
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var px = xFor(i), py = yFor(env.vPeak[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = cssVar('--velocity', '#0c6b47');
    ctx.lineWidth = 2.2; ctx.stroke();

    /* zero line */
    ctx.strokeStyle = cssVar('--line-strong', '#93b0c2');
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, yFor(0)); ctx.lineTo(W - padR, yFor(0)); ctx.stroke();
    ctx.setLineDash([]);

    /* PSV / EDV markers. A recording reloaded from storage keeps its parameters
       but not the per-frame cycle landmarks — those are only produced by a live
       segmentation pass — so the markers are drawn only when they exist. */
    var cyc = result.cycles;
    if (cyc && cyc.nCycles && cyc.systolicPeak && cyc.onset) {
      for (var c = 0; c < cyc.nCycles; c++) {
        var p = cyc.systolicPeak[c];
        ctx.fillStyle = cssVar('--support', '#a02440');
        ctx.beginPath(); ctx.arc(xFor(p), yFor(env.vPeak[p]), 4, 0, 2 * Math.PI); ctx.fill();
        if (c + 1 < cyc.nCycles) {
          var e = Math.max(p, cyc.onset[c + 1] - 1);
          ctx.fillStyle = cssVar('--imu', '#0a5fa5');
          ctx.beginPath(); ctx.arc(xFor(e), yFor(env.vPeak[e]), 4, 0, 2 * Math.PI); ctx.fill();
        }
      }
    }

    /* time axis */
    ctx.fillStyle = ink;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var ti = 0; ti <= 6; ti++) {
      ctx.fillText(((result.durationS * ti) / 6).toFixed(1) + 's',
                   padL + (plotW * ti) / 6, padT + plotH + 8);
    }

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Velocity envelope over ' + result.durationS.toFixed(1) + ' seconds. ' +
      'Peak systolic velocity ' + result.params.psv.toFixed(2) + ' metres per second, ' +
      'end-diastolic velocity ' + result.params.edv.toFixed(2) + '. ' +
      result.cycles.nCycles + ' cardiac cycles detected. Red dots mark systolic peaks, ' +
      'blue dots mark end-diastole.');
  }

  /* ------------------------------------------------- autocorrelation ------ */
  /*
   * Rxx(tau) from the methods document. The first peak away from zero lag is
   * the cycle length; how tall it is *is* the periodicity score.
   */
  function drawAutocorrelation(canvas, result, opts) {
    opts = opts || {};
    if (!result || !result.envelope) return;

    var env = result.envelope, n = env.nFrames;
    var mag = new Float64Array(n);
    for (var k = 0; k < n; k++) mag[k] = Math.abs(env.vPeak[k]);
    var maxLag = Math.min(n - 2, Math.floor(n / 2));
    var curve = DSP.autocorrelationCurve(mag, maxLag);

    var s = setupCanvas(canvas, opts.height || 180);
    var ctx = s.ctx, W = s.w, H = s.h;
    var padL = 48, padR = 12, padT = 12, padB = 28;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--surface', '#fff'); ctx.fillRect(0, 0, W, H);
    ctx.font = '600 11px ' + cssVar('--font', 'system-ui');

    function yFor(r) { return padT + plotH / 2 - r * (plotH / 2) * 0.92; }
    function xFor(l) { return padL + (plotW * l) / Math.max(1, maxLag); }

    ctx.strokeStyle = cssVar('--line', '#cfe0ea');
    ctx.fillStyle = cssVar('--ink-2', '#3d5364');
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [1, 0.5, 0, -0.5, -1].forEach(function (r) {
      var yy = yFor(r);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(r.toFixed(1), padL - 8, yy);
    });

    ctx.beginPath();
    for (var l = 0; l <= maxLag; l++) {
      var px = xFor(l), py = yFor(curve[l]);
      if (l === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = cssVar('--pattern', '#6a35a8');
    ctx.lineWidth = 2; ctx.stroke();

    /* mark the detected cycle lag */
    var lag = result.params.periodicityLag;
    if (lag > 0 && lag <= maxLag) {
      ctx.strokeStyle = cssVar('--support', '#a02440');
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(xFor(lag), padT); ctx.lineTo(xFor(lag), padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--support', '#a02440');
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('cycle = ' + (lag * env.dt).toFixed(2) + 's', xFor(lag) + 6, padT + 2);
    }

    ctx.fillStyle = cssVar('--ink-2', '#3d5364');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('lag (seconds)', padL + plotW / 2, padT + plotH + 8);

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Autocorrelation of the velocity envelope. Peak correlation ' +
      result.params.periodicity.toFixed(2) + ' at a lag of ' +
      (lag * env.dt).toFixed(2) + ' seconds, meaning the waveform repeats ' +
      (result.params.periodicity > 0.7 ? 'very regularly'
        : result.params.periodicity > 0.4 ? 'moderately regularly' : 'irregularly') + '.');
  }

  /* ------------------------------------------------ text alternative ------ */
  /*
   * One sentence that carries the same information a sighted reader takes from
   * the spectrogram. Used for aria-label and reused by the AI analyst.
   */
  function describeSpectrogram(result) {
    var p = result.params;
    var dir = p.direction > 0 ? 'almost entirely forward, toward the transducer'
            : p.direction < 0 ? 'almost entirely reverse, away from the transducer'
            : 'bidirectional, with flow on both sides of the baseline';
    var spread = p.spectralBroadening > 0.55
      ? 'The spectrum is broad and the systolic window is filled, which indicates a wide spread of velocities.'
      : p.spectralBroadening > 0.3
        ? 'The spectrum is moderately broad.'
        : 'The spectrum is narrow with a clear systolic window, so the blood cells are moving together.';

    return 'Doppler spectrogram covering ' + result.durationS.toFixed(1) + ' seconds. ' +
      'Peak systolic velocity ' + p.psv.toFixed(2) + ' metres per second, end-diastolic velocity ' +
      p.edv.toFixed(2) + ', mean ' + p.vMean.toFixed(2) + '. Flow is ' + dir + '. ' +
      spread + ' The waveform repeats with a periodicity of ' + p.periodicity.toFixed(2) +
      ' at about ' + Math.round(p.heartRateBpm) + ' beats per minute, ' +
      'and the pattern is classified as ' + p.patternName.toLowerCase() + '. ' +
      'Resistive index ' + p.ri.toFixed(2) + ', pulsatility index ' + p.pi.toFixed(2) + '.';
  }

  global.SonubraceViz = {
    drawSpectrogram: drawSpectrogram,
    drawEnvelope: drawEnvelope,
    drawAutocorrelation: drawAutocorrelation,
    describeSpectrogram: describeSpectrogram,
    rampColor: rampColor
  };
})(window);
