// Placeholder DSP interfaces fuer die spaetere C++ Implementierung.
export function stuuQProcessBand({ gainDb = 0, q = 1, frequencyHz = 1000 }) {
  return {
    gainDb,
    q,
    frequencyHz,
    status: 'stub',
  };
}

export function stuuCompProcess({ thresholdDb = -12, ratio = 4, attackMs = 10, releaseMs = 120 }) {
  return {
    thresholdDb,
    ratio,
    attackMs,
    releaseMs,
    status: 'stub',
  };
}
