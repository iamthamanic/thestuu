import { runStartCommand } from './start.js';

function printHelp() {
  console.log(`
TheStuu CLI

Usage:
  thestuu start [options]

Options:
  --port <number>         Dashboard port (default: 3000)
  --engine-port <number>  Engine port (default: 3987)
  --project <name>        Project filename in ~/.thestuu/projects
  --native-backend <id>   Native backend: tracktion | stub (default: tracktion)
  --native-vendor-dir <path> Path containing JUCE + tracktion_engine sources
  --native-socket <path>  Unix socket path for native transport bridge
  --no-native             Disable native transport process and use JS transport clock
  --no-browser            Do not open browser automatically
  -h, --help              Show help
`);
}

function parseArgs(argv) {
  const options = {
    port: 3000,
    enginePort: 3987,
    browser: true,
    project: 'welcome.stu',
    native: true,
    nativeBackend: 'tracktion',
    nativeVendorDir: null,
    nativeSocket: null,
  };

  const args = [...argv];
  const command = args[0];

  for (let index = 1; index < args.length; index += 1) {
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
      if (nextValue !== 'stub' && nextValue !== 'tracktion') {
        throw new Error(`Invalid value for --native-backend: ${args[index + 1]}. Use "stub" or "tracktion".`);
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

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
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

  if (command === 'start') {
    await runStartCommand(options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
