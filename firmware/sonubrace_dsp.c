/* ============================================================================
 * sonubrace_dsp.c — implementation of the Sonubrace signal chain.
 * See sonubrace_dsp.h for the mapping onto the methods document.
 * C99 + libm only, so it builds for a microcontroller, for a desktop, and for
 * WebAssembly from the same source.
 * ==========================================================================*/

#include "sonubrace_dsp.h"

#include <math.h>
#include <string.h>
#include <stdlib.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SB_EPS 1e-12

static double sb_clamp(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/* ============================== configuration ============================= */

void sb_config_default(sb_config *cfg)
{
    if (!cfg) return;
    cfg->f0             = 5.0e6;   /* 5 MHz wrist-scale transducer            */
    cfg->fs             = 16.0e3;  /* baseband slow-time rate. Chosen so the
                                    * Doppler band fills the spectrum: at 5 MHz
                                    * and 60 deg, +/-8 kHz spans +/-2.5 m/s. A
                                    * much higher rate leaves most bins holding
                                    * only noise for the argmax to trip over. */
    cfg->c              = 1540.0;  /* soft tissue                             */
    cfg->theta_deg      = 60.0;    /* the classic 60 deg insonation angle     */
    cfg->prf            = 16000.0;
    cfg->code_len       = 32;
    cfg->n_segments     = 16;
    cfg->chip_rate      = 2.0e6;
    cfg->fft_size       = 256;
    cfg->hop            = 64;
    cfg->window         = SB_WIN_HANN;
    cfg->wall_filter_hz = 60.0;
    cfg->dyn_range_db   = 45.0;
}

/* ========================= truncated long code ============================ */
/*
 * A long m-sequence is generated from a 16-bit linear-feedback shift register
 * and then TRUNCATED into n_segments consecutive slices. Each slice modulates
 * one transmit burst. Because the slices come from one long sequence they are
 * mutually low-correlating, so the receiver can tell which burst an echo came
 * from - the property Sonubrace relies on to keep Doppler continuous while
 * still gaining coded-excitation SNR.
 */
int sb_generate_truncated_long_code(int *codes, int code_len, int n_segments,
                                    unsigned seed)
{
    if (!codes || code_len <= 0 || n_segments <= 0) return 0;
    if (code_len > SB_MAX_CODE || n_segments > SB_MAX_SEGMENTS) return 0;

    unsigned lfsr = seed ? (seed & 0xFFFFu) : 0xACE1u;
    const int total = code_len * n_segments;

    for (int i = 0; i < total; ++i) {
        /* x^16 + x^14 + x^13 + x^11 + 1 -> maximal length 65535 */
        unsigned bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1u;
        lfsr = (lfsr >> 1) | (bit << 15);
        codes[i] = (lfsr & 1u) ? 1 : -1;
    }
    return total;
}

double sb_code_psl_db(const int *code, int code_len)
{
    if (!code || code_len <= 1) return 0.0;

    double peak = (double)code_len;   /* zero-lag autocorrelation */
    double side = 0.0;

    for (int lag = 1; lag < code_len; ++lag) {
        double acc = 0.0;
        for (int i = 0; i + lag < code_len; ++i) acc += (double)(code[i] * code[i + lag]);
        double a = fabs(acc);
        if (a > side) side = a;
    }
    if (side < SB_EPS) side = SB_EPS;
    return 20.0 * log10(peak / side);
}

/* ============================ transmit chain ============================== */

int sb_build_coded_burst(const sb_config *cfg, const int *code, int code_len,
                         double *out, int out_cap)
{
    if (!cfg || !code || !out || code_len <= 0) return 0;

    /* Sample the RF burst at 4x the carrier so the modulation is well formed. */
    const double fs_rf = 4.0 * cfg->f0;
    const int spc = (int)floor(fs_rf / cfg->chip_rate + 0.5);  /* samples/chip */
    const int n   = code_len * (spc > 0 ? spc : 1);
    const int len = n < out_cap ? n : out_cap;

    for (int k = 0; k < len; ++k) {
        int chip = k / (spc > 0 ? spc : 1);
        if (chip >= code_len) chip = code_len - 1;
        double t = (double)k / fs_rf;
        /* pulse x code, then x carrier — the two multipliers in the flowchart */
        out[k] = (double)code[chip] * sin(2.0 * M_PI * cfg->f0 * t);
    }
    return len;
}

/* ============================ receive chain =============================== */

void sb_apply_tgc(double *rf, int n, double fs, double c,
                  double alpha_db_cm_mhz, double f0_mhz)
{
    if (!rf || n <= 0) return;
    for (int k = 0; k < n; ++k) {
        double t_s      = (double)k / fs;
        double depth_cm = (c * t_s * 0.5) * 100.0;          /* round trip */
        double gain_db  = alpha_db_cm_mhz * f0_mhz * depth_cm * 2.0;
        if (gain_db > 60.0) gain_db = 60.0;                 /* avoid blow-up */
        rf[k] *= pow(10.0, gain_db / 20.0);
    }
}

/* Simple one-pole low-pass, applied forward then backward for zero phase. */
static void sb_lowpass(double *x, int n, double fs, double cut_hz)
{
    if (n <= 1 || cut_hz <= 0.0) return;
    double dt = 1.0 / fs;
    double rc = 1.0 / (2.0 * M_PI * cut_hz);
    double a  = dt / (rc + dt);

    double y = x[0];
    for (int k = 0; k < n; ++k) { y += a * (x[k] - y); x[k] = y; }
    y = x[n - 1];
    for (int k = n - 1; k >= 0; --k) { y += a * (x[k] - y); x[k] = y; }
}

void sb_quadrature_demodulate(const sb_config *cfg, const double *rf, int n,
                              double *i_out, double *q_out)
{
    if (!cfg || !rf || !i_out || !q_out || n <= 0) return;

    const double fs_rf = 4.0 * cfg->f0;
    for (int k = 0; k < n; ++k) {
        double t = (double)k / fs_rf;
        double ph = 2.0 * M_PI * cfg->f0 * t;
        i_out[k] =  rf[k] * cos(ph);   /* 0     mixer */
        q_out[k] = -rf[k] * sin(ph);   /* pi/2  mixer */
    }
    /* Remove the 2*f0 image, keep the Doppler baseband. */
    double cut = cfg->f0 * 0.25;
    sb_lowpass(i_out, n, fs_rf, cut);
    sb_lowpass(q_out, n, fs_rf, cut);
}

void sb_decode_segment(const double *i_in, const double *q_in, int n,
                       const int *code, int code_len, int samples_per_chip,
                       double *i_dec, double *q_dec)
{
    if (!i_in || !q_in || !code || !i_dec || !q_dec || n <= 0) return;
    if (samples_per_chip < 1) samples_per_chip = 1;

    const int taps = code_len * samples_per_chip;
    const double norm = 1.0 / (double)taps;

    /* Matched filter = correlation with the time-reversed transmitted code. */
    for (int k = 0; k < n; ++k) {
        double ai = 0.0, aq = 0.0;
        for (int j = 0; j < taps; ++j) {
            int idx = k - taps + 1 + j;
            if (idx < 0) continue;
            int chip = code[(taps - 1 - j) / samples_per_chip];
            ai += i_in[idx] * (double)chip;
            aq += q_in[idx] * (double)chip;
        }
        i_dec[k] = ai * norm;
        q_dec[k] = aq * norm;
    }
}

void sb_wall_filter(double *i_sig, double *q_sig, int n, double fs, double cut_hz)
{
    if (!i_sig || !q_sig || n <= 1 || cut_hz <= 0.0) return;

    double dt = 1.0 / fs;
    double rc = 1.0 / (2.0 * M_PI * cut_hz);
    double a  = rc / (rc + dt);

    double pi_prev = i_sig[0], pq_prev = q_sig[0];
    double yi = 0.0, yq = 0.0;
    for (int k = 1; k < n; ++k) {
        double xi = i_sig[k], xq = q_sig[k];
        yi = a * (yi + xi - pi_prev);
        yq = a * (yq + xq - pq_prev);
        pi_prev = xi; pq_prev = xq;
        i_sig[k] = yi; q_sig[k] = yq;
    }
    i_sig[0] = 0.0; q_sig[0] = 0.0;
}

/* ============================== transforms ================================ */

void sb_fft(double *re, double *im, int n, int dir)
{
    if (!re || !im || n < 2) return;

    /* bit reversal */
    for (int i = 1, j = 0; i < n; ++i) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            double tr = re[i]; re[i] = re[j]; re[j] = tr;
            double ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    /* butterflies */
    for (int len = 2; len <= n; len <<= 1) {
        double ang = (dir >= 0 ? -2.0 : 2.0) * M_PI / (double)len;
        double wr = cos(ang), wi = sin(ang);
        for (int i = 0; i < n; i += len) {
            double cr = 1.0, ci = 0.0;
            for (int j = 0; j < len / 2; ++j) {
                int a = i + j, b = i + j + len / 2;
                double xr = re[b] * cr - im[b] * ci;
                double xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr;        im[a] += xi;
                double nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
    if (dir < 0) {
        for (int k = 0; k < n; ++k) { re[k] /= (double)n; im[k] /= (double)n; }
    }
}

static double sb_window_value(int type, int k, int n)
{
    double x = (double)k / (double)(n - 1);
    switch (type) {
        case SB_WIN_HAMMING:  return 0.54 - 0.46 * cos(2.0 * M_PI * x);
        case SB_WIN_BLACKMAN: return 0.42 - 0.5 * cos(2.0 * M_PI * x)
                                          + 0.08 * cos(4.0 * M_PI * x);
        case SB_WIN_HANN:
        default:              return 0.5 - 0.5 * cos(2.0 * M_PI * x);
    }
}

int sb_stft(const sb_config *cfg, const double *i_sig, const double *q_sig,
            int n, double *power, int max_frames)
{
    if (!cfg || !i_sig || !q_sig || !power) return 0;

    const int N   = cfg->fft_size;
    const int hop = cfg->hop > 0 ? cfg->hop : N / 4;
    if (N < 2 || N > SB_MAX_FFT || n < N) return 0;

    static double re[SB_MAX_FFT], im[SB_MAX_FFT], win[SB_MAX_FFT];
    static int win_n = 0, win_type = -1;

    if (win_n != N || win_type != cfg->window) {
        for (int k = 0; k < N; ++k) win[k] = sb_window_value(cfg->window, k, N);
        win_n = N; win_type = cfg->window;
    }

    int frames = 0;
    for (int start = 0; start + N <= n && frames < max_frames; start += hop, ++frames) {
        for (int k = 0; k < N; ++k) {
            re[k] = i_sig[start + k] * win[k];
            im[k] = q_sig[start + k] * win[k];
        }
        sb_fft(re, im, N, +1);

        /* fftshift: write bins ordered from -fs/2 to +fs/2 so that the column
         * index maps monotonically to signed Doppler frequency. */
        double *row = power + (size_t)frames * (size_t)N;
        for (int k = 0; k < N; ++k) {
            int src = (k + N / 2) % N;
            row[k] = re[src] * re[src] + im[src] * im[src];
        }
    }
    return frames;
}

double sb_bin_to_doppler_hz(const sb_config *cfg, int bin)
{
    const int N = cfg->fft_size;
    return ((double)bin - (double)N / 2.0) * (cfg->fs / (double)N);
}

void sb_power_to_db(double *power, int n, double dyn_range_db)
{
    if (!power || n <= 0) return;
    double mx = 0.0;
    for (int k = 0; k < n; ++k) if (power[k] > mx) mx = power[k];
    if (mx < SB_EPS) mx = SB_EPS;

    for (int k = 0; k < n; ++k) {
        double db = 10.0 * log10((power[k] + SB_EPS) / mx);
        power[k] = sb_clamp(db, -dyn_range_db, 0.0);
    }
}

/* =============================== envelope ================================= */

double sb_doppler_to_velocity(const sb_config *cfg, double fd_hz)
{
    double ct = cos(cfg->theta_deg * M_PI / 180.0);
    if (fabs(ct) < 1e-6) return 0.0;               /* 90 deg: no Doppler info */
    return (cfg->c * fd_hz) / (2.0 * cfg->f0 * ct);
}

double sb_velocity_to_doppler(const sb_config *cfg, double v_ms)
{
    double ct = cos(cfg->theta_deg * M_PI / 180.0);
    return (2.0 * cfg->f0 * v_ms * ct) / cfg->c;
}

static int sb_cmp_double(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return (x < y) ? -1 : ((x > y) ? 1 : 0);
}

/* Median of a frame's dB values: a robust estimate of that frame's noise floor.
 * Robustness matters here — the mean would be dragged up by the Doppler peak
 * itself, which is the very thing we want the floor underneath. */
static double sb_frame_noise_floor_db(const double *row, int N)
{
    static double scratch[SB_MAX_FFT];
    memcpy(scratch, row, (size_t)N * sizeof(double));
    qsort(scratch, (size_t)N, sizeof(double), sb_cmp_double);
    return scratch[N / 2];
}

/*
 * The argmax runs only over bins standing clear of the frame's own noise floor.
 * Without that gate a frame carrying little flow signal has its peak picked out
 * of the noise — landing at an arbitrary bin, often near Nyquist, and reporting
 * an absurd velocity. Gating keeps the definition from the methods document
 * intact while making it survive a weak echo.
 *
 * The bandwidth threshold is relative to each frame's own peak, not to the
 * global maximum: BW asks how spread the velocities are AT THAT INSTANT, so
 * measuring it against a loud systolic frame elsewhere in the recording would
 * make every diastolic frame read as zero bandwidth.
 */
void sb_extract_envelope(const sb_config *cfg, const double *power_db,
                         int n_frames, double threshold_db, sb_envelope *env)
{
    if (!cfg || !power_db || !env || n_frames <= 0) return;

    const int N = cfg->fft_size;
    memset(env, 0, sizeof(*env));
    env->n_frames = n_frames < SB_MAX_FRAMES ? n_frames : SB_MAX_FRAMES;
    env->dt = (double)(cfg->hop > 0 ? cfg->hop : N / 4) / cfg->fs;

    for (int t = 0; t < env->n_frames; ++t) {
        const double *row = power_db + (size_t)t * (size_t)N;

        double floor_db = sb_frame_noise_floor_db(row, N);
        double gate     = floor_db + SB_NOISE_MARGIN_DB;

        /* Pass 1 — peak, restricted to bins above the noise gate. */
        int    peak_bin = -1;
        double peak_db  = -1e9;
        for (int k = 0; k < N; ++k) {
            double db = row[k];
            if (db < gate) continue;
            if (db > peak_db) { peak_db = db; peak_bin = k; }
        }

        if (peak_bin < 0) {
            /* Nothing rose above the noise: report no flow rather than
             * inventing a velocity out of the noise. */
            env->fd_peak[t] = 0.0; env->fd_mean[t] = 0.0;
            env->v_peak[t]  = 0.0; env->v_mean[t]  = 0.0;
            env->bw[t]      = 0.0; env->power[t]   = 0.0;
            env->snr[t]     = 0.0;
            continue;
        }

        /* Pass 2 — weighted mean and spectral edges over the signal bins only,
         * thresholded relative to this frame's own peak. */
        double edge_thr = peak_db + threshold_db;
        if (edge_thr < gate) edge_thr = gate;

        double sum_w = 0.0, sum_wf = 0.0;
        int    lo = -1, hi = -1;
        for (int k = 0; k < N; ++k) {
            double db = row[k];
            if (db < gate) continue;
            double lin = pow(10.0, db / 10.0);
            sum_w  += lin;
            sum_wf += lin * sb_bin_to_doppler_hz(cfg, k);
            if (db >= edge_thr) { if (lo < 0) lo = k; hi = k; }
        }

        /* Parabolic interpolation around the peak for sub-bin resolution:
         * this is what makes the argmax envelope smooth rather than stepped. */
        double bin_f = (double)peak_bin;
        if (peak_bin > 0 && peak_bin < N - 1) {
            double y0 = row[peak_bin - 1], y1 = row[peak_bin], y2 = row[peak_bin + 1];
            double den = (y0 - 2.0 * y1 + y2);
            if (fabs(den) > SB_EPS) bin_f += 0.5 * (y0 - y2) / den;
        }

        double fd_peak = (bin_f - (double)N / 2.0) * (cfg->fs / (double)N);
        double fd_mean = (sum_w > SB_EPS) ? (sum_wf / sum_w) : 0.0;

        env->fd_peak[t] = fd_peak;
        env->fd_mean[t] = fd_mean;
        env->v_peak[t]  = sb_doppler_to_velocity(cfg, fd_peak);
        env->v_mean[t]  = sb_doppler_to_velocity(cfg, fd_mean);
        env->bw[t]      = (lo >= 0 && hi >= lo)
                          ? (sb_bin_to_doppler_hz(cfg, hi) - sb_bin_to_doppler_hz(cfg, lo))
                          : 0.0;
        env->power[t]   = sum_w;
        env->snr[t]     = peak_db - floor_db;
    }
}

/* ========================= cardiac segmentation =========================== */

double sb_autocorrelation(const double *x, int n, int lag)
{
    if (!x || n <= 1 || lag < 0 || lag >= n) return 0.0;

    double mean = 0.0;
    for (int k = 0; k < n; ++k) mean += x[k];
    mean /= (double)n;

    double num = 0.0, den = 0.0;
    for (int k = 0; k < n - lag; ++k) num += (x[k] - mean) * (x[k + lag] - mean);
    for (int k = 0; k < n; ++k)       den += (x[k] - mean) * (x[k] - mean);

    return (den > SB_EPS) ? (num / den) : 0.0;
}

double sb_periodicity(const double *x, int n, int min_lag, int max_lag,
                      int *best_lag)
{
    double best = 0.0;
    int    bl   = 0;
    if (min_lag < 1) min_lag = 1;
    if (max_lag > n - 2) max_lag = n - 2;

    for (int lag = min_lag; lag <= max_lag; ++lag) {
        double r = sb_autocorrelation(x, n, lag);
        if (r > best) { best = r; bl = lag; }
    }
    if (best_lag) *best_lag = bl;
    return sb_clamp(best, 0.0, 1.0);
}

/* Centred moving average, used only for landmark detection — never for a
 * reported value, so no measurement is biased by the smoothing. */
static void sb_moving_average(const double *x, int n, int width, double *out)
{
    int half = width / 2;
    for (int k = 0; k < n; ++k) {
        double sum = 0.0;
        int    cnt = 0;
        int    lo = k - half < 0 ? 0 : k - half;
        int    hi = k + half > n - 1 ? n - 1 : k + half;
        for (int j = lo; j <= hi; ++j) { sum += x[j]; ++cnt; }
        out[k] = sum / (double)cnt;
    }
}

/* Physiological cycle-length bounds, in frames. */
static void sb_cycle_lag_bounds(double dt, int n_frames, int *min_lag, int *max_lag)
{
    int lo = (int)floor((60.0 / SB_HR_MAX_BPM) / dt);
    int hi = (int)ceil ((60.0 / SB_HR_MIN_BPM) / dt);
    if (lo < 2) lo = 2;
    if (hi > n_frames - 2) hi = n_frames - 2;
    if (hi <= lo) hi = (lo + 1 < n_frames - 2) ? lo + 1 : n_frames - 2;
    *min_lag = lo; *max_lag = hi;
}

int sb_segment_cardiac_cycles(const sb_envelope *env, sb_cycles *out)
{
    if (!env || !out || env->n_frames < 8) return 0;
    memset(out, 0, sizeof(*out));

    const int n = env->n_frames;

    /* Work on |v| so the detector is insensitive to flow direction. */
    static double mag[SB_MAX_FRAMES];
    static double smooth[SB_MAX_FRAMES];
    double vmax = 0.0;
    for (int k = 0; k < n; ++k) {
        mag[k] = fabs(env->v_peak[k]);
        if (mag[k] > vmax) vmax = mag[k];
    }
    if (vmax < SB_EPS) return 0;

    /* Cycle length from the autocorrelation of the envelope (methods doc:
     * periodicity is what tells us how regularly the waveform repeats),
     * searched only over physiologically possible cycle lengths. */
    int min_lag, max_lag;
    sb_cycle_lag_bounds(env->dt, n, &min_lag, &max_lag);

    int    lag  = 0;
    double per  = sb_periodicity(mag, n, min_lag, max_lag, &lag);
    if (lag < 2) return 0;

    /* Peak picking with refractory period = 60% of the estimated cycle. */
    const double thr  = 0.45 * vmax;
    const int    refr = (int)(0.6 * (double)lag);

    int last_peak = -refr;
    for (int k = 1; k < n - 1 && out->n_cycles < SB_MAX_CYCLES; ++k) {
        if (mag[k] < thr) continue;
        if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
        if (k - last_peak < refr) {
            /* keep the taller of two peaks inside one refractory window */
            if (out->n_cycles > 0 && mag[k] > mag[out->systolic_peak[out->n_cycles - 1]]) {
                out->systolic_peak[out->n_cycles - 1] = k;
                last_peak = k;
            }
            continue;
        }
        out->systolic_peak[out->n_cycles] = k;
        ++out->n_cycles;
        last_peak = k;
    }

    /* Cycle onset = end of diastole, taken as the minimum of the SMOOTHED
     * envelope over the last 45% of the interval before each systolic peak.
     *
     * Two details matter. The search runs on the smoothed trace because on the
     * raw envelope a backward gradient walk stops at the first noise dip,
     * landing almost anywhere on a slow, rounded upstroke — instability that
     * shows up directly as inflated beat-to-beat variability and can
     * misclassify a perfectly regular damped waveform as irregular.
     *
     * And the window is confined to LATE diastole so the early-diastolic
     * reverse notch stays out of it: at the notch the flow crosses zero, so
     * |v| has its global minimum there, and an unconfined search would read
     * end-diastolic velocity as ~0 on every recording and drive RI to 1. */
    int sm_width = (int)(0.04 / env->dt);
    if (sm_width < 3) sm_width = 3;
    if ((sm_width & 1) == 0) ++sm_width;
    sb_moving_average(mag, n, sm_width, smooth);

    for (int k = 0; k < out->n_cycles; ++k) {
        int pk    = out->systolic_peak[k];
        int limit = (k > 0) ? out->systolic_peak[k - 1] : (pk - lag < 0 ? 0 : pk - lag);

        int back = (int)(0.45 * (double)lag);
        int skip = (int)(0.03 * (double)lag);
        if (skip < 1) skip = 1;

        int from = pk - back; if (from < limit) from = limit;
        int to   = pk - skip; if (to < from)    to   = from;

        int    onset  = from;
        double lowest = smooth[from];
        for (int m = from; m <= to; ++m) {
            if (smooth[m] < lowest) { lowest = smooth[m]; onset = m; }
        }
        out->onset[k] = onset;
    }

    if (out->n_cycles < 2) {
        /* Fall back to the autocorrelation estimate. */
        out->heart_rate_bpm = 60.0 / ((double)lag * env->dt);
        out->hr_variability_ms = 0.0;
        return out->n_cycles;
    }

    /* Cycle length from peak to peak. The systolic peak is the sharpest,
     * highest-contrast landmark in the envelope, so it localises far more
     * precisely than the diastolic foot — and this interval is what heart rate
     * and its variability are computed from. */
    double sum = 0.0;
    for (int k = 1; k < out->n_cycles; ++k) {
        out->period_s[k - 1] =
            (double)(out->systolic_peak[k] - out->systolic_peak[k - 1]) * env->dt;
        sum += out->period_s[k - 1];
    }
    double mean_period = sum / (double)(out->n_cycles - 1);

    double var = 0.0;
    for (int k = 0; k + 1 < out->n_cycles; ++k) {
        double d = out->period_s[k] - mean_period;
        var += d * d;
    }
    var /= (double)(out->n_cycles - 1);

    out->heart_rate_bpm    = (mean_period > SB_EPS) ? 60.0 / mean_period : 0.0;
    out->hr_variability_ms = sqrt(var) * 1000.0;
    (void)per;
    return out->n_cycles;
}

/* ============================== parameters ================================ */

const char *sb_pattern_name(int pattern)
{
    switch (pattern) {
        case SB_PATTERN_LAMINAR:   return "Laminar";
        case SB_PATTERN_PULSATILE: return "Pulsatile";
        case SB_PATTERN_TURBULENT: return "Turbulent";
        case SB_PATTERN_IRREGULAR: return "Irregular";
        case SB_PATTERN_DAMPED:    return "Damped";
        default:                   return "Unknown";
    }
}

const char *sb_direction_name(int direction)
{
    if (direction > 0) return "Forward (toward transducer)";
    if (direction < 0) return "Reverse (away from transducer)";
    return "Bidirectional";
}

void sb_compute_params(const sb_config *cfg, const sb_envelope *env,
                       const sb_cycles *cyc, sb_params *out)
{
    if (!cfg || !env || !out || env->n_frames <= 0) return;
    memset(out, 0, sizeof(*out));

    const int n = env->n_frames;

    /* ---- MAIN PARAMETER 1: velocity ------------------------------------- */
    /* PSV = largest |v| at a systolic peak; EDV = |v| just before the next
     * onset (end of diastole). With no segmentation, fall back to global
     * max / min-of-magnitude.                                               */
    double psv = 0.0, edv = 0.0, vsum = 0.0, vabs_max = 0.0;

    for (int k = 0; k < n; ++k) {
        double a = fabs(env->v_peak[k]);
        if (a > vabs_max) vabs_max = a;
        vsum += fabs(env->v_mean[k]);
    }
    out->v_mean    = vsum / (double)n;
    out->v_max_abs = vabs_max;

    if (cyc && cyc->n_cycles >= 2) {
        double psv_sum = 0.0, edv_sum = 0.0;
        int    cnt = 0;
        for (int k = 0; k + 1 < cyc->n_cycles; ++k) {
            int p  = cyc->systolic_peak[k];
            /* End-diastole is the foot of the NEXT upstroke: the last moment of
             * this cycle before the next beat begins. */
            int e  = cyc->onset[k + 1];
            if (e <= p) e = p;
            psv_sum += fabs(env->v_peak[p]);
            edv_sum += fabs(env->v_peak[e]);
            ++cnt;
        }
        psv = cnt ? psv_sum / (double)cnt : vabs_max;
        edv = cnt ? edv_sum / (double)cnt : 0.0;
        out->heart_rate_bpm = cyc->heart_rate_bpm;

        /* Acceleration time: onset -> systolic peak of the first full cycle. */
        out->acceleration_time_s =
            (double)(cyc->systolic_peak[0] - cyc->onset[0]) * env->dt;
    } else {
        psv = vabs_max;
        double vmin = 1e9;
        for (int k = 0; k < n; ++k) { double a = fabs(env->v_peak[k]); if (a < vmin) vmin = a; }
        edv = (vmin < 1e9) ? vmin : 0.0;
    }
    out->psv = psv;
    out->edv = edv;

    /* ---- MAIN PARAMETER 2: flow direction -------------------------------- */
    /* Sign of the Doppler shift, weighted by frame power (methods doc: I/Q
     * demodulation is precisely what lets us keep the sign instead of |x|).  */
    double fwd = 0.0, rev = 0.0;
    for (int k = 0; k < n; ++k) {
        double w = env->power[k];
        if (env->fd_peak[k] > 0.0) fwd += w; else if (env->fd_peak[k] < 0.0) rev += w;
    }
    double tot = fwd + rev;
    out->forward_fraction = (tot > SB_EPS) ? fwd / tot : 0.0;
    out->reverse_fraction = (tot > SB_EPS) ? rev / tot : 0.0;

    if      (out->forward_fraction > 0.85) out->direction = +1;
    else if (out->reverse_fraction > 0.85) out->direction = -1;
    else                                   out->direction =  0;

    /* Diastolic flow reversal: a reverse excursion of at least 10% of PSV. */
    for (int k = 0; k < n; ++k) {
        double v = env->v_peak[k];
        if (out->forward_fraction >= 0.5 && v < -0.10 * psv) { out->reverse_flow_present = 1; break; }
        if (out->forward_fraction <  0.5 && v >  0.10 * psv) { out->reverse_flow_present = 1; break; }
    }

    /* ---- MAIN PARAMETER 3: flow pattern ---------------------------------- */
    static double mag[SB_MAX_FRAMES];
    for (int k = 0; k < n; ++k) mag[k] = fabs(env->v_peak[k]);

    int lag = 0, pmin_lag, pmax_lag;
    sb_cycle_lag_bounds(env->dt, n, &pmin_lag, &pmax_lag);
    out->periodicity = sb_periodicity(mag, n, pmin_lag, pmax_lag, &lag);

    double bw_sum = 0.0, broad_sum = 0.0;
    for (int k = 0; k < n; ++k) {
        bw_sum += env->bw[k];
        double denom = fabs(env->fd_peak[k]);
        broad_sum += (denom > SB_EPS) ? sb_clamp(env->bw[k] / (2.0 * denom), 0.0, 1.0) : 1.0;
    }
    out->bandwidth_hz        = bw_sum / (double)n;
    out->spectral_broadening = broad_sum / (double)n;

    /* Morphology: how consistent successive cycles are. Correlate each cycle
     * against the first one; perfectly repeatable shape scores 1.            */
    double morph = out->periodicity;
    if (cyc && cyc->n_cycles >= 3 && cyc->hr_variability_ms >= 0.0) {
        double mean_period_ms = (cyc->heart_rate_bpm > SB_EPS)
                                ? 60000.0 / cyc->heart_rate_bpm : 0.0;
        if (mean_period_ms > SB_EPS) {
            double cv = cyc->hr_variability_ms / mean_period_ms;
            morph = sb_clamp(out->periodicity * (1.0 - sb_clamp(cv, 0.0, 1.0)), 0.0, 1.0);
        }
    }
    out->morphology_score = morph;

    /* ---- SUPPORTING indices ---------------------------------------------- */
    out->ri = (psv > SB_EPS) ? (psv - edv) / psv : 0.0;
    out->pi = (out->v_mean > SB_EPS) ? (psv - edv) / out->v_mean : 0.0;
    out->sd_ratio = (edv > SB_EPS) ? psv / edv : 0.0;

    /* ---- Pattern classification ------------------------------------------ */
    /* Order matters: irregularity and turbulence are the findings that must
     * not be masked by an otherwise normal-looking waveform.                 */
    if (out->periodicity < SB_T_IRREGULAR_PERIODICITY ||
        (cyc && cyc->hr_variability_ms > SB_T_IRREGULAR_HRV_MS))
        out->pattern = SB_PATTERN_IRREGULAR;
    else if (out->spectral_broadening > SB_T_TURBULENT_BROADENING)
        out->pattern = SB_PATTERN_TURBULENT;
    else if (out->acceleration_time_s > SB_T_DAMPED_ACCEL_S &&
             out->ri < SB_T_DAMPED_RI)
        out->pattern = SB_PATTERN_DAMPED;
    else if (out->pi > SB_T_PULSATILE_PI || out->ri > SB_T_PULSATILE_RI)
        out->pattern = SB_PATTERN_PULSATILE;
    else
        out->pattern = SB_PATTERN_LAMINAR;

    /* ---- Signal quality --------------------------------------------------- */
    /* Per-frame SNR is how far that frame's Doppler peak stood above its own
     * noise floor. The MEDIAN across frames is the honest summary: a mean would
     * be inflated by a handful of loud systolic frames in a recording that was
     * otherwise noise. Frames with no signal contribute zero, so a recording
     * that only caught a few beats is scored down accordingly. */
    static double snrs[SB_MAX_FRAMES];
    for (int k = 0; k < n; ++k) snrs[k] = env->snr[k];
    qsort(snrs, (size_t)n, sizeof(double), sb_cmp_double);
    double med_snr = snrs[n / 2];

    out->signal_quality = sb_clamp(0.55 * sb_clamp(med_snr / 25.0, 0.0, 1.0)
                                 + 0.45 * out->periodicity, 0.0, 1.0);
}

/* ============================ full pipeline =============================== */

int sb_process_rf(const sb_config *cfg, const double *rf, int n,
                  const int *code, int code_len,
                  double *power_scratch, int max_frames,
                  sb_result *out)
{
    if (!cfg || !rf || !out || !power_scratch || n <= 0) return 0;

    double *i_sig = (double *)malloc((size_t)n * sizeof(double));
    double *q_sig = (double *)malloc((size_t)n * sizeof(double));
    double *i_dec = (double *)malloc((size_t)n * sizeof(double));
    double *q_dec = (double *)malloc((size_t)n * sizeof(double));
    if (!i_sig || !q_sig || !i_dec || !q_dec) {
        free(i_sig); free(q_sig); free(i_dec); free(q_dec);
        return 0;
    }

    sb_quadrature_demodulate(cfg, rf, n, i_sig, q_sig);

    if (code && code_len > 0) {
        int spc = (int)floor((4.0 * cfg->f0) / cfg->chip_rate + 0.5);
        sb_decode_segment(i_sig, q_sig, n, code, code_len, spc, i_dec, q_dec);
    } else {
        memcpy(i_dec, i_sig, (size_t)n * sizeof(double));
        memcpy(q_dec, q_sig, (size_t)n * sizeof(double));
    }

    sb_wall_filter(i_dec, q_dec, n, cfg->fs, cfg->wall_filter_hz);

    int frames = sb_stft(cfg, i_dec, q_dec, n, power_scratch, max_frames);
    if (frames > 0) {
        sb_power_to_db(power_scratch, frames * cfg->fft_size, cfg->dyn_range_db);
        /* -12 dB below each frame's own peak: the spectral edge used for BW. */
        sb_extract_envelope(cfg, power_scratch, frames, -12.0, &out->env);
        sb_segment_cardiac_cycles(&out->env, &out->cycles);
        sb_compute_params(cfg, &out->env, &out->cycles, &out->params);
    }

    free(i_sig); free(q_sig); free(i_dec); free(q_dec);
    return frames;
}
