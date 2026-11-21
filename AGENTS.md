# Checks

* Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` and `pnpm test` after changing code; CI runs the same four.
* Tests never call a model. The server tests run the real `server.mjs` against a fake API on localhost
  (`test/support/help-me.ts`), and the browser tests open the page from `file://` in demo mode.
* A test must be able to fail when the code is wrong. A test that needs a mock of our own code is a sign the code
  should be split instead.
* A known bug gets a test marked `todo` with its issue number, so the fix only has to remove the marker.
* Fix lint errors rather than silencing them. The legacy `.mjs`/`.js` files only warn until they are typed.
