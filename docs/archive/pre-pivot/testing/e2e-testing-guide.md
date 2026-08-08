# End-to-End Testing Guide

This guide covers E2E testing patterns for the AgentPod/AgentPod desktop application using Playwright and Tauri's WebDriver support.

## Overview

E2E tests verify the complete user experience by:
- Testing the full application stack (Svelte UI + Tauri backend + Management API)
- Simulating real user interactions
- Validating critical user journeys
- Catching integration issues between components

## Testing Stack

| Tool | Purpose |
|------|---------|
| Playwright | Browser automation and assertions |
| @playwright/test | Test runner and fixtures |
| Tauri Driver | WebDriver for Tauri apps |
| Docker | API and container environment |

## Project Structure

```
e2e/
├── playwright.config.ts       # Playwright configuration
├── global-setup.ts            # Pre-test environment setup
├── global-teardown.ts         # Post-test cleanup
├── fixtures/
│   ├── app.ts                 # App fixture (launches Tauri)
│   ├── api.ts                 # API client fixture
│   └── test-data.ts           # Test data generators
├── pages/
│   ├── base.page.ts           # Base page object
│   ├── login.page.ts          # Login page
│   ├── dashboard.page.ts      # Dashboard page
│   ├── sandbox.page.ts        # Sandbox detail page
│   └── settings.page.ts       # Settings page
├── specs/
│   ├── auth/
│   │   ├── login.spec.ts
│   │   └── logout.spec.ts
│   ├── sandbox/
│   │   ├── create.spec.ts
│   │   ├── lifecycle.spec.ts
│   │   └── opencode.spec.ts
│   └── settings/
│       ├── preferences.spec.ts
│       └── providers.spec.ts
└── utils/
    ├── docker.ts              # Docker helpers
    ├── wait.ts                # Wait utilities
    └── cleanup.ts             # Test cleanup utilities
```

## Setup

### Install Dependencies

```bash
# From project root
pnpm add -D @playwright/test playwright

# Install browsers
pnpm exec playwright install chromium
```

### Playwright Configuration

```typescript
// e2e/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './specs',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false, // Tauri tests should run sequentially
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1, // Single worker for Tauri
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    isCI ? ['github'] : ['list'],
  ],
  
  globalSetup: require.resolve('./global-setup.ts'),
  globalTeardown: require.resolve('./global-teardown.ts'),

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'desktop-large',
      use: {
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],

  // Start services before tests
  webServer: [
    {
      command: 'cd apps/api && bun run dev',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !isCI,
      timeout: 30000,
    },
  ],
});
```

### Global Setup

```typescript
// e2e/global-setup.ts
import { chromium, FullConfig } from '@playwright/test';
import { execSync } from 'child_process';

async function globalSetup(config: FullConfig) {
  console.log('Setting up E2E test environment...');

  // 1. Ensure Docker is running
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not running. Please start Docker first.');
  }

  // 2. Build Tauri app in dev mode if not already running
  // This is optional - you can also run `pnpm tauri dev` separately
  
  // 3. Seed test database
  execSync('cd apps/api && bun run db:seed:test', { stdio: 'inherit' });

  // 4. Create test user via API
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Create test user
    const response = await page.request.post('http://localhost:3001/api/auth/sign-up/email', {
      data: {
        email: 'e2e@test.com',
        password: 'TestPassword123!',
        name: 'E2E Test User',
      },
    });

    if (response.ok()) {
      console.log('Test user created');
    } else if (response.status() === 409) {
      console.log('Test user already exists');
    } else {
      console.warn('Could not create test user:', await response.text());
    }
  } finally {
    await browser.close();
  }

  console.log('E2E setup complete');
}

export default globalSetup;
```

### Global Teardown

