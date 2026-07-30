import { defineConfig } from "vite";
import path from "path";
import { readdirSync } from "fs";

// 自动扫描 src/ 下的所有 .html 作为多页面入口
const inputs = {};
for (const f of readdirSync("src")) {
  if (f.endsWith(".html")) {
    inputs[f.replace(".html", "")] = path.resolve("src", f);
  }
}

export default defineConfig({
  root: "src",
  build: {
    rollupOptions: { input: inputs },
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
  },
  server: {
    port: 1420,
    strictPort: true,
    hmr: { host: "localhost" },
  },
  clearScreen: false,
});
