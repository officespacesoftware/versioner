import { Command } from "commander";
import { registerIncrementRC } from "./commands/increment-rc.js";
import { registerCreateRC } from "./commands/create-rc.js";
import { registerCreateHotfix } from "./commands/create-hotfix.js";
import { registerReleaseVersion } from "./commands/release-version.js";
import { registerInitializeVersioner } from "./commands/initialize-versioner.js";
import { registerDownmerge } from "./commands/downmerge.js";
import { registerListVersions } from "./commands/list-versions.js";

const program = new Command();

program
  .name("release-management")
  .description("Git Flow release management CLI — same workflows as the MCP, scriptable from any shell or GitHub Actions")
  .option("--json", "Emit structured JSON instead of human-readable text")
  .option("--quiet", "Suppress progress logging; only emit the final result");

// Note: no program.version() — subcommands take `--version <ver>` as a release
// version argument and the global flag would short-circuit it.

registerListVersions(program);
registerCreateRC(program);
registerCreateHotfix(program);
registerIncrementRC(program);
registerReleaseVersion(program);
registerInitializeVersioner(program);
registerDownmerge(program);

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
