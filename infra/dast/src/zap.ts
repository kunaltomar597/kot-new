import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * How ZAP runs: an installed ZAP (`ZAP_PATH`: its `zap.sh`, or `zap.bat` on Windows) on a
 * developer's machine, or its container (`ZAP_DOCKER_IMAGE`) in CI. Either runs an Automation
 * Framework plan without a window and exits.
 */
export type ZapRunner =
  | { readonly kind: 'local'; readonly command: string }
  | { readonly kind: 'docker'; readonly image: string };

export function zapRunnerFrom(env: NodeJS.ProcessEnv): ZapRunner | undefined {
  const local = env.ZAP_PATH?.trim();
  if (local !== undefined && local !== '') return { kind: 'local', command: local };
  const image = env.ZAP_DOCKER_IMAGE?.trim();
  if (image !== undefined && image !== '') return { kind: 'docker', image };
  return undefined;
}

/** The run's folder as ZAP sees it: the folder itself, or where the container mounts it. */
export function zapFolder(runner: ZapRunner, folder: string): string {
  return runner.kind === 'docker' ? '/zap/wrk' : folder;
}

/** The command line that runs `plan` (a file in `folder`). */
export function zapCommand(
  runner: ZapRunner,
  folder: string,
  plan: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (runner.kind === 'local') {
    // A ZAP home of the run's own: no settings or add-ons carried over from other runs.
    return {
      command: runner.command,
      args: ['-cmd', '-dir', join(folder, 'home'), '-autorun', join(folder, plan)],
    };
  }
  // Host networking: the surfaces listen on 127.0.0.1 of the machine running the tests.
  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      `${folder}:/zap/wrk:rw`,
      runner.image,
      'zap.sh',
      '-cmd',
      '-autorun',
      `/zap/wrk/${plan}`,
    ],
  };
}

/**
 * Runs a plan; ZAP's output goes to `zap.log` in the folder. Resolves with ZAP's exit code (0 when
 * every job ran), or rejects when it outlives `timeoutMs`.
 */
export async function runZap(
  runner: ZapRunner,
  folder: string,
  plan: string,
  timeoutMs: number,
): Promise<number> {
  // The container's user is not the runner's: it must be able to write its reports here.
  if (runner.kind === 'docker') chmodSync(folder, 0o777);
  const { command, args } = zapCommand(runner, folder, plan);
  const log = createWriteStream(join(folder, 'zap.log'));
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(`ZAP did not finish ${plan} within ${String(timeoutMs / 60_000)} minutes`),
        );
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
  } finally {
    await new Promise((resolve) => log.end(resolve));
  }
}
