import { defineConfig } from "vite";

// Overworked 前端配置（单页面，特效在桌宠窗口内）
export default defineConfig({
  root: "src",
  server: {
    port: 1420,
    strictPort: true,
    hmr: { host: "localhost" },
  },
  clearScreen: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
