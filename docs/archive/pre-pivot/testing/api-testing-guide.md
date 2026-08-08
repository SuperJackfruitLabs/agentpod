# API Testing Guide

This guide covers testing patterns and best practices for the Management API (`apps/api/`).

## Overview

The API is built with:
- **Runtime**: Bun
- **Framework**: Hono
- **Database**: SQLite (bun:sqlite)
- **Auth**: Better Auth + API Key

## Test Categories

### Unit Tests

Test individual functions, classes, and modules in isolation.

**Location**: `apps/api/tests/unit/`

```
tests/unit/
├── utils/           # Pure functions, helpers
├── models/          # Database model tests
├── services/        # Service class tests
└── middleware/      # Middleware tests
```

### Integration Tests

Test complete request/response cycles through the API.

**Location**: `apps/api/tests/integration/`

```
tests/integration/
├── routes/          # Individual route tests
└── workflows/       # Multi-route scenario tests
```

## Writing Unit Tests

### Testing Pure Functions

```typescript
// tests/unit/utils/validation.test.ts
import { describe, it, expect } from 'bun:test';
import { validateSandboxName, sanitizeInput } from '../../../src/utils/validation';

describe("validateSandboxName", () => {
  it("should accept lowercase alphanumeric names with hyphens", () => {
    expect(validateSandboxName("my-project-123")).toBe(true);
  });

  it("should reject names with uppercase letters", () => {
    expect(validateSandboxName("MyProject")).toBe(false);
  });

  it("should reject names with special characters", () => {
    expect(validateSandboxName("my@project")).toBe(false);
    expect(validateSandboxName("my_project")).toBe(false);
    expect(validateSandboxName("my project")).toBe(false);
  });

  it("should reject empty names", () => {
    expect(validateSandboxName("")).toBe(false);
  });

  it("should reject names longer than 64 characters", () => {
    const longName = "a".repeat(65);
    expect(validateSandboxName(longName)).toBe(false);
  });
});
```

### Testing Services

Services have external dependencies that need to be mocked.

```typescript
// tests/unit/services/sandbox-manager.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SandboxManager } from '../../../src/services/sandbox-manager';
import { createMockDocker } from '../../mocks/docker';
import { createMockOpenCode } from '../../mocks/opencode-sdk';

describe("SandboxManager", () => {
  let manager: SandboxManager;
  let mockDocker: ReturnType<typeof createMockDocker>;
  let mockOpenCode: ReturnType<typeof createMockOpenCode>;

  beforeEach(() => {
    mockDocker = createMockDocker();
    mockOpenCode = createMockOpenCode();
    manager = new SandboxManager(mockDocker, mockOpenCode);
  });

  describe("createSandbox", () => {
    it("should create container with correct image for flavor", async () => {
      const sandbox = await manager.createSandbox({
        name: "test-project",
        flavor: "python",
        userId: "user-123",
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: expect.stringContaining("python"),
        })
      );
      expect(sandbox.id).toBeDefined();
      expect(sandbox.status).toBe("creating");
    });

    it("should use default flavor when not specified", async () => {
      await manager.createSandbox({
        name: "test-project",
        userId: "user-123",
      });

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: expect.stringContaining("fullstack"),
        })
      );
    });

    it("should throw when Docker fails to create container", async () => {
      mockDocker.createContainer.mockRejectedValue(new Error("Docker error"));

      await expect(
        manager.createSandbox({ name: "test", userId: "user-123" })
      ).rejects.toThrow("Failed to create sandbox");
    });
  });

  describe("startSandbox", () => {
    it("should start container and wait for OpenCode ready", async () => {
      mockDocker.getContainer.mockReturnValue({
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve({ State: { Running: true } })),
      });
      mockOpenCode.waitForReady.mockResolvedValue(true);

      const result = await manager.startSandbox("sandbox-123");

      expect(result.status).toBe("running");
      expect(mockOpenCode.waitForReady).toHaveBeenCalled();
    });

    it("should timeout if OpenCode doesn't become ready", async () => {
      mockDocker.getContainer.mockReturnValue({
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve({ State: { Running: true } })),
      });
      mockOpenCode.waitForReady.mockRejectedValue(new Error("Timeout"));

      await expect(manager.startSandbox("sandbox-123")).rejects.toThrow("Timeout");
    });
  });

  describe("deleteSandbox", () => {
    it("should stop and remove container", async () => {
      const stopMock = mock(() => Promise.resolve());
      const removeMock = mock(() => Promise.resolve());
      
      mockDocker.getContainer.mockReturnValue({
        stop: stopMock,
        remove: removeMock,
      });

      await manager.deleteSandbox("sandbox-123");

      expect(stopMock).toHaveBeenCalled();
      expect(removeMock).toHaveBeenCalled();
    });

    it("should still remove container if stop fails (container not running)", async () => {
      const stopMock = mock(() => Promise.reject(new Error("Not running")));
      const removeMock = mock(() => Promise.resolve());
      
      mockDocker.getContainer.mockReturnValue({
        stop: stopMock,
        remove: removeMock,
      });

      await manager.deleteSandbox("sandbox-123");

      expect(removeMock).toHaveBeenCalled();
    });
  });
});
```

