// Tiny .env reader (zero dependencies). Values are never logged or sent
// anywhere but X's own token endpoints -- the consumer secret in particular
// must never reach the browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  const out = {};

  // The .env file is a local-development convenience and is deliberately never
  // deployed. Its absence must NOT short-circuit this function: on a real host
  // there is no file and *every* value comes from the real environment. An
  // early `return {}` here meant a deployed server saw no X credentials, no
  // platform-assigned PORT and no DATA_DIR, while working perfectly on a
  // machine that happened to have a .env.
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) {
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }

  // Real environment variables always win over the file.
  return { ...out, ...process.env };
}

export { ROOT };
