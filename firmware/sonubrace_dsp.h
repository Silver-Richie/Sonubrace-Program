/* ============================================================================
 * sonubrace_dsp.h — Sonubrace signal-processing core (C99, no dependencies
 *                   beyond libm).
 *
 * This is the reference implementation of the microcontroller-side flowchart
 * and of the "Overview Methods of Sonubrace" methods document:
 *
 *   Phase 0 (transmit)
 *     crystal clock -> code generator -> pulse x code  -> x carrier -> DAC
 *     -> T/R switch -> transducer
 *
 *   Phase 1 (receive)
 *     transducer -> T/R -> amplifier -> TGC -> band-pass -> ADC
 *     -> quadrature demodulation (0 and pi/2 mixers) -> decoding (matched
 *     filter per truncated-long-code segment) -> Doppler signal
 *     -> STFT -> P(f,t) -> Doppler spectrogram -> envelope
 *     -> cardiac-cycle segmentation -> hemodynamic profile
 *     -> velocity | direction | pattern  (+ PSV, EDV, Vmean, RI, PI)
 *
 * Core Doppler relations implemented here (methods doc, eq. 1-6):
 *     fD      = 2 * f0 * v * cos(theta) / c
 *     v(t)    = c * fD(t) / (2 * f0 * cos(theta))
 *     fD(t)   = argmax_f P(f, t)
 *     Rxx(t)  = sum_t x(t) * x(t + tau)                 (periodicity)
 *     BW      = f_high(t) - f_low(t)                    (spectral bandwidth)
 *     RI      = (PSV - EDV) / PSV
 *     PI      = (PSV - EDV) / Vmean
 *
 * Sign convention: the analytic (I + jQ) signal preserves flow direction.
 *     fD > 0  -> flow toward the transducer   (forward / antegrade)
 *     fD < 0  -> flow away from the transducer (reverse / retrograde)
 *
 * Build (native demo):      make
 * Build (WebAssembly):      ./build_wasm.sh
 * ==========================================================================*/

#ifndef SONUBRACE_DSP_H
#define SONUBRACE_DSP_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- limits -- */
#define SB_MAX_FFT        1024   /* STFT window, must be a power of two       */
#define SB_MAX_FRAMES     4096   /* spectrogram time columns                  */
#define SB_MAX_CODE       256    /* truncated-long-code segment length (chips) */
#define SB_MAX_SEGMENTS    64    /* number of truncated segments (bursts)     */
#define SB_MAX_CYCLES      64    /* detected cardiac cycles                   */

/* --------------------------------------------------------- acquisition ---- */
/* Physical + acquisition configuration. Defaults come from sb_config_default(). */
typedef struct {
    double f0;          /* transmit centre frequency               [Hz]  */
    double fs;          /* ADC / baseband sampling rate            [Hz]  */
    double c;           /* speed of sound in tissue                [m/s] */
    double theta_deg;   /* Doppler (insonation) angle              [deg] */
    double prf;         /* pulse repetition frequency              [Hz]  */

    int    code_len;    /* chips per truncated segment                   */
    int    n_segments;  /* number of truncated segments per long code    */
    double chip_rate;   /* chips per second                        [Hz]  */

    int    fft_size;    /* STFT window length (power of two)             */
    int    hop;         /* STFT hop size in samples                      */
    int    window;      /* SB_WIN_HANN | SB_WIN_HAMMING | SB_WIN_BLACKMAN */

    double wall_filter_hz; /* high-pass cut-off removing vessel-wall clutter [Hz] */
    double dyn_range_db;   /* spectrogram display dynamic range         [dB] */
} sb_config;

enum { SB_WIN_HANN = 0, SB_WIN_HAMMING = 1, SB_WIN_BLACKMAN = 2 };

void sb_config_default(sb_config *cfg);

/* --------------------------------------------------- truncated long code -- */
/* Generates a maximal-length sequence (m-sequence) long code and truncates it
 * into `n_segments` segments of `code_len` chips. Each segment modulates one
 * transmit burst; on receive each segment is matched-filtered separately, which
 * is what lets Sonubrace separate overlapping echoes and keep the Doppler
 * signal continuous (methods doc, "Truncated Long Code", Qin et al. 2012).
 * `codes` must hold n_segments * code_len values; chips are +1 / -1.        */
int  sb_generate_truncated_long_code(int *codes, int code_len, int n_segments,
                                     unsigned seed);

/* Peak-to-sidelobe ratio of a segment's autocorrelation, in dB. Higher is
 * better: it is the margin by which a true echo stands above code self-noise. */
double sb_code_psl_db(const int *code, int code_len);

