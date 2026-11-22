// Fails the test run if any promise rejects without a handler. The production
// code is expected to swallow cancellations internally; a stray rejection would
// indicate a request chain that was not properly gated.

const unhandled = [];

process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

// Root hook plugin format consumed by Mocha via --require.
exports.mochaHooks = {
  afterAll() {
    if (unhandled.length > 0) {
      const snapshot = unhandled.splice(0, unhandled.length);
      throw new Error(
        `Unhandled promise rejection(s) detected: ${snapshot
          .map((r) => (r && r.message ? r.message : String(r)))
          .join(' | ')}`
      );
    }
  },
};
