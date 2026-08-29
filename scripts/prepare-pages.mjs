import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Bump when Pages must ignore cached ES modules. */
export const PAGES_ASSET_STAMP = "prompt-15";

export function bustRelativeModuleImports(source, stamp = PAGES_ASSET_STAMP) {
  return String(source)
    .replace(/(from\s+['"])(\.\.?\/[^'"]+?\.(?:mjs|json))(?:\?[^'"]*)?(['"])/g, `$1$2?v=${stamp}$3`)
    .replace(/(import\(\s*['"])(\.\.?\/[^'"]+?\.(?:mjs|json))(?:\?[^'"]*)?(['"]\s*\))/g, `$1$2?v=${stamp}$3`);
}

async function walkMjs(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkMjs(full, files);
    else if (entry.name.endsWith(".mjs")) files.push(full);
  }
  return files;
}

export async function preparePages({
  outputDirectory = path.join(studioRoot, "dist-pages"),
  stamp = PAGES_ASSET_STAMP,
} = {}) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp(path.join(studioRoot, "pages", "index.html"), path.join(outputDirectory, "index.html"));
  await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");
  await cp(path.join(studioRoot, "pages"), path.join(outputDirectory, "pages"), { recursive: true });
  await cp(path.join(studioRoot, "src"), path.join(outputDirectory, "src"), { recursive: true });
  await cp(path.join(studioRoot, "templates"), path.join(outputDirectory, "templates"), { recursive: true });
  const htmlPath = path.join(outputDirectory, "index.html");
  const html = await readFile(htmlPath, "utf8");
  await writeFile(
    htmlPath,
    html.replace(/browser-entry\.mjs(?:\?[^'"]*)?/, `browser-entry.mjs?v=${stamp}`),
    "utf8",
  );
  for (const file of await walkMjs(outputDirectory)) {
    const next = bustRelativeModuleImports(await readFile(file, "utf8"), stamp);
    await writeFile(file, next, "utf8");
  }
  return outputDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const folder = await preparePages();
    console.error(`[ThreeBrowser Studio] wrote ${folder}`);
  } catch (error) {
    console.error(`[ThreeBrowser Studio] pages prepare failed: ${error.message}`);
    process.exitCode = 1;
  }
}
