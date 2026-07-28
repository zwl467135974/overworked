import { defineConfig } from "vite";

// Overworked 前端配置
// 桌宠是 96×96 透明小窗，前端极简：Canvas + 冒泡 DOM。
export default defineConfig({
  // 前端源码放在 src/，把它作为 Vite 的 root（默认 root 是项目根，
  // 但我们的 index.html 在 src/ 下，所以要显式指定）
  root: "src",
  // Tauri 约定的开发端口
  server: {
    port: 1420,
    strictPort: true,
    hmr: {
      // Tauri dev 时通过宿主访问，避免 ws 连接问题
      host: "localhost",
    },
  },
  // 不清屏，方便看 Tauri/Rust 输出
  clearScreen: false,
  build: {
    // 输出到 dist（相对项目根），tauri.conf.json 里 frontendDist 指向它
    // 注意：root=src 后，outDir 相对 root 解析，要用绝对路径指回项目根的 dist
    outDir: "../dist",
    emptyOutDir: true,
    // 桌宠前端极小，不需要分块优化
    target: "esnext",
  },
});
