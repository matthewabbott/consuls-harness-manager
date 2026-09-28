# Consuls shell integration for bash, run as `bash --init-file <this file> -i` for plain
# shells. It starts up like a login shell, then reports the working directory (OSC 7) at every
# prompt so Consuls can follow `cd`. Nothing else is changed.

if [ -f /etc/profile ]; then . /etc/profile; fi
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
fi

__consuls_cwd() {
  local s=$?
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-}" "$PWD"
  return $s
}

# Git Bash (MSYS): report the Windows path — MSYS mounts like /tmp mean nothing to Windows.
if [ -n "${MSYSTEM:-}" ]; then
  __consuls_cwd() {
    local s=$?
    if [ "$PWD" != "${__consuls_pwd:-}" ]; then
      __consuls_pwd=$PWD
      __consuls_win=$(pwd -W 2>/dev/null) || __consuls_win=$PWD
    fi
    printf '\033]7;file://%s/%s\033\\' "${HOSTNAME:-}" "${__consuls_win#/}"
    return $s
  }
fi

# First, so everything after it still sees the last command's exit status.
case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  "declare -a"*) PROMPT_COMMAND=(__consuls_cwd "${PROMPT_COMMAND[@]}") ;;
  *) PROMPT_COMMAND="__consuls_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
