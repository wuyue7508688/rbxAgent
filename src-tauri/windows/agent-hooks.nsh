!define RBXPORT_AGENT_HOOK_DIR "${__FILEDIR__}"

!macro RBXPORT_AGENT_INSTALL
  SetOutPath "$INSTDIR\agent\dsh"
  File /r "${RBXPORT_AGENT_HOOK_DIR}\..\..\agent\dsh\.bundle\runtime\*.*"
  SetOutPath "$INSTDIR"
!macroend

!macro RBXPORT_AGENT_UNINSTALL
  IfFileExists "$INSTDIR\agent\dsh\rbxport.patch.yml" 0 +2
  RMDir /r /REBOOTOK "$INSTDIR\agent\dsh"
  RMDir /REBOOTOK "$INSTDIR\agent"
!macroend

!include "${RBXPORT_AGENT_HOOK_DIR}\hooks.nsh"
