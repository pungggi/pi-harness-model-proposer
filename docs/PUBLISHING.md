# Publishing `pi-harness-model-proposer` to npm

`pi-harness-model-proposer` (repo `pi-harness-model-proposer`) ships **raw
TypeScript source** (pi loads `.ts` extensions at runtime — no build step).
Releases are **CI-driven**: push a `v*.*.*` git tag and GitHub Actions publishes
to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements)
(SLSA).

Manual `npm publish` is blocked by the `prepublishOnly` guard in `package.json`
so every release (after bootstrap) goes through CI (guarantees version sync +
provenance + a clean test run).

```
git tag v0.2.0 && git push origin v0.2.0
        │
        ▼
release.yml  ──►  npm ci → typecheck → test → version-sync check → npm publish --provenance
                                                                      │
                                                                      ▼
                                                            npmjs.com/package/pi-harness-model-proposer
```

---

## 0. Bootstrap status (one-time, DONE @ 0.1.0)

`0.1.0` was published manually on 2026-08-09 under npm account `ngsoftware`
(same account that owns every sibling `pi-*` package; `pungggi` is the **GitHub**
org/user, not the npm account). The publish has **no** provenance badge —
expected for the bootstrap. From `0.2.0` onward, CI owns every publish.

The steps below are kept for the record:

npm Trusted Publishing **cannot create a new package** — it can only be attached
to a package that already exists. So the very first publish (`0.1.0`) is done
**manually from a laptop**, without provenance. From `0.2.0` onward, CI owns
every publish.

Bootstrap steps (run once, recorded here so it is reproducible):

1. **Temporarily drop the `prepublishOnly` block** in `package.json` (it blocks
   non-CI publishes by design).
2. **Manual first publish** — no `--provenance` (provenance needs the Trusted
   Publisher that does not exist yet):
   ```bash
   npm login                       # as the package owner (ngsoftware), interactive OTP OK
   npm publish --access public     # NO --provenance on the bootstrap
   npm view pi-harness-model-proposer version   # expect 0.1.0
   ```
3. **Restore** the `prepublishOnly` guard + the `--provenance` flag is already in
   `release.yml`. Commit.
4. **Attach the Trusted Publisher** on npmjs.com (§2 Option A).

`0.1.0` will have **no** provenance badge — expected for the bootstrap publish.
Every release from `0.2.0` is CI-only with provenance.

---

## 1. Prerequisites (one-time)

1. An **npm account** that will own `pi-harness-model-proposer` (`ngsoftware` —
   same account that owns all sibling `pi-*` packages; `pungggi` is the GitHub user).
2. **2FA enabled** on the account (required for modern publish).
3. Confirm ownership after bootstrap:
   ```bash
   npm view pi-harness-model-proposer version
   npm view pi-harness-model-proposer maintainers
   ```
4. **Repo must be public** for `--provenance`.

---

## 2. Auth for CI (pick ONE)

### Option A — Trusted Publishing / OIDC (preferred, no long-lived token)

No `NPM_TOKEN`. GitHub Actions proves identity via OIDC (`id-token: write` is
already in `release.yml`). Requires **npm ≥ 11.5.1** (the workflow upgrades npm
automatically) and **must not** set an empty `NODE_AUTH_TOKEN`.

1. Sign in at [npmjs.com](https://www.npmjs.com) as the package owner.
2. Open `https://www.npmjs.com/package/pi-harness-model-proposer` →
   **Settings → Trusted Publisher** → Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-harness-model-proposer`
   - **Workflow filename:** `release.yml` (exact name, no path)
   - Environment: leave empty unless you use GitHub Environments
3. On GitHub, make sure there is **no** `NPM_TOKEN` secret (or it is empty):
   ```bash
   gh secret list --repo pungggi/pi-harness-model-proposer
   ```
4. Push a `v*.*.*` tag (see §3). CI publishes with provenance.

Docs: https://docs.npmjs.com/trusted-publishers

### Option B — Classic **Automation** token (fallback)

`EOTP` means the token still requires an authenticator code. CI cannot type OTP.

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**.
2. Choose **Classic token → Automation** (bypasses 2FA on publish; not "Publish",
   not "Read-only").
3. Set the GitHub secret:
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-harness-model-proposer
   ```

---

## 3. Publish a release (each time, post-bootstrap)

Keep `package.json` version and the git tag in sync (`release.yml` enforces it).

```bash
# already bumped package.json to 0.2.0, committed on main:
git tag v0.2.0
git push origin main --follow-tags
gh run watch
```

Or atomically via npm:
```bash
npm version patch -m "release: %s"   # or minor / major
git push origin main --follow-tags
gh run watch
```

---

## 4. Re-run a failed tag release (do not retag)

```bash
gh run list --workflow=release.yml --limit 5
gh run rerun <run-id> --failed
gh run watch <run-id>
npm view pi-harness-model-proposer version
```

Do **not** delete/recreate the tag unless the version never published.

---

## 5. Verify + install

```bash
npm view pi-harness-model-proposer version
pi install npm:pi-harness-model-proposer
# or update:
pi update npm:pi-harness-model-proposer
```

From `0.2.0` onward the npm page shows a **Provenance** badge.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| **`EOTP` / one-time password** | Token is not Automation. Use **Classic → Automation**, or delete `NPM_TOKEN` and use **Trusted Publisher** OIDC. |
| **`E401` / invalid token** | Fix `NPM_TOKEN` secret or OIDC. |
| **`E404` on PUT (first publish)** | Bootstrap not done — see §0. |
| `version drift: tag != package.json` | Align versions, retag only if necessary. |
| Local emergency publish | `CI=1 npm publish --access public --provenance` after `npm login`. Prefer CI. |
