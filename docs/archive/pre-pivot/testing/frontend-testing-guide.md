# Frontend Testing Guide

This guide covers testing patterns for the Tauri desktop app (`apps/frontend/`), including both Svelte components and the Rust backend.

## Overview

The frontend consists of:
- **Svelte/SvelteKit** - UI layer with Svelte 5 runes
- **Tauri/Rust** - Native backend for IPC
- **TypeScript** - Type-safe API wrapper and stores

## Test Categories

### Unit Tests
- **Stores** - Svelte state management
- **Utilities** - Helper functions
- **API Wrapper** - Tauri invoke wrapper

### Component Tests
- **UI Components** - Isolated component rendering
- **Page Components** - Route-level components

### Rust Tests
- **Commands** - Tauri command handlers
- **Services** - Business logic
- **Models** - Data structures

## Testing Stack

| Layer | Tool |
|-------|------|
| Svelte Components | Vitest + Testing Library |
| Svelte Stores | Vitest |
| TypeScript Utilities | Vitest |
| Rust Backend | cargo test |

## Setup

### Install Testing Dependencies

```bash
cd apps/frontend
pnpm add -D vitest @testing-library/svelte @testing-library/jest-dom jsdom
```

### Configure Vitest

```typescript
// apps/frontend/vitest.config.ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      $lib: '/src/lib',
      $app: '/tests/mocks/$app',
    },
  },
});
```

### Test Setup File

```typescript
// apps/frontend/tests/setup.ts
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { mockTauri } from './mocks/tauri';

// Mock Tauri globally
vi.mock('@tauri-apps/api/core', () => mockTauri);
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

// Reset mocks between tests
beforeEach(() => {
  mockTauri.reset();
});
```

## Testing Svelte Stores

### Auth Store Test

```typescript
// apps/frontend/tests/unit/stores/auth.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockTauri } from '../../mocks/tauri';

// Import store after mocks are set up
let authStore: typeof import('$lib/stores/auth.svelte');

describe("authStore", () => {
  beforeEach(async () => {
    mockTauri.reset();
    // Re-import to get fresh store
    vi.resetModules();
    authStore = await import('$lib/stores/auth.svelte');
  });

  describe("login", () => {
    it("should set isAuthenticated to true on successful login", async () => {
      mockTauri.invoke.mockResolvedValueOnce({
        token: "test-token",
        user: { id: "user-1", email: "test@example.com" },
      });

      await authStore.login("test@example.com", "password123");

      expect(authStore.isAuthenticated).toBe(true);
      expect(authStore.user?.email).toBe("test@example.com");
    });

    it("should set error on failed login", async () => {
      mockTauri.invoke.mockRejectedValueOnce(new Error("Invalid credentials"));

      await authStore.login("test@example.com", "wrong-password");

      expect(authStore.isAuthenticated).toBe(false);
      expect(authStore.error).toContain("Invalid credentials");
    });

    it("should call correct Tauri command", async () => {
      mockTauri.invoke.mockResolvedValueOnce({ token: "test" });

      await authStore.login("test@example.com", "password123");

      expect(mockTauri.invoke).toHaveBeenCalledWith("auth_login", {
        email: "test@example.com",
        password: "password123",
      });
    });
  });

  describe("logout", () => {
    it("should clear user and token on logout", async () => {
      // Set up logged in state
      mockTauri.invoke.mockResolvedValueOnce({
        token: "test-token",
        user: { id: "user-1" },
      });
      await authStore.login("test@example.com", "password");

      mockTauri.invoke.mockResolvedValueOnce(undefined);
      await authStore.logout();

      expect(authStore.isAuthenticated).toBe(false);
      expect(authStore.user).toBeNull();
    });
  });
});
```

### Sandboxes Store Test

