export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionMacLegacyIconPng: "assets/prod/black-macos-legacy-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/synara-black-windows.ico",
  productionWebFaviconIco: "assets/prod/synara-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/synara-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/synara-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/synara-black-web-apple-touch-180.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export type PackagedDesktopBrandFlavor = "production" | "canary" | "super";

export interface DesktopBrandAssetPaths {
  readonly macIconSource: string;
  readonly macLegacyIconSource: string;
  readonly windowsIconIco: string;
  readonly windowsNotificationIconPng: string;
}

export const SUPER_DESKTOP_BRAND_ASSET_PATHS: DesktopBrandAssetPaths = {
  macIconSource: "assets/super/super-synara-1024.png",
  macLegacyIconSource: "assets/super/super-synara-macos-legacy-1024.png",
  windowsIconIco: "assets/super/super-synara-windows.ico",
  windowsNotificationIconPng: "assets/super/super-synara-1024.png",
};

const PRODUCTION_DESKTOP_BRAND_ASSET_PATHS: DesktopBrandAssetPaths = {
  macIconSource: BRAND_ASSET_PATHS.productionMacIconPng,
  macLegacyIconSource: BRAND_ASSET_PATHS.productionMacLegacyIconPng,
  windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  windowsNotificationIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
};

export function resolveDesktopBrandAssetPaths(
  flavor: PackagedDesktopBrandFlavor,
): DesktopBrandAssetPaths {
  return flavor === "super"
    ? SUPER_DESKTOP_BRAND_ASSET_PATHS
    : PRODUCTION_DESKTOP_BRAND_ASSET_PATHS;
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const DEVELOPMENT_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];
