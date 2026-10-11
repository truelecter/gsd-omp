# Fork: `truelecter/gsd-omp`, branch `local`

`local` is an upstream release tag plus our branches. Each branch is based on the tag and kept ready to merge upstream; `local` carries its commits. This file lists everything on `local` that upstream doesn't have, and when each piece can go.

## Base

Upstream tag `v1.0.25`.

## On top of the base

| Commit on `local` | Source | What and why | Drop when |
| --- | --- | --- | --- |
| `feat(extension): track execute-phase runs with OMP's native todo` | branch `feat/execute-phase-todo`, tchivs/gsd-omp#73 | The `/gsd-execute-phase` prompt (`nativeExecutePrompt` in `src/extension.cjs`) asks the agent to `init` OMP's `todo` before the first wave, one item per wave plus the phase gates. Upstream says "Do not invent a separate progress UI", which most runs read as "no `todo`". | Upstream releases #73. |
| `fix(projection): carry the OMP executor dispatch contract in the execute-phase skill` | branch `fix/execute-phase-skill-dispatch`, tchivs/gsd-omp#74 | Moves the executor dispatch contract (native `task` with `isolated: true`) from `nativeExecutePrompt` to `ompExecuteDispatchContract` in `src/projection.cjs`, and gives the projected `gsd-execute-phase` skill an `<omp_dispatch>` block with it. Without it, a run that reaches execute-phase without the command (`/gsd-plan-phase N --auto`, `/gsd-autonomous`, a skill read) stops at GSD Core's isolation gate, which answers `none` for OMP. On `local` the commit also carries the `todo` line from the row above, which moved into that function. | Upstream releases #74. |
| `docs(fork): list what local carries` | this file | Keeps this list next to the commits. | No branch is left; build from the upstream tag again. |

## Check

List the commits `local` adds to the base; the table above must name every one:

```sh
git log --oneline v1.0.25..local
```

## Move to a newer upstream

1. Rebase `local` onto the new tag: `git rebase --onto v<new> v<old> local`. Skip a commit when upstream already has it.
2. Update "Base" and the table in this file in the same rebase (amend the `docs(fork)` commit).
3. Run the check above, then force-push `local`.

To change one of our commits, change its branch (rebased onto the same tag), then replace its commit on `local`.
