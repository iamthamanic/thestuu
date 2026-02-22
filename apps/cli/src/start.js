import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import open from 'open';
import { createDefaultProject, parseProject, serializeProject } from '@thestuu/shared-json';

const execFileAsync = promisify(execFile);

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function cxxCmd() {
  if (process.env.STUU_NATIVE_CXX && process.env.STUU_NATIVE_CXX.trim()) {
    return process.env.STUU_NATIVE_CXX.trim();
  }
  return process.platform === 'win32' ? 'clang++.exe' : 'clang++';
}

function cmakeCmd() {
  if (process.env.STUU_NATIVE_CMAKE && process.env.STUU_NATIVE_CMAKE.trim()) {
    return process.env.STUU_NATIVE_CMAKE.trim();
  }
  return process.platform === 'win32' ? 'cmake.exe' : 'cmake';
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 25000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function probe() {
      const socket = net.createConnection({ host, port });

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for ${host}:${port}`));
          return;
        }
        setTimeout(probe, 250);
      });
    }

    probe();
  });
}

function waitForPortOrProcessExit(port, host, child, timeoutMs = 25000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let childExited = false;
    let childExitCode = null;
    let childExitSignal = null;

    function cleanup() {
      child.off('exit', onExit);
    }

    function rejectWith(message) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(message));
    }

    function resolveReady() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }

    function onExit(code, signal) {
      childExited = true;
      childExitCode = code;
      childExitSignal = signal;
    }

    function probe() {
      const socket = net.createConnection({ host, port });

      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });

      socket.once('error', () => {
        socket.destroy();
        if (childExited) {
          rejectWith(`Process exited before ${host}:${port} became ready (code ${childExitCode ?? 'null'}, signal ${childExitSignal ?? 'none'})`);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          rejectWith(`Timeout waiting for ${host}:${port}`);
          return;
        }
        setTimeout(probe, 250);
      });
    }

    child.on('exit', onExit);
    probe();
  });
}

function waitForUnixSocket(socketPath, timeoutMs = 25000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function probe() {
      const socket = net.createConnection({ path: socketPath });

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for unix socket ${socketPath}`));
          return;
        }
        setTimeout(probe, 200);
      });
    }

    probe();
  });
}

function runCommand(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isPortOpen(port, host = '127.0.0.1', timeoutMs = 600) {
  try {
    await waitForPort(port, host, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function requestJson(url, timeoutMs = 1200) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'http:') {
    return Promise.reject(new Error(`Unsupported protocol for ${url}: ${parsedUrl.protocol}`));
  }

  const port = parsedUrl.port ? Number(parsedUrl.port) : 80;
  const requestPath = `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsedUrl.hostname, port });
    let settled = false;
    let rawResponse = '';

    function finalize(handler, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      handler(value);
    }

    const timeout = setTimeout(() => {
      finalize(reject, new Error(`Timeout requesting ${url}`));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n`
        + `Host: ${parsedUrl.host}\r\n`
        + 'Connection: close\r\n'
        + 'Accept: application/json\r\n\r\n',
      );
    });
    socket.on('data', (chunk) => {
      rawResponse += chunk;
      if (rawResponse.length > 1024 * 1024) {
        finalize(reject, new Error(`Response too large from ${url}`));
      }
    });
    socket.once('end', () => {
      const separator = rawResponse.indexOf('\r\n\r\n');
      if (separator < 0) {
        finalize(reject, new Error(`Malformed HTTP response from ${url}`));
        return;
      }

      const header = rawResponse.slice(0, separator);
      const body = rawResponse.slice(separator + 4);
      const statusLine = header.split('\r\n')[0] || '';
      const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

      if (!body.trim()) {
        finalize(resolve, { statusCode, json: null });
        return;
      }

      try {
        finalize(resolve, { statusCode, json: JSON.parse(body) });
      } catch (error) {
        finalize(reject, new Error(`Invalid JSON response from ${url}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.once('error', (error) => {
      finalize(reject, error);
    });
  });
}

async function isEngineHealthy(port, host = '127.0.0.1', timeoutMs = 1200) {
  try {
    const { statusCode, json } = await requestJson(`http://${host}:${port}/health`, timeoutMs);
    return statusCode === 200 && json?.ok === true && json?.service === 'thestuu-engine';
  } catch {
    return false;
  }
}

async function hasRunningDashboardDevProcess(repoRoot) {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'command='], {
      cwd: repoRoot,
      maxBuffer: 2 * 1024 * 1024,
    });
    const dashboardPath = path.join(repoRoot, 'apps', 'dashboard');
    const repoNextBinary = path.join(repoRoot, 'node_modules', '.bin', 'next');
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => line.includes('next dev') && (line.includes(dashboardPath) || line.includes(repoNextBinary)));
  } catch {
    return false;
  }
}

