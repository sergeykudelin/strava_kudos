# AGENTS.md

## Cursor Cloud specific instructions

This is a Node.js CLI application (ES modules, Node 22) that automates giving kudos on Strava. There is no backend server, database, or long-running process — it is a one-shot script.

### Running the app

- `node main.js --help` — show CLI help
- `node main.js --dry-run --verbose` — preview actions without sending kudos (requires valid config)
- `node main.js` — run for real (sends kudos)

See `README.md` for full CLI options and configuration details.

### Configuration

A `config.json`, `config.yaml`, or `config.yml` must exist in the project root with a valid `stravaSessionCookie` and `athleteId`. Copy from `config.json.example` or `config.yaml.example`. Without a real Strava session cookie, the app will fail with an HTTP 301 (redirect to login).

### Testing caveats

- There is **no test suite** (no unit tests, no integration tests). The only way to validate the app is to run it.
- End-to-end testing requires a valid Strava session cookie (`_strava4_session` from browser dev tools) and a real athlete ID. Without these, the app will error at the Strava API call stage, which is expected.
- The app has no lint configuration (no ESLint, no Prettier config).
- The app has no build step — it runs directly via `node main.js`.

### No lint/test/build

- No `lint`, `test`, or `build` scripts are defined in `package.json`. Only `start` (`node main.js`) exists.
- No `.eslintrc`, `tsconfig.json`, or similar tooling config files are present.
