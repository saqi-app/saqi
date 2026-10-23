import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const resultDirectory =
  process.env.SAQI_RIG_RESULT_DIR ??
  join(homedir(), ".local", "state", "saqi", "results");

export function resultPath(attemptId, directory = resultDirectory) {
  return join(directory, `saqi-rig-${attemptId}.json`);
}

export function recoveryResultPaths(
  attemptId,
  {
    directory = resultDirectory,
    home = homedir(),
    temporaryDirectory = tmpdir(),
  } = {}
) {
  return [
    ...new Set([
      resultPath(attemptId, directory),
      resultPath(
        attemptId,
        join(home, "Library", "Application Support", "Saqi", "results")
      ),
      resultPath(attemptId, temporaryDirectory),
    ]),
  ];
}
