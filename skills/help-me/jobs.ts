/** Something in flight that a newer request, or the end of the session, can stop. */
export interface Job {
  abort: () => void;
}

export type Jobs = ReturnType<typeof createJobs>;

/** Thrown by a model call that a newer call in the same slot aborted. */
export class SupersededError extends Error {
  constructor() {
    super("superseded");
  }
}

/** The model calls in flight, at most one per slot: claiming a slot aborts the job already in it. */
export function createJobs() {
  const running = new Map<string, Job>();
  return {
    claim(slot: string, job: Job): void {
      running.get(slot)?.abort();
      running.set(slot, job);
    },
    release(slot: string, job: Job): void {
      if (running.get(slot) === job) {
        running.delete(slot);
      }
    },
    abortAll(): void {
      for (const job of running.values()) {
        job.abort();
      }
    },
  };
}
