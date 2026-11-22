import { BACKENDS } from "./backends.ts";
import type { Backend, BackendName } from "./backends.ts";
import type { Jobs } from "./jobs.ts";
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
  backend: BackendName;
  model: string;
  effort: string;
  env: NodeJS.ProcessEnv;
  jobs: Jobs;
}

/** The `ModelCall` for one backend: every reply is checked against the schema it was asked for. */
export const createModel =
  ({ backend, model, effort, env, jobs }: ModelOptions): ModelCall =>
  async (slot, system, schema, input) => {
    const { run }: Backend = BACKENDS[backend];
    const raw = await run({ slot, system, schema, input, model, effort, env, jobs });
    const data = dropNulls(raw.data);
    check(data, schema);
    return Object.assign({}, data, { model: raw.model || model || backend, ms: raw.ms });
  };