### Testing Models

Models interact with the database. Use a test database.

```typescript
// tests/unit/models/sandbox.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ensureDbInitialized, cleanupTestDatabase } from '../../setup';
import * as SandboxModel from '../../../src/models/sandbox';

describe("SandboxModel", () => {
  beforeEach(() => {
    cleanupTestDatabase();
    ensureDbInitialized();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  describe("create", () => {
    it("should create a sandbox record", () => {
      const sandbox = SandboxModel.create({
        id: "sandbox-123",
        userId: "user-456",
        name: "test-sandbox",
        containerId: "container-789",
        flavor: "js",
        status: "creating",
      });

      expect(sandbox.id).toBe("sandbox-123");
      expect(sandbox.name).toBe("test-sandbox");
      expect(sandbox.createdAt).toBeDefined();
    });

    it("should throw on duplicate id", () => {
      SandboxModel.create({
        id: "sandbox-123",
        userId: "user-456",
        name: "test-1",
        containerId: "container-1",
        flavor: "js",
        status: "creating",
      });

      expect(() =>
        SandboxModel.create({
          id: "sandbox-123",
          userId: "user-456",
          name: "test-2",
          containerId: "container-2",
          flavor: "js",
          status: "creating",
        })
      ).toThrow();
    });
  });

  describe("findById", () => {
    it("should return sandbox by id", () => {
      SandboxModel.create({
        id: "sandbox-123",
        userId: "user-456",
        name: "test",
        containerId: "container-1",
        flavor: "js",
        status: "running",
      });

      const found = SandboxModel.findById("sandbox-123");

      expect(found).not.toBeNull();
      expect(found!.name).toBe("test");
    });

    it("should return null for non-existent id", () => {
      const found = SandboxModel.findById("non-existent");
      expect(found).toBeNull();
    });
  });

  describe("findByUserId", () => {
    it("should return all sandboxes for user", () => {
      SandboxModel.create({
        id: "sandbox-1",
        userId: "user-456",
        name: "test-1",
        containerId: "c-1",
        flavor: "js",
        status: "running",
      });
      SandboxModel.create({
        id: "sandbox-2",
        userId: "user-456",
        name: "test-2",
        containerId: "c-2",
        flavor: "python",
        status: "stopped",
      });
      SandboxModel.create({
        id: "sandbox-3",
        userId: "other-user",
        name: "other",
        containerId: "c-3",
        flavor: "js",
        status: "running",
      });

      const sandboxes = SandboxModel.findByUserId("user-456");

      expect(sandboxes).toHaveLength(2);
      expect(sandboxes.map((s) => s.name)).toEqual(["test-1", "test-2"]);
    });
  });

  describe("updateStatus", () => {
    it("should update sandbox status", () => {
      SandboxModel.create({
        id: "sandbox-123",
        userId: "user-456",
        name: "test",
        containerId: "c-1",
        flavor: "js",
        status: "creating",
      });

      SandboxModel.updateStatus("sandbox-123", "running");

      const updated = SandboxModel.findById("sandbox-123");
      expect(updated!.status).toBe("running");
    });
  });
});
```

