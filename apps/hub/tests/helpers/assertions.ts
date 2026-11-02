/**
 * Custom Test Assertions
 * 
 * Additional assertions for common test patterns.
 */

import { expect } from 'bun:test';

// ============================================================================
// Type Assertions
// ============================================================================

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message ?? `Expected value to be defined, got ${value}`);
  }
}

/**
 * Assert that a value is null
 */
export function assertNull(value: unknown, message?: string): asserts value is null {
  if (value !== null) {
    throw new Error(message ?? `Expected null, got ${typeof value}`);
  }
}

/**
 * Assert that a value is an array
 */
export function assertArray<T>(value: unknown, message?: string): asserts value is T[] {
  if (!Array.isArray(value)) {
    throw new Error(message ?? `Expected array, got ${typeof value}`);
  }
}

// ============================================================================
// Object Assertions
// ============================================================================

/**
 * Assert that an object has all required keys
 */
export function assertHasKeys(obj: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((key) => !(key in obj));
  if (missing.length > 0) {
    throw new Error(`Object is missing required keys: ${missing.join(', ')}`);
  }
}

/**
 * Assert that an object matches a partial shape
 */
export function assertShape<T extends Record<string, unknown>>(
  obj: unknown,
  shape: Partial<T>
): asserts obj is T {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`Expected object, got ${typeof obj}`);
  }

  for (const [key, expectedValue] of Object.entries(shape)) {
    const actualValue = (obj as Record<string, unknown>)[key];
    if (actualValue !== expectedValue) {
      throw new Error(
        `Expected ${key} to be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`
      );
    }
  }
}

// ============================================================================
// Date/Time Assertions
// ============================================================================

/**
 * Assert that a string is a valid ISO date
 */
export function assertISODate(value: unknown, message?: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(message ?? `Expected string, got ${typeof value}`);
  }
  
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(message ?? `Expected valid ISO date, got ${value}`);
  }
}

/**
 * Assert that a date is within a time range
 */
export function assertDateWithin(
  value: string | Date,
  range: { before?: Date; after?: Date }
): void {
  const date = typeof value === 'string' ? new Date(value) : value;
  
  if (range.before && date >= range.before) {
    throw new Error(`Expected date ${date.toISOString()} to be before ${range.before.toISOString()}`);
  }
  
  if (range.after && date <= range.after) {
    throw new Error(`Expected date ${date.toISOString()} to be after ${range.after.toISOString()}`);
  }
}

/**
 * Assert that a date is recent (within the last N seconds)
 */
export function assertRecentDate(value: string | Date, withinSeconds: number = 5): void {
  const date = typeof value === 'string' ? new Date(value) : value;
  const now = new Date();
  const diff = Math.abs(now.getTime() - date.getTime()) / 1000;
  
  if (diff > withinSeconds) {
    throw new Error(
      `Expected date to be within ${withinSeconds}s of now, but was ${diff.toFixed(1)}s ago`
    );
  }
}

// ============================================================================
// Collection Assertions
// ============================================================================

/**
 * Assert that an array has a specific length
 */
export function assertLength<T>(arr: T[], length: number): void {
  if (arr.length !== length) {
    throw new Error(`Expected array length ${length}, got ${arr.length}`);
  }
}

/**
 * Assert that an array is not empty
 */
export function assertNotEmpty<T>(arr: T[]): void {
  if (arr.length === 0) {
    throw new Error('Expected non-empty array');
  }
}

/**
 * Assert that an array contains an item matching a predicate
 */
export function assertContains<T>(arr: T[], predicate: (item: T) => boolean, message?: string): void {
  const found = arr.find(predicate);
  if (!found) {
    throw new Error(message ?? 'Array does not contain matching item');
  }
}

/**
 * Assert that an array is sorted
 */
export function assertSorted<T>(
  arr: T[],
  compareFn: (a: T, b: T) => number,
  order: 'asc' | 'desc' = 'asc'
): void {
  if (arr.length === 0) return;
  // reduce without a seed walks adjacent pairs with both elements typed `T`.
  arr.reduce((prev, cur, i) => {
    const comparison = compareFn(prev, cur);
    const isOrdered = order === 'asc' ? comparison <= 0 : comparison >= 0;
    
    if (!isOrdered) {
      throw new Error(`Array is not sorted in ${order}ending order at index ${i}`);
    }
    return cur;
  });
}

// ============================================================================
// Error Assertions
// ============================================================================

/**
 * Assert that a function throws an error with a specific message
 */
export async function assertThrowsMessage(
  fn: () => unknown | Promise<unknown>,
  messagePattern: string | RegExp
): Promise<void> {
  let threw = false;
  let error: Error | undefined;

  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
  } catch (e) {
    threw = true;
    error = e as Error;
  }

  if (!threw) {
    throw new Error('Expected function to throw');
  }

  const pattern = typeof messagePattern === 'string' 
    ? new RegExp(messagePattern, 'i')
    : messagePattern;

  if (!pattern.test(error!.message)) {
    throw new Error(
      `Expected error message to match ${pattern}, got "${error!.message}"`
    );
  }
}

/**
 * Assert that a function throws a specific error type
 */
export async function assertThrowsType<T extends Error>(
  fn: () => unknown | Promise<unknown>,
  errorType: new (...args: unknown[]) => T
): Promise<void> {
  let threw = false;
  let error: Error | undefined;

  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
  } catch (e) {
    threw = true;
    error = e as Error;
  }

  if (!threw) {
    throw new Error('Expected function to throw');
  }

  if (!(error instanceof errorType)) {
    throw new Error(
      `Expected error type ${errorType.name}, got ${error!.constructor.name}`
    );
  }
}

// ============================================================================
// API Response Assertions
// ============================================================================

/**
 * Assert that a response has pagination info
 */
export function assertPaginated(
  response: { items?: unknown[]; total?: number; page?: number; pageSize?: number }
): void {
  assertDefined(response.items, 'Response should have items array');
  assertArray(response.items, 'items should be an array');
  assertDefined(response.total, 'Response should have total count');
  assertDefined(response.page, 'Response should have page number');
  assertDefined(response.pageSize, 'Response should have pageSize');
}

/**
 * Assert that a response represents a created resource
 */
export function assertCreated(response: { id?: string; createdAt?: string }): void {
  assertDefined(response.id, 'Created resource should have id');
  assertDefined(response.createdAt, 'Created resource should have createdAt');
  assertISODate(response.createdAt);
  assertRecentDate(response.createdAt, 10);
}

/**
 * Assert that a sandbox response is valid
 */
export function assertSandbox(sandbox: Record<string, unknown>): void {
  assertHasKeys(sandbox, ['id', 'name', 'status', 'flavor']);
  expect(typeof sandbox.id).toBe('string');
  expect(typeof sandbox.name).toBe('string');
  const statuses: unknown[] = ['creating', 'running', 'stopped', 'error'];
  expect(statuses).toContain(sandbox.status);
}
