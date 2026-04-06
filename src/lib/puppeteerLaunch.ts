import { existsSync } from "node:fs";
import type { Browser } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const viewport = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
} as const;

function useBundledServerlessChromium(): boolean {
  return (
    process.env.VERCEL === "1" ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.AWS_EXECUTION_ENV)
  );
}

function resolveLocalChromeExecutable(): string | undefined {
  const fromEnv =
    process.env.CHROME_EXECUTABLE_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    return fromEnv;
  }
  if (process.platform === "darwin") {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(mac)) {
      return mac;
    }
  }
  const linuxCandidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of linuxCandidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

/**
 * Launches a browser for scraping: Sparticuz Chromium on Vercel/serverless,
 * system Chrome locally (see CHROME_EXECUTABLE_PATH if auto-detect fails).
 */
export async function launchPuppeteerBrowser(): Promise<Browser> {
  if (useBundledServerlessChromium()) {
    chromium.setGraphicsMode = false;
    return puppeteer.launch({
      args: puppeteer.defaultArgs({
        args: chromium.args,
        headless: "shell",
      }),
      defaultViewport: viewport,
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }

  const executablePath = resolveLocalChromeExecutable();
  if (!executablePath) {
    throw new Error(
      "Could not find Chrome/Chromium. Install Google Chrome or set CHROME_EXECUTABLE_PATH.",
    );
  }

  return puppeteer.launch({
    defaultViewport: viewport,
    executablePath,
    headless: true,
  });
}
