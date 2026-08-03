; NSIS 安装前钩子：杀掉正在运行的旧进程，确保 exe 能被替换
; Tauri 2 的 NSIS 模板不自动关闭旧进程，导致覆盖安装时 exe 被锁、替换静默失败

!macro NSIS_HOOK_PREINSTALL
  ; 尝试关闭正在运行的 Overworked（给它2秒优雅退出）
  nsExec::ExecToLog 'taskkill /IM "${MAINBINARYNAME}.exe" /T'
  Pop $0
  ; 等待进程完全退出（最多3秒）
  Sleep 2000
!macroend
