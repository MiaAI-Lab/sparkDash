# shellcheck shell=sh
# SERVICE_STATE is consumed by scripts that source this helper.
# shellcheck disable=SC2034
privileged_service_state() {
  if SERVICE_OUTPUT=$(sudo -n launchctl print "system/$1" 2>&1); then
    SERVICE_STATE=loaded
    return 0
  else
    SERVICE_STATUS=$?
  fi
  if [ "$SERVICE_STATUS" -eq 113 ]; then
    case "$SERVICE_OUTPUT" in
      *"Could not find service \"$1\" in domain for system")
        SERVICE_STATE=absent
        return 0
        ;;
    esac
  fi
  printf 'Cannot inspect system/%s (exit %s): %s\n' "$1" "$SERVICE_STATUS" "$SERVICE_OUTPUT" >&2
  return 1
}
