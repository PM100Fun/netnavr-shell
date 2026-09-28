# Contributing

Use Node.js 24+, npm and Git. Run `npm ci` and `npm run verify` before a PR.
Explain the user result, tests, source pair and remaining platform limitations.
Follow [the code of conduct](CODE_OF_CONDUCT.md).

Shell owns interaction and App packaging. Core owns runtime data and the shared
HTTP contract. Do not copy contract definitions into Shell: update the exact Core
Git dependency, regenerate the npm lock, and rerun the real integration test.
Schema changes need compatibility and recovery review in Core.

Keep changes focused and discuss substantial architecture changes first. Do not
commit private planning, credentials, user data, databases, payment code, upstream
reference checkouts or generated builds. Tests must use temporary data and must
not silently exercise a user's authenticated provider. Technical checks do not
replace human experience acceptance. Contributions use Apache-2.0.
