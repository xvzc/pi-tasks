{ pkgs, ... }:
{
  packages = with pkgs; [
    nixd
    nixfmt
    typescript-language-server
  ];

  enterShell = # sh
    ''
      unset PI_CODING_AGENT_DIR
      export name="devenv:pi-tasks"
    '';
}
