{ pkgs, ... }:

{
  packages = [
    pkgs.iproute2
    pkgs.nodejs_22
  ];

  scripts.dev-port.exec = ''
    set -eu
    preferred=$1
    dir=$(cd "''${2:-.}" && pwd -P)
    envfile="$dir/.env.local"

    port_busy() { [ -n "$(ss -lntH "sport = :$1" 2>/dev/null)" ]; }
    port_owner() {
      ss -lptnH "sport = :$1" 2>/dev/null |
        sed -nE 's/.*pid=([0-9]+).*/\1/p' |
        while read -r pid; do readlink "/proc/$pid/cwd" 2>/dev/null && break; done
    }
    usable() {
      port_busy "$1" || return 0
      [ "$(port_owner "$1")" = "$dir" ]
    }

    recorded=$(sed -n 's/^DEV_PORT=//p' "$envfile" 2>/dev/null | tail -1)
    port=""
    for candidate in ''${recorded:-} "$preferred"; do
      if usable "$candidate"; then port=$candidate; break; fi
    done
    if [ -z "$port" ]; then
      port=$preferred
      while ! usable "$port"; do port=$((port + 1)); done
    fi

    tmp=$(mktemp "$envfile.XXXXXX")
    {
      grep -v '^DEV_\(PORT\|URL\)=' "$envfile" 2>/dev/null || :
      printf 'DEV_PORT=%s\nDEV_URL=http://localhost:%s\n' "$port" "$port"
    } >"$tmp"
    mv "$tmp" "$envfile"
    echo "$port"
  '';

  scripts.dev-url.exec = ''
    dir=$(cd "''${1:-.}" && pwd -P)
    sed -n 's/^DEV_URL=//p' "$dir/.env.local" 2>/dev/null | tail -1
  '';

  processes.web.exec = ''
    port=$(dev-port 4321 "$PWD")
    exec node node_modules/.bin/astro dev --host 0.0.0.0 --port "$port"
  '';

  enterShell = ''
    node --version
    npm --version
  '';
}
