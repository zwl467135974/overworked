import { defineConfig } from "vite";
import path from "path";

// Overworked 前端配置
// 桌宠是 96×96 透明小窗，前端极简：Canvas + 冒泡 DOM。
export default defineConfig({
  root: "src",
  // 多页面入口：主页面 + 特效页
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/index.html"),
        fx: path.resolve(__dirname, "src/fx.html"),
      },
    },
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
