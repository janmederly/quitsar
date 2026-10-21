# ts-fsrs

`ts-fsrs.js` is the self-contained ES module from **ts-fsrs 5.4.2**
(`dist/index.mjs`), using FSRS-6. Its source-map comment is omitted.
Upstream: https://github.com/open-spaced-repetition/ts-fsrs/tree/v5.4.2
License: MIT, reproduced in `ts-fsrs.LICENSE`.

Vendored so direct static serving, browser guest offline use, Node.js 22.13,
and Cloudflare builds all use the same pinned implementation without a CDN
or a new build step. Version 6 requires Node.js 24 and a different runtime.

npm tarball: `ts-fsrs-5.4.2.tgz`
Integrity: `sha512-z4qop4pzTcyTzuJ566d9EaX/4bZZzhYfeaPImfVr+xcYT65c5oBgFDijUhCE/D+C78eaolHIhKRZ04/RwF+v2g==`

The app uses the supplied default model parameters, a 90% default desired
retention, Again/Good ratings, and one 10-minute learning/relearning step.
Personal parameter optimization is not implemented.
