/**
 * GitHub Action entrypoint.
 *
 * The action is a thin adapter over the existing CLI: it reads the documented
 * `paths` and `external` inputs from the standard `INPUT_<NAME>` environment
 * variables, builds the CLI argument list, and calls the typed `run(...)`
 * in-process. It never spawns a shell, never parses CLI output, and never
 * changes the working directory, so caller-relative paths keep resolving from
 * the caller's workspace while the action itself is loaded from its own
 * checkout.
 *
 * The wrapper itself lives in `action-runner.ts` so it can be exercised
 * in-process without triggering this entrypoint's one-shot execution. This file
 * only re-exports the wrapper's surface and starts one action run.
 *
 * This file has no dependency on action-owned assets: the reproducible
 * `action-dist/index.cjs` bundle is self-contained, so no `import.meta.url` or
 * `__dirname` lookup is needed at runtime.
 */
import {
  ActionInputError,
  buildCommandLine,
  createProcessIo,
  readActionInputs,
  runAction,
  type ActionInputs,
} from './action-runner.js';
import { formatInternalErrorText } from './run.js';

export { ActionInputError, buildCommandLine, createProcessIo, readActionInputs, runAction };
export type { ActionInputs };

const io = createProcessIo();

// Set the exit code instead of calling process.exit() so stdout and stderr are
// flushed, and await the whole async check chain before Node exits.
void runAction(process.env, io)
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error: unknown) => {
    io.writeError(formatInternalErrorText(error));
    process.exitCode = 2;
  });