```typescript
// apps/frontend/tests/unit/stores/sandboxes.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockTauri } from '../../mocks/tauri';

let sandboxesStore: typeof import('$lib/stores/sandboxes.svelte');

describe("sandboxesStore", () => {
  beforeEach(async () => {
    mockTauri.reset();
    vi.resetModules();
    sandboxesStore = await import('$lib/stores/sandboxes.svelte');
  });

  describe("fetchSandboxes", () => {
    it("should load sandboxes from API", async () => {
      const mockSandboxes = [
        { id: "1", name: "Project A", status: "running" },
        { id: "2", name: "Project B", status: "stopped" },
      ];
      mockTauri.invoke.mockResolvedValueOnce(mockSandboxes);

      await sandboxesStore.fetchSandboxes();

      expect(sandboxesStore.sandboxes).toHaveLength(2);
      expect(sandboxesStore.sandboxes[0].name).toBe("Project A");
    });

    it("should set loading state during fetch", async () => {
      mockTauri.invoke.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
      );

      const fetchPromise = sandboxesStore.fetchSandboxes();

      expect(sandboxesStore.isLoading).toBe(true);
      await fetchPromise;
      expect(sandboxesStore.isLoading).toBe(false);
    });
  });

  describe("createSandbox", () => {
    it("should add new sandbox to list", async () => {
      const newSandbox = { id: "new", name: "New Project", status: "creating" };
      mockTauri.invoke.mockResolvedValueOnce(newSandbox);

      await sandboxesStore.createSandbox({ name: "New Project", flavor: "js" });

      expect(sandboxesStore.sandboxes).toContainEqual(
        expect.objectContaining({ name: "New Project" })
      );
    });
  });

  describe("deleteSandbox", () => {
    it("should remove sandbox from list", async () => {
      sandboxesStore.sandboxes = [
        { id: "1", name: "Keep", status: "running" },
        { id: "2", name: "Delete", status: "stopped" },
      ];
      mockTauri.invoke.mockResolvedValueOnce(undefined);

      await sandboxesStore.deleteSandbox("2");

      expect(sandboxesStore.sandboxes).toHaveLength(1);
      expect(sandboxesStore.sandboxes[0].name).toBe("Keep");
    });
  });
});
```

## Testing Svelte Components

### Simple Component Test

```typescript
// apps/frontend/tests/components/Button.test.ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Button from '$lib/components/ui/button/button.svelte';

describe("Button", () => {
  it("should render with text", () => {
    const { getByText } = render(Button, {
      props: { children: "Click me" },
    });

    expect(getByText("Click me")).toBeInTheDocument();
  });

  it("should call onclick when clicked", async () => {
    const handleClick = vi.fn();
    const { getByRole } = render(Button, {
      props: { onclick: handleClick },
    });

    await fireEvent.click(getByRole("button"));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("should be disabled when disabled prop is true", () => {
    const { getByRole } = render(Button, {
      props: { disabled: true },
    });

    expect(getByRole("button")).toBeDisabled();
  });

  it("should apply variant classes", () => {
    const { getByRole } = render(Button, {
      props: { variant: "destructive" },
    });

    expect(getByRole("button")).toHaveClass("destructive");
  });
});
```

### Component with State Test

```typescript
// apps/frontend/tests/components/SandboxCard.test.ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import SandboxCard from '$lib/components/SandboxCard.svelte';

describe("SandboxCard", () => {
  const defaultSandbox = {
    id: "sandbox-123",
    name: "My Project",
    status: "running",
    flavor: "js",
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("should display sandbox name and status", () => {
    const { getByText } = render(SandboxCard, {
      props: { sandbox: defaultSandbox },
    });

    expect(getByText("My Project")).toBeInTheDocument();
    expect(getByText("running")).toBeInTheDocument();
  });

  it("should show status indicator with correct color", () => {
    const { container } = render(SandboxCard, {
      props: { sandbox: { ...defaultSandbox, status: "running" } },
    });

    const indicator = container.querySelector("[data-status-indicator]");
    expect(indicator).toHaveClass("bg-green-500");
  });

  it("should emit delete event when delete button is clicked", async () => {
    const { getByRole, component } = render(SandboxCard, {
      props: { sandbox: defaultSandbox },
    });

    const deleteHandler = vi.fn();
    component.$on("delete", deleteHandler);

    await fireEvent.click(getByRole("button", { name: /delete/i }));

    expect(deleteHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { id: "sandbox-123" },
      })
    );
  });

  it("should show confirmation dialog before delete", async () => {
    const { getByRole, getByText } = render(SandboxCard, {
      props: { sandbox: defaultSandbox },
    });

    await fireEvent.click(getByRole("button", { name: /delete/i }));

    expect(getByText(/are you sure/i)).toBeInTheDocument();
  });

  it("should navigate to sandbox on click", async () => {
    const { getByRole } = render(SandboxCard, {
      props: { sandbox: defaultSandbox },
    });

    await fireEvent.click(getByRole("article"));

    // Verify navigation was triggered
    expect(window.location.pathname).toContain("sandbox-123");
  });
});
```

