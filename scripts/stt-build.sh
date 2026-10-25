#!/bin/sh
# The Consuls server's speech engine: parakeet.cpp's command-line tool (MIT), cross-compiled on
# this Mac for the server (never built there), into target/stt/aarch64-linux-gnu/parakeet-cli. It
# runs Fluid Speech Mini, which scripts/server.sh fetches on the server. Does nothing when that
# build is already there. Needs zig and cmake (brew install zig cmake).
#
# Two things about zig as the compiler:
# - its clang crashes on ggml's ARM kernels when tuning for the Spark's cores (cortex-a725), so
#   the target is a generic Armv8.6 with the features those cores have;
# - it reads -march as a CPU name, so the wrappers drop the -march flags the projects add.
set -eu

REPO=https://github.com/mudler/parakeet.cpp.git
COMMIT=5c9b0fbbd8e611d88e47d7e1ebae9bca9b447e8f
TRIPLE=aarch64-linux-gnu
GLIBC=2.39
CPU=generic+v8_6a+dotprod+fullfp16+i8mm+bf16

cd "$(dirname "$0")/.."
OUT="$PWD/target/stt/$TRIPLE"
SRC="$PWD/target/stt/src/parakeet.cpp"
BIN="$OUT/parakeet-cli"
STAMP="$COMMIT $TRIPLE.$GLIBC $CPU"
if [ -x "$BIN" ] && [ "$(cat "$BIN.stamp" 2>/dev/null)" = "$STAMP" ]; then exit 0; fi

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone -q --filter=blob:none --no-checkout "$REPO" "$SRC"
fi
git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
git -C "$SRC" checkout -q --force "$COMMIT"
git -C "$SRC" submodule update -q --init --depth 1 third_party/ggml

TC="$OUT/toolchain"
mkdir -p "$TC"
for tool in cc c++; do
  cat >"$TC/z$tool" <<EOF
#!/bin/sh
for a; do shift; case "\$a" in -march=*) ;; *) set -- "\$@" "\$a" ;; esac; done
exec zig $tool -target $TRIPLE.$GLIBC -mcpu=$CPU "\$@"
EOF
done
printf '#!/bin/sh\nexec zig ar "$@"\n' >"$TC/zar"
printf '#!/bin/sh\nexec zig ranlib "$@"\n' >"$TC/zranlib"
chmod +x "$TC"/z*
cat >"$TC/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER $TC/zcc)
set(CMAKE_CXX_COMPILER $TC/zc++)
set(CMAKE_AR $TC/zar)
set(CMAKE_RANLIB $TC/zranlib)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
EOF

echo "building parakeet-cli for ${TRIPLE}…"
B="$OUT/build"
cmake -S "$SRC" -B "$B" -DCMAKE_TOOLCHAIN_FILE="$TC/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS=-s -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF -DGGML_METAL=OFF -DGGML_ACCELERATE=OFF \
  -DPARAKEET_BUILD_SERVER=OFF -DPARAKEET_WITH_CED=OFF -DPARAKEET_WITH_VOICEDETECT=OFF >"$OUT/cmake.log" 2>&1 ||
  { tail -20 "$OUT/cmake.log" >&2; exit 1; }
cmake --build "$B" -j 10 --target parakeet-cli >"$OUT/build.log" 2>&1 || { grep -iE "error" "$OUT/build.log" | head -20 >&2; exit 1; }
cp "$B/examples/cli/parakeet-cli" "$BIN"
echo "$STAMP" >"$BIN.stamp"
echo "built $BIN ($(du -h "$BIN" | cut -f1))"
