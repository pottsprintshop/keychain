// Main-thread side of the STEP export: runs step-worker.js and hands back a Blob.
// Loaded lazily, so the ~6 MB CAD engine is only fetched when someone downloads a STEP.

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./step-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, progress, ok, buffer, error, report } = e.data;
    const job = pending.get(id);
    if (!job) return;
    if (progress) return job.onProgress(progress);
    pending.delete(id);
    if (ok) job.resolve({ blob: new Blob([buffer], { type: 'model/step' }), report });
    else job.reject(new Error(error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The CAD engine failed to start.');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

export function buildStep(model, colors, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, model, colors });
  });
}
