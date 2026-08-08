# TDD Workflow Guide

This guide provides a detailed walkthrough of Test-Driven Development (TDD) practices for the AgentPod project.

## The TDD Cycle

### 1. Red Phase - Write a Failing Test

Start by writing a test that describes what you want the code to do. The test should fail because the code doesn't exist yet.

```typescript
// apps/api/tests/unit/services/sandbox-manager.test.ts
import { describe, it, expect } from 'bun:test';

describe("SandboxManager", () => {
  describe("createSandbox", () => {
    it("should create a sandbox with the given name", async () => {
      const manager = new SandboxManager(mockDocker);
      
      const sandbox = await manager.createSandbox({
        name: "my-project",
        flavor: "js",
      });

      expect(sandbox.name).toBe("my-project");
      expect(sandbox.flavor).toBe("js");
      expect(sandbox.status).toBe("creating");
    });
  });
});
```

Run the test to see it fail:

```bash
bun test tests/unit/services/sandbox-manager.test.ts
```

### 2. Green Phase - Write Minimum Code

Write the simplest code that makes the test pass. Don't worry about optimization or elegance yet.

```typescript
// apps/api/src/services/sandbox-manager.ts
export class SandboxManager {
  async createSandbox(config: { name: string; flavor: string }) {
    return {
      name: config.name,
      flavor: config.flavor,
      status: "creating",
    };
  }
}
```

Run the test again to see it pass:

```bash
bun test tests/unit/services/sandbox-manager.test.ts
# ✓ should create a sandbox with the given name
```

### 3. Refactor Phase - Improve the Code

Now improve the code while keeping the tests green. Add types, extract functions, improve naming, etc.

```typescript
// apps/api/src/services/sandbox-manager.ts
import type { Sandbox, SandboxConfig } from '@agentpod/types';

export class SandboxManager {
  private docker: Docker;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  async createSandbox(config: SandboxConfig): Promise<Sandbox> {
    const id = generateId();
    
    return {
      id,
      name: config.name,
      flavor: config.flavor,
      status: "creating",
      createdAt: new Date().toISOString(),
    };
  }
}
```

Run all tests to ensure nothing broke:

```bash
bun test
```

## TDD Best Practices

### Write One Test at a Time

Don't write multiple failing tests. Write one test, make it pass, then write the next.

```typescript
// ✅ Good - One focused test
it("should throw when name is empty", () => {
  expect(() => manager.createSandbox({ name: "" })).toThrow();
});

// Then later add:
it("should throw when name contains special characters", () => {
  expect(() => manager.createSandbox({ name: "my@project" })).toThrow();
});
```

### Test Behavior, Not Implementation

Test what the code does, not how it does it.

```typescript
// ✅ Good - Tests behavior
it("should return sandbox info when container starts successfully", async () => {
  const result = await manager.startSandbox("sandbox-123");
  expect(result.status).toBe("running");
});

// ❌ Bad - Tests implementation details
it("should call docker.startContainer with correct params", async () => {
  await manager.startSandbox("sandbox-123");
  expect(docker.startContainer).toHaveBeenCalledWith("sandbox-123");
});
```

### Use Descriptive Test Names

Test names should describe the expected behavior clearly.

```typescript
// ✅ Good - Clear description
it("should return 404 when sandbox does not exist", () => {});
it("should retry connection up to 3 times before failing", () => {});

// ❌ Bad - Vague or implementation-focused
it("should work correctly", () => {});
it("should call retry function", () => {});
```

### Keep Tests Independent

Each test should be able to run in isolation.

```typescript
// ✅ Good - Independent tests
describe("SandboxManager", () => {
  let manager: SandboxManager;
  
  beforeEach(() => {
    manager = new SandboxManager(createMockDocker());
  });

  it("test 1", () => { /* uses fresh manager */ });
  it("test 2", () => { /* uses fresh manager */ });
});

// ❌ Bad - Tests depend on each other
let sandboxId: string;

it("should create sandbox", () => {
  sandboxId = manager.createSandbox({ name: "test" }).id;
});

it("should delete sandbox", () => {
  manager.deleteSandbox(sandboxId); // Depends on previous test!
});
```

## TDD for Different Test Types

### Unit Tests

For pure functions and isolated classes:

```typescript
// 1. Write test
describe("validateSandboxName", () => {
  it("should return true for valid names", () => {
    expect(validateSandboxName("my-project")).toBe(true);
  });

  it("should return false for names with spaces", () => {
    expect(validateSandboxName("my project")).toBe(false);
  });
});

// 2. Implement
function validateSandboxName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}
```

### Integration Tests

For API routes and database operations:

```typescript
// 1. Write test
describe("POST /api/sandboxes", () => {
  it("should create sandbox and return 201", async () => {
    const response = await app.post("/api/sandboxes", {
      name: "test-sandbox",
    });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe("test-sandbox");
  });
});

// 2. Implement route
app.post("/sandboxes", async (c) => {
  const body = await c.req.json();
  const sandbox = await sandboxManager.createSandbox(body);
  return c.json(sandbox, 201);
});
```

### E2E Tests

For complete user workflows:

```typescript
// 1. Write test
test("user can create and manage a sandbox", async ({ page }) => {
  await page.goto("/");
  await page.click('[data-testid="new-sandbox"]');
  await page.fill('[data-testid="sandbox-name"]', "e2e-test");
  await page.click('[data-testid="create"]');
  
  await expect(page.locator('[data-testid="sandbox-card"]'))
    .toContainText("e2e-test");
});

// 2. Implement UI
```

## Common TDD Patterns

### Triangulation

Add multiple test cases to force generalization:

```typescript
it("should add 1 + 1", () => {
  expect(add(1, 1)).toBe(2);
});

it("should add 2 + 3", () => {
  expect(add(2, 3)).toBe(5);  // Forces real implementation
});

it("should handle negative numbers", () => {
  expect(add(-1, 1)).toBe(0);  // Adds another dimension
});
```

### Obvious Implementation

When the solution is obvious, implement it directly:

```typescript
it("should return sandbox status", () => {
  const sandbox = { status: "running" };
  expect(getSandboxStatus(sandbox)).toBe("running");
});

// Implementation is obvious
function getSandboxStatus(sandbox: Sandbox): string {
  return sandbox.status;
}
```

### Fake It Till You Make It

Start with hardcoded values, then generalize:

```typescript
// First pass - fake it
function add(a: number, b: number): number {
  return 2; // Makes first test pass
}

// Second pass - make it real
function add(a: number, b: number): number {
  return a + b; // Generalize after second test
}
```

## TDD Workflow Checklist

Before starting a feature:

- [ ] Identify the first behavior to implement
- [ ] Create test file in appropriate directory
- [ ] Write failing test
- [ ] Run test to confirm it fails for the right reason

During implementation:

- [ ] Write minimum code to pass test
- [ ] Run test to confirm it passes
- [ ] Refactor if needed
- [ ] Run all related tests to ensure nothing broke

After implementation:

- [ ] Review test names for clarity
- [ ] Check for edge cases that need tests
- [ ] Run full test suite
- [ ] Check coverage meets requirements

## Resources

- [Test-Driven Development by Example](https://www.amazon.com/Test-Driven-Development-Kent-Beck/dp/0321146530) - Kent Beck
- [Growing Object-Oriented Software, Guided by Tests](http://www.growing-object-oriented-software.com/) - Freeman & Pryce
- [The Art of Unit Testing](https://www.manning.com/books/the-art-of-unit-testing) - Roy Osherove
