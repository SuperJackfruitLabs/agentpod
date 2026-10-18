// libsodium-wrappers 0.7.15 ships no typings and @types/libsodium-wrappers is a
// deprecated empty stub. Declare only what the hub uses.
declare module "libsodium-wrappers" {
  interface Base64Variants {
    readonly URLSAFE_NO_PADDING: number;
  }
  interface Sodium {
    readonly ready: Promise<void>;
    readonly base64_variants: Base64Variants;
    from_base64(input: string, variant?: number): Uint8Array;
    to_base64(input: string | Uint8Array, variant?: number): string;
    to_string(input: Uint8Array): string;
    crypto_scalarmult_base(privateKey: Uint8Array): Uint8Array;
    crypto_box_seal(message: string | Uint8Array, publicKey: Uint8Array): Uint8Array;
    crypto_box_seal_open(
      ciphertext: Uint8Array,
      publicKey: Uint8Array,
      privateKey: Uint8Array,
    ): Uint8Array;
  }
  const sodium: Sodium;
  export default sodium;
}
