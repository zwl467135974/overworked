@echo off
REM Overworked 桌宠 - 开发模式启动
REM 双击此文件即可启动桌宠（需要已安装 Rust + Node 依赖）
cd /d "%~dp0"
echo 正在启动 Overworked 桌宠...
call npm run tauri dev
pause
