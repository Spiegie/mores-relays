{ description = "Morse Chat - Nix flake for Node.js development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_22;

        # Playwright MCP server for browser automation. Pinned to the
        # @playwright/mcp release line whose playwright-core matches the
        # playwright version in this flake's nixpkgs (1.63.0), so the
        # browser revisions in nixpkgs' playwright.browsers (chromium 1243,
        # firefox 1543, webkit 2359) resolve exactly. The vendored
        # package.json/lock in nix/playwright-mcp/ pin playwright-core to
        # the stable 1.63.0 instead of the upstream alpha. The wrapper
        # points PLAYWRIGHT_BROWSERS_PATH at the nixpkgs browsers so
        # nothing is ever downloaded at runtime.
        playwright-mcp = pkgs.buildNpmPackage {
          pname = "playwright-mcp";
          version = "0.0.80";
          # The npm tarball ships no lockfile and pins an alpha playwright.
          # Build the source ourselves and drop in the vendored
          # package.json + lock (see nix/playwright-mcp/), which pin
          # playwright-core to the stable 1.63.0 that matches the nixpkgs
          # browsers. postPatch cannot be used for this because the npmDeps
          # fixed-output derivation evaluates its own phases.
          src = pkgs.runCommand "playwright-mcp-0.0.80-src" { } ''
            mkdir -p $out
            tar -xf ${pkgs.fetchurl {
              name = "playwright-mcp-0.0.80.tar.gz";
              url = "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.80.tgz";
              hash = "sha256-uB7aPwp8xwqcr321IM2tWMSKHdM0tOP88JbAUSyYrw0=";
            }} --strip-components=1 -C $out
            cp ${./nix/playwright-mcp/package.json} $out/package.json
            cp ${./nix/playwright-mcp/package-lock.json} $out/package-lock.json
          '';
          npmDepsHash = "sha256-l0wNESCjqjuSQDY3C/KIA5zbBuHNQqf7FyXJaO6sZk4=";
          # playwright's postinstall would try to download browsers; the
          # browsers come from nixpkgs instead.
          npmFlags = [ "--ignore-scripts" ];
          dontNpmBuild = true;
          postInstall = ''
            mkdir -p $out/bin
            substitute ${./nix/playwright-mcp/wrapper.sh} $out/bin/mcp-server-playwright \
              --replace @browsers@ "${pkgs.playwright.browsers}" \
              --replace @node@ "${nodejs}" \
              --replace @out@ "$out"
            chmod +x $out/bin/mcp-server-playwright
          '';
          meta.mainProgram = "mcp-server-playwright";
        };

        # Builds the Vite client (dist/) and ships the full node_modules
        # (incl. tsx) plus the server, mirroring the Dockerfile layout.
        morse-chat = pkgs.buildNpmPackage {
          pname = "morse-chat";
          version = "0.1.0";
          src = self;

          inherit nodejs;
          npmDepsHash = "sha256-UZ4iWL3a39yYrhn1tj6DYF1RSWGmOAYa/1mF2dTl7g4=";

          npmBuildScript = "build";

          installPhase = ''
            runHook preInstall

            mkdir -p $out
            cp -r dist $out/dist
            cp -r node_modules $out/node_modules
            cp morse-relais.ts package.json LICENSE $out/

            runHook postInstall
          '';
        };

        dockerImage = pkgs.dockerTools.buildLayeredImage {
          name = "morse-chat";
          tag = "latest";
          created = "now";

          contents = [
            nodejs
            morse-chat
            (pkgs.dockerTools.fakeNss.override {
              extraPasswdLines = [ "morseuser:x:1000:1000::${morse-chat}:/bin/sh" ];
              extraGroupLines = [ "morseuser:x:1000:" ];
            })
          ];

          # tsx needs a writable temp directory for its IPC pipe.
          # Runs inside the layer root, so the path must be relative.
          fakeRootCommands = ''
            mkdir ./tmp
            chmod 1777 ./tmp
          '';

          config = {
            User = "1000:1000";
            WorkingDir = "${morse-chat}";
            Entrypoint = [
              "${nodejs}/bin/node"
              "${morse-chat}/node_modules/tsx/dist/cli.mjs"
              "${morse-chat}/morse-relais.ts"
            ];
            Cmd = [ "server" "--port" "7002" "--name" "docker-server" ];
            ExposedPorts = { "7002/tcp" = { }; };
            Env = [ "NODE_ENV=production" ];
            Healthcheck = {
              Test = [
                "CMD"
                "${nodejs}/bin/node"
                "-e"
                "fetch('http://localhost:7002/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
              ];
              Interval = 30000000000;
              Timeout = 3000000000;
              StartPeriod = 5000000000;
              Retries = 3;
            };
          };
        };
      in
      {
        packages = {
          inherit dockerImage playwright-mcp;
          default = dockerImage;
        };

        devShells.default = pkgs.mkShell {
          name = "morse-chat-dev";
          
          buildInputs = with pkgs; [
            nodejs
            git
            openssl
            gcc
          ];
          
          NODE_PATH = "${nodejs}/lib/node_modules";
          
          shellHook = ''
            export NODE_ENV=development
            export PATH="$NODE_PATH/.bin:./node_modules/.bin:$PATH"
            echo "========================================"
            echo "  Morse Chat Development Shell"
            echo "========================================"
            echo ""
            echo "Project Structure:"
            echo "  morse-relais.ts          - Server (Node.js + WebSocket)"
            echo "  morse-chat-browser-client.tsx - React client component"
            echo "  src/main.tsx             - React entry point"
            echo "  vite.config.ts           - Vite configuration"
            echo ""
            echo "Available commands:"
            echo "  npm install             - Install dependencies (tsx, vite, etc.)"
            echo "  npm run dev              - Start Vite dev server (http://localhost:3000)"
            echo "  npm run build            - Build for production"
            echo "  npm run preview          - Preview production build"
            echo "  tsx morse-relais.ts server --port 7002 --name my-server"
            echo "                           - Start the Morse relay server"
            echo ""
            echo "Default connections:"
            echo "  WebSocket:    ws://localhost:7002"
            echo "  Vite dev:     http://localhost:3000"
            echo ""
          '';
        };
      }
    );
}
