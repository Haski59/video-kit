// Child process for the S-ID allocation race: register N distinct sources against one shared registry.
import { registerShort } from "../../engine/ingest/identity.js";
const [registryFile, tag, n] = process.argv.slice(2);
const out = [];
for (let i = 0; i < Number(n); i++) {
  const sha = (tag + String(i)).padEnd(64, "0").replace(/[^0-9a-f]/g, "a").slice(0, 64);
  out.push(registerShort({ registryFile, source: { sha256: sha, filename: `${tag}-${i}.mov` }, type: "reel" }).id);
}
process.stdout.write(JSON.stringify(out));
