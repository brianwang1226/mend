# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. Every file is changed or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the path of the patch file, relative to the working directory, or
`-` (or absent) to read the patch from standard input. The working directory
is the root of the tree; every path in a patch is relative to it.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits name old lines that are found in the file at the first of three matching
tiers: exact, ignoring trailing whitespace, ignoring leading and trailing
whitespace. A patch that changes nothing prints only `ok: 0 files`.

Built for the make.fun "Build mend" bounty. Node 22 and its standard library
alone; there is no install step. `SPEC.md` in the kit is the whole contract.
