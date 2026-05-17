/**
 * Performance profile helpers (Low / Balanced / High) for dashboard + engine hints.
 * Location: apps/dashboard/lib
 */

/** @typedef {'low' | 'balanced' | 'high'} PerformanceProfile */

const STORAGE_KEY = 'thestuu.performanceProfile';

/**
 * @returns {PerformanceProfile}
 */
export function getPerformanceProfile() {
  if (typeof window === 'undefined') {
    return 'balanced';
  }
  const env = typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_STUU_PERF === 'low'
    ? 'low'
    : null;
  if (env === 'low') {
    return 'low';
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'low' || stored === 'balanced' || stored === 'high') {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return 'balanced';
}

/**
 * @param {PerformanceProfile} profile
 */
export function setPerformanceProfile(profile) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, profile);
  } catch {
    /* ignore */
  }
}

/**
 * @param {PerformanceProfile} profile
 */
export function meterIntervalMsForProfile(profile) {
  if (profile === 'low') {
    return 140;
  }
  if (profile === 'high') {
    return 50;
  }
  return 80;
}

/**
 * @param {PerformanceProfile} profile
 */
export function levelMeterLightMode(profile) {
  return profile === 'low';
}
