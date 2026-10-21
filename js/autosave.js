// Keep at most one write in flight and one dirty marker. Read the latest state
// only when writing, so typing does not retain a full snapshot per keystroke.
export function createAutosave(
  write,
  { delay = 750, onPending = () => {}, onError = () => {} } = {}
) {
  let dirty = false;
  let running = null;
  let timer;
  let changedAt = 0;
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => run().catch(onError), Math.max(0, changedAt + delay - Date.now()));
  }
  function run() {
    if (running) return running;
    if (!dirty) return Promise.resolve();
    clearTimeout(timer);
    dirty = false;
    let failed = false;
    running = Promise.resolve()
      .then(write)
      .catch((error) => {
        failed = true;
        dirty = true;
        throw error;
      })
      .finally(() => {
        running = null;
        onPending(dirty);
        if (dirty && !failed) arm();
      });
    return running;
  }
  return {
    schedule() {
      dirty = true;
      changedAt = Date.now();
      onPending(true);
      arm();
    },
    async flush() {
      clearTimeout(timer);
      while (dirty || running) {
        await run();
        clearTimeout(timer);
      }
    }
  };
}
