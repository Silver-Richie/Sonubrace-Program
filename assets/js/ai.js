/* ============================================================================
 * ai.js — the Sonubrace analyst.
 *
 * Two layers, in this order:
 *
 *   1. EXPERT ENGINE (always on, no key, no network). A deterministic
 *      rule/feature model over the three main parameters, the supporting
 *      indices and the user's health profile. It produces the spectrogram
 *      explanation, the NCD risk flags and the risk-management advice, and it
 *      answers the common questions. Being deterministic matters for a
 *      research platform: the same recording always yields the same reading,
 *      so results are reproducible and citable.
 *
 *   2. CLAUDE (optional). Free-form questions, grounded in a structured
 *      summary of the same numbers. Enabled only when the user supplies a key.
 *
 * SCOPE: Sonubrace is a screening and monitoring aid. Nothing here is a
 * diagnosis. Every risk output is phrased as a pattern to discuss with a
 * clinician, and urgent findings say so plainly.
 *
 * Reference ranges below are for a peripheral (radial-artery) recording site
 * and are the platform's defaults, not universal truth: they vary by vessel,
 * age and equipment. Adjust REFERENCE for your study population and say which
 * values you used when you publish.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var REFERENCE = {
    psv:  { low: 0.40, high: 1.20, unit: 'm/s',
            note: 'peak systolic velocity, radial artery at rest' },
    edv:  { low: 0.02, high: 0.25, unit: 'm/s' },
    vmean:{ low: 0.08, high: 0.40, unit: 'm/s' },
    ri:   { low: 0.55, high: 0.90, note: 'resistive index, peripheral artery' },
    pi:   { low: 1.00, high: 6.00, note: 'pulsatility index, peripheral artery' },
    hr:   { low: 50,   high: 100,  unit: 'bpm' },
    periodicity: { low: 0.55, high: 1.0 },
    broadening:  { low: 0.0,  high: 0.45 },
    quality:     { low: 0.55, high: 1.0 }
  };

  function band(value, ref) {
    if (value < ref.low) return 'low';
    if (value > ref.high) return 'high';
    return 'normal';
  }

  function pct(x) { return Math.round(x * 100) + '%'; }
  function n2(x) { return (Math.round(x * 100) / 100).toFixed(2); }

  /* ======================================================================= *
   *  1. Findings — one structured object per observation.
   * ======================================================================= */
  /*
   * A finding is { id, severity, parameter, title, detail, action }.
   * severity: 'info' | 'watch' | 'attention' | 'urgent'
   * Keeping them structured (rather than a paragraph) lets the UI sort by
   * severity, lets the risk model count them, and lets Claude be handed facts
   * instead of prose.
   */

  function analyseVelocity(p, profile, out) {
    var b = band(p.psv, REFERENCE.psv);

    if (b === 'high') {
      out.push({
        id: 'psv-high', severity: p.psv > REFERENCE.psv.high * 1.5 ? 'attention' : 'watch',
        parameter: 'velocity',
        title: 'Peak systolic velocity is above the expected range',
        detail: 'PSV measured ' + n2(p.psv) + ' m/s against an expected ' +
                REFERENCE.psv.low + '–' + REFERENCE.psv.high + ' m/s at this site. ' +
                'Blood is being pushed through the vessel faster than usual, which happens when ' +
                'the driving pressure is high or the channel the blood passes through has narrowed.',
        action: 'Raised velocity together with a raised resistive index is the pattern most often ' +
                'discussed in relation to hypertension. Recheck at rest, and bring the trend to a clinician.'
      });
    } else if (b === 'low') {
      out.push({
        id: 'psv-low', severity: 'watch', parameter: 'velocity',
        title: 'Peak systolic velocity is below the expected range',
        detail: 'PSV measured ' + n2(p.psv) + ' m/s against an expected ' +
                REFERENCE.psv.low + '–' + REFERENCE.psv.high + ' m/s. Low peak velocity means ' +
                'each heartbeat is moving less blood past the probe than expected.',
        action: 'Confirm the insonation angle first — an angle far from ' +
                'the target under-reads velocity. If the angle was good, low flow is worth ' +
                'discussing alongside blood pressure and glucose.'
      });
    } else {
      out.push({
        id: 'psv-normal', severity: 'info', parameter: 'velocity',
        title: 'Peak systolic velocity is within the expected range',
        detail: 'PSV ' + n2(p.psv) + ' m/s, EDV ' + n2(p.edv) + ' m/s, mean ' + n2(p.vMean) + ' m/s.',
        action: 'No action needed on velocity alone.'
      });
    }

    if (p.edv > REFERENCE.edv.high) {
      out.push({
        id: 'edv-high', severity: 'watch', parameter: 'velocity',
        title: 'Diastolic flow stays unusually high',
        detail: 'End-diastolic velocity is ' + n2(p.edv) + ' m/s. Flow that never falls away ' +
                'between beats means the resistance downstream is low, which is normal in an ' +
                'organ that needs constant supply but unusual in a limb artery at rest.',
        action: 'Note whether the recording was taken after exercise or in a warm room; both ' +
                'raise diastolic flow legitimately.'
      });
    }
  }

  function analyseDirection(p, profile, out) {
    if (p.direction === 0) {
      out.push({
        id: 'dir-bidirectional', severity: 'watch', parameter: 'direction',
        title: 'Flow is bidirectional through the recording',
        detail: pct(p.forwardFraction) + ' of the signal power sits above the baseline (forward) ' +
                'and ' + pct(p.reverseFraction) + ' below it (reverse). A vessel that carries ' +
                'substantial flow in both directions across the whole recording is either being ' +
                'sampled at a branch point, or the probe angle is close to 90 degrees where the ' +
                'sign becomes unstable.',
        action: 'Reposition the band slightly along the vessel and record again before reading anything into this.'
      });
    } else {
      out.push({
        id: 'dir-clear', severity: 'info', parameter: 'direction',
        title: 'Flow direction is consistent',
        detail: 'Flow is ' + (p.direction > 0 ? 'forward, toward the transducer' :
                'reverse, away from the transducer') + ', carrying ' +
                pct(Math.max(p.forwardFraction, p.reverseFraction)) + ' of the signal power. ' +
                'The in-phase and quadrature channels resolve this sign directly, which is why ' +
                'Sonubrace can report a direction rather than only a magnitude.',
        action: 'No action needed.'
      });
    }

    if (p.reverseFlowPresent && p.direction !== 0) {
      out.push({
        id: 'dir-reversal', severity: 'info', parameter: 'direction',
        title: 'A brief flow reversal appears in early diastole',
        detail: 'Momentary reversal after the systolic peak is the normal signature of a healthy ' +
                'high-resistance limb artery: the pulse wave reflects back from the periphery. ' +
                'Its absence in an artery that should have it is more notable than its presence.',
        action: 'None — this is expected in a resting limb artery.'
      });
    }
  }

  function analysePattern(p, profile, out) {
    var key = p.patternKey;

    if (key === 'turbulent') {
      out.push({
        id: 'pattern-turbulent', severity: 'attention', parameter: 'pattern',
        title: 'The spectrum is broad — flow is not moving as one stream',
        detail: 'Spectral broadening is ' + n2(p.spectralBroadening) + ' and the mean bandwidth is ' +
                Math.round(p.bandwidthHz) + ' Hz. In a healthy vessel the blood cells travel at ' +
                'similar speeds, so the spectrogram shows a thin bright line with a dark window ' +
                'beneath it. Here that window is filled in, meaning cells are moving at many ' +
                'different speeds at once — the acoustic signature of disturbed flow.',
        action: 'Disturbed flow downstream of a narrowing is one recognised cause. Repeat the ' +
                'recording to rule out probe movement, then raise a persistent finding with a clinician.'
      });
    } else if (key === 'irregular') {
      out.push({
        id: 'pattern-irregular', severity: 'attention', parameter: 'pattern',
        title: 'The rhythm is irregular between beats',
        detail: 'Periodicity is ' + n2(p.periodicity) + ' (a regular waveform scores above ' +
                REFERENCE.periodicity.low + ') and beat-to-beat variation is ' +
                Math.round(p.hrVariabilityMs) + ' ms. The autocorrelation does not find a single ' +
                'strong repeat interval, so successive beats are not the same length.',
        action: 'Rhythm irregularity is a finding for a clinician with an ECG, not for ultrasound alone. ' +
                'Record again while completely still — motion also lowers this score.'
      });
    } else if (key === 'damped') {
      out.push({
        id: 'pattern-damped', severity: 'attention', parameter: 'pattern',
        title: 'The upstroke is slow and the peak is blunted',
        detail: 'Acceleration time is ' + Math.round(p.accelerationTimeS * 1000) + ' ms with a ' +
                'resistive index of ' + n2(p.ri) + '. A waveform that rises slowly and never sharpens ' +
                'is what a pulse looks like after it has passed through a narrowing further upstream.',
        action: 'Worth a clinical assessment of the vessel upstream of the recording site.'
      });
    } else if (key === 'pulsatile') {
      out.push({
        id: 'pattern-pulsatile', severity: 'watch', parameter: 'pattern',
        title: 'The waveform is highly pulsatile',
        detail: 'RI ' + n2(p.ri) + ', PI ' + n2(p.pi) + '. Flow surges strongly in systole and ' +
                'falls close to nothing in diastole. In a resting limb this is common; when it is ' +
                'new for a given person it points to stiffer vessels or higher downstream resistance.',
        action: 'Track it over several sessions — the trend carries more meaning than one reading.'
      });
    } else if (key === 'laminar') {
      out.push({
        id: 'pattern-laminar', severity: 'info', parameter: 'pattern',
        title: 'Flow is laminar and regular',
        detail: 'Periodicity ' + n2(p.periodicity) + ', spectral broadening ' + n2(p.spectralBroadening) +
                '. The blood cells are travelling together at similar speeds and the waveform ' +
                'repeats reliably from beat to beat — the expected picture in a healthy vessel.',
        action: 'No action needed.'
      });
    }
  }

  function analyseSupporting(p, profile, out) {
    if (p.ri > REFERENCE.ri.high) {
      out.push({
        id: 'ri-high', severity: 'watch', parameter: 'support',
        title: 'Resistive index is high',
        detail: 'RI = (PSV − EDV) / PSV = ' + n2(p.ri) + '. The closer RI sits to 1, the more ' +
                'completely flow stops between beats, which means the vessel bed downstream is ' +
                'resisting it.',
        action: 'Repeatedly high RI alongside raised velocity is the combination worth showing a clinician.'
      });
    } else if (p.ri < REFERENCE.ri.low && p.ri > 0) {
      out.push({
        id: 'ri-low', severity: 'watch', parameter: 'support',
        title: 'Resistive index is low',
        detail: 'RI = ' + n2(p.ri) + '. Flow continues strongly through diastole. Downstream of a ' +
                'significant narrowing the waveform is often both damped and low-resistance.',
        action: 'Read this together with the acceleration time above.'
      });
    }

    if (p.pi > REFERENCE.pi.high) {
      out.push({
        id: 'pi-high', severity: 'watch', parameter: 'support',
        title: 'Pulsatility index is high',
        detail: 'PI = (PSV − EDV) / mean velocity = ' + n2(p.pi) + '. PI reflects how elastic the ' +
                'vessel is and how much the flow varies across the cycle; stiffer vessels give ' +
                'higher values.',
        action: 'Follow the trend across sessions rather than reacting to one reading.'
      });
    }

    if (p.heartRateBpm > 0) {
      var hb = band(p.heartRateBpm, REFERENCE.hr);
      if (hb !== 'normal') {
        out.push({
          id: 'hr-' + hb, severity: 'watch', parameter: 'support',
          title: 'Heart rate is ' + (hb === 'high' ? 'above' : 'below') + ' the usual resting range',
          detail: 'Derived from the cardiac-cycle segmentation: ' +
                  Math.round(p.heartRateBpm) + ' bpm across ' + '' +
                  'the recording, against a resting range of ' + REFERENCE.hr.low + '–' +
                  REFERENCE.hr.high + ' bpm.',
          action: 'Rest for five minutes and record again before drawing any conclusion.'
        });
      }
    }
  }

  function analyseQuality(p, imuStatus, out) {
    if (p.signalQuality < REFERENCE.quality.low) {
      out.push({
        id: 'quality-low', severity: 'attention', parameter: 'quality',
        title: 'Signal quality is low — treat these numbers with caution',
        detail: 'Quality scored ' + pct(p.signalQuality) + ', combining how far the Doppler signal ' +
                'stands above the noise floor (' + Math.round(p.snrDb) + ' dB) with how regularly ' +
                'the waveform repeats. Below about ' + pct(REFERENCE.quality.low) + ' the envelope ' +
                'may be tracking noise rather than blood.',
        action: 'Re-record: hold the band at the target angle, stay still, and make sure there is ' +
                'good contact with the skin.'
      });
    }
    if (imuStatus && !imuStatus.inTolerance) {
      out.push({
        id: 'angle-off', severity: 'attention', parameter: 'quality',
        title: 'The recording angle was off target',
        detail: 'The band sat at ' + Math.round(imuStatus.angle) + '° rather than ' +
                imuStatus.target + '°. Velocity depends on cos(θ), so this angle distorts every ' +
                'velocity figure by roughly ' + Math.round(imuStatus.cosineErrorPercent) + '%.',
        action: 'Re-record with the angle guide green. The velocity numbers above are not reliable until you do.'
      });
    }
  }

  /* ======================================================================= *
   *  2. NCD risk model
   * ======================================================================= */
  /*
   * A transparent additive score. Each contribution names itself, so the user
   * can see exactly why a flag was raised — a black-box number would be worse
   * than useless in a screening tool people are meant to trust.
   *
   * Score is 0–100 and is a PRIORITY FOR REVIEW, not a probability of disease.
   */
  function riskModel(p, profile) {
    profile = profile || {};
    var flags = [];
    var score = 0;

    function add(points, reason, domain) {
      score += points;
      flags.push({ points: points, reason: reason, domain: domain });
    }

    /* --- signal-derived contributions ---------------------------------- */
    if (p.psv > REFERENCE.psv.high) add(p.psv > REFERENCE.psv.high * 1.5 ? 18 : 10,
      'Peak systolic velocity above the expected range', 'cardiovascular');
    if (p.psv < REFERENCE.psv.low) add(8,
      'Peak systolic velocity below the expected range', 'cardiovascular');
    if (p.ri > REFERENCE.ri.high) add(10, 'High resistive index', 'cardiovascular');
    if (p.ri < REFERENCE.ri.low && p.ri > 0) add(8, 'Low resistive index with a damped waveform', 'vascular');
    if (p.pi > REFERENCE.pi.high) add(6, 'High pulsatility index', 'vascular');
    if (p.patternKey === 'turbulent') add(16, 'Turbulent flow pattern', 'vascular');
    if (p.patternKey === 'damped') add(14, 'Damped (tardus–parvus) waveform', 'vascular');
    if (p.patternKey === 'irregular') add(12, 'Irregular rhythm', 'cardiac');
    if (p.direction === 0) add(5, 'Flow direction unresolved', 'technical');
    if (p.spectralBroadening > 0.45) add(6, 'Spectral broadening', 'vascular');

    /* --- profile contributions ------------------------------------------- */
    var age = Number(profile.age) || 0;
    if (age >= 65) add(8, 'Age 65 or over', 'demographic');
    else if (age >= 45) add(4, 'Age 45 or over', 'demographic');

    var bmi = bmiOf(profile);
    if (bmi >= 30) add(7, 'BMI in the obese range (' + bmi.toFixed(1) + ')', 'metabolic');
    else if (bmi >= 25) add(3, 'BMI in the overweight range (' + bmi.toFixed(1) + ')', 'metabolic');

    var cond = profile.conditions || [];
    if (cond.indexOf('hypertension') >= 0) add(10, 'Diagnosed hypertension', 'cardiovascular');
    if (cond.indexOf('diabetes') >= 0)     add(10, 'Diagnosed diabetes', 'metabolic');
    if (cond.indexOf('heart_disease') >= 0)add(12, 'Known heart disease', 'cardiac');
    if (cond.indexOf('stroke') >= 0)       add(10, 'Previous stroke or TIA', 'cardiovascular');
    if (cond.indexOf('kidney') >= 0)       add(6,  'Kidney disease', 'renal');
    if (cond.indexOf('high_cholesterol') >= 0) add(6, 'High cholesterol', 'metabolic');

    if (profile.smoking === 'current') add(10, 'Current smoker', 'lifestyle');
    else if (profile.smoking === 'former') add(3, 'Former smoker', 'lifestyle');

    if (profile.activity === 'sedentary') add(6, 'Sedentary activity level', 'lifestyle');
    if (profile.family_history) add(5, 'Family history of cardiovascular or metabolic disease', 'demographic');

    score = Math.max(0, Math.min(100, score));

    var level = score >= 55 ? 'high' : score >= 30 ? 'moderate' : 'low';

    /* Anything genuinely urgent overrides the arithmetic. */
    var urgent = p.patternKey === 'turbulent' && p.psv > REFERENCE.psv.high * 1.5;
    if (urgent) level = 'high';

    return {
      score: Math.round(score),
      level: level,
      flags: flags.sort(function (a, b) { return b.points - a.points; }),
      urgent: urgent,
      reliable: p.signalQuality >= REFERENCE.quality.low
    };
  }

  function bmiOf(profile) {
    var h = Number(profile.height_cm) || 0, w = Number(profile.weight_kg) || 0;
    if (h <= 0 || w <= 0) return 0;
    return w / Math.pow(h / 100, 2);
  }

  /* ======================================================================= *
   *  3. Risk management advice
   * ======================================================================= */
  /*
   * General, non-prescriptive, and explicitly framed as things to raise with a
   * clinician. The platform never suggests starting, stopping or changing any
   * medication.
   */
  function riskManagement(p, profile, risk) {
    var items = [];
    profile = profile || {};

    if (risk.urgent) {
      items.push({
        priority: 'urgent',
        text: 'This recording combines a high peak velocity with a turbulent pattern. That ' +
              'combination should be assessed by a clinician rather than tracked at home. ' +
              'If you also have chest pain, sudden weakness, difficulty speaking, or a cold, ' +
              'pale or painful limb, seek emergency care now.'
      });
    }

    if (!risk.reliable) {
      items.push({
        priority: 'first',
        text: 'Repeat the recording before acting on it. Signal quality was below the reliable ' +
              'threshold, so the parameters may reflect the measurement rather than your circulation.'
      });
    }

    items.push({
      priority: 'routine',
      text: 'Record at the same time of day, at rest, for several days. A single Doppler recording ' +
            'is a snapshot; the trend across sessions is what makes continuous monitoring useful.'
    });

    if (p.psv > REFERENCE.psv.high || (profile.conditions || []).indexOf('hypertension') >= 0) {
      items.push({
        priority: 'routine',
        text: 'Pair each session with a blood-pressure reading. Velocity and pressure are two views ' +
              'of the same circulation, and a clinician can act on the pair far better than on either alone.'
      });
    }

    if ((profile.conditions || []).indexOf('diabetes') >= 0 || p.spectralBroadening > 0.45) {
      items.push({
        priority: 'routine',
        text: 'Note your glucose readings alongside these sessions. Blood viscosity changes with ' +
              'glucose, and viscosity is one of the things that widens the Doppler spectrum.'
      });
    }

    if (profile.smoking === 'current') {
      items.push({
        priority: 'routine',
        text: 'Smoking narrows peripheral vessels within minutes of a cigarette and is the single ' +
              'largest modifiable contributor in this score. Support for stopping is available through your clinician.'
      });
    }
    if (profile.activity === 'sedentary') {
      items.push({
        priority: 'routine',
        text: 'Regular moderate activity improves vessel elasticity, which is what the pulsatility ' +
              'index measures. Build up gradually and check with a clinician first if you have known heart disease.'
      });
    }

    if (risk.level === 'high') {
      items.push({
        priority: 'important',
        text: 'Take this reading, and ideally an export of several sessions, to a clinician. ' +
              'Sonubrace flags patterns worth a professional look; it does not diagnose anything.'
      });
    }

    return items;
  }

  /* ======================================================================= *
   *  4. Full report
   * ======================================================================= */

  function analyse(result, profile, imuStatus) {
    if (!result || !result.params) return null;
    var p = result.params;
    var findings = [];

    analyseQuality(p, imuStatus, findings);
    analyseVelocity(p, profile, findings);
    analyseDirection(p, profile, findings);
    analysePattern(p, profile, findings);
    analyseSupporting(p, profile, findings);

    var risk = riskModel(p, profile);
    var order = { urgent: 0, attention: 1, watch: 2, info: 3 };
    findings.sort(function (a, b) { return order[a.severity] - order[b.severity]; });

    return {
      generatedAt: new Date().toISOString(),
      summary: summarise(result, risk),
      spectrogramExplanation: explainSpectrogram(result),
      findings: findings,
      risk: risk,
      management: riskManagement(p, profile, risk),
      params: p,
      disclaimer: 'Sonubrace is a screening and monitoring aid, not a diagnostic device. ' +
                  'It cannot diagnose any condition and does not replace clinical assessment.'
    };
  }

  /* Two or three sentences a person can read first and act on. */
  function summarise(result, risk) {
    var p = result.params;
    var lead = 'Over ' + result.durationS.toFixed(1) + ' seconds this recording shows ' +
      p.patternName.toLowerCase() + ' flow at ' + n2(p.psv) + ' m/s peak systolic velocity, ' +
      (p.direction > 0 ? 'running forward past the probe' :
       p.direction < 0 ? 'running in reverse past the probe' : 'without a settled direction') +
      ', repeating ' + (p.periodicity > 0.7 ? 'very regularly' :
       p.periodicity > 0.4 ? 'fairly regularly' : 'irregularly') +
      ' at about ' + Math.round(p.heartRateBpm) + ' beats per minute.';

    var verdict = risk.level === 'high'
      ? ' Several features here are worth a clinician looking at, so treat this as a prompt to book an appointment rather than a result to interpret alone.'
      : risk.level === 'moderate'
        ? ' Most of this looks ordinary, with a few features worth keeping an eye on across further sessions.'
        : ' Nothing in this recording stands outside the expected range.';

    var caveat = risk.reliable ? ''
      : ' Signal quality was low, so repeat the recording before reading much into these numbers.';

    return lead + verdict + caveat;
  }

  /* ======================================================================= *
   *  5. Spectrogram explanation
   * ======================================================================= */
  /*
   * The methods document asks the platform to make the spectrogram
   * understandable to a general reader. This walks the picture in the order a
   * person's eye moves: axes first, then the bright line, then the window
   * under it, then the repeat.
   */
  function explainSpectrogram(result) {
    var p = result.params;
    var parts = [];

    parts.push({
      heading: 'What the axes mean',
      text: 'Time runs left to right across ' + result.durationS.toFixed(1) + ' seconds. Height above ' +
            'the dashed centre line is speed: the further from the line, the faster the blood. Above ' +
            'the line means flow toward the probe, below it means away — the in-phase and quadrature ' +
            'channels are what let Sonubrace tell those apart instead of only reporting a magnitude. ' +
            'Brightness is how much signal came back at that speed at that instant.'
    });

    parts.push({
      heading: 'The bright outline',
      text: 'The line tracing the top of the bright region is the envelope: at each moment it is the ' +
            'fastest speed present, found by taking the strongest frequency in that time slice ' +
            '(fD = argmax P(f,t)) and converting it with v = c·fD / (2·f₀·cos θ). Its tallest points ' +
            'are the peak systolic velocity, ' + n2(p.psv) + ' m/s here; the lowest points just before ' +
            'the next beat are the end-diastolic velocity, ' + n2(p.edv) + ' m/s. Those two numbers are ' +
            'where RI (' + n2(p.ri) + ') and PI (' + n2(p.pi) + ') come from.'
    });

    parts.push({
      heading: 'The space underneath',
      text: p.spectralBroadening > 0.45
        ? 'The area under the envelope is filled in rather than dark. That means blood cells are ' +
          'passing at many different speeds at once instead of moving together — measured here as a ' +
          'bandwidth of ' + Math.round(p.bandwidthHz) + ' Hz. Filled-in windows are how disturbed flow ' +
          'announces itself acoustically.'
        : 'The area under the envelope is dark, which is what you want to see. It means almost all the ' +
          'blood cells are moving at close to the same speed, so there is little signal at the slower ' +
          'speeds. Bandwidth here is ' + Math.round(p.bandwidthHz) + ' Hz.'
    });

    parts.push({
      heading: 'The repeating shape',
      text: 'Each rise and fall is one heartbeat, and ' + result.cycles.nCycles + ' were detected. ' +
            'The autocorrelation Rxx(τ) measures how well the trace lines up with a shifted copy of ' +
            'itself; it peaks at ' + n2(p.periodicity) + ' here, so the beats are ' +
            (p.periodicity > 0.7 ? 'very consistent' : p.periodicity > 0.4 ? 'reasonably consistent'
              : 'not consistent') + ' in shape and spacing. Beat-to-beat variation is ' +
            Math.round(p.hrVariabilityMs) + ' ms.'
    });

    parts.push({
      heading: 'What it adds up to',
      text: 'Taken together — the height of the envelope, which side of the line it sits on, and how ' +
            'cleanly it repeats — this is classified as ' + p.patternName.toLowerCase() + ' flow.'
    });

    return parts;
  }

  /* ======================================================================= *
   *  6. Question answering — expert engine
   * ======================================================================= */
  /*
   * Intent matching on keywords. Each answer is built from the live numbers,
   * so it is specific to the recording in front of the user rather than a
   * canned definition.
   */
  var INTENTS = [
    {
      id: 'velocity',
      keys: ['velocity', 'speed', 'fast', 'slow', 'psv', 'edv', 'm/s', 'how fast'],
      answer: function (ctx) {
        var p = ctx.params;
        return {
          title: 'Your blood-flow velocity',
          body: 'Peak systolic velocity — the fastest the blood moves, at the height of each ' +
                'heartbeat — is ' + n2(p.psv) + ' m/s. Between beats it falls to ' + n2(p.edv) +
                ' m/s (end-diastolic velocity), and averaged across the whole recording it is ' +
                n2(p.vMean) + ' m/s. For this recording site the usual resting range for the peak is ' +
                REFERENCE.psv.low + '–' + REFERENCE.psv.high + ' m/s, so yours is ' +
                band(p.psv, REFERENCE.psv) + '. These come from the Doppler shift: the echo returns ' +
                'at a slightly different frequency than it was sent, and that difference is ' +
                'proportional to speed.',
          points: [
            'Faster than expected often reflects higher pressure or a narrower channel.',
            'Slower than expected can reflect low perfusion — but check the probe angle first, ' +
            'because a bad angle under-reads velocity every time.'
          ]
        };
      }
    },
    {
      id: 'direction',
      keys: ['direction', 'backward', 'backwards', 'reverse', 'forward', 'which way', 'retrograde'],
      answer: function (ctx) {
        var p = ctx.params;
        return {
          title: 'Which way your blood is flowing',
          body: 'Flow is ' + p.directionName.toLowerCase() + '. ' + pct(p.forwardFraction) +
                ' of the returned signal sits on the forward side of the baseline and ' +
                pct(p.reverseFraction) + ' on the reverse side. Sonubrace can tell these apart ' +
                'because the echo is split into two channels a quarter-cycle apart (in-phase and ' +
                'quadrature); comparing them recovers the sign of the Doppler shift, not just its size.',
          points: p.reverseFlowPresent
            ? ['A short reversal just after each peak is normal in a limb artery — it is the pulse ' +
               'wave bouncing back from the periphery.']
            : ['Flow stays on one side of the baseline throughout, which is the straightforward case.']
        };
      }
    },
    {
      id: 'pattern',
      keys: ['pattern', 'turbulent', 'laminar', 'shape', 'waveform', 'irregular', 'rhythm', 'periodicity'],
      answer: function (ctx) {
        var p = ctx.params;
        return {
          title: 'Your flow pattern',
          body: 'This recording is classified as ' + p.patternName.toLowerCase() + '. That comes from ' +
                'three measurements taken together: how regularly the waveform repeats ' +
                '(periodicity ' + n2(p.periodicity) + ', from the autocorrelation), how widely the ' +
                'velocities are spread at any instant (bandwidth ' + Math.round(p.bandwidthHz) +
                ' Hz, broadening ' + n2(p.spectralBroadening) + '), and the shape of the waveform ' +
                'itself (morphology score ' + n2(p.morphologyScore) + ', built from PSV, EDV and mean ' +
                'velocity through RI and PI).',
          points: [
            'Laminar: cells move together, the spectrum is a thin line with a dark window beneath it.',
            'Turbulent: the window fills in because cells move at many speeds at once.',
            'Irregular: the beats do not repeat at a steady interval.',
            'Damped: the rise to the peak is slow and rounded rather than sharp.'
          ]
        };
      }
    },
    {
      id: 'ri-pi',
      keys: ['ri', 'pi', 'resistive', 'pulsatility', 'index', 'sd ratio', 's/d'],
      answer: function (ctx) {
        var p = ctx.params;
        return {
          title: 'Resistive and pulsatility index',
          body: 'RI = (PSV − EDV) / PSV = (' + n2(p.psv) + ' − ' + n2(p.edv) + ') / ' + n2(p.psv) +
                ' = ' + n2(p.ri) + '. It asks how much of the flow disappears between beats, so it ' +
                'measures the resistance the blood meets downstream. PI = (PSV − EDV) / mean velocity = ' +
                n2(p.pi) + ', which uses the average rather than the peak and so reflects how elastic ' +
                'the vessel is across the whole cycle. Your S/D ratio is ' + n2(p.sdRatio) + '.',
          points: [
            'RI near 1 means flow almost stops between beats (high downstream resistance).',
            'RI is low when flow continues strongly through diastole.',
            'Both are supporting measures: they are computed from the velocity numbers, not measured separately.'
          ]
        };
      }
    },
    {
      id: 'spectrogram',
      keys: ['spectrogram', 'graph', 'chart', 'picture', 'colour', 'color', 'image', 'read the', 'stft'],
      answer: function (ctx) {
        var parts = explainSpectrogram(ctx.result);
        return {
          title: 'How to read your spectrogram',
          body: parts[0].text + ' ' + parts[1].text,
          points: [parts[2].text, parts[3].text]
        };
      }
    },
    {
      id: 'risk',
      keys: ['risk', 'ncd', 'disease', 'diabetes', 'hypertension', 'dangerous', 'worried', 'serious', 'bad'],
      answer: function (ctx) {
        var r = ctx.report.risk;
        return {
          title: 'What this means for your risk',
          body: 'Your review-priority score is ' + r.score + ' out of 100, which is in the ' + r.level +
                ' band. That is a priority for review, not a probability of disease — it says how ' +
                'much in this recording and your health profile is worth a professional look. ' +
                (r.reliable ? '' : 'Signal quality was low, so treat it as provisional. ') +
                'Sonubrace cannot diagnose anything.',
          points: r.flags.slice(0, 5).map(function (f) {
            return f.reason + ' (+' + f.points + ')';
          })
        };
      }
    },
    {
      id: 'angle',
      keys: ['angle', 'imu', 'position', 'tilt', 'hold', 'still', 'placement', 'wear'],
      answer: function (ctx) {
        return {
          title: 'Angle and how to hold the band',
          body: 'The Doppler equation contains cos θ, so the angle between the beam and the vessel ' +
                'changes every velocity reading. Sonubrace targets ' +
                ((global.SONUBRACE_CONFIG || {}).imu || {}).targetAngleDeg + '° because the cosine ' +
                'changes slowly there — a few degrees of wobble barely moves the answer. At 90° the ' +
                'cosine is zero and the measurement collapses entirely. The IMU illustration on the ' +
                'main page shows your live angle against that target.',
          points: [
            'Keep the guide green before you start recording.',
            'Stay still: movement adds frequencies that are not blood, and lowers the quality score.',
            'Good skin contact matters as much as angle.'
          ]
        };
      }
    },
    {
      id: 'tlc',
      keys: ['truncated', 'long code', 'code', 'coded', 'excitation', 'decoding', 'how does it work',
             'microcontroller', 'accuracy'],
      answer: function () {
        return {
          title: 'Truncated long code, and why Sonubrace uses it',
          body: 'A single short ultrasound pulse is easy to interpret but carries little energy, so ' +
                'its echo is weak. A long pulse carries more energy but smears in time. Coded ' +
                'excitation solves both: transmit a long coded waveform, then compress it on receive ' +
                'by correlating against the same code. Sonubrace generates one long sequence and ' +
                'truncates it into segments, using a different segment for each burst. Because the ' +
                'segments correlate poorly with each other, the receiver can tell which burst an ' +
                'echo belongs to — which is what keeps the Doppler signal continuous while still ' +
                'gaining the signal-to-noise benefit.',
          points: [
            'Transmit: pulse × code × carrier → DAC → transducer.',
            'Receive: ADC → in-phase and quadrature mixers → matched-filter decode → Doppler signal.',
            'Then STFT → spectrogram → envelope → the three parameters.'
          ]
        };
      }
    },
    {
      id: 'quality',
      keys: ['quality', 'reliable', 'trust', 'accurate', 'noise', 'snr', 'retake', 'again'],
      answer: function (ctx) {
        var p = ctx.params;
        return {
          title: 'How much to trust this recording',
          body: 'Signal quality scored ' + pct(p.signalQuality) + ', combining how far the Doppler ' +
                'signal stood above the noise floor (' + Math.round(p.snrDb) + ' dB) with how ' +
                'consistently the waveform repeated. ' +
                (p.signalQuality >= REFERENCE.quality.low
                  ? 'That is above the threshold where the parameters are dependable.'
                  : 'That is below the threshold, so please record again before relying on these numbers.'),
          points: [
            'Angle off target is the most common cause of a poor recording.',
            'Movement is the second: it adds frequencies that are not blood.',
            'Six seconds of still, well-angled recording beats a minute of drifting.'
          ]
        };
      }
    },
    {
      id: 'improve',
      keys: ['improve', 'better', 'advice', 'should i do', 'help', 'lifestyle', 'exercise', 'diet',
             'manage', 'reduce'],
      answer: function (ctx) {
        return {
          title: 'What you can do',
          body: 'Sonubrace tracks patterns; it does not prescribe. These are general points to raise ' +
                'with a clinician, who can weigh them against your full history.',
          points: ctx.report.management.map(function (m) { return m.text; })
        };
      }
    }
  ];

  function answerLocally(question, ctx) {
    var q = String(question || '').toLowerCase();
    var best = null, bestScore = 0;

    for (var i = 0; i < INTENTS.length; i++) {
      var intent = INTENTS[i], score = 0;
      for (var k = 0; k < intent.keys.length; k++) {
        if (q.indexOf(intent.keys[k]) >= 0) score += intent.keys[k].length;
      }
      if (score > bestScore) { bestScore = score; best = intent; }
    }

    if (!best) {
      /* Say what it can answer rather than guessing at what was meant. */
      return {
        title: 'I can answer that from your recording',
        body: 'I did not recognise that question. I can explain your velocity, your flow direction, ' +
              'your flow pattern, the RI and PI indices, how to read the spectrogram, how the ' +
              'truncated long code works, what your risk score means, or how to get a better recording.',
        points: ['Try: "why is my velocity high?", "what does the spectrogram show?", ' +
                 '"what is RI?", "is this dangerous?"'],
        intent: 'fallback'
      };
    }

    var out = best.answer(ctx);
    out.intent = best.id;
    return out;
  }

  /* ======================================================================= *
   *  7. Claude (optional)
   * ======================================================================= */

  var KEY_STORE = 'sonubrace.claude.key';

  function getClaudeKey() {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }
  function setClaudeKey(key) {
    try {
      if (key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
      return true;
    } catch (e) { return false; }
  }
  function claudeAvailable() {
    var c = (global.SONUBRACE_CONFIG || {}).ai || {};
    return !!(c.enableClaude && getClaudeKey());
  }

  /* A compact factual brief. Claude is given the numbers and the expert
     engine's own reading, and told to stay inside them. */
  function contextBrief(ctx) {
    var p = ctx.params, r = ctx.report;
    return [
      'RECORDING',
      '  duration_s: ' + ctx.result.durationS.toFixed(1),
      '  cardiac_cycles: ' + ctx.result.cycles.nCycles,
      '  signal_quality: ' + n2(p.signalQuality) + ' (snr ' + Math.round(p.snrDb) + ' dB)',
      'MAIN PARAMETERS',
      '  velocity: PSV ' + n2(p.psv) + ' m/s, EDV ' + n2(p.edv) + ' m/s, mean ' + n2(p.vMean) + ' m/s',
      '  direction: ' + p.directionName + ' (forward ' + pct(p.forwardFraction) +
        ', reverse ' + pct(p.reverseFraction) + ')',
      '  pattern: ' + p.patternName + ' (periodicity ' + n2(p.periodicity) +
        ', bandwidth ' + Math.round(p.bandwidthHz) + ' Hz, broadening ' + n2(p.spectralBroadening) + ')',
      'SUPPORTING',
      '  RI ' + n2(p.ri) + ', PI ' + n2(p.pi) + ', S/D ' + n2(p.sdRatio) +
        ', HR ' + Math.round(p.heartRateBpm) + ' bpm, HRV ' + Math.round(p.hrVariabilityMs) + ' ms',
      '  acceleration_time_ms: ' + Math.round(p.accelerationTimeS * 1000),
      'HEALTH PROFILE',
      '  ' + JSON.stringify(ctx.profile || {}),
      'EXPERT ENGINE READING',
      '  score: ' + r.risk.score + '/100 (' + r.risk.level + ')',
      '  findings: ' + r.findings.map(function (f) { return f.severity + ': ' + f.title; }).join('; ')
    ].join('\n');
  }

  var SYSTEM_PROMPT =
    'You are the Sonubrace analyst. Sonubrace is a wrist-worn continuous Doppler ultrasound ' +
    'monitor for haemodynamic screening of non-communicable diseases. You are given one ' +
    'recording\'s computed parameters and the user\'s health profile.\n\n' +
    'Rules:\n' +
    '- Answer only from the data provided. If something is not in it, say so.\n' +
    '- Never diagnose. Describe patterns and say what is worth discussing with a clinician.\n' +
    '- Never suggest starting, stopping or changing any medication.\n' +
    '- Write for a general reader with no medical training. Explain a term the first time you use it.\n' +
    '- Be concise: a short paragraph, then bullets only if they earn their place.\n' +
    '- If signal quality is low, say that the numbers may reflect the measurement, not the person.\n' +
    '- If the user describes emergency symptoms (chest pain, sudden weakness, difficulty speaking, ' +
    'a cold or painless pale limb), tell them to seek emergency care immediately.';

  /* Direct browser->API call. Works because Anthropic supports CORS with the
     anthropic-dangerous-direct-browser-access header, but it exposes the key
     to anyone with access to this browser profile — hence the warning in the
     settings UI and in config.js. */
  function askClaude(question, ctx, history) {
    var c = (global.SONUBRACE_CONFIG || {}).ai || {};
    var key = getClaudeKey();
    if (!key) return Promise.reject(new Error('No Claude key is set.'));

    var messages = [];
    (history || []).slice(-6).forEach(function (m) {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
    });
    messages.push({
      role: 'user',
      content: 'Recording data:\n' + contextBrief(ctx) + '\n\nQuestion: ' + question
    });

    return fetch(c.claudeEndpoint || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: c.claudeModel || 'claude-opus-5',
        max_tokens: c.maxTokens || 1024,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            var msg = (body.error && body.error.message) || ('HTTP ' + res.status);
            throw new Error('Claude request failed: ' + msg);
          });
        }
        return res.json();
      })
      .then(function (data) {
        var text = (data.content || []).filter(function (b) { return b.type === 'text'; })
          .map(function (b) { return b.text; }).join('\n').trim();
        return { title: null, body: text, points: [], intent: 'claude', source: 'claude' };
      });
  }

  /* Single entry point the chat UI calls. Falls back to the expert engine if
     Claude is unavailable or errors — the user always gets an answer. */
  function ask(question, ctx, history) {
    var useClaude = claudeAvailable() && ctx && ctx.preferClaude !== false;
    if (!useClaude) return Promise.resolve(answerLocally(question, ctx));

    return askClaude(question, ctx, history).catch(function (err) {
      var local = answerLocally(question, ctx);
      local.notice = 'Claude was unavailable (' + err.message + '), so this answer comes from the built-in analyst.';
      return local;
    });
  }

  global.SonubraceAI = {
    REFERENCE: REFERENCE,
    analyse: analyse,
    riskModel: riskModel,
    riskManagement: riskManagement,
    explainSpectrogram: explainSpectrogram,
    answerLocally: answerLocally,
    ask: ask,
    askClaude: askClaude,
    contextBrief: contextBrief,
    getClaudeKey: getClaudeKey,
    setClaudeKey: setClaudeKey,
    claudeAvailable: claudeAvailable,
    bmiOf: bmiOf,
    band: band,
    SUGGESTIONS: [
      'What does my spectrogram show?',
      'Why is my velocity what it is?',
      'What do RI and PI mean?',
      'Is my flow pattern normal?',
      'What does my risk score mean?',
      'How do I get a better recording?'
    ]
  };
})(window);
