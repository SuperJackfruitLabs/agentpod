export const pluginPlanFixture = {
  schemaVersion: 1, operationId: 'a'.repeat(32), action: 'enable',
  binding: { nodeId: 'node_fixture', stationKey: 'hermes:fixture', harness: 'hermes', plugin: 'agentpod-live' },
  version: '0.3.0', gate: { allowed: true, version: '0.21.3', reason: 'Hermes 0.21.3 is within the tested range' },
  files: 'absent', filesDigest: '', fileAction: 'add', fileNames: ['__init__.py', 'plugin.yaml'],
  config: { path: 'config.yaml', beforeSHA256: '1'.repeat(64), afterSHA256: '2'.repeat(64),
    diff: '  + plugins:\n  +   enabled:\n  +     - agentpod-live\n', diffTruncated: false, restoresBackup: false },
  noOp: false, notes: [], refusal: null, restartRequired: true,
  createdAt: '2026-09-25T10:00:00Z', planDigest: '3'.repeat(64),
};
export const pluginRefusalFixture = {
  ...pluginPlanFixture, action: 'disable', gate: null, files: null, fileAction: null, fileNames: [], config: null,
  refusal: 'hermes-live: apn has no record of installing agentpod-live in this profile', restartRequired: false,
};
