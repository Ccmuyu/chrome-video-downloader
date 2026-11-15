import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(project, "public/ffmpeg");
const coreDir = join(project, "node_modules/@ffmpeg/core/dist/esm");
const workerEntry = join(project, "node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js");
const esbuild = await import(require.resolve("esbuild"));

await mkdir(out, { recursive: true });
await cp(join(coreDir, "ffmpeg-core.js"), join(out, "ffmpeg-core.js"));
await cp(join(coreDir, "ffmpeg-core.wasm"), join(out, "ffmpeg-core.wasm"));
await writeFile(
  join(out, "LICENSE.txt"),
  `ffmpeg.wasm core files in this directory come from the npm package @ffmpeg/core.
That package is licensed under GPL-2.0-or-later.
The full license text is published at https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
and must be kept with any redistribution of these files.
`,
);
await esbuild.build({
  entryPoints: [workerEntry],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(out, "worker.js"),
});

const workerPath = join(out, "worker.js");
const worker = await readFile(workerPath, "utf8");
// worker 默认把核心指到 unpkg。清空后，没传 coreURL 会失败，而不是在运行时去外网拉 wasm。
await writeFile(workerPath, worker.replace(/https:\/\/unpkg\.com[^`'"]*/g, ""));