### Testing Middleware

```typescript
// tests/unit/middleware/auth.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { apiKeyAuth } from '../../../src/middleware/auth';

describe("apiKeyAuth middleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use("/*", apiKeyAuth());
    app.get("/test", (c) => c.json({ success: true }));
  });

  it("should allow request with valid API key in header", async () => {
    const res = await app.request("/test", {
      headers: { "X-API-Key": "test-token" },
    });

    expect(res.status).toBe(200);
  });

  it("should allow request with valid Bearer token", async () => {
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(200);
  });

  it("should reject request with invalid API key", async () => {
    const res = await app.request("/test", {
      headers: { "X-API-Key": "invalid-token" },
    });

    expect(res.status).toBe(401);
  });

  it("should reject request without authentication", async () => {
    const res = await app.request("/test");

    expect(res.status).toBe(401);
  });
});
```

## Writing Integration Tests

### Route Testing

```typescript
// tests/integration/routes/sandboxes.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createTestApp, TestApp } from '../../helpers/request';
import { seedDatabase, clearDatabase } from '../../helpers/database';
import { createSandbox, createUser } from '../../helpers/factories';

describe("Sandboxes API", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  describe("GET /api/sandboxes", () => {
    it("should return empty array when no sandboxes exist", async () => {
      const res = await app.get("/api/sandboxes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("should return user's sandboxes", async () => {
      await seedDatabase({
        sandboxes: [
          createSandbox({ name: "project-1" }),
          createSandbox({ name: "project-2" }),
        ],
      });

      const res = await app.get("/api/sandboxes");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].name).toBe("project-1");
    });

    it("should not return other users' sandboxes", async () => {
      await seedDatabase({
        sandboxes: [
          createSandbox({ name: "mine", userId: "current-user" }),
          createSandbox({ name: "others", userId: "other-user" }),
        ],
      });

      const res = await app.get("/api/sandboxes");

      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("mine");
    });
  });

  describe("POST /api/sandboxes", () => {
    it("should create sandbox with valid input", async () => {
      const res = await app.post("/api/sandboxes", {
        name: "new-project",
        flavor: "js",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        name: "new-project",
        flavor: "js",
        status: expect.stringMatching(/creating|running/),
      });
    });

    it("should return 400 when name is missing", async () => {
      const res = await app.post("/api/sandboxes", {
        flavor: "js",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("should return 400 when name is invalid", async () => {
      const res = await app.post("/api/sandboxes", {
        name: "Invalid Name!",
        flavor: "js",
      });

      expect(res.status).toBe(400);
    });

    it("should return 400 when flavor is invalid", async () => {
      const res = await app.post("/api/sandboxes", {
        name: "my-project",
        flavor: "invalid-flavor",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("flavor");
    });
  });

  describe("GET /api/sandboxes/:id", () => {
    it("should return sandbox by id", async () => {
      await seedDatabase({
        sandboxes: [createSandbox({ id: "sandbox-123", name: "test" })],
      });

      const res = await app.get("/api/sandboxes/sandbox-123");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("test");
    });

    it("should return 404 for non-existent sandbox", async () => {
      const res = await app.get("/api/sandboxes/non-existent");

      expect(res.status).toBe(404);
    });

    it("should return 403 for another user's sandbox", async () => {
      await seedDatabase({
        sandboxes: [
          createSandbox({
            id: "sandbox-123",
            name: "private",
            userId: "other-user",
          }),
        ],
      });

      const res = await app.get("/api/sandboxes/sandbox-123");

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/sandboxes/:id", () => {
    it("should delete sandbox and return 204", async () => {
      await seedDatabase({
        sandboxes: [createSandbox({ id: "sandbox-123" })],
      });

      const res = await app.delete("/api/sandboxes/sandbox-123");

      expect(res.status).toBe(204);

      // Verify it's deleted
      const getRes = await app.get("/api/sandboxes/sandbox-123");
      expect(getRes.status).toBe(404);
    });
  });
});
```

### Workflow Testing

Test complete user journeys that span multiple routes.

