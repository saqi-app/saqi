export function rigPoolHealth(write) {
  let pending = false;
  let task;
  return () => {
    pending = true;
    task ??= Promise.resolve().then(async () => {
      try {
        while (pending) {
          pending = false;
          // eslint-disable-next-line no-await-in-loop -- One writer owns the health file; overlapping requests share its latest durable state.
          await write();
        }
      } finally {
        task = undefined;
      }
    });
    return task;
  };
}
