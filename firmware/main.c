/* ============================================================================
 * main.c — native self-test / demo for the Sonubrace DSP core.
 *
 * Synthesises a Doppler echo with a known peak systolic velocity, runs it
 * through the whole Phase 0 / Phase 1 chain, and prints the three main
 * parameters plus the supporting indices. Use it to verify that a change to
 * sonubrace_dsp.c still recovers the velocity it was given.
 *
 *   make && ./sonubrace_demo
 * ==========================================================================*/

#include "sonubrace_dsp.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* 6 seconds at the default 16 kHz slow-time rate: long enough for the
 * autocorrelation to see several cardiac cycles, which is what the periodicity
 * and heart-rate estimates depend on. */
#define DEMO_SECONDS   6
#define DEMO_N        (16000 * DEMO_SECONDS)
#define DEMO_FRAMES   2048

static double frand(unsigned *s)
{
    *s = (*s * 1103515245u + 12345u);
    return ((double)((*s >> 16) & 0x7FFF) / 16383.5) - 1.0;
}

/* Triphasic arterial velocity waveform, in m/s, at time t.
 *
 * Note that the upstroke rises FROM edv and the diastolic tail decays
 * asymptotically TO edv. Real arterial flow is continuous across the cycle
 * boundary; a waveform that started each beat at zero, or whose tail decayed
 * past its own declared end-diastolic value, would put a false minimum exactly
 * where EDV is read — making a correct measurement look like a large error. */
static double waveform(double t, double hr_bpm, double psv, double edv)
{
    double period = 60.0 / hr_bpm;
    double ph = fmod(t, period) / period;          /* 0..1 within the cycle */

    if (ph < 0.15) {                                /* systolic upstroke     */
        double u = ph / 0.15;
        return edv + (psv - edv) * sin(0.5 * M_PI * u);
    } else if (ph < 0.32) {                         /* systolic downstroke   */
        double u = (ph - 0.15) / 0.17;
        return psv + (-0.10 * psv - psv) * (1.0 - cos(M_PI * u)) / 2.0;
    } else if (ph < 0.45) {                         /* early-diastolic notch */
        double u = (ph - 0.32) / 0.13;
        return -0.10 * psv + (1.6 * edv + 0.10 * psv) * u;
    }
    double u = (ph - 0.45) / 0.55;                  /* diastolic runoff      */
    return edv * (1.0 + 0.6 * exp(-2.5 * u));
}

int main(void)
{
    sb_config cfg;
    sb_config_default(&cfg);
    cfg.fft_size = 256;
    cfg.hop      = 64;

    const double hr  = 72.0;
    const double psv = 0.85;                        /* ground truth, m/s     */
    const double edv = 0.16;                        /* ground truth, m/s     */

    /* --- Phase 0: truncated long code ---------------------------------- */
    static int codes[SB_MAX_CODE * SB_MAX_SEGMENTS];
    int total = sb_generate_truncated_long_code(codes, cfg.code_len,
                                                cfg.n_segments, 0xACE1u);
    printf("Truncated long code : %d chips = %d segments x %d\n",
           total, cfg.n_segments, cfg.code_len);
    printf("Segment 0 PSL       : %.2f dB\n", sb_code_psl_db(codes, cfg.code_len));

    /* --- Synthesise the demodulated Doppler signal directly -------------
     * (The full RF path is exercised by sb_process_rf; here we build the
     *  baseband I/Q so the ground-truth velocity is unambiguous.)          */
    static double i_sig[DEMO_N], q_sig[DEMO_N];
    unsigned seed = 7u;
    double phase = 0.0;

    for (int k = 0; k < DEMO_N; ++k) {
        double t  = (double)k / cfg.fs;
        double v  = waveform(t, hr, psv, edv);
        double fd = sb_velocity_to_doppler(&cfg, v);

        phase += 2.0 * M_PI * fd / cfg.fs;          /* integrate instantaneous freq */
        double amp = 1.0 + 0.25 * fabs(v) / psv;
        i_sig[k] = amp * cos(phase) + 0.05 * frand(&seed);
        q_sig[k] = amp * sin(phase) + 0.05 * frand(&seed);
    }

    sb_wall_filter(i_sig, q_sig, DEMO_N, cfg.fs, cfg.wall_filter_hz);

    /* --- Phase 1: STFT -> spectrogram -> envelope ----------------------- */
    static double power[(size_t)DEMO_FRAMES * SB_MAX_FFT];
    int frames = sb_stft(&cfg, i_sig, q_sig, DEMO_N, power, DEMO_FRAMES);
    if (frames <= 0) { fprintf(stderr, "STFT failed\n"); return 1; }
    sb_power_to_db(power, frames * cfg.fft_size, cfg.dyn_range_db);

    static sb_envelope env;
    static sb_cycles   cyc;
    static sb_params   par;

    sb_extract_envelope(&cfg, power, frames, -12.0, &env);
    sb_segment_cardiac_cycles(&env, &cyc);
    sb_compute_params(&cfg, &env, &cyc, &par);

    /* --- Report ---------------------------------------------------------- */
    printf("\nFrames              : %d  (dt = %.4f s, span = %.2f s)\n",
           env.n_frames, env.dt, env.n_frames * env.dt);
    printf("Cardiac cycles      : %d\n", cyc.n_cycles);

    puts("\n--- MAIN PARAMETERS -------------------------------------------");
    printf("1. Velocity  PSV    : %.3f m/s   (ground truth %.3f)\n", par.psv, psv);
    printf("             EDV    : %.3f m/s   (ground truth %.3f)\n", par.edv, edv);
    printf("             Vmean  : %.3f m/s\n", par.v_mean);
    printf("2. Direction        : %s  (forward %.0f%%)\n",
           sb_direction_name(par.direction), par.forward_fraction * 100.0);
    printf("3. Pattern          : %s\n", sb_pattern_name(par.pattern));
    printf("   periodicity      : %.3f\n", par.periodicity);
    printf("   bandwidth        : %.1f Hz\n", par.bandwidth_hz);
    printf("   broadening       : %.3f\n", par.spectral_broadening);

    puts("\n--- SUPPORTING INDICES ----------------------------------------");
    printf("RI                  : %.3f\n", par.ri);
    printf("PI                  : %.3f\n", par.pi);
    printf("S/D ratio           : %.2f\n", par.sd_ratio);
    printf("Heart rate          : %.1f bpm  (ground truth %.1f)\n",
           par.heart_rate_bpm, hr);
    printf("Signal quality      : %.0f%%\n", par.signal_quality * 100.0);

    /* --- Pass/fail ------------------------------------------------------- */
    double err = fabs(par.psv - psv) / psv;
    printf("\nPSV recovery error  : %.1f%%  -> %s\n",
           err * 100.0, err < 0.15 ? "PASS" : "FAIL");
    return err < 0.15 ? 0 : 1;
}
