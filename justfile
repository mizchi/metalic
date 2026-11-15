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

validate: build
  node scripts/validate-metal.mjs
