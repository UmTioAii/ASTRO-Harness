Closes #

## What changes

<!-- One or two sentences. -->

## TDD evidence

- RED: <!-- command and the short failing output, before the change -->
- GREEN: <!-- command and the passing result -->

<!-- Docs or config only? State here why RED does not apply. -->

## Invariants touched

<!-- I-xx, or "none". -->

## Checklist

- [ ] Issue `#n` exists with testable acceptance criteria
- [ ] Branch `<type>/<n>-<slug>` created from an up-to-date `main`
- [ ] RED committed before GREEN (`test:` before `feat:`/`fix:`)
- [ ] `bun test` and `bun run typecheck` pass
- [ ] No secret in the diff, tests, log, audit or ledger (I-03)
- [ ] Affected docs updated; a new file in `docs/` is in `docs/INDEX.md`
- [ ] Target 200 changed lines, ceiling 400 (justify below)
- [ ] Two fresh-context reviews requested: A security, B correctness (`docs/review-checklist.md`)
- [ ] English artifacts: title, body, comments and commits

<!-- Size exception, if any: -->

## Review

<!-- Filled by the reviewer: Review: APPROVE | Review: REQUEST_CHANGES -->