```typescript
// e2e/global-teardown.ts
import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';

async function globalTeardown(config: FullConfig) {
  console.log('Cleaning up E2E test environment...');

  // Clean up test data
  try {
    execSync('cd apps/api && bun run db:clean:test', { stdio: 'inherit' });
  } catch (e) {
    console.warn('Could not clean test database:', e);
  }

  // Stop any test containers
  try {
    execSync('docker ps -q --filter "label=e2e-test" | xargs -r docker stop', {
      stdio: 'inherit',
    });
    execSync('docker ps -aq --filter "label=e2e-test" | xargs -r docker rm', {
      stdio: 'inherit',
    });
  } catch (e) {
    console.warn('Could not clean up containers:', e);
  }

  console.log('E2E teardown complete');
}

export default globalTeardown;
```

## Page Objects

### Base Page

```typescript
// e2e/pages/base.page.ts
import { Page, Locator, expect } from '@playwright/test';

export class BasePage {
  readonly page: Page;
  readonly loadingIndicator: Locator;
  readonly errorToast: Locator;
  readonly successToast: Locator;

  constructor(page: Page) {
    this.page = page;
    this.loadingIndicator = page.locator('[data-testid="loading"]');
    this.errorToast = page.locator('[data-testid="toast-error"]');
    this.successToast = page.locator('[data-testid="toast-success"]');
  }

  async waitForLoad() {
    await this.page.waitForLoadState('networkidle');
    await expect(this.loadingIndicator).not.toBeVisible({ timeout: 10000 });
  }

  async waitForToast(type: 'success' | 'error') {
    const toast = type === 'success' ? this.successToast : this.errorToast;
    await expect(toast).toBeVisible({ timeout: 5000 });
    return toast.textContent();
  }

  async dismissToast() {
    await this.page.locator('[data-testid="toast-dismiss"]').click();
  }

  async takeScreenshot(name: string) {
    await this.page.screenshot({ path: `e2e/screenshots/${name}.png` });
  }
}
```

### Login Page

```typescript
// e2e/pages/login.page.ts
import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly githubButton: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.locator('[data-testid="email-input"]');
    this.passwordInput = page.locator('[data-testid="password-input"]');
    this.submitButton = page.locator('[data-testid="login-submit"]');
    this.errorMessage = page.locator('[data-testid="login-error"]');
    this.githubButton = page.locator('[data-testid="github-login"]');
  }

  async goto() {
    await this.page.goto('/login');
    await this.waitForLoad();
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectError(message: string) {
    await expect(this.errorMessage).toContainText(message);
  }

  async expectLoggedIn() {
    await expect(this.page).toHaveURL(/\/(dashboard|sandboxes)/);
  }
}
```

### Dashboard Page

```typescript
// e2e/pages/dashboard.page.ts
import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class DashboardPage extends BasePage {
  readonly createSandboxButton: Locator;
  readonly sandboxList: Locator;
  readonly emptyState: Locator;
  readonly userMenu: Locator;
  readonly logoutButton: Locator;

  constructor(page: Page) {
    super(page);
    this.createSandboxButton = page.locator('[data-testid="create-sandbox-btn"]');
    this.sandboxList = page.locator('[data-testid="sandbox-list"]');
    this.emptyState = page.locator('[data-testid="empty-state"]');
    this.userMenu = page.locator('[data-testid="user-menu"]');
    this.logoutButton = page.locator('[data-testid="logout-btn"]');
  }

  async goto() {
    await this.page.goto('/dashboard');
    await this.waitForLoad();
  }

  async getSandboxCards() {
    return this.sandboxList.locator('[data-testid="sandbox-card"]').all();
  }

  async getSandboxByName(name: string) {
    return this.sandboxList.locator(`[data-testid="sandbox-card"]:has-text("${name}")`);
  }

  async clickCreateSandbox() {
    await this.createSandboxButton.click();
  }

  async logout() {
    await this.userMenu.click();
    await this.logoutButton.click();
    await expect(this.page).toHaveURL('/login');
  }

  async expectSandboxCount(count: number) {
    const cards = await this.getSandboxCards();
    expect(cards).toHaveLength(count);
  }

  async expectEmptyState() {
    await expect(this.emptyState).toBeVisible();
  }
}
```

