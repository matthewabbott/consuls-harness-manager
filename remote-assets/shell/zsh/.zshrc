# Consuls shell integration for zsh: runs your own .zshrc, then reports the working directory
# (OSC 7) at every prompt so Consuls can follow `cd` in plain shells. Nothing else is changed.
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zshrc" ]]; then
  __consuls_zdotdir=$ZDOTDIR
  ZDOTDIR=${USER_ZDOTDIR:-$HOME}
  . "$ZDOTDIR/.zshrc"
  ZDOTDIR=$__consuls_zdotdir
fi

__consuls_cwd() {
  printf '\033]7;file://%s%s\033\\' "${HOST:-}" "$PWD"
}
autoload -Uz add-zsh-hook && add-zsh-hook precmd __consuls_cwd

# From here on zsh reads your own files (.zlogin now, .zlogout on exit).
ZDOTDIR=${USER_ZDOTDIR:-$HOME}