### Testing Component with Async Data

```typescript
// apps/frontend/tests/components/SandboxList.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor, within } from '@testing-library/svelte';
import { mockTauri } from '../mocks/tauri';
import SandboxList from '$lib/components/SandboxList.svelte';

describe("SandboxList", () => {
  beforeEach(() => {
    mockTauri.reset();
  });

  it("should show loading state initially", () => {
    mockTauri.invoke.mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const { getByTestId } = render(SandboxList);

    expect(getByTestId("loading-spinner")).toBeInTheDocument();
  });

  it("should render sandboxes when loaded", async () => {
    mockTauri.invoke.mockResolvedValueOnce([
      { id: "1", name: "Project A", status: "running" },
      { id: "2", name: "Project B", status: "stopped" },
    ]);

    const { getAllByRole } = render(SandboxList);

    await waitFor(() => {
      expect(getAllByRole("article")).toHaveLength(2);
    });
  });

  it("should show empty state when no sandboxes", async () => {
    mockTauri.invoke.mockResolvedValueOnce([]);

    const { getByText } = render(SandboxList);

    await waitFor(() => {
      expect(getByText(/no sandboxes/i)).toBeInTheDocument();
    });
  });

  it("should show error state on fetch failure", async () => {
    mockTauri.invoke.mockRejectedValueOnce(new Error("Network error"));

    const { getByText } = render(SandboxList);

    await waitFor(() => {
      expect(getByText(/error/i)).toBeInTheDocument();
    });
  });
});
```

## Testing Rust Backend

### Command Tests

```rust
// apps/frontend/src-tauri/src/commands/sandbox.rs

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize)]
pub struct Sandbox {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Deserialize)]
pub struct CreateSandboxInput {
    pub name: String,
    pub flavor: Option<String>,
}

#[tauri::command]
pub async fn create_sandbox(
    input: CreateSandboxInput,
    api_client: State<'_, ApiClient>,
) -> Result<Sandbox, String> {
    // Implementation
    api_client
        .create_sandbox(&input.name, input.flavor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::predicate::*;

    // Mock ApiClient
    mock! {
        ApiClient {
            async fn create_sandbox(
                &self,
                name: &str,
                flavor: Option<&str>,
            ) -> Result<Sandbox, ApiError>;
        }
    }

    #[tokio::test]
    async fn test_create_sandbox_success() {
        let mut mock_client = MockApiClient::new();
        mock_client
            .expect_create_sandbox()
            .with(eq("test-project"), eq(Some("js")))
            .returning(|name, _| {
                Ok(Sandbox {
                    id: "sandbox-123".to_string(),
                    name: name.to_string(),
                    status: "creating".to_string(),
                })
            });

        let input = CreateSandboxInput {
            name: "test-project".to_string(),
            flavor: Some("js".to_string()),
        };

        let result = create_sandbox_impl(input, &mock_client).await;

        assert!(result.is_ok());
        let sandbox = result.unwrap();
        assert_eq!(sandbox.name, "test-project");
        assert_eq!(sandbox.status, "creating");
    }

    #[tokio::test]
    async fn test_create_sandbox_error() {
        let mut mock_client = MockApiClient::new();
        mock_client
            .expect_create_sandbox()
            .returning(|_, _| Err(ApiError::NetworkError("Connection failed".to_string())));

        let input = CreateSandboxInput {
            name: "test".to_string(),
            flavor: None,
        };

        let result = create_sandbox_impl(input, &mock_client).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Connection failed"));
    }

    #[tokio::test]
    async fn test_create_sandbox_uses_default_flavor() {
        let mut mock_client = MockApiClient::new();
        mock_client
            .expect_create_sandbox()
            .with(eq("test"), eq(None))
            .returning(|name, _| {
                Ok(Sandbox {
                    id: "id".to_string(),
                    name: name.to_string(),
                    status: "creating".to_string(),
                })
            });

        let input = CreateSandboxInput {
            name: "test".to_string(),
            flavor: None,
        };

        let _ = create_sandbox_impl(input, &mock_client).await;

        // Expectation verified by mockall
    }
}
```

### Service Tests

