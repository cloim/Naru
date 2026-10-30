; Tauri installs a per-user app into %LOCALAPPDATA%\<productName>, which is also Naru's default data folder.
; Keep program files apart from the WSL disk and job data: the default moves to %LOCALAPPDATA%\Programs\Naru,
; the usual place for per-user apps. A folder the user picks on the directory page is left as chosen.
!macro NARU_DEFAULT_INSTDIR
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  ${EndIf}
!macroend

; Runs after .onInit has picked the default (or the previous install location) and before the pages show.
!define MUI_CUSTOMFUNCTION_GUIINIT NaruGuiInit
Function NaruGuiInit
  !insertmacro NARU_DEFAULT_INSTDIR
FunctionEnd

; Silent installs skip the GUI callbacks.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro NARU_DEFAULT_INSTDIR
  SetOutPath $INSTDIR
!macroend
