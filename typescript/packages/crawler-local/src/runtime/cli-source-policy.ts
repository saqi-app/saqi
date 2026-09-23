import { SourceConfigurationSchema } from "@saqi/precedent-iso";
import type { SourceConfiguration } from "@saqi/source-adapter";

export type CliSourceInitialization = "environment" | "keychain" | "none";

interface CliSourceOptions {
  readonly command: string | undefined;
  readonly commandArguments?: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly loadManagedSource: () => Promise<SourceConfiguration>;
}

const KEYCHAIN_MANAGED_COMMANDS: ReadonlySet<string> = new Set([
  "run-service",
  "set-concurrency",
]);

const CONFIG_BOUND_LEDGER_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "resume-paid",
  "status",
  "verify",
  "verify-source",
]);

const SOURCE_INDEPENDENT_COMMANDS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "help",
  "health",
  "install-cdp-browser-service",
  "doctor",
  "completion-plan",
  "clear-source-failures",
  "clear-source-stop",
  "fetch-resolution",
  "install-service",
  "install-runtime",
  "import-sol-operations",
  "pause",
  "pause-paid",
  "requeue-render-failures",
  "resume",
  "run-collector",
  "runtime-retention",
  "validate-resolution",
]);

/** Selects the source-identity authority before a CLI command can do work. */
export function cliSourceInitialization(
  command: string | undefined,
  commandArguments: readonly string[] = [],
): CliSourceInitialization {
  if (command === "service-control")
    return serviceControlAction(commandArguments) === "stop"
      ? "none"
      : "keychain";
  if (command !== undefined && KEYCHAIN_MANAGED_COMMANDS.has(command))
    return "keychain";
  if (
    command !== undefined &&
    CONFIG_BOUND_LEDGER_COMMANDS.has(command) &&
    commandArguments.includes("--config")
  )
    return "keychain";
  if (command !== undefined && SOURCE_INDEPENDENT_COMMANDS.has(command))
    return "none";
  return "environment";
}

function serviceControlAction(values: readonly string[]): string | undefined {
  const index = values.indexOf("--action");
  return index < 0 ? undefined : values[index + 1];
}

/** Resolves one command's source identity without exposing credential values. */
export async function loadCliSourceConfiguration(
  options: CliSourceOptions,
): Promise<null | SourceConfiguration> {
  const mode = cliSourceInitialization(
    options.command,
    options.commandArguments,
  );
  if (mode === "none") return null;
  if (mode === "keychain") return options.loadManagedSource();
  const name = options.environment["SAQI_SOURCE_NAME"];
  const origin = options.environment["SAQI_SOURCE_BASE_URL"];
  if (name === undefined && origin === undefined) return null;
  if (name === undefined || origin === undefined) {
    throw new Error(
      "SAQI_SOURCE_NAME and SAQI_SOURCE_BASE_URL must be configured together",
    );
  }
  return SourceConfigurationSchema.parse({ name, origin });
}
