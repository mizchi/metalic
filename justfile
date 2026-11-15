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

validate: build
  node scripts/validate-metal.mjs
  node scripts/validate-workloads.mjs
