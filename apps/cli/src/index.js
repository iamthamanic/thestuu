import { runStartCommand } from './start.js';

function printHelp() {
  console.log(`
TheStuu CLI

Usage:
  thestuu dev [options]     Recommended: clean start, full stack (native + engine + UI)
  thestuu start [options]   Same as dev (alias)

Options:
  --desktop               Open Tauri window instead of browser (still starts native + engine first)
  --reuse                 Do not kill :3990/:3010; reuse engine only if native/Tracktion already ready
  --no-clean              Skip killing stale dev processes (same as --reuse for ports)
  --port <number>         Dashboard port (default: 3010)
  --engine-port <number>  Engine port (default: 3990)
  --project <name>        Project filename in ~/.thestuu/projects
  --native-backend <id>   Native backend: tracktion (required)
  --native-vendor-dir <path> Path to tracktion_engine clone
  --native-socket <path>  Unix socket (default: /tmp/thestuu-native.sock — matches Tauri)
  --no-native             Disable native transport process
  --legacy-daw            Legacy JSON DAW mode (QA only)
  --no-browser            Do not open browser (default when using --desktop)
  -h, --help              Show help

Examples:
  npm run dev
  npm run dev -- --desktop
  npm run start -- --no-browser
  npm run start -- --reuse
`);
}

function parseArgs(argv) {
  const options = {
    port: 3010,
    enginePort: 3990,
    browser: true,
    project: 'welcome.stu',
    native: true,
    nativeBackend: 'tracktion',
    nativeVendorDir: null,
    nativeSocket: null,
    legacyDaw: false,
    clean: false,
    reuse: false,
    desktop: false,
    dawReadyTimeoutMs: 120000,
  };

  const args = [...argv];
  let command = args[0] === 'dev' || args[0] === 'start' ? args.shift() : 'dev';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--port') {
      options.port = Number(args[index + 1] || options.port);
      index += 1;
      continue;
    }

    if (arg === '--engine-port') {
      options.enginePort = Number(args[index + 1] || options.enginePort);
      index += 1;
      continue;
    }

    if (arg === '--project') {
      options.project = args[index + 1] || options.project;
      index += 1;
      continue;
    }

    if (arg === '--native-socket') {
      options.nativeSocket = args[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--native-backend') {
      const nextValue = (args[index + 1] || '').toLowerCase();
      if (nextValue !== 'tracktion') {
        throw new Error(`Invalid value for --native-backend: ${args[index + 1]}. Nur "tracktion" wird unterstützt.`);
      }
      options.nativeBackend = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--native-vendor-dir') {
      options.nativeVendorDir = args[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--no-browser') {
      options.browser = false;
      continue;
    }

    if (arg === '--no-native') {
      options.native = false;
      continue;
    }

    if (arg === '--legacy-daw') {
      options.legacyDaw = true;
      continue;
    }

    if (arg === '--desktop') {
      options.desktop = true;
      options.browser = false;
      continue;
    }

    if (arg === '--reuse') {
      options.reuse = true;
      continue;
    }

    if (arg === '--no-clean') {
      options.reuse = true;
      continue;
    }

    if (arg === '--clean') {
      options.clean = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.reuse) {
    options.clean = true;
  }

  return { command, options };
}

export async function runCli(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  const { command, options } = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (command === 'dev' || command === 'start') {
    await runStartCommand(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
