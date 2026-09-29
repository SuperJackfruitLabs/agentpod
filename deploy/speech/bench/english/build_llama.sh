#!/bin/bash
set -e
cd ~/tts-bench-en
uv venv -q --allow-existing -p 3.12 .venv-zig
VIRTUAL_ENV=.venv-zig uv pip install -q ziglang cmake ninja
ZIG="$PWD/.venv-zig/bin/python -m ziglang"
mkdir -p tools
printf '#!/bin/sh\nexec %s cc "$@"\n' "$ZIG" > tools/zcc
printf '#!/bin/sh\nexec %s c++ "$@"\n' "$ZIG" > tools/zcxx
printf '#!/bin/sh\nexec %s ar "$@"\n' "$ZIG" > tools/zar
printf '#!/bin/sh\nexec %s ranlib "$@"\n' "$ZIG" > tools/zranlib
chmod +x tools/*
export PATH="$PWD/.venv-zig/bin:$PATH"
export CC=$PWD/tools/zcc CXX=$PWD/tools/zcxx
export CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_OPENMP=OFF -DCMAKE_AR=$PWD/tools/zar -DCMAKE_RANLIB=$PWD/tools/zranlib -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_CURL=OFF"
VIRTUAL_ENV=.venv-neutts uv pip install --reinstall --no-cache "llama-cpp-python==0.3.19" 2>&1 | tail -n 40
.venv-neutts/bin/python -c "import llama_cpp; print(llama_cpp.__version__, llama_cpp.llama_print_system_info())"
