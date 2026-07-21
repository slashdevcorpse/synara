import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const fixturePath = fileURLToPath(import.meta.url);

if (mode === "grandchild") {
  process.stdout.on("error", () => undefined);
  process.stdout.write(`ACP_JOB_GRANDCHILD:${process.pid}\n`);
  setInterval(() => undefined, 1_000);
} else if (mode === "child") {
  process.stdout.write(`ACP_JOB_CHILD:${process.pid}\n`);
  const grandchild = spawn(process.execPath, [fixturePath, "grandchild"], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
    windowsHide: true,
  });
  grandchild.unref();
  grandchild.stdout.once("data", (chunk) => {
    process.stdout.write(chunk, () => process.exit(0));
  });
} else if (mode === "root" || mode === "orphan-root") {
  process.stdout.write(`ACP_JOB_ROOT:${process.pid}\n`);
  spawn(process.execPath, [fixturePath, "child"], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  process.stdin.resume();
  if (mode === "root") {
    process.stdin.on("end", () => process.exit(0));
  } else {
    process.stdin.on("end", () => undefined);
    setInterval(() => undefined, 1_000);
  }
} else if (mode === "launcher") {
  const [helperPath, encodedExecutable, encodedCommandLine] = process.argv.slice(3);
  if (!helperPath || !encodedExecutable || !encodedCommandLine) {
    process.stderr.write("Launcher fixture requires the helper and two encoded launch values.\n");
    process.exit(64);
  }
  const wrapper = spawn(
    helperPath,
    [encodedExecutable, encodedCommandLine, String(process.pid)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  process.stdout.write(`ACP_JOB_WRAPPER:${wrapper.pid}\n`);
  let observedGrandchild = false;
  const forward = (chunk, target) => {
    target.write(chunk);
    if (!observedGrandchild && chunk.toString().includes("ACP_JOB_GRANDCHILD:")) {
      observedGrandchild = true;
      setTimeout(() => process.exit(0), 25);
    }
  };
  wrapper.stdout.on("data", (chunk) => forward(chunk, process.stdout));
  wrapper.stderr.on("data", (chunk) => forward(chunk, process.stderr));
  setTimeout(() => {
    process.stderr.write("Launcher fixture timed out waiting for the provider tree.\n");
    process.exit(70);
  }, 10_000).unref();
} else {
  process.stderr.write("Expected a Windows ACP Job Object fixture mode.\n");
  process.exit(64);
}