```typescript
// tests/integration/workflows/sandbox-lifecycle.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createTestApp, TestApp } from '../../helpers/request';
import { clearDatabase } from '../../helpers/database';

describe("Sandbox Lifecycle Workflow", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  it("should complete full sandbox lifecycle: create -> start -> stop -> delete", async () => {
    // Create
    const createRes = await app.post("/api/sandboxes", {
      name: "lifecycle-test",
      flavor: "js",
    });
    expect(createRes.status).toBe(201);
    const sandboxId = createRes.body.id;

    // Verify created
    const getRes = await app.get(`/api/sandboxes/${sandboxId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toMatch(/creating|running/);

    // Start (if not already running)
    if (getRes.body.status !== "running") {
      const startRes = await app.post(`/api/sandboxes/${sandboxId}/start`);
      expect(startRes.status).toBe(200);
      expect(startRes.body.status).toBe("running");
    }

    // Stop
    const stopRes = await app.post(`/api/sandboxes/${sandboxId}/stop`);
    expect(stopRes.status).toBe(200);
    expect(stopRes.body.status).toBe("stopped");

    // Delete
    const deleteRes = await app.delete(`/api/sandboxes/${sandboxId}`);
    expect(deleteRes.status).toBe(204);

    // Verify deleted
    const finalRes = await app.get(`/api/sandboxes/${sandboxId}`);
    expect(finalRes.status).toBe(404);
  });

  it("should handle concurrent sandbox operations", async () => {
    // Create multiple sandboxes concurrently
    const createPromises = Array.from({ length: 3 }, (_, i) =>
      app.post("/api/sandboxes", {
        name: `concurrent-${i}`,
        flavor: "js",
      })
    );

    const results = await Promise.all(createPromises);

    results.forEach((res, i) => {
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(`concurrent-${i}`);
    });

    // List all
    const listRes = await app.get("/api/sandboxes");
    expect(listRes.body).toHaveLength(3);
  });
});
```

## Test Helpers

### Request Helper

```typescript
// tests/helpers/request.ts
import { app } from '../../src/index';

export interface TestApp {
  get(path: string): Promise<TestResponse>;
  post(path: string, body?: unknown): Promise<TestResponse>;
  put(path: string, body?: unknown): Promise<TestResponse>;
  patch(path: string, body?: unknown): Promise<TestResponse>;
  delete(path: string): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface TestResponse {
  status: number;
  body: any;
  headers: Headers;
}

export async function createTestApp(): Promise<TestApp> {
  const authHeader = { "X-API-Key": "test-token" };

  const request = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<TestResponse> => {
    const res = await app.request(path, {
      method,
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let responseBody;
    const contentType = res.headers.get("Content-Type");
    if (contentType?.includes("application/json")) {
      responseBody = await res.json();
    } else {
      responseBody = await res.text();
    }

    return {
      status: res.status,
      body: responseBody,
      headers: res.headers,
    };
  };

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
    close: async () => {
      // Cleanup if needed
    },
  };
}
```

### Factories

See `tests/helpers/factories.ts` for test data factories.

### Database Helpers

See `tests/helpers/database.ts` for database utilities.

## Running Tests

```bash
# All tests
bun test

# Unit tests only
bun test tests/unit

# Integration tests only
bun test tests/integration

# Specific file
bun test tests/unit/services/sandbox-manager.test.ts

# Watch mode
bun test --watch

# With coverage
bun test --coverage

# Verbose output
bun test --verbose
```

## Coverage

Coverage is collected using Bun's built-in coverage tool:

```bash
bun test --coverage
```

Coverage reports are generated in `coverage/` directory. View the HTML report:

```bash
open coverage/index.html
```

## Best Practices

1. **Isolate tests** - Each test should be independent
2. **Use factories** - Create test data consistently
3. **Mock at boundaries** - Mock external services, not internal logic
4. **Test edge cases** - Empty inputs, large inputs, special characters
5. **Test error paths** - Ensure errors are handled correctly
6. **Keep tests fast** - Mock slow operations, use test database
7. **Name tests clearly** - Describe expected behavior
8. **Avoid test duplication** - Extract common setup to helpers