async function getListeningCommandOnPort(port) {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout: pidStdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      maxBuffer: 1024 * 1024,
    });
    const pid = pidStdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^[0-9]+$/.test(line));
    if (!pid) {
      return null;
    }

    const { stdout: commandStdout } = await execFileAsync('ps', ['-p', pid, '-o', 'command='], {
      maxBuffer: 1024 * 1024,
    });
    const command = commandStdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

async function ensureNativeEngineBinary(repoRoot, options = {}) {
  const nativeRoot = path.join(repoRoot, 'apps', 'native-engine');
  const buildDir = path.join(nativeRoot, 'build');
  const cmake = cmakeCmd();
  const compiler = cxxCmd();
  const explicitTracktion = options.tracktionEnabled;
  const envTracktion = String(process.env.STUU_ENABLE_TRACKTION || '').toLowerCase();
  const tracktionEnabled = explicitTracktion === undefined
    ? ['1', 'true', 'on', 'yes'].includes(envTracktion)
    : Boolean(explicitTracktion);
  const vendorDir = (options.vendorDir || process.env.STUU_NATIVE_VENDOR_DIR || '').trim();

  await fs.mkdir(buildDir, { recursive: true });

  const configureArgs = [
    '-S', nativeRoot,
    '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DSTUU_ENABLE_TRACKTION=${tracktionEnabled ? 'ON' : 'OFF'}`,
  ];

  if (vendorDir) {
    configureArgs.push(`-DSTUU_THIRD_PARTY_DIR=${path.resolve(vendorDir)}`);
    configureArgs.push('-DTE_ADD_EXAMPLES=OFF');
  }
  if (process.env.STUU_NATIVE_CXX && process.env.STUU_NATIVE_CXX.trim()) {
    configureArgs.push(`-DCMAKE_CXX_COMPILER=${compiler}`);
  }

  console.log('[thestuu-cli] configuring native engine via CMake (Tracktion backend)...');
  await runCommand(cmake, configureArgs, { cwd: repoRoot });
  await runCommand(cmake, ['--build', buildDir, '--target', 'thestuu-native', '--config', 'Release'], { cwd: repoRoot });

  const candidates = [
    path.join(buildDir, process.platform === 'win32' ? 'thestuu-native.exe' : 'thestuu-native'),
    path.join(buildDir, 'Release', process.platform === 'win32' ? 'thestuu-native.exe' : 'thestuu-native'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next path
    }
  }

  throw new Error(`Native binary not found after build. Checked: ${candidates.join(', ')}`);
}

function spawnNativeEngine({ binaryPath, cwd, env, socketPath }) {
  const child = spawn(binaryPath, ['--socket', socketPath], {
    cwd,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[thestuu-cli] native-engine exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`);
    }
  });

  return child;
}

function spawnWorkspaceProcess({ workspace, script, cwd, env, name }) {
  const child = spawn(npmCmd(), ['run', script, '--workspace', workspace], {
    cwd,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[thestuu-cli] ${name} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`);
    }
  });

  return child;
}