### Sandbox Page

```typescript
// e2e/pages/sandbox.page.ts
import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class SandboxPage extends BasePage {
  readonly sandboxName: Locator;
  readonly statusBadge: Locator;
  readonly startButton: Locator;
  readonly stopButton: Locator;
  readonly deleteButton: Locator;
  readonly openCodePanel: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly terminalTab: Locator;
  readonly filesTab: Locator;

  constructor(page: Page) {
    super(page);
    this.sandboxName = page.locator('[data-testid="sandbox-name"]');
    this.statusBadge = page.locator('[data-testid="status-badge"]');
    this.startButton = page.locator('[data-testid="start-sandbox"]');
    this.stopButton = page.locator('[data-testid="stop-sandbox"]');
    this.deleteButton = page.locator('[data-testid="delete-sandbox"]');
    this.openCodePanel = page.locator('[data-testid="opencode-panel"]');
    this.chatInput = page.locator('[data-testid="chat-input"]');
    this.sendButton = page.locator('[data-testid="send-message"]');
    this.messageList = page.locator('[data-testid="message-list"]');
    this.terminalTab = page.locator('[data-testid="terminal-tab"]');
    this.filesTab = page.locator('[data-testid="files-tab"]');
  }

  async goto(sandboxId: string) {
    await this.page.goto(`/sandbox/${sandboxId}`);
    await this.waitForLoad();
  }

  async start() {
    await this.startButton.click();
    await this.waitForStatus('running', 60000);
  }

  async stop() {
    await this.stopButton.click();
    await this.waitForStatus('stopped', 30000);
  }

  async delete() {
    await this.deleteButton.click();
    // Confirm deletion dialog
    await this.page.locator('[data-testid="confirm-delete"]').click();
    await expect(this.page).toHaveURL('/dashboard');
  }

  async waitForStatus(status: string, timeout = 30000) {
    await expect(this.statusBadge).toContainText(status, { timeout });
  }

  async sendMessage(message: string) {
    await this.chatInput.fill(message);
    await this.sendButton.click();
  }

  async waitForResponse(timeout = 60000) {
    // Wait for assistant message to appear
    const lastMessage = this.messageList.locator('[data-role="assistant"]').last();
    await expect(lastMessage).toBeVisible({ timeout });
    return lastMessage.textContent();
  }

  async getMessages() {
    return this.messageList.locator('[data-testid="message"]').all();
  }
}
```

## Fixtures

### App Fixture

```typescript
// e2e/fixtures/app.ts
import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';
import { DashboardPage } from '../pages/dashboard.page';
import { SandboxPage } from '../pages/sandbox.page';

// Test user credentials
const TEST_USER = {
  email: 'e2e@test.com',
  password: 'TestPassword123!',
};

type Fixtures = {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  sandboxPage: SandboxPage;
  authenticatedPage: DashboardPage;
};

export const test = base.extend<Fixtures>({
  loginPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    await use(loginPage);
  },

  dashboardPage: async ({ page }, use) => {
    const dashboardPage = new DashboardPage(page);
    await use(dashboardPage);
  },

  sandboxPage: async ({ page }, use) => {
    const sandboxPage = new SandboxPage(page);
    await use(sandboxPage);
  },

  // Pre-authenticated page fixture
  authenticatedPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(TEST_USER.email, TEST_USER.password);
    await loginPage.expectLoggedIn();

    const dashboardPage = new DashboardPage(page);
    await use(dashboardPage);
  },
});

export { expect };
```

### API Fixture

