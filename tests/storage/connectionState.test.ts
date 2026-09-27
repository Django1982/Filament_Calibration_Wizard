import { describe, expect, it, beforeEach } from 'vitest';
import { deriveConnectionState, getConnectionState, setConnectionState } from '../../src/storage/connectionState';

describe('deriveConnectionState (pure)', () => {
  it('is no-backend when the health check fails, regardless of authFailed', () => {
    expect(deriveConnectionState({ healthOk: false, authFailed: false })).toBe('no-backend');
    expect(deriveConnectionState({ healthOk: false, authFailed: true })).toBe('no-backend');
  });

  it('is connected when the health check succeeds and no auth failure occurred', () => {
    expect(deriveConnectionState({ healthOk: true, authFailed: false })).toBe('connected');
  });

  it('is needs-token when the health check succeeds but a data call 401ed', () => {
    expect(deriveConnectionState({ healthOk: true, authFailed: true })).toBe('needs-token');
  });

  it('defaults isDesktop/hasServerUrl to false, so omitting them keeps the original three-state behavior', () => {
    expect(deriveConnectionState({ healthOk: false, authFailed: false })).toBe('no-backend');
    expect(deriveConnectionState({ healthOk: true, authFailed: false })).toBe('connected');
    expect(deriveConnectionState({ healthOk: true, authFailed: true })).toBe('needs-token');
  });

  it('is no-url when running desktop with no server URL configured, regardless of healthOk/authFailed', () => {
    expect(deriveConnectionState({ healthOk: false, authFailed: false, isDesktop: true, hasServerUrl: false })).toBe('no-url');
    expect(deriveConnectionState({ healthOk: true, authFailed: false, isDesktop: true, hasServerUrl: false })).toBe('no-url');
    expect(deriveConnectionState({ healthOk: true, authFailed: true, isDesktop: true, hasServerUrl: false })).toBe('no-url');
  });

  it('is NOT no-url when desktop but a server URL is configured — falls through to the normal health/auth logic', () => {
    expect(deriveConnectionState({ healthOk: false, authFailed: false, isDesktop: true, hasServerUrl: true })).toBe('no-backend');
    expect(deriveConnectionState({ healthOk: true, authFailed: false, isDesktop: true, hasServerUrl: true })).toBe('connected');
    expect(deriveConnectionState({ healthOk: true, authFailed: true, isDesktop: true, hasServerUrl: true })).toBe('needs-token');
  });

  it('is NOT no-url when not desktop, even with no server URL configured (plain browser default)', () => {
    expect(deriveConnectionState({ healthOk: false, authFailed: false, isDesktop: false, hasServerUrl: false })).toBe('no-backend');
  });
});

describe('getConnectionState / setConnectionState', () => {
  beforeEach(() => {
    setConnectionState('no-backend');
  });

  it('defaults to no-backend', () => {
    expect(getConnectionState()).toBe('no-backend');
  });

  it('reflects the last value written', () => {
    setConnectionState('connected');
    expect(getConnectionState()).toBe('connected');

    setConnectionState('needs-token');
    expect(getConnectionState()).toBe('needs-token');

    setConnectionState('no-url');
    expect(getConnectionState()).toBe('no-url');
  });
});
