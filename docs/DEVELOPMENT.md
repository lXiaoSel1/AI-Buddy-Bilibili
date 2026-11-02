# Development and reproducibility

These independent repositories contain one plugin, its required shared modules, the unchanged runtime contract, real domain/client/shared tests and build/verification helpers. They do not require a sibling plugin or a host checkout. The host is a separately installed runtime dependency (AI Buddy >= 2.0.2); no developer Node installation is required by end users.

Use the exact Node/npm versions in PUBLIC-REPOSITORY.json and .nvmrc. esbuild 0.28.2 is the only declared development dependency and is fixed by package-lock.json. In a fresh checkout with no node_modules, run:

```sh
npm ci
npm test
npm run build
npm run verify:artifacts
npm run repro
```

Run npm ci only in your own independent checkout. The build never runs an install or modifies an existing node_modules. npm run build supplies npm_execpath; direct node invocation may instead set BUDDY_NPM_CLI to an existing absolute npm-cli.js path. There is no private runtime path fallback.

Each build creates a new artifacts/<timestamp>/ directory and ARTIFACTS.json. A second build creates a different directory and must produce byte-identical TGZs for the same source. SOURCE-INPUTS.json inside the archive binds all public source files (including tools, tests, documentation and licenses) using relative paths and SHA-256, with no developer paths. BUILD-INVENTORY.json binds the package members. Reproducibility checks do not rewrite a frozen or published archive. Once a public version is frozen, any byte change requires a new version and new release asset.

PUBLIC-SOURCE.json records the deterministic export inventory, excluding only itself to avoid a recursive digest. TEST-SCOPE.json records retained and excluded tests and any fixture projection. The public snapshot includes both records; .git, node_modules, owned receipts, test outputs and build outputs are excluded. .gitattributes disables checkout normalization so existing LF/CRLF source and license bytes remain exact; changing source bytes changes provenance and package bytes.

npm test uses the owned-test runner: it isolates fixtures, records TAP/log/source hashes, and cleans only verified successful owned temporary roots. Failed or incomplete runs remain with bounded retention. Override AI_BUDDY_TEST_TEMP_BASE with a short absolute path when needed on Windows. It never uses a user's app profile or account to fill missing fixtures.

The original private integration runner still requires both plugin artifacts. The public single-plugin commands select exactly the exported plugin; they do not weaken the private two-plugin evidence API. The exported suite does not run paid models, log into platforms, send comments/messages, or certify real provider semantics. Optional pinned old-package tests remain explicitly skipped unless their required historical archive is supplied.