```typescript
// e2e/fixtures/api.ts
import { test as base, APIRequestContext } from '@playwright/test';

type APIFixtures = {
  apiContext: APIRequestContext;
  createTestSandbox: (name: string) => Promise<{ id: string; name: string }>;
  cleanupSandboxes: () => Promise<void>;
};

export const test = base.extend<APIFixtures>({
  apiContext: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: 'http://localhost:3001',
      extraHTTPHeaders: {
        Authorization: `Bearer ${process.env.TEST_API_TOKEN || 'test-token'}`,
      },
    });
    await use(context);
    await context.dispose();
  },

  createTestSandbox: async ({ apiContext }, use) => {
    const createdSandboxes: string[] = [];

    const createSandbox = async (name: string) => {
      const response = await apiContext.post('/api/v2/sandboxes', {
        data: {
          name,
          flavorId: 'fullstack',
          resourceTierId: 'starter',
        },
      });
      const sandbox = await response.json();
      createdSandboxes.push(sandbox.id);
      return sandbox;
    };

    await use(createSandbox);

    // Cleanup created sandboxes
    for (const id of createdSandboxes) {
      try {
        await apiContext.delete(`/api/v2/sandboxes/${id}`);
      } catch {
        // Ignore cleanup errors
      }
    }
  },

  cleanupSandboxes: async ({ apiContext }, use) => {
    await use(async () => {
      const response = await apiContext.get('/api/v2/sandboxes');
      const { sandboxes } = await response.json();
      
      for (const sandbox of sandboxes) {
        if (sandbox.name.startsWith('e2e-')) {
          await apiContext.delete(`/api/v2/sandboxes/${sandbox.id}`);
        }
      }
    });
  },
});
```

## Test Specifications

### Authentication Tests

```typescript
// e2e/specs/auth/login.spec.ts
import { test, expect } from '../../fixtures/app';

test.describe('Login', () => {
  test.beforeEach(async ({ loginPage }) => {
    await loginPage.goto();
  });

  test('should display login form', async ({ loginPage }) => {
    await expect(loginPage.emailInput).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    await expect(loginPage.submitButton).toBeVisible();
  });

  test('should show error with invalid credentials', async ({ loginPage }) => {
    await loginPage.login('invalid@email.com', 'wrongpassword');
    await loginPage.expectError('Invalid credentials');
  });

  test('should login successfully with valid credentials', async ({ loginPage }) => {
    await loginPage.login('e2e@test.com', 'TestPassword123!');
    await loginPage.expectLoggedIn();
  });

  test('should show validation error for empty email', async ({ loginPage }) => {
    await loginPage.login('', 'password');
    await loginPage.expectError('Email is required');
  });

  test('should show validation error for invalid email format', async ({ loginPage }) => {
    await loginPage.login('notanemail', 'password');
    await loginPage.expectError('Invalid email');
  });

  test('should redirect to dashboard after login', async ({ loginPage, page }) => {
    await loginPage.login('e2e@test.com', 'TestPassword123!');
    await expect(page).toHaveURL('/dashboard');
  });
});
```

### Sandbox Lifecycle Tests

```typescript
// e2e/specs/sandbox/lifecycle.spec.ts
import { test, expect } from '../../fixtures/app';

test.describe('Sandbox Lifecycle', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    // Start from authenticated dashboard
  });

  test('should create a new sandbox', async ({ authenticatedPage, page }) => {
    await authenticatedPage.clickCreateSandbox();

    // Fill create sandbox form
    await page.fill('[data-testid="sandbox-name-input"]', 'e2e-test-sandbox');
    await page.selectOption('[data-testid="flavor-select"]', 'fullstack');
    await page.selectOption('[data-testid="resource-tier-select"]', 'starter');
    await page.click('[data-testid="create-confirm"]');

    // Should navigate to sandbox page
    await expect(page).toHaveURL(/\/sandbox\/.+/);
    await expect(page.locator('[data-testid="sandbox-name"]')).toContainText('e2e-test-sandbox');
  });

  test('should start and stop sandbox', async ({ authenticatedPage, sandboxPage, createTestSandbox }) => {
    // Create sandbox via API for faster setup
    const sandbox = await createTestSandbox('e2e-lifecycle-test');
    
    await sandboxPage.goto(sandbox.id);
    await sandboxPage.waitForStatus('stopped');

    // Start sandbox
    await sandboxPage.start();
    await sandboxPage.waitForStatus('running');

    // Stop sandbox
    await sandboxPage.stop();
    await sandboxPage.waitForStatus('stopped');
  });

  test('should delete sandbox', async ({ authenticatedPage, sandboxPage, createTestSandbox, page }) => {
    const sandbox = await createTestSandbox('e2e-delete-test');
    
    await sandboxPage.goto(sandbox.id);
    await sandboxPage.delete();

    // Should redirect to dashboard
    await expect(page).toHaveURL('/dashboard');
    
    // Sandbox should not be in list
    const sandboxCard = authenticatedPage.getSandboxByName('e2e-delete-test');
    await expect(sandboxCard).not.toBeVisible();
  });
});
```

