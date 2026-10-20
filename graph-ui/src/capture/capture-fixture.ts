import type { CaptureEvent, CaptureSession, CaptureStarted } from './capture-source';

export const captureSession = (overrides: Partial<CaptureSession> = {}): CaptureSession => ({
    id: 'capture-1', project: 'sample', generation: 'g1', profile: 'node', status: 'recording',
    created_at: 1792512000, expires_at: 1792515600, accepted_events: 0, dropped_events: 0, max_events: 1000,
    values_enabled: false, allowed_fields: [], capabilities: ['explicit_lineage_events'],
    gaps: ['Application instrumentation must be installed separately.'], ...overrides,
});
export const captureStarted = (overrides: Partial<CaptureSession> = {}): CaptureStarted => ({
    schema_version: 1, session: captureSession(overrides), token: 'ephemeral-test-token',
    lineage_url: '/api/capture/lineage?id=capture-1', traces_url: '/api/capture/traces?id=capture-1',
    instructions: ['Start your application manually with the selected development adapter.'],
});
export const captureEvent = (overrides: Partial<CaptureEvent> = {}): CaptureEvent => ({
    id: 1, producer_id: 'node-A', language: 'javascript', sequence: 1, operation: 'read',
    invocation_id: 'call-1', value_id: 'value-1', inputs: [], access_path: 'user.email',
    source: { file_path: 'src/users.ts', line: 12, source_hash: 'sha256:abc' }, source_status: 'matched', ...overrides,
});
