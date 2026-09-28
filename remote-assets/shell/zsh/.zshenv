# Consuls shell integration for zsh: ZDOTDIR points at this folder and USER_ZDOTDIR at yours,
# so each of these files runs your own first. See .zshrc.
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zshenv" ]]; then
  __consuls_zdotdir=$ZDOTDIR
  ZDOTDIR=${USER_ZDOTDIR:-$HOME}
  . "$ZDOTDIR/.zshenv"
  USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$__consuls_zdotdir
fi
