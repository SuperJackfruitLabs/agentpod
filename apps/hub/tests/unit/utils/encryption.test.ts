/**
 * Unit Tests for Encryption Utility
 * 
 * Tests the AES-256-GCM encryption/decryption functions used for
 * securing sensitive data like API keys and tokens.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { encrypt, decrypt, clearKeyCache, isEncryptionConfigured } from '../../../src/utils/encryption.ts';

describe('Encryption Utility', () => {
  beforeEach(() => {
    // Clear the cached key before each test to ensure isolation
    clearKeyCache();
  });

  afterEach(() => {
    clearKeyCache();
  });

  describe('encrypt', () => {
    test('should return empty string for empty input', async () => {
      const result = await encrypt('');
      expect(result).toBe('');
    });

    test('should encrypt a simple string', async () => {
      const plaintext = 'hello world';
      const encrypted = await encrypt(plaintext);
      
      // Should return a non-empty base64 string
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(plaintext);
      // Base64 characters only
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test('should encrypt API key format strings', async () => {
      const apiKey = 'sk-1234567890abcdef1234567890abcdef';
      const encrypted = await encrypt(apiKey);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(apiKey);
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test('should produce different ciphertexts for same plaintext (due to random IV)', async () => {
      const plaintext = 'test-api-key-12345';
      
      const encrypted1 = await encrypt(plaintext);
      const encrypted2 = await encrypt(plaintext);
      
      // Due to random IV, each encryption should produce different output
      expect(encrypted1).not.toBe(encrypted2);
    });

    test('should handle unicode characters', async () => {
      const plaintext = '密码测试 🔐 パスワード';
      const encrypted = await encrypt(plaintext);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    test('should handle very long strings', async () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = await encrypt(plaintext);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted.length).toBeGreaterThan(plaintext.length); // Due to IV + base64 encoding
    });

    test('should handle special characters', async () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;\':",./<>?`~';
      const encrypted = await encrypt(plaintext);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('decrypt', () => {
    test('should return empty string for empty input', async () => {
      const result = await decrypt('');
      expect(result).toBe('');
    });

    test('should decrypt an encrypted string correctly', async () => {
      const original = 'my-secret-api-key';
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);
      
      expect(decrypted).toBe(original);
    });

    test('should roundtrip encrypt/decrypt for various inputs', async () => {
      const testCases = [
        'simple-text',
        'sk-proj-1234567890abcdef',
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        '{"key": "value", "nested": {"data": 123}}',
        '   spaces and tabs\t\t  ',
        'line1\nline2\nline3',
        '密码 🔐 パスワード',
      ];

      for (const original of testCases) {
        const encrypted = await encrypt(original);
        const decrypted = await decrypt(encrypted);
        expect(decrypted).toBe(original);
      }
    });

    test('should throw error for invalid base64 input', async () => {
      await expect(decrypt('not-valid-base64!!!')).rejects.toThrow();
    });

    test('should throw error for tampered ciphertext', async () => {
      const original = 'test-data';
      const encrypted = await encrypt(original);
      
      // Tamper with the encrypted data (modify a character in the middle)
      const chars = encrypted.split('');
      const midpoint = Math.floor(chars.length / 2);
      chars[midpoint] = chars[midpoint] === 'A' ? 'B' : 'A';
      const tampered = chars.join('');
      
      await expect(decrypt(tampered)).rejects.toThrow();
    });

    test('should throw error for truncated ciphertext', async () => {
      const original = 'test-data-that-is-long-enough';
      const encrypted = await encrypt(original);
      
      // Truncate the encrypted data
      const truncated = encrypted.slice(0, encrypted.length - 10);
      
      await expect(decrypt(truncated)).rejects.toThrow();
    });

    test('a decrypt failure keeps the underlying error as its cause', async () => {
      const error = await decrypt('not-valid-base64!!!').catch((e: unknown) => e);
      if (!(error instanceof Error)) throw new Error('decrypt did not reject with an Error');
      expect(error.message).toBe('Failed to decrypt data');
      expect(error.cause).toBeDefined();
    });
  });

  describe('clearKeyCache', () => {
    test('should clear the cached key without error', () => {
      // This should not throw
      expect(() => clearKeyCache()).not.toThrow();
    });

    test('should allow encryption after clearing cache', async () => {
      // Encrypt once to populate cache
      await encrypt('test');
      
      // Clear the cache
      clearKeyCache();
      
      // Should still work
      const encrypted = await encrypt('another-test');
      expect(encrypted).toBeTruthy();
    });

    test('should maintain consistency after cache clear', async () => {
      const original = 'consistency-test';
      
      // Encrypt
      const encrypted1 = await encrypt(original);
      
      // Clear cache
      clearKeyCache();
      
      // Decrypt should still work (key derived from same source)
      const decrypted = await decrypt(encrypted1);
      expect(decrypted).toBe(original);
    });
  });

  describe('isEncryptionConfigured', () => {
    test('should return a boolean indicating proper configuration', () => {
      // The function checks two conditions:
      // 1. Key is not the default dev key
      // 2. Key has at least 32 characters
      const result = isEncryptionConfigured();
      
      // Should return a boolean
      expect(typeof result).toBe('boolean');
    });

    test('function should be callable without errors', () => {
      // Ensure the function doesn't throw
      expect(() => isEncryptionConfigured()).not.toThrow();
    });

    // Note: The actual return value depends on environment configuration.
    // In test environments with custom .env files, this may return true.
    // Integration tests should verify the specific behavior per environment.
  });

  describe('encryption key handling', () => {
    test('should handle key caching correctly', async () => {
      // First encryption should initialize the key
      const encrypted1 = await encrypt('test1');
      
      // Second encryption should use cached key
      const encrypted2 = await encrypt('test2');
      
      // Both should work correctly
      const decrypted1 = await decrypt(encrypted1);
      const decrypted2 = await decrypt(encrypted2);
      
      expect(decrypted1).toBe('test1');
      expect(decrypted2).toBe('test2');
    });
  });

  describe('security properties', () => {
    test('encrypted output should not contain plaintext', async () => {
      const plaintext = 'sensitive-password-12345';
      const encrypted = await encrypt(plaintext);
      
      // The encrypted output should not contain the plaintext
      expect(encrypted).not.toContain(plaintext);
      expect(encrypted).not.toContain('sensitive');
      expect(encrypted).not.toContain('password');
    });

    test('encrypted output should be significantly different from plaintext', async () => {
      const plaintext = 'test';
      const encrypted = await encrypt(plaintext);
      
      // Convert both to compare as byte arrays
      const plaintextBytes = new TextEncoder().encode(plaintext);
      const encryptedBytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
      
      // Encrypted should be longer (IV + ciphertext + tag)
      expect(encryptedBytes.length).toBeGreaterThan(plaintextBytes.length);
      // At minimum: 12 (IV) + 4 (plaintext) + 16 (tag) = 32 bytes
      expect(encryptedBytes.length).toBeGreaterThanOrEqual(32);
    });

    test('IV should be unique for each encryption', async () => {
      const plaintext = 'test';
      
      // Encrypt multiple times and extract IVs
      const ivs: string[] = [];
      for (let i = 0; i < 10; i++) {
        const encrypted = await encrypt(plaintext);
        const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
        // Extract first 12 bytes (IV)
        const iv = Array.from(bytes.slice(0, 12)).join(',');
        ivs.push(iv);
      }
      
      // All IVs should be unique
      const uniqueIvs = new Set(ivs);
      expect(uniqueIvs.size).toBe(10);
    });
  });

  describe('edge cases', () => {
    test('should handle whitespace-only strings', async () => {
      const testCases = [' ', '  ', '\t', '\n', '\r\n', '   \t\n  '];
      
      for (const original of testCases) {
        const encrypted = await encrypt(original);
        const decrypted = await decrypt(encrypted);
        expect(decrypted).toBe(original);
      }
    });

    test('should handle single character', async () => {
      const original = 'a';
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    test('should handle null bytes in string', async () => {
      const original = 'before\0after';
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    test('should handle emoji sequences', async () => {
      const original = '👨‍👩‍👧‍👦 👋🏽 🏳️‍🌈';
      const encrypted = await encrypt(original);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(original);
    });
  });
});
