/**
 * Test Mocks Index
 *
 * Centralized exports for all test mocks.
 * Import from this file to use mocks in tests.
 */

// Docker Orchestrator Mock
export {
  MockDockerOrchestrator,
  createMockDockerOrchestrator,
  mockDockerOrchestratorModule,
  resetDockerMock,
  addMockSandbox,
  addMockImage,
  getMockSandbox,
  updateMockSandbox,
  setMockDockerHealth,
  setMockDockerInfo,
  mockCalls as dockerMockCalls,
} from './docker';
export type { MockSandboxData, MockImageData } from './docker';

// OpenCode SDK Mock
export {
  mockOpencodeV2,
  createMockOpencodeV2,
  resetOpencodeMock,
  addMockSession,
  addMockMessage,
  addMockFiles,
  getMockSession as getOpencodeMockSession,
  setMockOpenCodeHealth,
  mockCalls as opencodeMockCalls,
} from './opencode-sdk';
export type { MockSessionData, MockMessageData, MockFileData } from './opencode-sdk';

// Git Service Mock
export {
  MockGitBackend,
  createMockGitBackend,
  resetGitMock,
  addMockRepo,
  addMockRepoFile,
  getMockRepo,
  mockCalls as gitMockCalls,
} from './git';
export type { MockRepoData, MockCommitData } from './git';


/**
 * Reset all mocks - call this in beforeEach to ensure clean state
 */
export function resetAllMocks(): void {
  const { resetDockerMock } = require('./docker');
  const { resetOpencodeMock } = require('./opencode-sdk');
  const { resetGitMock } = require('./git');

  resetDockerMock();
  resetOpencodeMock();
  resetGitMock();
}
