import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_DIR_VARIABLE = "RELEASE_MANAGEMENT_OUTPUT_DIR";

let sequence = 0;

const timestamp = (date: Date): string =>
  date.toISOString().replace(/[-:.]/g, "");

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.startsWith(code)
      ? `${code}: ${error.message}`
      : error.message;
  }
  return String(error);
};

export const writeStructuredOutput = async (
  tool: string,
  structured: unknown
): Promise<string> => {
  const dir = process.env[OUTPUT_DIR_VARIABLE];
  if (!dir) {
    return "";
  }
  sequence += 1;
  const seq = String(sequence).padStart(6, "0");
  const name = `${timestamp(new Date())}-${seq}-${tool}.json`;
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(structured, null, 2)}\n`, {
      mode: 0o644,
    });
    await rename(temp, target);
    return "";
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return (
      `\n\n⚠️  The structured output could not be written to ` +
      `${OUTPUT_DIR_VARIABLE}: ${describe(error)}`
    );
  }
};
