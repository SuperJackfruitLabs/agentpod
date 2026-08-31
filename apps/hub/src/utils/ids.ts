/**
 * Prefixed ids, one minter.
 *
 * Was a private const in `services/enrollment.ts`, which is why `station-registry`
 * grew a second, incompatible shape (a hyphenated UUID that kaambaan's own id
 * schema rejects — see `fixtures/ecosystem-identity/id_grammar.json`,
 * `agentpod.station`). One exported minter is how that stops happening again.
 */
export const prefixedId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