### OpenCode Integration Tests

```typescript
// e2e/specs/sandbox/opencode.spec.ts
import { test, expect } from '../../fixtures/app';

test.describe('OpenCode Chat', () => {
  test.beforeEach(async ({ authenticatedPage, sandboxPage, createTestSandbox }) => {
    // Create and start a sandbox
    const sandbox = await createTestSandbox('e2e-opencode-test');
    await sandboxPage.goto(sandbox.id);
    await sandboxPage.start();
    await sandboxPage.waitForStatus('running');
  });

  test('should send message and receive response', async ({ sandboxPage }) => {
    await sandboxPage.sendMessage('Hello, what files are in the project?');
    
    const response = await sandboxPage.waitForResponse();
    expect(response).toBeTruthy();
    expect(response!.length).toBeGreaterThan(0);
  });

  test('should display message history', async ({ sandboxPage }) => {
    await sandboxPage.sendMessage('Create a hello.txt file with "Hello World"');
    await sandboxPage.waitForResponse();

    const messages = await sandboxPage.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2); // User + Assistant
  });

  test('should show typing indicator while processing', async ({ sandboxPage, page }) => {
    await sandboxPage.sendMessage('List all files');
    
    // Typing indicator should appear
    const typingIndicator = page.locator('[data-testid="typing-indicator"]');
    await expect(typingIndicator).toBeVisible({ timeout: 5000 });
    
    // Should disappear after response
    await sandboxPage.waitForResponse();
    await expect(typingIndicator).not.toBeVisible();
  });

  test.skip('should handle long-running operations', async ({ sandboxPage }) => {
    // Skip in CI due to time constraints
    await sandboxPage.sendMessage('Install express and create a basic server');
    
    // Should complete within 2 minutes
    const response = await sandboxPage.waitForResponse(120000);
    expect(response).toContain('express');
  });
});
```

### Settings Tests

```typescript
// e2e/specs/settings/preferences.spec.ts
import { test, expect } from '../../fixtures/app';

test.describe('User Preferences', () => {
  test.beforeEach(async ({ authenticatedPage, page }) => {
    await page.goto('/settings');
  });

  test('should load user preferences', async ({ page }) => {
    await expect(page.locator('[data-testid="theme-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="editor-font-size"]')).toBeVisible();
  });

  test('should save theme preference', async ({ page }) => {
    await page.selectOption('[data-testid="theme-select"]', 'dark');
    await page.click('[data-testid="save-preferences"]');
    
    await expect(page.locator('[data-testid="toast-success"]')).toContainText('Preferences saved');
    
    // Reload and verify
    await page.reload();
    await expect(page.locator('[data-testid="theme-select"]')).toHaveValue('dark');
  });

  test('should persist preferences after logout', async ({ page, loginPage }) => {
    // Set preference
    await page.selectOption('[data-testid="theme-select"]', 'light');
    await page.click('[data-testid="save-preferences"]');
    
    // Logout
    await page.locator('[data-testid="user-menu"]').click();
    await page.locator('[data-testid="logout-btn"]').click();
    
    // Login again
    await loginPage.login('e2e@test.com', 'TestPassword123!');
    await page.goto('/settings');
    
    // Verify preference persisted
    await expect(page.locator('[data-testid="theme-select"]')).toHaveValue('light');
  });
});
```