/* ------------------------------------------------------ transmit chain ---- */
/* Phase 0. Builds one coded, carrier-modulated burst ready for the DAC.
 * Returns the number of samples written into `out` (capacity `out_cap`).    */
int sb_build_coded_burst(const sb_config *cfg, const int *code, int code_len,
                         double *out, int out_cap);

/* ------------------------------------------------------- receive chain ---- */
/* Phase 1a. Time-gain compensation: undoes depth-dependent attenuation.
 * alpha is in dB/(cm*MHz); tissue is typically 0.5.                         */
void sb_apply_tgc(double *rf, int n, double fs, double c, double alpha_db_cm_mhz,
                  double f0_mhz);

/* Phase 1b. Quadrature demodulation. Mixes the RF echo with cos (0) and
 * -sin (pi/2) carriers and low-pass filters, yielding the complex baseband
 * signal I + jQ that carries both Doppler magnitude and sign.               */
void sb_quadrature_demodulate(const sb_config *cfg, const double *rf, int n,
                              double *i_out, double *q_out);

/* Phase 1c. Decoding: matched filter (correlate) the baseband against the
 * transmitted segment code, restoring range resolution and SNR gain.
 * Writes n samples to i_dec/q_dec.                                          */
void sb_decode_segment(const double *i_in, const double *q_in, int n,
                       const int *code, int code_len, int samples_per_chip,
                       double *i_dec, double *q_dec);

/* Phase 1d. Wall filter: high-pass the slow-time complex signal to remove
 * near-DC clutter from vessel walls and probe motion.                       */
void sb_wall_filter(double *i_sig, double *q_sig, int n, double fs, double cut_hz);

/* ----------------------------------------------------------- transforms --- */
/* In-place radix-2 complex FFT. n must be a power of two, dir = +1 forward. */
void sb_fft(double *re, double *im, int n, int dir);

/* Spectrogram. Rows = time frames, columns = fft_size frequency bins ordered
 * from the most negative to the most positive Doppler frequency (fftshift'd),
 * so that column index maps monotonically to signed Doppler shift.
 * `power` must hold n_frames * fft_size doubles. Returns n_frames.          */
int sb_stft(const sb_config *cfg, const double *i_sig, const double *q_sig,
            int n, double *power, int max_frames);

/* Signed Doppler frequency for a given spectrogram column index.            */
double sb_bin_to_doppler_hz(const sb_config *cfg, int bin);

/* Convert power to dB relative to the global maximum, clamped to
 * [-dyn_range_db, 0]. Operates in place over n_frames * fft_size values.    */
void sb_power_to_db(double *power, int n, double dyn_range_db);

/* ------------------------------------------------------------- envelope --- */
/* Per-frame results extracted from the spectrogram. */
typedef struct {
    int    n_frames;
    double dt;                        /* seconds per frame                  */
    double fd_peak[SB_MAX_FRAMES];    /* argmax_f P(f,t)               [Hz]  */
    double fd_mean[SB_MAX_FRAMES];    /* power-weighted mean Doppler   [Hz]  */
    double v_peak [SB_MAX_FRAMES];    /* signed velocity envelope      [m/s] */
    double v_mean [SB_MAX_FRAMES];    /* signed mean velocity          [m/s] */
    double bw     [SB_MAX_FRAMES];    /* spectral bandwidth f_hi-f_lo  [Hz]  */
    double power  [SB_MAX_FRAMES];    /* summed power of the signal bins     */
    double snr    [SB_MAX_FRAMES];    /* frame peak above its noise floor [dB]*/
} sb_envelope;

/* Pattern-classification thresholds. These CLASSIFY the waveform shape and are
 * separate from the reference ranges used to FLAG a value as unusual: a value
 * can be perfectly normal and still be best described as pulsatile. Calibrated
 * against the simulator's known scenarios; re-check against your own cohort
 * before publishing, and report the values you used. */
#define SB_T_IRREGULAR_PERIODICITY  0.35
#define SB_T_IRREGULAR_HRV_MS       120.0
#define SB_T_TURBULENT_BROADENING   0.55   /* laminar ~0.25, turbulent ~0.9   */
#define SB_T_DAMPED_ACCEL_S         0.12
#define SB_T_DAMPED_RI              0.70
#define SB_T_PULSATILE_PI           4.0    /* normal peripheral flow ~2.5-3.0 */
#define SB_T_PULSATILE_RI           0.92

/* Physiological bounds on the cardiac cycle, used to bound the autocorrelation
 * search. Not a convenience: autocorrelation decays monotonically away from
 * lag 0 for any smooth signal, so an unbounded search always returns the
 * smallest lag offered and reports a heart rate in the thousands. */
#define SB_HR_MIN_BPM  35.0
#define SB_HR_MAX_BPM  220.0