async function ensureHomeFiles(stuuHome, requestedProject) {
  const projectsDir = path.join(stuuHome, 'projects');
  const configPath = path.join(stuuHome, 'config.json');
  const projectName = requestedProject.endsWith('.stu') ? requestedProject : `${requestedProject}.stu`;
  const projectPath = path.join(projectsDir, projectName);

  await fs.mkdir(projectsDir, { recursive: true });

  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date().toISOString(),
          default_project: projectName,
          audio: {
            sample_rate: 48000,
            buffer_size: 256,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  try {
    const raw = await fs.readFile(projectPath, 'utf8');
    parseProject(raw);
  } catch {
    const project = createDefaultProject('Welcome to TheStuu');
    await fs.writeFile(projectPath, serializeProject(project), 'utf8');
  }

  return { projectPath, projectsDir, configPath };
}

function attachShutdown(children) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    for (const child of children) {
      if (!child || child.killed) {
        continue;
      }
      child.kill('SIGTERM');
    }

    setTimeout(() => process.exit(0), 250);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const DEFAULT_VENDOR_SUBPATH = path.join('vendor', 'tracktion_engine');

export async function runStartCommand(options) {
  const commandFile = fileURLToPath(import.meta.url);
  const cliDir = path.resolve(path.dirname(commandFile), '..');
  const repoRoot = path.resolve(cliDir, '..', '..');

  const stuuHome = process.env.STUU_HOME || path.join(os.homedir(), '.thestuu');
  const host = process.env.STUU_HOST || '127.0.0.1';
  const vendorDirRaw = (options.nativeVendorDir || process.env.STUU_NATIVE_VENDOR_DIR || '').trim();
  const vendorDir = vendorDirRaw || path.join(repoRoot, DEFAULT_VENDOR_SUBPATH);

  if (options.native !== false) {
    try {
      await fs.access(path.join(vendorDir, 'CMakeLists.txt'));
    } catch {
      throw new Error(
        `TheStuu benötigt das Tracktion-Backend. Kein tracktion_engine unter: ${vendorDir}. ` +
        'Setze STUU_NATIVE_VENDOR_DIR auf den Pfad zu einem tracktion_engine-Klon (mit JUCE-Submodule) oder starte mit --native-vendor-dir <pfad>. Siehe apps/native-engine/README.md bzw. scripts/setup-tracktion.sh.'
      );
    }
  }

  const { projectPath } = await ensureHomeFiles(stuuHome, options.project || 'welcome.stu');

  const commonEnv = {
    ...process.env,
    STUU_HOME: stuuHome,
  };
  const tracktionRequested = options.nativeBackend === 'tracktion';
  const nativeBuildEnv = {
    ...commonEnv,
    STUU_ENABLE_TRACKTION: tracktionRequested ? '1' : '0',
  };

  let nativeChild = null;
  let engineChild = null;
  let engineMode = 'spawned';
  const nativeSocketPath = options.nativeSocket
    ? path.resolve(options.nativeSocket)
    : path.join(os.tmpdir(), `thestuu-native-${process.pid}.sock`);
  const engineAlreadyOpen = await isPortOpen(options.enginePort, host, 800);
  if (engineAlreadyOpen) {
    const engineHealthy = await isEngineHealthy(options.enginePort, host, 1200);
    if (!engineHealthy) {
      const commandOnPort = await getListeningCommandOnPort(options.enginePort);
      const looksLikeEngineProcess = typeof commandOnPort === 'string'
        && /\bnode\b.*\bsrc\/server\.js\b/.test(commandOnPort);
      if (!looksLikeEngineProcess) {
        throw new Error(
          `Engine port ${host}:${options.enginePort} is already in use by a non-TheStuu service. ` +
          'Stop the conflicting process or choose another --engine-port.',
        );
      }
      console.warn(
        `[thestuu-cli] engine health probe unavailable on ${host}:${options.enginePort}; ` +
        `reusing existing engine process (${commandOnPort}).`,
      );
    }
    engineMode = 'reused-existing';
    console.log(`[thestuu-cli] engine port ${host}:${options.enginePort} already active, reusing existing process.`);
  } else {
    if (options.native !== false) {
      try {
        await fs.unlink(nativeSocketPath);
      } catch {
        // ignore stale socket cleanup failures
      }

      const nativeBinary = await ensureNativeEngineBinary(repoRoot, {
        tracktionEnabled: tracktionRequested,
        vendorDir,
      });
      nativeChild = spawnNativeEngine({
        binaryPath: nativeBinary,
        cwd: repoRoot,
        env: {
          ...nativeBuildEnv,
          STUU_NATIVE_SOCKET: nativeSocketPath,
        },
        socketPath: nativeSocketPath,
      });

      await waitForUnixSocket(nativeSocketPath);
    }

    engineChild = spawnWorkspaceProcess({
      workspace: '@thestuu/engine',
      script: 'start',
      cwd: repoRoot,
      env: {
        ...commonEnv,
        ENGINE_PORT: String(options.enginePort),
        ENGINE_HOST: host,
        STUU_NATIVE_TRANSPORT: options.native === false ? '0' : '1',
        STUU_NATIVE_SOCKET: nativeSocketPath,
      },
      name: 'engine',
    });

    try {
      await waitForPortOrProcessExit(options.enginePort, host, engineChild);
    } catch (firstError) {
      const portNowOpen = await isPortOpen(options.enginePort, host, 800);
      let canReuseExistingEngine = false;

      if (portNowOpen) {
        if (await isEngineHealthy(options.enginePort, host, 1200)) {
          canReuseExistingEngine = true;
        } else {
          const commandOnPort = await getListeningCommandOnPort(options.enginePort);
          const looksLikeEngineProcess = typeof commandOnPort === 'string'
            && /\bnode\b.*\bsrc\/server\.js\b/.test(commandOnPort);
          if (looksLikeEngineProcess) {
            canReuseExistingEngine = true;
            console.warn(
              `[thestuu-cli] engine health probe unavailable on ${host}:${options.enginePort}; ` +
              `reusing existing engine process (${commandOnPort}).`,
            );
          }
        }
      }

      if (!canReuseExistingEngine) {
        throw firstError;
      }

      engineMode = 'reused-existing';
      if (engineChild && !engineChild.killed) {
        engineChild.kill('SIGTERM');
      }
      engineChild = null;

      if (nativeChild && !nativeChild.killed) {
        nativeChild.kill('SIGTERM');
      }
      nativeChild = null;

      console.warn(`[thestuu-cli] engine port ${host}:${options.enginePort} became active during startup, reusing existing process.`);
    }
  }

  const dashboardEnv = {
    ...commonEnv,
    PORT: String(options.port),
    HOSTNAME: host,
    NEXT_PUBLIC_ENGINE_URL: `http://${host}:${options.enginePort}`,
  };
  const dashboardLockPath = path.join(repoRoot, 'apps', 'dashboard', '.next', 'dev', 'lock');
  let dashboardMode = 'spawned';
  let dashboardChild = null;

  if (await isPortOpen(options.port, host, 800)) {
    dashboardMode = 'reused-existing';
    console.log(`[thestuu-cli] dashboard port ${host}:${options.port} already active, reusing existing process.`);
  } else {
    const spawnDashboard = () => spawnWorkspaceProcess({
      workspace: '@thestuu/dashboard',
      script: 'dev',
      cwd: repoRoot,
      env: dashboardEnv,
      name: 'dashboard',
    });

    dashboardChild = spawnDashboard();

    try {
      await waitForPortOrProcessExit(options.port, host, dashboardChild);
    } catch (firstError) {
      const lockExists = await fileExists(dashboardLockPath);
      const portNowOpen = await isPortOpen(options.port, host, 800);
      if (portNowOpen) {
        dashboardMode = 'reused-existing';
        dashboardChild = null;
      } else if (lockExists) {
        const hasRunningDevProcess = await hasRunningDashboardDevProcess(repoRoot);
        if (hasRunningDevProcess) {
          throw new Error(
            `Dashboard lock conflict (${dashboardLockPath}): another next dev process is active. ` +
            `Stop it or choose another --port (current: ${options.port}).`,
          );
        }

        try {
          await fs.unlink(dashboardLockPath);
          console.warn(`[thestuu-cli] removed stale dashboard lock: ${dashboardLockPath}`);
        } catch (unlinkError) {
          throw new Error(
            `Dashboard start failed and stale lock could not be removed (${dashboardLockPath}): ` +
            `${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }

        dashboardChild = spawnDashboard();
        await waitForPortOrProcessExit(options.port, host, dashboardChild);
      } else {
        throw firstError;
      }
    }
  }

  attachShutdown([nativeChild, engineChild, dashboardChild]);

  const dashboardUrl = `http://${host}:${options.port}`;

  console.log(`[thestuu-cli] home: ${stuuHome}`);
  console.log(`[thestuu-cli] project: ${projectPath}`);
  console.log(`[thestuu-cli] engine: http://${host}:${options.enginePort}`);
  console.log(`[thestuu-cli] engine mode: ${engineMode}`);
  console.log(`[thestuu-cli] dashboard: ${dashboardUrl}`);
  console.log(`[thestuu-cli] dashboard mode: ${dashboardMode}`);
  if (options.native !== false && nativeChild) {
    console.log(`[thestuu-cli] native socket: ${nativeSocketPath}`);
    console.log('[thestuu-cli] native backend: tracktion');
    console.log(`[thestuu-cli] native vendor dir: ${vendorDir}`);
  } else if (options.native !== false) {
    console.log('[thestuu-cli] native mode: reused with existing engine process');
  }

  if (options.browser) {
    await open(dashboardUrl);
  }

  console.log('[thestuu-cli] TheStuu is running. Press Ctrl+C to stop.');

  await new Promise(() => {});
}
