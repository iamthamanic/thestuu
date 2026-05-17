/**
 * Map engine Socket.IO diagnostics payload to LOGS panel health rows (browser mode).
 */

/**
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function mapEngineDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const flags = raw.nativeDawFlags && typeof raw.nativeDawFlags === 'object'
    ? raw.nativeDawFlags
    : {};
  return {
    nativeProcessRunning: Boolean(raw.nativeProcessRunning),
    ipcConnected: Boolean(raw.ipcConnected),
    tracktionReady: Boolean(raw.tracktionReady),
    audioDeviceReady: Boolean(raw.audioDeviceReady),
    dawReady: Boolean(raw.dawReady),
    dawAuthority: typeof raw.dawAuthority === 'string' ? raw.dawAuthority : 'unknown',
    nativeSocketPath: typeof raw.nativeSocketPath === 'string' ? raw.nativeSocketPath : '',
    nativeDawFlags: flags,
  };
}

/**
 * @param {'connecting'|'online'|'offline'} connection
 * @param {boolean} dawEngineReady
 * @param {ReturnType<typeof mapEngineDiagnostics> | null} engineDiagnostics
 * @param {object | null} desktopHealth
 */
export function mergeLogsPanelHealth(connection, dawEngineReady, engineDiagnostics, desktopHealth) {
  if (desktopHealth && typeof desktopHealth === 'object') {
    return {
      dashboardOnline: Boolean(desktopHealth.dashboardOnline ?? connection === 'online'),
      engineOnline: Boolean(desktopHealth.engineOnline ?? connection === 'online'),
      engineManagedByDesktop: Boolean(desktopHealth.engineManagedByDesktop),
      lastEngineError: desktopHealth.lastEngineError ?? null,
      nativeProcessRunning: Boolean(desktopHealth.nativeProcessRunning),
      ipcConnected: Boolean(desktopHealth.ipcConnected),
      tracktionReady: Boolean(desktopHealth.tracktionReady),
      audioDeviceReady: Boolean(desktopHealth.audioDeviceReady),
      dawReady: Boolean(desktopHealth.dawReady ?? dawEngineReady),
      dawAuthority: desktopHealth.dawAuthority,
      nativeSocketPath: desktopHealth.socketPath || desktopHealth.nativeSocketPath || '',
    };
  }
  if (engineDiagnostics) {
    return {
      dashboardOnline: connection === 'online',
      engineOnline: connection === 'online',
      nativeProcessRunning: engineDiagnostics.nativeProcessRunning,
      ipcConnected: engineDiagnostics.ipcConnected,
      tracktionReady: engineDiagnostics.tracktionReady,
      audioDeviceReady: engineDiagnostics.audioDeviceReady,
      dawReady: dawEngineReady,
      dawAuthority: engineDiagnostics.dawAuthority,
      nativeSocketPath: engineDiagnostics.nativeSocketPath,
    };
  }
  return {
    dashboardOnline: connection === 'online',
    engineOnline: connection === 'online',
    nativeProcessRunning: false,
    ipcConnected: false,
    tracktionReady: false,
    audioDeviceReady: false,
    dawReady: dawEngineReady,
    dawAuthority: 'unknown',
    nativeSocketPath: '',
  };
}
