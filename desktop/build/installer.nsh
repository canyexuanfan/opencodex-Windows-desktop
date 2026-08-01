; Keep the product-name directory when NSIS is invoked silently with /D=<parent>.
; electron-builder's built-in assisted-page guard runs later and only checks
; whether the full path contains APP_FILENAME anywhere; that is ambiguous when
; a parent directory itself contains "OpenCodex".
!macro customInit
  ${StdUtils.GetFileNamePart} $0 "$INSTDIR"
  ${If} $0 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend
