/* ============================================================================
 * imu.js — Inertial Measurement Unit illustration and angle guidance.
 *
 * The methods document gives the IMU two jobs:
 *   1. tell the user the ideal angle for calibration, and
 *   2. remind them to stop moving, so the echo capture is clean.
 *
 * This module draws the wrist, the probe and the insonation beam onto a canvas
 * so the user can *see* what "60 degrees" means, and turns raw orientation and
 * gyro numbers into one plain-language instruction.
 *
 * Sources of orientation, in order of preference:
 *   - the Sonubrace band's own IMU over BLE (setOrientation from ble.js)
 *   - the phone's DeviceOrientation / DeviceMotion sensors
 *   - a manual slider, so the illustration is usable on a desktop
 *
 * Why the angle matters: fD = 2 f0 v cos(theta) / c. At theta = 90 degrees
 * cos(theta) = 0 and the measurement collapses; near 60 degrees the cosine
 * changes slowly, so a few degrees of wobble barely shifts the velocity.
 * ==========================================================================*/

(function (global) {
  'use strict';

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function cfgIMU() {
    var c = (global.SONUBRACE_CONFIG && global.SONUBRACE_CONFIG.imu) || {};
    return {
      target: c.targetAngleDeg !== undefined ? c.targetAngleDeg : 60,
      tolerance: c.toleranceDeg !== undefined ? c.toleranceDeg : 8,
      stillness: c.stillnessGyroDps !== undefined ? c.stillnessGyroDps : 12,
      minHold: c.minHoldSeconds !== undefined ? c.minHoldSeconds : 6
    };
  }

  /* ------------------------------------------------------------ state ----- */

  function IMU(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.cfg = cfgIMU();

    this.angle = this.cfg.target;      /* insonation angle, degrees          */
    this.roll = 0;                     /* rotation about the forearm axis    */
    this.motion = 0;                   /* gyro magnitude, deg/s              */
    this.holdSeconds = 0;
    this.lastTick = performance.now();
    this.source = 'manual';
    this.listeners = [];
    this._raf = null;
  }

  IMU.prototype.onUpdate = function (fn) { this.listeners.push(fn); return this; };

  IMU.prototype._emit = function () {
    var st = this.status();
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i](st, this);
  };

  /* Feed orientation from any source. angle/roll in degrees, gyro in deg/s. */
  IMU.prototype.setOrientation = function (angleDeg, rollDeg, gyroDps, source) {
    var now = performance.now();
    var dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    this.angle = clamp(angleDeg, 0, 90);
    if (rollDeg !== undefined && rollDeg !== null) this.roll = rollDeg;
    if (gyroDps !== undefined && gyroDps !== null) this.motion = gyroDps;
    if (source) this.source = source;

    /* Hold timer only accumulates while both angle and stillness are good. */
    if (this.inTolerance() && this.isStill()) this.holdSeconds += dt;
    else this.holdSeconds = 0;

    this._emit();
  };

  IMU.prototype.inTolerance = function () {
    return Math.abs(this.angle - this.cfg.target) <= this.cfg.tolerance;
  };
  IMU.prototype.isStill = function () {
    return this.motion <= this.cfg.stillness;
  };
  IMU.prototype.isReady = function () {
    return this.inTolerance() && this.isStill() && this.holdSeconds >= this.cfg.minHold;
  };

  /* Cosine error: how much the velocity reading is distorted by being off
     the target angle. This is the honest way to express "angle accuracy" —
     5 degrees off at 60 costs far more than 5 degrees off at 30.            */
  IMU.prototype.cosineErrorPercent = function () {
    var t = Math.cos(this.cfg.target * Math.PI / 180);
    var a = Math.cos(this.angle * Math.PI / 180);
    if (Math.abs(a) < 1e-6) return 100;
    return Math.abs((a - t) / t) * 100;
  };

  /* One instruction, in plain words. This is the string the page announces
     through an aria-live region, so it must stand alone.                    */
  IMU.prototype.guidance = function () {
    if (!this.isStill()) {
      return { level: 'warn', text: 'Hold still. The band is moving too much to capture a clean echo.' };
    }
    var diff = this.angle - this.cfg.target;
    if (Math.abs(diff) > this.cfg.tolerance) {
      var dir = diff > 0 ? 'Lower' : 'Raise';
      return {
        level: 'warn',
        text: dir + ' the band by about ' + Math.round(Math.abs(diff)) +
              ' degrees to reach the ' + this.cfg.target + ' degree target angle.'
      };
    }
    if (this.holdSeconds < this.cfg.minHold) {
      var left = Math.ceil(this.cfg.minHold - this.holdSeconds);
      return { level: 'ok', text: 'Good angle. Keep still for ' + left + ' more second' + (left === 1 ? '' : 's') + '.' };
    }
    return { level: 'ok', text: 'Angle and stillness are good. Ready to record.' };
  };

  IMU.prototype.status = function () {
    return {
      angle: this.angle,
      roll: this.roll,
      motion: this.motion,
      target: this.cfg.target,
      tolerance: this.cfg.tolerance,
      inTolerance: this.inTolerance(),
      still: this.isStill(),
      ready: this.isReady(),
      holdSeconds: this.holdSeconds,
      cosineErrorPercent: this.cosineErrorPercent(),
      source: this.source,
      guidance: this.guidance()
    };
  };

  /* ----------------------------------------------------------- drawing ---- */
  /*
   * A side view: forearm, the vessel running through it, the band sitting on
   * the skin, and the ultrasound beam leaving the transducer at `angle` to the
   * vessel. A shaded wedge shows the acceptable angle band.
   */
  IMU.prototype.draw = function () {
    var canvas = this.canvas;
    if (!canvas) return;

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var W = canvas.clientWidth || 480;
    var H = this.opts.height || 260;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var ok = this.inTolerance() && this.isStill();
    var okCol   = cssVar('--ok', '#0c6b47');
    var warnCol = cssVar('--warn', '#8a5300');
    var imuCol  = cssVar('--imu', '#0a5fa5');
    var ink     = cssVar('--ink-2', '#3d5364');
    var accent  = ok ? okCol : warnCol;

    var skinY = H * 0.62;          /* skin surface                   */
    var vesselY = H * 0.80;        /* vessel centre line             */
    var probeX = W * 0.42;

    /* --- forearm block ---------------------------------------------------- */
    ctx.fillStyle = cssVar('--surface-3', '#dcecf5');
    ctx.strokeStyle = cssVar('--line-strong', '#93b0c2');
    ctx.lineWidth = 1.5;
    roundRect(ctx, W * 0.06, skinY, W * 0.88, H * 0.30, 16);
    ctx.fill(); ctx.stroke();

    /* --- vessel ----------------------------------------------------------- */
    var vesselH = 18;
    ctx.fillStyle = cssVar('--support-soft', '#fde3e9');
    ctx.strokeStyle = cssVar('--support', '#a02440');
    ctx.lineWidth = 2;
    roundRect(ctx, W * 0.06, vesselY - vesselH / 2, W * 0.88, vesselH, vesselH / 2);
    ctx.fill(); ctx.stroke();

    /* flow arrows inside the vessel */
    ctx.strokeStyle = cssVar('--support', '#a02440');
    ctx.lineWidth = 2;
    var phase = (performance.now() / 900) % 1;
    for (var a = 0; a < 6; a++) {
      var ax = W * 0.12 + ((a + phase) / 6) * W * 0.76;
      ctx.beginPath();
      ctx.moveTo(ax, vesselY); ctx.lineTo(ax + 12, vesselY);
      ctx.moveTo(ax + 8, vesselY - 4); ctx.lineTo(ax + 12, vesselY);
      ctx.lineTo(ax + 8, vesselY + 4);
      ctx.stroke();
    }

    /* --- tolerance wedge --------------------------------------------------- */
    var beamLen = Math.min(W * 0.34, skinY - 14);
    function beamEnd(deg) {
      var r = deg * Math.PI / 180;
      return { x: probeX - Math.cos(r) * beamLen, y: skinY - Math.sin(r) * beamLen };
    }
    var lo = beamEnd(this.cfg.target - this.cfg.tolerance);
    var hi = beamEnd(this.cfg.target + this.cfg.tolerance);

    ctx.fillStyle = ok ? 'rgba(12,107,71,.16)' : 'rgba(138,83,0,.14)';
    ctx.beginPath();
    ctx.moveTo(probeX, skinY);
    ctx.lineTo(lo.x, lo.y);
    ctx.lineTo(hi.x, hi.y);
    ctx.closePath(); ctx.fill();

    /* --- ultrasound beam --------------------------------------------------- */
    var end = beamEnd(this.angle);
    var grad = ctx.createLinearGradient(probeX, skinY, end.x, end.y);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(probeX, skinY); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.lineCap = 'butt';

    /* --- band + transducer -------------------------------------------------- */
    ctx.save();
    ctx.translate(probeX, skinY);
    ctx.rotate((-(this.angle - 90)) * Math.PI / 180 * 0.35);   /* subtle tilt */
    ctx.fillStyle = imuCol;
    roundRect(ctx, -34, -26, 68, 26, 8);
    ctx.fill();
    ctx.fillStyle = cssVar('--surface', '#fff');
    ctx.font = '700 10px ' + cssVar('--font', 'system-ui');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SONUBRACE', 0, -13);
    ctx.restore();

    /* --- angle arc + readout ------------------------------------------------ */
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(probeX, skinY, 46, Math.PI, Math.PI + (this.angle * Math.PI / 180), false);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.font = '800 15px ' + cssVar('--font', 'system-ui');
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(this.angle.toFixed(0) + '°', probeX - 96, skinY - 30);

    ctx.fillStyle = ink;
    ctx.font = '600 11px ' + cssVar('--font', 'system-ui');
    ctx.fillText('target ' + this.cfg.target + '° ±' + this.cfg.tolerance + '°',
                 probeX - 96, skinY - 14);

    /* --- motion indicator ---------------------------------------------------- */
    var still = this.isStill();
    ctx.fillStyle = still ? okCol : warnCol;
    ctx.beginPath(); ctx.arc(W - 22, 20, 7, 0, 2 * Math.PI); ctx.fill();
    ctx.font = '700 11px ' + cssVar('--font', 'system-ui');
    ctx.textAlign = 'right';
    ctx.fillText(still ? 'STILL' : 'MOVING', W - 34, 24);

    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Side view of the forearm. The Sonubrace band sits on the skin and aims its ultrasound beam at ' +
      this.angle.toFixed(0) + ' degrees to the vessel; the target is ' + this.cfg.target +
      ' degrees plus or minus ' + this.cfg.tolerance + '. The band is currently ' +
      (still ? 'still' : 'moving too much') + '. ' + this.guidance().text);
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------------- animation ------ */

  IMU.prototype.start = function () {
    var self = this;
    if (this._raf) return;
    var loop = function () {
      self.draw();
      self._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  };
  IMU.prototype.stop = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  };

  /* --------------------------------------------- device sensor binding ---- */
  /*
   * iOS requires a user gesture before granting motion access, so this must be
   * called from a click handler. Returns a promise resolving to true if live
   * sensor data is now flowing.
   */
  IMU.prototype.useDeviceSensors = function () {
    var self = this;

    function attach() {
      global.addEventListener('deviceorientation', function (e) {
        if (e.beta === null) return;
        /* beta is front-back tilt; map it onto the insonation angle. */
        var angle = clamp(Math.abs(e.beta), 0, 90);
        self.setOrientation(angle, e.gamma || 0, self.motion, 'device');
      });
      global.addEventListener('devicemotion', function (e) {
        var r = e.rotationRate;
        if (!r) return;
        var mag = Math.sqrt((r.alpha || 0) * (r.alpha || 0) +
                            (r.beta || 0) * (r.beta || 0) +
                            (r.gamma || 0) * (r.gamma || 0));
        self.motion = mag;
      });
      self.source = 'device';
      return true;
    }

    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      return DeviceMotionEvent.requestPermission()
        .then(function (state) { return state === 'granted' ? attach() : false; })
        .catch(function () { return false; });
    }
    if (typeof DeviceOrientationEvent !== 'undefined') return Promise.resolve(attach());
    return Promise.resolve(false);
  };

  /* Gentle synthetic drift, so the illustration is alive on a desktop with no
     sensors and no band attached. */
  IMU.prototype.useSimulatedDrift = function (centre) {
    var self = this;
    var base = centre !== undefined ? centre : this.cfg.target;
    var t0 = performance.now();
    this.source = 'simulated';
    if (this._sim) clearInterval(this._sim);
    this._sim = setInterval(function () {
      var t = (performance.now() - t0) / 1000;
      var angle = base + 5 * Math.sin(t * 0.6) + 2 * Math.sin(t * 2.3);
      var gyro = Math.abs(6 * Math.cos(t * 0.6) + 3 * Math.cos(t * 2.3));
      self.setOrientation(angle, 4 * Math.sin(t * 0.4), gyro, 'simulated');
    }, 100);
  };
  IMU.prototype.stopSimulatedDrift = function () {
    if (this._sim) clearInterval(this._sim);
    this._sim = null;
  };

  global.SonubraceIMU = { IMU: IMU };
})(window);
