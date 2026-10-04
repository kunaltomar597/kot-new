; The Restaurant Platform's additions to electron-builder's NSIS installer (ONB-001, ONB-002,
; NFR-I02, UPD-007, P0-16d). electron-builder includes this file ahead of its own script and calls
; the macros below as hooks. docs/runbooks/windows-installer.md describes the whole flow.
;
;   Install   the data-drive page (ONB-002); with the files copied, Install-RestaurantPlatform.ps1
;             (install, or repair when the installation file exists).
;   Update    the same installer over an older version: the services are stopped before any file
;   Repair    is replaced (Stop-RestaurantPlatform.ps1), electron-builder removes the old files,
;             the new ones are copied and Install-RestaurantPlatform.ps1 repairs. If the old files
;             cannot be removed, Start-RestaurantPlatform.ps1 starts the old version again.
;   Uninstall Uninstall-RestaurantPlatform.ps1 before the files go: the services and firewall
;             rules are removed; the data stays unless the Owner allowed deleting it.
;
; Installer options (silent installs, the update agent and CI):
;   /S                         no pages
;   /DATADIR=<folder>          the data folder of a new installation (default: the default drive)
;   /STAFFSUBNET=<cidr>[,...]  the staff network the firewall admits (SEC-008; default: the PC's)
;   /MINFREEGB=<n>             the free space the data drive needs (default: 20)
; Uninstaller options: /S, /DELETEDATA (honoured only while the Owner's permission holds).
;
; The strings are English only in v1, like the rest of the product (NFR-L02).

!include LogicLib.nsh
!include nsDialogs.nsh
!include FileFunc.nsh

; Written by the stage step: RP_SETUP_DIR, RP_MIN_FREE_GB and the vendor's addresses.
!include "${PROJECT_DIR}/staging/installer-defines.nsh"

!define RP_SETUP_LOGS "%ProgramData%\RestaurantPlatform\setup-logs"

!define RP_TEXT_DRIVE_TITLE "The restaurant's data"
!define RP_TEXT_DRIVE_SUBTITLE "Choose the drive that keeps the orders, bills and backups."
!define RP_TEXT_DRIVE_INTRO "The data is kept in a RestaurantPlatform folder on the drive you choose. Choose a hard disk inside this PC; a second disk is safer than the Windows drive."
!define RP_TEXT_DRIVE_SYSTEM "Only the Windows drive can hold the data. A second disk inside the PC is safer: add one and run the installer again, or carry on with this drive."
!define RP_TEXT_DRIVE_NONE "No drive on this PC can hold the data. It needs a hard disk inside the PC, formatted NTFS, with at least $RPMinFreeGB GB free."
!define RP_TEXT_DRIVE_REFUSED "These drives cannot hold the data:"
!define RP_TEXT_DRIVES_FAILED "The installer could not list this PC's drives, so it will choose the drive itself."
!define RP_TEXT_STOPPING "Stopping the restaurant's services..."
!define RP_TEXT_STOP_FAILED "The restaurant's services could not be stopped, so nothing was changed. The log is in ${RP_SETUP_LOGS}."
!define RP_TEXT_SETTING_UP "Setting up the database and the restaurant's server. This takes a few minutes..."
!define RP_TEXT_SETUP_FAILED "The set-up did not finish. The log is in ${RP_SETUP_LOGS}. Run the installer again to repair, or call support."
!define RP_TEXT_UPDATE_FAILED "The installed version's files could not be replaced, so it carries on as before. Restart the PC and run the installer again."
!define RP_TEXT_UNINSTALL_TITLE "The restaurant's data"
!define RP_TEXT_UNINSTALL_SUBTITLE "Uninstalling keeps the data unless you delete it."
!define RP_TEXT_UNINSTALL_KEEPS "Uninstalling removes the program and its services. The restaurant's data (orders, bills, the database and its backups) stays on the data drive, and installing again carries on with it."
!define RP_TEXT_DELETE_DATA "Also delete the restaurant's data"
!define RP_TEXT_DELETE_NEEDS_OWNER "The Owner must allow this first on the POS: Manage, System, Removing the software. The permission lasts 30 minutes. Backups kept elsewhere are not touched."
!define RP_TEXT_DELETE_NOT_ALLOWED "The Owner has not allowed deleting the data, so it was not deleted.$\r$\n$\r$\nUninstall anyway and keep the data?"
!define RP_TEXT_UNINSTALL_FAILED "The restaurant's services could not be removed (the log is in %TEMP%).$\r$\n$\r$\nRemove the program files anyway?"

; The 64-bit Windows PowerShell 5.1, which every Windows 10 and 11 PC has; the installer itself is
; a 32-bit program, whose System32 is the 32-bit one.
!macro RPFindPowerShell
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $RPPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $RPPowerShell "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

; Runs a set-up script; its exit code is left on the stack.
!macro RPRunScript SCRIPT ARGUMENTS
  nsExec::ExecToLog '"$RPPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT}" ${ARGUMENTS}'
!macroend

; Inserted after electron-builder's includes and pages, so the functions can use them.
!macro customHeader
  Var RPPowerShell
  !ifndef BUILD_UNINSTALLER
    Var RPDataDir
    Var RPDataDirGiven
    Var RPStaffSubnet
    Var RPMinFreeGB
    Var RPRepair
    Var RPDriveList
    Var RPDriveCount

    ; The data-drive page (ONB-002), from Get-DataDriveChoice.ps1's INI file. Skipped on repair,
    ; which keeps the data where it is, and when /DATADIR= was given.
    Function RPDrivePageCreate
      ${If} $RPRepair == "1"
      ${OrIf} $RPDataDirGiven == "1"
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "${RP_TEXT_DRIVE_TITLE}" "${RP_TEXT_DRIVE_SUBTITLE}"
      StrCpy $R9 "$PLUGINSDIR\drives.ini"
      nsExec::ExecToStack '"$RPPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\setup\Get-DataDriveChoice.ps1" -MinFreeGB $RPMinFreeGB -IniFile "$R9"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "${RP_TEXT_DRIVES_FAILED}"
        Abort
      ${EndIf}

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ReadINIStr $RPDriveCount $R9 Choice EligibleCount
      ReadINIStr $2 $R9 Choice DefaultIndex
      ReadINIStr $3 $R9 Choice Warning
      ReadINIStr $4 $R9 Choice RefusedCount

      ${NSD_CreateLabel} 0 0 100% 28u "${RP_TEXT_DRIVE_INTRO}"
      Pop $0
      ${If} $RPDriveCount < 1
        ${NSD_CreateLabel} 0 32u 100% 24u "${RP_TEXT_DRIVE_NONE}"
        Pop $0
        ; Nothing can hold the data: the installation cannot go on.
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 0
      ${Else}
        ${NSD_CreateDropList} 0 32u 100% 80u ""
        Pop $RPDriveList
        StrCpy $5 0
        ${DoWhile} $5 < $RPDriveCount
          ReadINIStr $6 $R9 "Eligible$5" Text
          ${NSD_CB_AddString} $RPDriveList $6
          IntOp $5 $5 + 1
        ${Loop}
        ${If} $2 < 0
          StrCpy $2 0
        ${EndIf}
        SendMessage $RPDriveList ${CB_SETCURSEL} $2 0
        ${If} $3 == "SYSTEM_DRIVE"
          ${NSD_CreateLabel} 0 50u 100% 24u "${RP_TEXT_DRIVE_SYSTEM}"
          Pop $0
        ${EndIf}
      ${EndIf}
      ${If} $4 > 0
        StrCpy $7 "${RP_TEXT_DRIVE_REFUSED}"
        StrCpy $5 0
        ${DoWhile} $5 < $4
          ReadINIStr $6 $R9 "Refused$5" Text
          StrCpy $7 "$7$\r$\n$6"
          IntOp $5 $5 + 1
        ${Loop}
        ${NSD_CreateLabel} 0 78u 100% 60u "$7"
        Pop $0
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function RPDrivePageLeave
      ${If} $RPDriveCount > 0
        SendMessage $RPDriveList ${CB_GETCURSEL} 0 0 $0
        ${If} $0 < 0
          StrCpy $0 0
        ${EndIf}
        ReadINIStr $RPDataDir "$PLUGINSDIR\drives.ini" "Eligible$0" DataDir
      ${EndIf}
    FunctionEnd
  !else
    Var RPDeleteData
    Var RPDeleteBox

    ; Keep the data or delete it (NFR-I02). Not shown when a newer version is being installed.
    Function un.RPDataPageCreate
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "${RP_TEXT_UNINSTALL_TITLE}" "${RP_TEXT_UNINSTALL_SUBTITLE}"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 36u "${RP_TEXT_UNINSTALL_KEEPS}"
      Pop $0
      ${NSD_CreateCheckbox} 0 42u 100% 12u "${RP_TEXT_DELETE_DATA}"
      Pop $RPDeleteBox
      ${If} $RPDeleteData == "1"
        ${NSD_Check} $RPDeleteBox
      ${EndIf}
      ${NSD_CreateLabel} 12u 58u -12u 36u "${RP_TEXT_DELETE_NEEDS_OWNER}"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function un.RPDataPageLeave
      ${NSD_GetState} $RPDeleteBox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $RPDeleteData "1"
      ${Else}
        StrCpy $RPDeleteData "0"
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; ---------------------------------------------------------------------------------- installer

!macro customInit
  !insertmacro RPFindPowerShell
  ; The scripts needed before the files are copied: the drive page and stopping the services.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\setup"
  File "${RP_SETUP_DIR}/RestaurantPlatform.Setup.psm1"
  File "${RP_SETUP_DIR}/Get-DataDriveChoice.ps1"
  File "${RP_SETUP_DIR}/Stop-RestaurantPlatform.ps1"
  File "${RP_SETUP_DIR}/Start-RestaurantPlatform.ps1"

  ${GetParameters} $R0
  StrCpy $RPDataDirGiven "0"
  ClearErrors
  ${GetOptions} $R0 "/DATADIR=" $RPDataDir
  ${If} ${Errors}
    StrCpy $RPDataDir ""
  ${ElseIf} $RPDataDir != ""
    StrCpy $RPDataDirGiven "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/STAFFSUBNET=" $RPStaffSubnet
  ${If} ${Errors}
    StrCpy $RPStaffSubnet ""
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/MINFREEGB=" $RPMinFreeGB
  IntOp $RPMinFreeGB $RPMinFreeGB + 0
  ${If} ${Errors}
  ${OrIf} $RPMinFreeGB < 1
    StrCpy $RPMinFreeGB "${RP_MIN_FREE_GB}"
  ${EndIf}

  ; A repair (or an update) when the installation file exists: the data stays where it is.
  StrCpy $RPRepair "0"
  ReadEnvStr $R1 ProgramData
  ${If} ${FileExists} "$R1\RestaurantPlatform\installation.json"
    StrCpy $RPRepair "1"
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom RPDrivePageCreate RPDrivePageLeave
!macroend

; Before electron-builder removes an installed version's files: its services are stopped (the
; installer), and the POS window is closed (installer and uninstaller).
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    SetDetailsPrint both
    DetailPrint "${RP_TEXT_STOPPING}"
    !insertmacro RPRunScript "$PLUGINSDIR\setup\Stop-RestaurantPlatform.ps1" '-InstallDir "$INSTDIR"'
    Pop $0
    ${If} $0 != 0
      !insertmacro RPRunScript "$PLUGINSDIR\setup\Start-RestaurantPlatform.ps1" '-InstallDir "$INSTDIR"'
      Pop $1
      MessageBox MB_OK|MB_ICONSTOP "${RP_TEXT_STOP_FAILED}" /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
    ${IfNot} ${Silent}
      SetDetailsPrint none
    ${EndIf}
  !endif
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
!macroend

; The installed version's uninstaller has run (with --updated). When it could not remove the old
; files, they are back in place: the old version is started again and nothing is installed.
!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
  ${ElseIf} $R0 != 0
    !insertmacro RPRunScript "$PLUGINSDIR\setup\Start-RestaurantPlatform.ps1" '-InstallDir "$INSTDIR"'
    Pop $0
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    MessageBox MB_OK|MB_ICONSTOP "${RP_TEXT_UPDATE_FAILED}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; With the files copied: the services, the database and the firewall (install or repair).
!macro customInstall
  SetDetailsPrint both
  StrCpy $0 '-InstallDir "$INSTDIR" -ProductVersion "${VERSION}" -MinFreeGB $RPMinFreeGB'
  ${If} $RPDataDir != ""
    StrCpy $0 '$0 -DataDir "$RPDataDir"'
  ${EndIf}
  ${If} $RPStaffSubnet != ""
    StrCpy $0 '$0 -StaffSubnet "$RPStaffSubnet"'
  ${EndIf}
  !ifdef RP_CONTROL_PLANE_URL
    StrCpy $0 '$0 -ControlPlaneUrl "${RP_CONTROL_PLANE_URL}"'
  !endif
  !ifdef RP_RELAY_URL
    StrCpy $0 '$0 -RelayUrl "${RP_RELAY_URL}"'
  !endif
  !ifdef RP_QR_SITE_URL
    StrCpy $0 '$0 -QrSiteUrl "${RP_QR_SITE_URL}"'
  !endif
  !ifdef RP_ERROR_DSN
    StrCpy $0 '$0 -ErrorDsn "${RP_ERROR_DSN}"'
  !endif
  DetailPrint "${RP_TEXT_SETTING_UP}"
  !insertmacro RPRunScript "$INSTDIR\setup\Install-RestaurantPlatform.ps1" '$0'
  Pop $1
  ${If} $1 != 0
    MessageBox MB_OK|MB_ICONSTOP "${RP_TEXT_SETUP_FAILED}" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

; -------------------------------------------------------------------------------- uninstaller

!macro customUnInit
  !insertmacro RPFindPowerShell
  StrCpy $RPDeleteData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DELETEDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $RPDeleteData "1"
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.RPDataPageCreate un.RPDataPageLeave
!macroend

; Before the files go. A newer version being installed keeps the services and the data.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    SetDetailsPrint both
    StrCpy $0 ""
    ${If} $RPDeleteData == "1"
      StrCpy $0 "-DeleteData"
    ${EndIf}
    !insertmacro RPRunScript "$INSTDIR\setup\Uninstall-RestaurantPlatform.ps1" '-InstallDir "$INSTDIR" $0'
    Pop $1
    ${If} $1 == 3
      ; The Owner has not allowed deleting the data; nothing was changed.
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION "${RP_TEXT_DELETE_NOT_ALLOWED}" /SD IDNO IDYES`
        !insertmacro RPRunScript "$INSTDIR\setup\Uninstall-RestaurantPlatform.ps1" '-InstallDir "$INSTDIR"'
        Pop $1
      ${Else}
        SetErrorLevel 3
        Abort
      ${EndIf}
    ${EndIf}
    ${If} $1 != 0
      ${IfNot} ${Cmd} `MessageBox MB_YESNO|MB_ICONSTOP "${RP_TEXT_UNINSTALL_FAILED}" /SD IDNO IDYES`
        SetErrorLevel 1
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
