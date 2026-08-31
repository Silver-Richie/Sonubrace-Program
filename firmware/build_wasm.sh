#!/usr/bin/env bash
# Compile the Sonubrace DSP core to WebAssembly.
#
# Requires the Emscripten SDK (https://emscripten.org). Once emcc is on PATH:
#     ./build_wasm.sh
# Output: ../assets/js/sonubrace_dsp.js  (+ .wasm)
#
# The web app uses assets/js/dsp.js by default and only switches to the WASM
# core when window.SONUBRACE_CONFIG.useWasm is true and this file exists, so
# the site keeps working whether or not you have run this script.
set -euo pipefail

command -v emcc >/dev/null || { echo "emcc not found - install the Emscripten SDK first."; exit 1; }

EXPORTED='["_sb_config_default","_sb_generate_truncated_long_code","_sb_code_psl_db","_sb_build_coded_burst","_sb_quadrature_demodulate","_sb_decode_segment","_sb_wall_filter","_sb_fft","_sb_stft","_sb_power_to_db","_sb_bin_to_doppler_hz","_sb_extract_envelope","_sb_doppler_to_velocity","_sb_velocity_to_doppler","_sb_segment_cardiac_cycles","_sb_compute_params","_sb_process_rf","_sb_autocorrelation","_sb_periodicity","_malloc","_free"]'

emcc sonubrace_dsp.c \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=SonubraceDSP \
  -s EXPORTED_FUNCTIONS="$EXPORTED" \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF64","HEAP32","getValue","setValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -o ../assets/js/sonubrace_dsp.js

echo "Built ../assets/js/sonubrace_dsp.js"
echo "Now set useWasm: true in assets/js/config.js"
