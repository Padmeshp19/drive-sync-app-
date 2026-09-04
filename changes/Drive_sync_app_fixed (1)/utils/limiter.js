// Bounded-concurrency task runner with no external dependency.
// Usage: const limit = createLimiter(8); await limit(() => doAsyncThing());
// Every call sharing the same `limit` instance competes for the same pool,
// so folder walks / size calculations that used to run one request at a
// time (a single file waiting on the previous file's full round trip)
// instead keep N requests in flight at once.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();

    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          active -= 1;
          resolve(value);
          runNext();
        },
        (err) => {
          active -= 1;
          reject(err);
          runNext();
        }
      );
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

module.exports = { createLimiter };
