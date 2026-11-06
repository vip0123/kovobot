import { type Config, ConfigError, loadConfig } from "@kovobot/config";

/**
 * The server's settings from the environment. If the environment is wrong, it
 * prints every problem and exits, for the server and the commands alike.
 */
export function configOrExit(): { config: Config; warnings: string[] } {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
