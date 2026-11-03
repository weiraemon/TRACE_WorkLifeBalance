Unicode True
!include "MUI2.nsh"
!include "FileFunc.nsh"
Name "CHAOS Android 界面预览"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\CHAOS-Android-Preview"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\CHAOS-Android-Preview.exe"
!define MUI_FINISHPAGE_RUN_TEXT "打开 Android 界面预览"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var Parameters
Var NoIntegration

Section
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/NOINTEGRATION" $NoIntegration
  IfErrors 0 done
  CreateShortcut "$SMPROGRAMS\CHAOS Android 界面预览.lnk" "$INSTDIR\CHAOS-Android-Preview.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CHAOSAndroidPreview" "DisplayName" "CHAOS Android 界面预览"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CHAOSAndroidPreview" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CHAOSAndroidPreview" "DisplayVersion" "${VERSION}"
  FileOpen $0 "$INSTDIR\.preview-integration" w
  FileClose $0
  done:
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\.preview-integration" 0 files
  Delete "$SMPROGRAMS\CHAOS Android 界面预览.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CHAOSAndroidPreview"
  Delete "$INSTDIR\.preview-integration"
  files:
  ; Delete only packaged files; leave unknown files and the separate sample workspace intact.
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