```rust
// apps/frontend/src-tauri/src/services/storage.rs

use std::path::PathBuf;

pub struct StorageService {
    base_path: PathBuf,
}

impl StorageService {
    pub fn new(base_path: PathBuf) -> Self {
        Self { base_path }
    }

    pub fn get_config_path(&self) -> PathBuf {
        self.base_path.join("config.json")
    }

    pub fn read_config(&self) -> Result<Config, StorageError> {
        let path = self.get_config_path();
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content).map_err(StorageError::from)
    }

    pub fn write_config(&self, config: &Config) -> Result<(), StorageError> {
        let path = self.get_config_path();
        let content = serde_json::to_string_pretty(config)?;
        std::fs::write(&path, content)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage() -> (StorageService, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let service = StorageService::new(temp_dir.path().to_path_buf());
        (service, temp_dir)
    }

    #[test]
    fn test_get_config_path() {
        let (service, temp_dir) = create_test_storage();
        
        let path = service.get_config_path();
        
        assert_eq!(path, temp_dir.path().join("config.json"));
    }

    #[test]
    fn test_write_and_read_config() {
        let (service, _temp_dir) = create_test_storage();
        let config = Config {
            api_url: "http://localhost:3001".to_string(),
            theme: "dark".to_string(),
        };

        service.write_config(&config).unwrap();
        let loaded = service.read_config().unwrap();

        assert_eq!(loaded.api_url, config.api_url);
        assert_eq!(loaded.theme, config.theme);
    }

    #[test]
    fn test_read_config_not_found() {
        let (service, _temp_dir) = create_test_storage();
        
        let result = service.read_config();
        
        assert!(result.is_err());
    }

    #[test]
    fn test_read_config_invalid_json() {
        let (service, temp_dir) = create_test_storage();
        std::fs::write(temp_dir.path().join("config.json"), "invalid json").unwrap();
        
        let result = service.read_config();
        
        assert!(result.is_err());
    }
}
```

## Mocks

### Tauri Mock

```typescript
// apps/frontend/tests/mocks/tauri.ts
import { vi } from 'vitest';

export const mockTauri = {
  invoke: vi.fn(),
  
  reset() {
    this.invoke.mockReset();
  },

  // Helper to set up common responses
  setupAuth(user: { id: string; email: string } | null) {
    this.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'auth_get_current_user') {
        return Promise.resolve(user);
      }
      if (cmd === 'auth_is_authenticated') {
        return Promise.resolve(user !== null);
      }
      return Promise.reject(new Error(`Unknown command: ${cmd}`));
    });
  },

  setupSandboxes(sandboxes: any[]) {
    this.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'sandboxes_list') {
        return Promise.resolve(sandboxes);
      }
      return Promise.reject(new Error(`Unknown command: ${cmd}`));
    });
  },
};
```

### SvelteKit Mock

```typescript
// apps/frontend/tests/mocks/$app/navigation.ts
import { vi } from 'vitest';

export const goto = vi.fn();
export const invalidate = vi.fn();
export const invalidateAll = vi.fn();
export const prefetch = vi.fn();
```

```typescript
// apps/frontend/tests/mocks/$app/stores.ts
import { readable, writable } from 'svelte/store';

export const page = readable({
  url: new URL('http://localhost'),
  params: {},
  route: { id: '/' },
  status: 200,
  error: null,
  data: {},
  form: null,
});

export const navigating = readable(null);
export const updated = readable(false);
```

## Running Tests

### Frontend Tests

```bash
cd apps/frontend

# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage

# Specific file
pnpm test tests/unit/stores/auth.test.ts
```

### Rust Tests

```bash
cd apps/frontend/src-tauri

# Run all tests
cargo test

# Specific test
cargo test test_create_sandbox

# With output
cargo test -- --nocapture

# Verbose
cargo test -- --show-output
```

## Best Practices

### Svelte Testing

1. **Reset stores** between tests to ensure isolation
2. **Use Testing Library** queries for accessibility
3. **Test user interactions**, not implementation
4. **Mock Tauri invoke** at the module level

### Rust Testing

1. **Use `#[cfg(test)]`** for test modules
2. **Use `tempfile`** for filesystem tests
3. **Use `mockall`** for mocking traits
4. **Test error conditions** thoroughly

### General

1. **Write tests first** (TDD)
2. **Keep tests focused** - one assertion per test when possible
3. **Use descriptive names** - describe expected behavior
4. **Avoid testing frameworks** - test application logic
