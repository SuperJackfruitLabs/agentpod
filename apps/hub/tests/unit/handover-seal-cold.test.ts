import { expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import vector from "../../../../packages/contract/fixtures/handover-v1.json";
import { sealHandover } from "../../src/services/handover-seal";

// Own file on purpose: bun runs each test file in a fresh module graph, so
// sodium.ready has not resolved from another test. Do NOT await sodium.ready
// before the first sealHandover call here.
test("concurrent seals on a cold process both succeed and open", async () => {
  const [a, b] = await Promise.all([
    sealHandover(vector.public_key, vector.material),
    sealHandover(vector.public_key, vector.material),
  ]);
  await sodium.ready; // only after the code under test has run
  const sk = sodium.from_base64(vector.private_key, sodium.base64_variants.URLSAFE_NO_PADDING);
  const pk = sodium.crypto_scalarmult_base(sk);
  for (const env of [a, b]) {
    const sealed = sodium.from_base64(
      env.slice("stk-handover-v1:".length),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    const plain = sodium.crypto_box_seal_open(sealed, pk, sk);
    expect(JSON.parse(sodium.to_string(plain))).toEqual(vector.material);
  }
  expect(a).not.toBe(b);
});
