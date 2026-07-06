const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.142.5\n");
  process.exit(0);
}

process.stderr.write(JSON.stringify({ event: "fake-stderr-started" }) + "\n");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let count = 0;
rl.on("line", (line) => {
  count += 1;
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = { raw: line };
  }
  process.stdout.write(
    JSON.stringify({
      id: parsed.id ?? count,
      result: {
        ok: true,
        echo: parsed,
      },
    }) + "\n",
  );
});

rl.on("close", () => {
  process.exit(0);
});
