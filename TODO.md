# TODO — pi-harness-model-proposer

Follow-ups surfaced by pi-continual-harness 0.12.0/0.13.0 (2026-10-01, PRs
pungggi/pi-continual-harness#16 and #17 — the pi 0.87/0.99 API adoption).
No breakage today: this package consumes only unchanged exports
(`registerProposer`, `ProposeInput`, `CompleteResult`, `DeltaProposer`); both
releases were additive-only.

## 1. Peer-dep alignment (do together, one release)

- [ ] Bump `@earendil-works/pi-coding-agent` peer + dev to **`>=0.99.0`**.
      pi-continual-harness now requires `>=0.99.0` itself; installed together,
      a stale `>=0.74.0` range here can resolve an incompatible set.
- [ ] Bump `pi-continual-harness` peer + dev to **`>=0.12.0`** (first release
      with the ≥0.99 requirement and the new seams below).
- [ ] Release as 0.3.0 via the usual tag-driven CI (PR → merge → `v0.3.0`).

## 2. Adopt the `classify` seam (optional, natural fit)

pi-continual-harness 0.12.0 injects an optional **`classify`** closure into
`ProposeInput` when `classifier.model` is configured in harness.json
(`"classifier": { "model": "typesafe/jev-latest" }` or a local llama.cpp
classifier; pi ≥ 0.99 `modelRegistry.classify()`). It answers batched yes/no
questions cheaply — cheaper than a full `complete` call.

- [ ] Cheap pre-filter before the dedicated-model completion: ask ONE bool
      question ("does this trajectory contain a durable correction worth
      deltas?") and skip the model call entirely when the answer is no —
      saves hidden model spend on routine windows.
- [ ] Or a classifier-validated mode: run the completion as today, then have
      the classifier confirm each proposed delta is grounded before returning.
- [ ] Contract: `classify` is `undefined` when no classifier is configured —
      degrade to today's behavior; never require it. Report a `modelCall`
      entry for classifier usage so spend stays audited.
- [ ] Reference impl to copy: the gate in `pi-continual-harness`
      `src/auto-refine.ts` (`buildGateRequest` / `gateDecision` in
      `src/classify.ts`, exported from the package entry).

## 3. Housekeeping (nice-to-have)

- [ ] Re-check `parseDeltas` robustness against the new audit fields
      (`modelCall.usage`, boundary-delivered auto-refine entries
      `harness.auto-refine-request`) — should be transparent, but worth a
      test fixture.
- [ ] Consider documenting the interaction with
      `"autoRefine": { "gate": true }` in this package's README once 2 lands.
