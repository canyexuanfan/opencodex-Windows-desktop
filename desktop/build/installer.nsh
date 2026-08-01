; Keep the product-name directory in both silent installs and the assisted
; directory page. The page normally leaves the parent path in its edit box and
; only electron-builder's later pre-install guard appends APP_FILENAME. We
; normalize the visible edit box as well, so the user can see the real target.
!include nsDialogs.nsh
!include FileFunc.nsh
!ifndef BUILD_UNINSTALLER
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ocxDirectoryPageShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ocxDirectoryPageLeave

Function ocxDirectoryPageShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1019
  ${NSD_GetText} $1 $2
  ${GetFileName} "$2" $3
  ${If} $3 != "${APP_FILENAME}"
    StrCpy $4 $2 1 -1
    ${If} $4 == "\"
      StrCpy $2 "$2${APP_FILENAME}"
    ${Else}
      StrCpy $2 "$2\${APP_FILENAME}"
    ${EndIf}
    ${NSD_SetText} $1 $2
  ${EndIf}
FunctionEnd

Function ocxDirectoryPageLeave
  ; MUI runs this callback before it copies the edit-box value to $INSTDIR,
  ; so read and normalize the visible control directly.
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1019
  ${NSD_GetText} $1 $2
  ${GetFileName} "$2" $3
  ${If} $3 != "${APP_FILENAME}"
    StrCpy $4 $2 1 -1
    ${If} $4 == "\"
      StrCpy $2 "$2${APP_FILENAME}"
    ${Else}
      StrCpy $2 "$2\${APP_FILENAME}"
    ${EndIf}
    ${NSD_SetText} $1 $2
  ${EndIf}
FunctionEnd
!endif

!macro customInit
  ${StdUtils.GetFileNamePart} $0 "$INSTDIR"
  ${If} $0 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend
