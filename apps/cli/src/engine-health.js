/**
 * Engine /health probes for CLI startup and reuse checks.
 */

import net from 'node:net';

function requestJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const port = Number(urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80));
    const host = urlObj.hostname || '127.0.0.1';
    const path = `${urlObj.pathname}${urlObj.search}`;

    let settled = false;
    let rawResponse = '';

    function finalize(fn, value) {
      if (settled) return;
      settled = true;
      fn(value);
    }

    const socket = net.createConnection({ host, port }, () => {
      socket.write(`GET ${path || '/'} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
    });

    const timer = setTimeout(() => {
      socket.destroy();
      finalize(reject, new Error(`timeout: ${url}`));
    }, timeoutMs);

    socket.on('data', (chunk) => {
      rawResponse += chunk;
      if (rawResponse.length > 1024 * 1024) {
        clearTimeout(timer);
        socket.destroy();
        finalize(reject, new Error(`response too large: ${url}`));
      }
    });

    socket.once('end', () => {
      clearTimeout(timer);
      const separator = rawResponse.indexOf('\r\n\r\n');
      if (separator < 0) {
        finalize(reject, new Error(`malformed HTTP: ${url}`));
        return;
      }
      const statusLine = rawResponse.slice(0, separator).split('\r\n')[0] || '';
      const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      const body = rawResponse.slice(separator + 4).trim();
      let json = null;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch (error) {
          finalize(reject, error);
          return;
        }
      }
      finalize(resolve, { statusCode, json });
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      finalize(reject, error);
    });
  });
}

export async function fetchEngineHealth(port, host = '127.0.0.1', timeoutMs = 2000) {
  try {
    return await requestJson(`http://${host}:${port}/health`, timeoutMs);
  } catch {
    return { statusCode: 0, json: null };
  }
}

export async function isEngineHealthy(port, host = '127.0.0.1', timeoutMs = 1200) {
  const { statusCode, json } = await fetchEngineHealth(port, host, timeoutMs);
  return statusCode === 200 && json?.ok === true && json?.service === 'thestuu-engine';
}

/**
 * @param {number} port
 * @param {string} host
 * @param {string | null} expectedNativeSocket
 */
export async function isEngineDawReady(port, host, expectedNativeSocket, timeoutMs = 2000) {
  const { statusCode, json } = await fetchEngineHealth(port, host, timeoutMs);
  if (statusCode !== 200 || !json?.ok || json?.service !== 'thestuu-engine') {
    return false;
  }
  const diag = json.diagnostics && typeof json.diagnostics === 'object'
    ? json.diagnostics
    : {};
  if (diag.dawReady === true) {
    return true;
  }
  const tracktionUp = Boolean(json.nativeTransport || diag.tracktionReady);
  const ipcUp = diag.ipcConnected !== false;
  if (!tracktionUp || !ipcUp) {
    return false;
  }
  if (!expectedNativeSocket) {
    return true;
  }
  const diagSocket = diag.nativeSocketPath ?? json.nativeSocketPath ?? null;
  if (!diagSocket) {
    return true;
  }
  return diagSocket === expectedNativeSocket;
}

/**
 * @param {number} port
 * @param {string} host
 * @param {number} timeoutMs
 */
export async function waitForEngineDawReady(port, host, expectedNativeSocket, timeoutMs = 90000) {
  const start = Date.now();
  let lastLogMs = 0;
  while (Date.now() - start < timeoutMs) {
    if (await isEngineDawReady(port, host, expectedNativeSocket, 2500)) {
      return true;
    }
    const elapsed = Date.now() - start;
    if (elapsed - lastLogMs >= 5000) {
      console.log('[thestuu-cli] waiting for native/Tracktion on engine /health…');
      lastLogMs = elapsed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
