# Consuls shell integration for zsh: runs your own .zprofile (see .zshrc).
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zprofile" ]]; then
  __consuls_zdotdir=$ZDOTDIR
  ZDOTDIR=${USER_ZDOTDIR:-$HOME}
  . "$ZDOTDIR/.zprofile"
  ZDOTDIR=$__consuls_zdotdir
fi
