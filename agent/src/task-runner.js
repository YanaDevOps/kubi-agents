export function coalesceAsyncTask(task) {
  let active = null;
  return (...args) => {
    if (active) return active;
    active = Promise.resolve()
      .then(() => task(...args))
      .finally(() => {
        active = null;
      });
    return active;
  };
}