/* Margin in dB above a frame's median power that a bin must clear to count as
 * signal rather than noise. */
#define SB_NOISE_MARGIN_DB  12.0

/* Extracts fd_peak / fd_mean / bandwidth per frame and converts to velocity.
 * `threshold_db` (e.g. -20) sets the spectral edge used for the bandwidth. */
void sb_extract_envelope(const sb_config *cfg, const double *power_db,
                         int n_frames, double threshold_db, sb_envelope *env);

/* Doppler frequency -> signed velocity (methods doc eq. 2).                 */
double sb_doppler_to_velocity(const sb_config *cfg, double fd_hz);
/* Velocity -> Doppler frequency (methods doc eq. 1).                        */
double sb_velocity_to_doppler(const sb_config *cfg, double v_ms);

/* ------------------------------------------------- cardiac segmentation --- */
typedef struct {
    int    n_cycles;
    int    onset[SB_MAX_CYCLES];    /* frame index of each cycle onset      */
    int    systolic_peak[SB_MAX_CYCLES];
    double period_s[SB_MAX_CYCLES];
    double heart_rate_bpm;          /* median over detected cycles          */
    double hr_variability_ms;       /* std-dev of cycle length              */
} sb_cycles;

int sb_segment_cardiac_cycles(const sb_envelope *env, sb_cycles *out);

/* -------------------------------------------------- main / support params -- */
/* The three main parameters of the methods document, plus the supporting
 * indices derived from them.                                                */
typedef struct {
    /* --- MAIN PARAMETER 1: velocity --- */
    double psv;             /* peak systolic velocity            [m/s] */
    double edv;             /* end-diastolic velocity            [m/s] */
    double v_mean;          /* time-averaged mean velocity       [m/s] */
    double v_max_abs;       /* largest |v| observed              [m/s] */

    /* --- MAIN PARAMETER 2: flow direction --- */
    int    direction;       /* +1 forward, -1 reverse, 0 bidirectional  */
    double forward_fraction;/* fraction of frame power with fD > 0      */
    double reverse_fraction;/* fraction of frame power with fD < 0      */
    int    reverse_flow_present; /* diastolic flow reversal detected     */

    /* --- MAIN PARAMETER 3: flow pattern --- */
    double periodicity;     /* normalised autocorrelation peak, 0..1    */
    double bandwidth_hz;    /* mean spectral bandwidth            [Hz]  */
    double spectral_broadening; /* BW / |peak fD|, 0..1 (turbulence)    */
    double morphology_score;/* waveform-shape regularity, 0..1          */
    int    pattern;         /* see sb_pattern enum                      */

    /* --- SUPPORTING indices --- */
    double ri;              /* resistive index  (PSV-EDV)/PSV           */
    double pi;              /* pulsatility index (PSV-EDV)/Vmean        */
    double sd_ratio;        /* systolic/diastolic ratio  PSV/EDV        */
    double acceleration_time_s;
    double heart_rate_bpm;
    double signal_quality;  /* 0..1, drives the "retake" prompt         */
} sb_params;

typedef enum {
    SB_PATTERN_UNKNOWN      = 0,
    SB_PATTERN_LAMINAR      = 1,  /* narrow spectrum, high periodicity      */
    SB_PATTERN_PULSATILE    = 2,  /* strong systolic peak, low diastole     */
    SB_PATTERN_TURBULENT    = 3,  /* broad spectrum, spectral filling       */
    SB_PATTERN_IRREGULAR    = 4,  /* low periodicity / arrhythmic           */
    SB_PATTERN_DAMPED       = 5   /* blunted, tardus-parvus                 */
} sb_pattern;

const char *sb_pattern_name(int pattern);
const char *sb_direction_name(int direction);

void sb_compute_params(const sb_config *cfg, const sb_envelope *env,
                       const sb_cycles *cyc, sb_params *out);

/* Normalised autocorrelation of a signal at lag tau, methods doc eq. 4.     */
double sb_autocorrelation(const double *x, int n, int lag);
/* Best lag in [min_lag, max_lag] and its normalised peak value.             */
double sb_periodicity(const double *x, int n, int min_lag, int max_lag,
                      int *best_lag);

/* ---------------------------------------------------------- convenience --- */
/* Full pipeline from a raw RF echo buffer to parameters. Intended for the
 * host/WASM build; the microcontroller runs the stages incrementally.       */
typedef struct {
    sb_envelope env;
    sb_cycles   cycles;
    sb_params   params;
} sb_result;

int sb_process_rf(const sb_config *cfg, const double *rf, int n,
                  const int *code, int code_len,
                  double *power_scratch, int max_frames,
                  sb_result *out);

#ifdef __cplusplus
}
#endif
#endif /* SONUBRACE_DSP_H */
