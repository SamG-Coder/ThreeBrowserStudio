import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const studioRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function preparePages({
  outputDirectory = path.join(studioRoot, "dist-pages"),
} = {}) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await cp(path.join(studioRoot, "pages", "index.html"), path.join(outputDirectory, "index.html"));
  await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");
  await cp(path.join(studioRoot, "pages"), path.join(outputDirectory, "pages"), { recursive: true });
  await cp(path.join(studioRoot, "src"), path.join(outputDirectory, "src"), { recursive: true });
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
