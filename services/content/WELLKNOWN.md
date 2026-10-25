# /.well-known — passkey + universal-link association files

Served as **Workers Static Assets** on `pnyx.pxkq.uk` (free, no Worker invocation;
see `wrangler.jsonc` `assets`). This is the domain the app's passkey RP ID and
`associatedDomains` bind to (`app/src/services/passkey-recovery.ts`,
`app/app.config.js`), so the files MUST live here.

## Android is filled in; iOS still has one placeholder

✅ **Deployed and verified live 2026-10-25** (Worker version `f5e1badd`): Google's verifier returns
**2 statements, zero errors**, where the placeholder had it rejecting every statement. Re-check with
the command at the bottom of this file after any edit here.

✅ **`assetlinks.json` carries the real fingerprints (2026-10-25).** Both were read back from the
artifacts themselves with `apksigner verify --print-certs`, not copied from a note:

| package | key | fingerprint |
|---|---|---|
| `uk.pxkq.pnyx` (release **and preview**: preview deliberately shares prod's app id, and therefore its storage) | `<keystore-dir>/pnyx-release.p12`, `CN=Pnyx` | `89:28:62:99:…:05:3D:BE` |
| `uk.pxkq.pnyx.dev` | the RN template's `debug.keystore`, `CN=Android Debug` | `FA:C6:17:45:…:03:3B:9C` |

⚠️ **The `.dev` entry delegates `get_login_creds` to a publicly known key.** The template debug
keystore ships with React Native, password `android`, identical on every machine — so any sideloaded
app that names itself `uk.pxkq.pnyx.dev` and signs with it is also authorized to ask for passkeys
scoped to this RP. That is the price of associating a debug-signed variant at all. Drop the second
statement if the dev variant does not need the passkey rail.

⚠️ **`uk.pxkq.pnyx.devclient` is deliberately absent.** Add it only if the dev client ever needs
passkeys or links; it is signed by the same debug key as `.dev`.

- `apple-app-site-association` → still carries **`APPLE_TEAM_ID`**, and there is nothing to fill it
  with: the 10-char Team ID comes from an Apple Developer membership (Apple Developer → Membership;
  it's public) and there is no account yet. iOS passkeys and universal links stay off until there is.

Read a fingerprint back with `cd app/android && ./gradlew :app:signingReport`, or straight off an
artifact with `apksigner verify --print-certs <apk>`. See
[`docs/ANDROID_SIGNING.md`](../../docs/ANDROID_SIGNING.md).

`services/content/src/wellknown.test.ts` guards this file: it fails if a placeholder comes back, if a
fingerprint is not 32 colon-separated uppercase bytes, or if the release package stops delegating
`get_login_creds`. The Apple file is only shape-checked, because its placeholder is expected.

After editing, `bunx wrangler deploy` from `services/content/` (a redeploy — these
change ~never). No code change needed. **The file is only live once that deploy runs**; verify with

```sh
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list\
?source.web.site=https://pnyx.pxkq.uk\
&relation=delegate_permission/common.get_login_creds" | head -c 400
```

which names the exact reason it rejected a statement (it reported
`malformed cert fingerprint: ANDROID_SHA256_FINGERPRINT` for the whole week the placeholder was up).