## Running E2E Tests

### Commands

```bash
# Run all E2E tests
pnpm test:e2e

# Run specific test file
pnpm test:e2e specs/auth/login.spec.ts

# Run tests with UI
pnpm test:e2e --ui

# Run tests in headed mode (see browser)
pnpm test:e2e --headed

# Run with specific project
pnpm test:e2e --project=desktop

# Debug mode
pnpm test:e2e --debug

# Generate report
pnpm test:e2e --reporter=html
```

### Package.json Scripts

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:report": "playwright show-report"
  }
}
```

### Prerequisites

Before running E2E tests:

1. **Start Docker** - Required for sandbox tests
2. **API running** - `cd apps/api && bun run dev`
3. **Frontend running** (optional) - `cd apps/frontend && pnpm tauri dev`

The Playwright config can auto-start the API using `webServer`.

## CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    services:
      docker:
        image: docker:dind
        options: --privileged

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Install dependencies
        run: pnpm install

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps chromium

      - name: Start API
        run: |
          cd apps/api
          bun run dev &
          sleep 5

      - name: Wait for API
        run: |
          timeout 30 bash -c 'until curl -s http://localhost:3001/health; do sleep 1; done'

      - name: Run E2E tests
        run: pnpm test:e2e
        env:
          CI: true
          TEST_API_TOKEN: ${{ secrets.TEST_API_TOKEN }}

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7

      - name: Upload screenshots
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: screenshots
          path: e2e/screenshots/
          retention-days: 7
```

## Best Practices

### Test Isolation

1. **Each test should be independent** - Don't rely on state from other tests
2. **Use fixtures for setup** - Pre-create data needed for tests
3. **Clean up after tests** - Delete created resources

### Selectors

Use `data-testid` attributes for stable selectors:

```html
<!-- Good -->
<button data-testid="submit-btn">Submit</button>

<!-- Avoid -->
<button class="btn-primary submit">Submit</button>
```

```typescript
// Good
await page.click('[data-testid="submit-btn"]');

// Avoid - fragile selectors
await page.click('.btn-primary.submit');
await page.click('button:has-text("Submit")');
```

### Waiting

Use explicit waits instead of arbitrary timeouts:

```typescript
// Good
await expect(page.locator('[data-testid="result"]')).toBeVisible();
await page.waitForResponse(resp => resp.url().includes('/api/sandbox'));

// Avoid
await page.waitForTimeout(5000);
```

### Test Data

Use unique identifiers for test data:

```typescript
// Good - unique name per test run
const sandboxName = `e2e-test-${Date.now()}`;

// Avoid - collision risk
const sandboxName = 'test-sandbox';
```

### Error Handling

Capture context on failures:

```typescript
test('should create sandbox', async ({ page }) => {
  try {
    // ... test steps
  } catch (error) {
    await page.screenshot({ path: `e2e/screenshots/create-sandbox-failure.png` });
    throw error;
  }
});
```

## Troubleshooting

### Common Issues

**Tests timeout waiting for element**
- Check if element has correct `data-testid`
- Verify element is not hidden by CSS
- Increase timeout for slow operations

**Tests fail only in CI**
- CI environment may be slower - increase timeouts
- Check for missing environment variables
- Verify Docker is available in CI

**Flaky tests**
- Add explicit waits for async operations
- Avoid time-dependent assertions
- Ensure proper test isolation

### Debug Mode

```bash
# Run with Playwright Inspector
pnpm test:e2e --debug

# Run specific test with debugging
pnpm test:e2e specs/auth/login.spec.ts --debug
```

### Viewing Traces

```bash
# Generate trace on failure
pnpm test:e2e --trace on

# View trace
pnpm exec playwright show-trace trace.zip
```

---

See also:
- `TESTING.md` - Overall testing strategy
- `docs/testing/api-testing-guide.md` - API testing patterns
- `docs/testing/frontend-testing-guide.md` - Frontend testing patterns
- [Playwright Documentation](https://playwright.dev/docs/intro)
