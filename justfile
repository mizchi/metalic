default:
  @just --list

build:
  pnpm build

test: build
  pnpm check
  pnpm test

parse file: build
  pnpm parse {{quote(file)}}

module file: build
  pnpm parse --module {{quote(file)}}

bench: build
  pnpm bench

bench-diagnostics: build
  pnpm bench:diagnostics

bench-buffers: build
  pnpm bench:buffers

bench-scheduling: build
  pnpm bench:scheduling

bench-cooperation: build
  pnpm bench:cooperation

bench-workloads: build
  pnpm bench:workloads

bench-adaptive: build
  pnpm bench:adaptive

bench-fit *args: build
  pnpm bench:fit {{args}}

validate: build
  node scripts/validate-metal.mjs
  node scripts/validate-workloads.mjs
  MTL_DEBUG_LAYER=1 MTL_SHADER_VALIDATION=1 node scripts/validate-adaptive.mjs
