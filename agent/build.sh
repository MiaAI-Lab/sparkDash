#!/usr/bin/env bash
# Build release binaries in Docker against Debian bullseye (glibc 2.31), so
# they run on Ubuntu 20.04 and later, including DGX OS:
#
#   ./build.sh [aarch64|x86_64|all]      -> dist/sparkdash-agent-<arch>-linux
#
# The other architecture is emulated (qemu binfmt, `docker run --platform`
# must work), which is slow but needs no cross toolchain. The binary links
# only glibc dynamically; NVML is dlopen()ed at runtime, so a static musl
# build is not an option. Override the image with RUST_IMAGE. FEATURES=clipboard
# builds the desktop clipboard sync in as well (-> ...-linux-clipboard).
set -euo pipefail
cd "$(dirname "$0")"

image=${RUST_IMAGE:-rust:1.90-bullseye}
features=${FEATURES:-}
max_glibc=2.31

build() {
  local arch=$1 platform=$2 out="dist/sparkdash-agent-$1-linux${features:+-$features}"
  echo "== $arch ($platform, $image)"
  docker run --rm --platform "$platform" --user "$(id -u):$(id -g)" \
    -v "$PWD":/src -w /src -e CARGO_HOME=/src/target/docker/cargo-home \
    "$image" \
    cargo build --release --locked ${features:+--features "$features"} --target-dir "/src/target/docker/$arch${features:+-$features}"
  mkdir -p dist
  cp "target/docker/$arch${features:+-$features}/release/sparkdash-agent" "$out"
  file "$out"
  local glibc
  glibc=$(docker run --rm --platform "$platform" -v "$PWD/dist":/dist:ro "$image" \
    objdump -T "/$out" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
  echo "newest glibc symbol: $glibc"
  if [ "$(printf '%s\n%s\n' "${glibc#GLIBC_}" "$max_glibc" | sort -V | tail -1)" != "$max_glibc" ]; then
    echo "$out needs $glibc, newer than $max_glibc" >&2
    exit 1
  fi
  ls -l "$out"
}

case "${1:-all}" in
  aarch64) build aarch64 linux/arm64 ;;
  x86_64) build x86_64 linux/amd64 ;;
  all)
    build x86_64 linux/amd64
    build aarch64 linux/arm64
    ;;
  *)
    echo "usage: $0 [aarch64|x86_64|all]" >&2
    exit 2
    ;;
esac
