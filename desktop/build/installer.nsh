; Keep the product-name directory visible and effective. electron-builder's
; built-in MUI directory page only sanitizes on the next page, so selecting a
; parent directory keeps showing the parent path. We replace that page with a
; controlled nsDialogs page and normalize after the browse dialog returns.
!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
Var ocxInstallDirInput

!macro customPageAfterChangeDir
  Function ocxEnsureInstallDir
    ${GetFileName} "$INSTDIR" $0
    ${If} $INSTDIR == ""
      Return
    ${EndIf}
    ${If} $0 != "${APP_FILENAME}"
      StrCpy $1 $INSTDIR 1 -1
      ${If} $1 == "\"
        StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
      ${Else}
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function ocxDirectoryPageCreate
    Call ocxEnsureInstallDir
    !insertmacro MUI_HEADER_TEXT "选择安装位置" "选择 OpenCodex 要安装到的文件夹。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 0u 300u 24u "Setup 将把 OpenCodex 安装到下列文件夹。要安装到其他文件夹，请单击 [浏览...] 并选择。"
    Pop $0
    ${NSD_CreateGroupBox} 0u 34u 300u 50u "目标文件夹"
    Pop $0
    ${NSD_CreateDirRequest} 12u 54u 216u 14u "$INSTDIR"
    Pop $ocxInstallDirInput
    ${NSD_CreateBrowseButton} 236u 53u 64u 16u "浏览(&B)..."
    Pop $0
    ${NSD_OnClick} $0 ocxDirectoryBrowse

    nsDialogs::Show
  FunctionEnd

  Function ocxDirectoryBrowse
    Pop $0
    ${NSD_GetText} $ocxInstallDirInput $INSTDIR
    nsDialogs::SelectFolderDialog "选择安装 OpenCodex 的文件夹" "$INSTDIR"
    Pop $0
    ${If} $0 != error
      StrCpy $INSTDIR "$0"
      Call ocxEnsureInstallDir
      ${NSD_SetText} $ocxInstallDirInput "$INSTDIR"
    ${EndIf}
  FunctionEnd

  Function ocxDirectoryPageLeave
    ${NSD_GetText} $ocxInstallDirInput $INSTDIR
    Call ocxEnsureInstallDir
    ${If} $INSTDIR == ""
      MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "请选择 OpenCodex 安装文件夹。"
      Abort
    ${EndIf}
  FunctionEnd

  Page custom ocxDirectoryPageCreate ocxDirectoryPageLeave
!macroend
!endif

!macro customInit
  Call ocxEnsureInstallDir
!macroend

!macro customInstall
  StrCpy $0 "$INSTDIR\resources\tray\opencodex-tray-online.ico"
  ${IfNot} ${FileExists} "$0"
    StrCpy $0 "$appExe"
  ${EndIf}

  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  !endif

  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      Delete "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}
  !endif

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
