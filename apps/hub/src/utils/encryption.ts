/**
 * Encryption Utility
 * 
 * Provides AES-256-GCM encryption for sensitive data like API keys and tokens.
 * Uses Web Crypto API for cross-platform compatibility.
 */

import { config } from '../config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('encryption');

// Constants
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for GCM
const TAG_LENGTH = 128; // Authentication tag length in bits

// Cached encryption key
let cachedKey: CryptoKey | null = null;

/**
 * Derive a CryptoKey from the encryption key string
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  if (cachedKey) {
    return cachedKey;
  }

  // Use the first 32 bytes of the key (or pad if shorter)
  let keyMaterial = config.encryption.key;
  if (keyMaterial.length < 32) {
    keyMaterial = keyMaterial.padEnd(32, '0');
  } else if (keyMaterial.length > 32) {
    keyMaterial = keyMaterial.slice(0, 32);
  }

  const encoder = new TextEncoder();
  const keyData = encoder.encode(keyMaterial);

  cachedKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );

  return cachedKey;
}

/**
 * Encrypt a string value
 * Returns a base64-encoded string containing IV + ciphertext + tag
 */
export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) {
    return '';
  }

  try {
    const key = await getEncryptionKey();
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Encrypt
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv,
        tagLength: TAG_LENGTH,
      },
      key,
      data
    );

    // Combine IV + ciphertext into a single buffer
    const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), IV_LENGTH);

    // Encode as base64
    return btoa(String.fromCharCode(...combined));
  } catch (error) {
    log.error('Encryption failed', { error });
    throw new Error('Failed to encrypt data', { cause: error });
  }
}

/**
 * Decrypt a base64-encoded encrypted string
 */
export async function decrypt(encryptedBase64: string): Promise<string> {
  if (!encryptedBase64) {
    return '';
  }

  try {
    const key = await getEncryptionKey();

    // Decode base64
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    // Extract IV and ciphertext
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv,
        tagLength: TAG_LENGTH,
      },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    log.error('Decryption failed', { error });
    throw new Error('Failed to decrypt data', { cause: error });
  }
}

/**
 * Clear the cached encryption key (useful for testing or key rotation)
 */
export function clearKeyCache(): void {
  cachedKey = null;
}

/**
 * Check if the encryption key is properly configured
 */
export function isEncryptionConfigured(): boolean {
  const key = config.encryption.key;
  // Check if it's not the default dev key and has sufficient length
  return key !== 'dev-encryption-key-32-bytes-long!' && key.length >= 32;
}
