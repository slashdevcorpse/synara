import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import {
  LOCAL_PREVIEW_ROUTE_PREFIX,
  localPreviewContentTypeForPath,
} from "@synara/shared/localPreviewFiles";
import type { Plugin } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

const DEMO_SCRIPT_EXECUTED_MESSAGE = "synara-demo-script-executed";
const DEMO_FIXTURE_PATHS = [
  "demo.html",
  "demo-assets/styles/demo.css",
  "demo-assets/scripts/demo.js",
  "demo-assets/images/synara-preview.svg",
] as const;

function readDemoFixture(relativePath: (typeof DEMO_FIXTURE_PATHS)[number]): string {
  return readFileSync(
    fileURLToPath(new URL(`../../docs/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const instrumentedDemoScript = `${readDemoFixture("demo-assets/scripts/demo.js")}

const synaraPreviewScriptSource =
  document.currentScript instanceof HTMLScriptElement ? document.currentScript.src : null;
window.addEventListener(
  "load",
  async () => {
    const stylesheet = document.querySelector('link[rel="stylesheet"]');
    const image = document.querySelector("img.demo-mark");
    const card = document.querySelector(".demo-card");
    let stylesheetLoaded = false;
    try {
      stylesheetLoaded = stylesheet instanceof HTMLLinkElement && stylesheet.sheet !== null;
    } catch {
      stylesheetLoaded = false;
    }
    const corsProbe = {
      ok: false,
      status: null,
      containsDemoCardRule: false,
      error: null,
    };
    if (stylesheet instanceof HTMLLinkElement) {
      try {
        const response = await fetch(stylesheet.href, { cache: "no-store" });
        const css = await response.text();
        corsProbe.ok = response.ok;
        corsProbe.status = response.status;
        corsProbe.containsDemoCardRule = css.includes(".demo-card");
      } catch (error) {
        corsProbe.error = error instanceof Error ? error.message : String(error);
      }
    }
    window.parent.postMessage(
      {
        type: "${DEMO_SCRIPT_EXECUTED_MESSAGE}",
        href: window.location.href,
        status: document.querySelector("#script-status")?.textContent ?? null,
        scriptSrc: synaraPreviewScriptSource,
        stylesheetHref: stylesheet instanceof HTMLLinkElement ? stylesheet.href : null,
        stylesheetPresent: stylesheet instanceof HTMLLinkElement,
        stylesheetLoaded,
        cardPaddingTop: card instanceof HTMLElement ? getComputedStyle(card).paddingTop : null,
        imageSrc: image instanceof HTMLImageElement ? image.src : null,
        imageComplete: image instanceof HTMLImageElement && image.complete,
        imageNaturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
        corsProbe,
      },
      "*",
    );
  },
  { once: true },
);`;

const demoFixtureByPath = new Map<string, string>([
  ["demo.html", readDemoFixture("demo.html")],
  ["demo-assets/styles/demo.css", readDemoFixture("demo-assets/styles/demo.css")],
  ["demo-assets/scripts/demo.js", instrumentedDemoScript],
  [
    "demo-assets/images/synara-preview.svg",
    readDemoFixture("demo-assets/images/synara-preview.svg"),
  ],
]);

function localPreviewFixtureCsp(input: {
  grant: string;
  origin: string;
  purpose: "browser" | "preview";
}): string {
  if (input.purpose === "preview") {
    return [
      "sandbox",
      "default-src 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "frame-src 'none'",
      "child-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }
  const capabilitySource = `${input.origin}${LOCAL_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(input.grant)}/`;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${capabilitySource}`,
    `style-src 'unsafe-inline' ${capabilitySource}`,
    `img-src ${capabilitySource} data: blob:`,
    `font-src ${capabilitySource} data:`,
    `media-src ${capabilitySource} data: blob:`,
    `connect-src ${capabilitySource}`,
    "webrtc 'block'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function rawPathnameFromRequestTarget(requestTarget: string): string | null {
  const queryIndex = requestTarget.indexOf("?");
  const withoutQuery = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  if (withoutQuery.startsWith("/")) return withoutQuery;
  const schemeIndex = withoutQuery.indexOf("://");
  if (schemeIndex === -1) return null;
  const pathIndex = withoutQuery.indexOf("/", schemeIndex + 3);
  return pathIndex === -1 ? "/" : withoutQuery.slice(pathIndex);
}

function parseLocalPreviewFixturePath(pathname: string): {
  grant: string;
  purpose: "browser" | "preview";
  relativePath: string;
} | null {
  const prefix = `${LOCAL_PREVIEW_ROUTE_PREFIX}/`;
  const suffix = pathname.slice(prefix.length);
  const separatorIndex = suffix.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === suffix.length - 1) return null;

  let grant: string;
  let relativePathSegments: string[];
  const encodedRelativePathSegments = suffix.slice(separatorIndex + 1).split("/");
  try {
    grant = decodeURIComponent(suffix.slice(0, separatorIndex));
    relativePathSegments = encodedRelativePathSegments.map((segment) =>
      decodeURIComponent(segment),
    );
  } catch {
    return null;
  }
  const grantMatch = /^(preview|browser)-grant-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.exec(grant);
  if (
    !grantMatch ||
    grant.includes("\0") ||
    grant.includes("/") ||
    grant.includes("\\") ||
    relativePathSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0") ||
        segment.includes("/") ||
        segment.includes("\\") ||
        /^[A-Za-z]:/.test(segment),
    )
  ) {
    return null;
  }
  const relativePath = relativePathSegments.join("/");
  return {
    grant,
    purpose: grantMatch[1] as "browser" | "preview",
    relativePath,
  };
}

function localPreviewFixturePlugin(): Plugin {
  return {
    name: "synara-browser-test-local-preview-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" || !request.url) {
          next();
          return;
        }
        const rawPathname = rawPathnameFromRequestTarget(request.url);
        const prefix = `${LOCAL_PREVIEW_ROUTE_PREFIX}/`;
        if (!rawPathname?.startsWith(prefix)) {
          next();
          return;
        }
        const capabilityPath = parseLocalPreviewFixturePath(rawPathname);
        if (!capabilityPath) {
          response.statusCode = 404;
          response.end("Not Found");
          return;
        }
        const { grant, purpose, relativePath } = capabilityPath;
        const body = demoFixtureByPath.get(relativePath);
        const contentType = localPreviewContentTypeForPath(relativePath);
        if (body === undefined || contentType === null) {
          response.statusCode = 404;
          response.end("Not Found");
          return;
        }

        response.statusCode = 200;
        response.setHeader("Content-Type", contentType);
        response.setHeader("Content-Length", Buffer.byteLength(body));
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Pragma", "no-cache");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-DNS-Prefetch-Control", "off");
        response.setHeader(
          "Content-Security-Policy",
          relativePath.endsWith(".svg")
            ? "sandbox; default-src 'none'; style-src 'unsafe-inline'"
            : localPreviewFixtureCsp({
                grant,
                origin: `http://${request.headers.host ?? "localhost"}`,
                purpose,
              }),
        );
        if (purpose === "browser") {
          response.setHeader("Access-Control-Allow-Origin", "null");
        } else {
          response.setHeader("Vary", "Origin");
          const requestOrigin = Array.isArray(request.headers.origin)
            ? request.headers.origin[0]
            : request.headers.origin;
          if (requestOrigin?.trim().toLowerCase() === "null") {
            response.setHeader("Access-Control-Allow-Origin", "null");
          }
        }
        response.end(body);
      });
    },
  };
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [localPreviewFixturePlugin()],
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: [
        "src/components/**/*.browser.tsx",
        "src/lib/**/*.browser.ts",
        "src/lib/**/*.browser.tsx",
      ],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
