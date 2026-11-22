import { SupersededError } from "./jobs.ts";
import type { Jobs } from "./jobs.ts";
import type { Backend } from "./providers.ts";
import { check, dropNulls } from "./schema.ts";
import type { Infer, ObjectSchema } from "./schema.ts";

/**
 * Asks the model for JSON matching `schema`. A newer call in the same `slot` aborts this one, which then rejects with
 * a `SupersededError`.
 */
export type ModelCall = <S extends ObjectSchema>(
  slot: string,
  system: string,
  schema: S,
  input: string,
) => Promise<Reply<S>>;

export type Reply<S extends ObjectSchema> = Infer<S> & { model: string; ms: number | undefined };

export interface ModelOptions {
  /** Shown as the model when neither the backend nor --model names one. */
  name: string;
  backend: Backend;
  /** "" for the backend's own default. */
  model: string;
  effort: string;
  env: NodeJS.ProcessEnv;
  jobs: Jobs;
}

/** The `ModelCall` for one backend: every reply is checked against the schema it was asked for. */
export const createModel =
  ({ name, backend, model: asked, effort, env, jobs }: ModelOptions): ModelCall =>
  async (slot, system, schema, input) => {
    const model = asked || backend.model;
    const ctl = new AbortController();
    const job = { abort: () => ctl.abort() };
    jobs.claim(slot, job);
    try {
      const raw = await backend.run({ system, schema, input, model, effort, env, signal: ctl.signal });
      const data = dropNulls(raw.data);
      check(data, schema);
      return Object.assign({}, data, { model: raw.model || model || name, ms: raw.ms });
    } catch (error) {
      // However the backend reports being stopped, the caller only needs to know it was replaced.
      throw ctl.signal.aborted ? new SupersededError() : error;
    } finally {
      jobs.release(slot, job);
    }
  };
