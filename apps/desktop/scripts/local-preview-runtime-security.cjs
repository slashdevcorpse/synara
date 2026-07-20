// FILE: local-preview-runtime-security.cjs
// Purpose: Probes the pinned Electron runtime's local-preview document-start guard in every frame.
// Layer: Desktop security smoke test

const { readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");

const { app, BrowserWindow } = require("electron");

const { source: guardSource } = JSON.parse(
  readFileSync(join(__dirname, "../src/localPreviewRuntimeGuard.json"), "utf8"),
);
const blockedNames = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
const resultPath = process.env.SYNARA_LOCAL_PREVIEW_SECURITY_RESULT;
let probeStep = "startup";

function report(result) {
  if (resultPath) {
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  }
}

report({ stage: "started" });

function inlineScriptString(value) {
  return JSON.stringify(value).replaceAll("</script", "<\\/script");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Probe server did not receive a TCP address."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function frameDocument(label) {
  return `<!doctype html><meta charset="utf-8"><script>
    const names = ${JSON.stringify(blockedNames)};
    function inspect(scope) {
      const before = Object.fromEntries(names.map((name) => [name, typeof scope[name]]));
      for (const name of names) {
        try { scope[name] = function bypass() {}; } catch {}
        try { Object.defineProperty(scope, name, { configurable: true, value: function bypass() {} }); } catch {}
        try { delete scope[name]; } catch {}
      }
      return {
        before,
        after: Object.fromEntries(names.map((name) => [name, typeof scope[name]])),
      };
    }
    parent.postMessage({ probeFrame: ${JSON.stringify(label)}, result: inspect(window) }, "*");
  </script>`;
}

function entryDocument(crossOrigin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Local preview guard probe</title></head><body>
  <script>
    const names = ${JSON.stringify(blockedNames)};
    function inspect(scope) {
      const before = Object.fromEntries(names.map((name) => [name, typeof scope[name]]));
      for (const name of names) {
        try { scope[name] = function bypass() {}; } catch {}
        try { Object.defineProperty(scope, name, { configurable: true, value: function bypass() {} }); } catch {}
        try { delete scope[name]; } catch {}
      }
      return {
        before,
        after: Object.fromEntries(names.map((name) => [name, typeof scope[name]])),
      };
    }

    window.__probeResults = { top: inspect(window) };
    window.addEventListener("message", (event) => {
      if (event.data && typeof event.data.probeFrame === "string") {
        window.__probeResults[event.data.probeFrame] = event.data.result;
      }
    });

    const blank = document.createElement("iframe");
    document.documentElement.append(blank);
    window.__probeResults.aboutBlank = inspect(blank.contentWindow);

    const srcdoc = document.createElement("iframe");
    srcdoc.srcdoc = ${inlineScriptString(frameDocument("srcdoc"))};
    document.documentElement.append(srcdoc);

    const sameOrigin = document.createElement("iframe");
    sameOrigin.src = "/frame";
    document.documentElement.append(sameOrigin);

    const crossOrigin = document.createElement("iframe");
    crossOrigin.src = ${JSON.stringify(`${crossOrigin}/frame`)};
    document.documentElement.append(crossOrigin);
  </script>
  </body></html>`;
}

function isGuarded(result) {
  return blockedNames.every(
    (name) => result?.before?.[name] === "undefined" && result?.after?.[name] === "undefined",
  );
}

async function waitForFrameResults(webContents) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const results = await webContents.executeJavaScript("window.__probeResults", true);
    if (
      results &&
      ["top", "aboutBlank", "srcdoc", "sameOrigin", "crossOrigin"].every((key) => results[key])
    ) {
      return results;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for every probe frame.");
}

async function run() {
  const crossServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(frameDocument("crossOrigin"));
  });
  const crossOrigin = await listen(crossServer);
  const entryServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/frame" ? frameDocument("sameOrigin") : entryDocument(crossOrigin),
    );
  });
  const entryOrigin = await listen(entryServer);
  let window = null;

  try {
    probeStep = "create-window";
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      report({ details, error: "Probe renderer exited.", stage: "renderer-gone", step: probeStep });
    });
    probeStep = "load-blank";
    await window.loadURL("about:blank");
    const { debugger: runtimeDebugger } = window.webContents;
    probeStep = "attach-debugger";
    runtimeDebugger.attach("1.3");
    probeStep = "page-enable";
    await runtimeDebugger.sendCommand("Page.enable");
    probeStep = "install-document-start-guard";
    await runtimeDebugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: guardSource,
      runImmediately: true,
    });
    probeStep = "verify-active-guard";
    const verification = await runtimeDebugger.sendCommand("Runtime.evaluate", {
      expression:
        "['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'].map((name) => typeof globalThis[name])",
      returnByValue: true,
    });
    if (
      !Array.isArray(verification?.result?.value) ||
      verification.result.value.some((value) => value !== "undefined")
    ) {
      throw new Error("The document-start guard was not active in the initial frame.");
    }
    probeStep = "load-entry";
    await window.loadURL(entryOrigin);
    probeStep = "collect-frame-results";
    const results = await waitForFrameResults(window.webContents);
    const passed = Object.values(results).every(isGuarded);
    report({ passed, results, stage: "complete" });
    process.exitCode = passed ? 0 : 1;
  } finally {
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    await Promise.all([closeServer(entryServer), closeServer(crossServer)]);
  }
}

app.disableHardwareAcceleration();

const hardTimeout = setTimeout(() => {
  report({
    error: "Electron did not complete the runtime probe within 20 seconds.",
    stage: "timeout",
  });
  process.exitCode = 1;
  app.exit(1);
}, 20_000);

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    report({
      error: error instanceof Error ? error.stack : String(error),
      stage: "error",
      step: probeStep,
    });
    process.exitCode = 1;
  } finally {
    clearTimeout(hardTimeout);
    app.quit();
  }
});
