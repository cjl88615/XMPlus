# Browser queue regression tests

From the repository root, run:

```sh
node web/tests/queue-behavior.cjs web/public/app.js
```

The 29 offline behavior cases execute the actual browser script in a Node VM with DOM, audio, and network fixtures. They cover album pagination, cross-page playback, queue isolation, stale responses, failure handling, and saved state. They do not validate real media decoding, account entitlements, upstream availability, or long-duration playback.
