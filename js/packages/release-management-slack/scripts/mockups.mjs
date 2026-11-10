// Print a Block Kit Builder link for every message the app posts, rendered
// from the structured fixtures. With --write, also save each one to
// test/fixtures/mockups/<name>.json, which the tests compare against.
//   npm run mockups [-- --write] [-- <name filter>]

import { mkdirSync, writeFileSync } from "node:fs";

import { builderUrl, messages } from "../test/mockup-messages.mjs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const filter = args.find((a) => !a.startsWith("--"));
const out = new URL("../test/fixtures/mockups/", import.meta.url);

if (write) {
  mkdirSync(out, { recursive: true });
}
for (const [name, message] of Object.entries(messages())) {
  if (filter && !name.includes(filter)) {
    continue;
  }
  if (write) {
    writeFileSync(
      new URL(`${name}.json`, out),
      JSON.stringify(message.view ?? { blocks: message.blocks }, null, 2) + "\n"
    );
  }
  console.log(`${name}\n  ${builderUrl(message)}\n`);
}
