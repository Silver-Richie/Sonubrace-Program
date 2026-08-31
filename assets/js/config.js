/* ============================================================================
 * config.js — the only file you need to edit to connect Sonubrace to a real
 * backend. Everything else reads from window.SONUBRACE_CONFIG.
 *
 * Leave supabase.url empty and the whole platform still works: accounts and
 * recordings are then kept in this browser only (IndexedDB). Fill it in and
 * the same code paths write to your hosted Postgres database instead.
 * ==========================================================================*/

window.SONUBRACE_CONFIG = {

  /* -------------------------------------------------------------- backend --
   * Create a free project at https://supabase.com, then paste the Project URL
   * and the *anon public* key from Project Settings -> API.
   * The anon key is safe to publish: every table is protected by the
   * row-level-security policies in sql/schema.sql, so a user can only ever
   * read or write their own rows.
   * Run sql/schema.sql once in the Supabase SQL editor before first use.     */
  supabase: {
    url: '',            // e.g. 'https://abcdefghijkl.supabase.co'
    anonKey: ''         // e.g. 'eyJhbGciOi...'
  },

  /* ------------------------------------------------------------ acquisition -
   * Physical constants of the Sonubrace probe. These feed every equation in
   * dsp.js and must match the firmware in firmware/sonubrace_dsp.c.          */
  acquisition: {
    f0:             5.0e6,   // transmit centre frequency          [Hz]
    fs:             16.0e3,  // slow-time (baseband) sample rate    [Hz]
    c:              1540.0,  // speed of sound in soft tissue      [m/s]
    thetaDeg:       60.0,    // Doppler insonation angle           [deg]
    prf:            16000.0, // pulse repetition frequency          [Hz]
    codeLen:        32,      // chips per truncated segment
    nSegments:      16,      // truncated segments per long code
    chipRate:       2.0e6,   // chips per second                    [Hz]
    fftSize:        256,     // STFT window (power of two)
    hop:            64,      // STFT hop
    window:         'hann',  // hann | hamming | blackman
    wallFilterHz:   60.0,    // clutter high-pass cut-off           [Hz]
    dynRangeDb:     45.0,    // spectrogram display dynamic range   [dB]
    envelopeThreshDb: -12.0  // spectral edge for bandwidth, dB below the frame peak
  },

  /* -------------------------------------------------------------- hardware --
   * Nordic UART Service is the default BLE profile. Change these UUIDs to
   * whatever your microcontroller advertises.                                */
  ble: {
    serviceUuid:  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    txCharUuid:   '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // host -> device
    rxCharUuid:   '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // device -> host
    namePrefix:   'Sonubrace'
  },

  /* -------------------------------------------------------------------- IMU -
   * Angle guidance shown during calibration. The target is the insonation
   * angle above; tolerance sets when the guide turns green.                  */
  imu: {
    targetAngleDeg:   60.0,
    toleranceDeg:     8.0,
    stillnessGyroDps: 12.0,   // above this the user is told to hold still
    minHoldSeconds:   6.0
  },

  /* --------------------------------------------------------------------- AI -
   * The built-in expert engine always runs and needs no key. Claude is an
   * optional add-on for free-form questions; the key is stored only in this
   * browser's localStorage and is never committed to the repository.
   * SECURITY NOTE: a browser-side key is visible to anyone using that browser
   * profile. For a public deployment, proxy the call through a server
   * function instead of pasting a key here.                                   */
  ai: {
    enableExpertEngine: true,
    enableClaude:       true,
    claudeModel:        'claude-opus-5',
    claudeEndpoint:     'https://api.anthropic.com/v1/messages',
    maxTokens:          1024
  },

  /* --------------------------------------------------------------- runtime --*/
  useWasm: false,        // true after running firmware/build_wasm.sh
  demoMode: true,        // allow the simulator when no device is connected
  version: '1.0.0'
};
