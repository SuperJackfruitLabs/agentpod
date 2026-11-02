/**
 * Read a test response's JSON body as a shape, without a cast.
 *
 * `Response.json()` is `Promise<unknown>`. A cast to `{ error: string }` would
 * satisfy the compiler and count against the lint baseline's
 * `no-unsafe-type-assertion`; a schema satisfies both, and a body that is not
 * an object fails here by name instead of as `undefined` three lines later.
 */
import { z } from "zod";

const JsonObject = z.record(z.string(), z.unknown());

/** The body, which must be a JSON object. */
export async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  return JsonObject.parse(await res.json());
}

/** One field of the body, which must be a JSON object. */
export async function jsonField(res: Response, key: string): Promise<unknown> {
  return (await jsonObject(res))[key];
}

/** The body, which must be a JSON array. */
export async function jsonArray(res: Response): Promise<unknown[]> {
  return z.array(z.unknown()).parse(await res.json());
}
