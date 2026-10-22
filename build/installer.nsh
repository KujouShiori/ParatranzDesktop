; electron-builder NSIS 自定义脚本：卸载时清掉本程序在注册表里留下的痕迹。
; 这些键是 Windows 在我们发通知、声明 AppUserModelID 时替我们写的，
; 安装器不会自动回收，所以卸载要自己删。

!macro customUnInstall
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\cn.paratranz.desktop"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\cn.paratranz.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Paratranz Desktop"
!macroend
