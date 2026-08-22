# Pi Arsenal

This repository is a portable package of shared Pi tools for ordinary agents on supported branch-host environments. Loose agents, prompts, skills, and extensions are bundled here. External packages remain links in [`sources.json`](./sources.json) and are installed from their original package sources rather than vendored.

All included capabilities are expected to work across supported branch-host environments. Treat an incompatibility as an implementation bug: fix it at the original resource or upstream repository, then resync this arsenal. Do not create platform-specific profiles or subsets.

## Bootstrap a Pi environment

Before bootstrapping, identify the target operating system, shell, filesystem path syntax, and actual Pi runtime/package mechanism, then adapt command and path syntax to that environment. Environment differences affect installation mechanics only; do not omit arsenal resources or create platform-specific subsets.

1. Install the arsenal through Pi's package mechanism:

   ```sh
   pi install git:github.com/aruru-project/pi-arsenal
   ```

   To develop from a local clone instead:

   ```sh
   pi install "<PI_ARSENAL_DIR>"
   ```

2. Install each external package registered in `sources.json` through the same mechanism:

   ```sh
   pi install npm:pi-web-access
   pi install git:github.com/Oyaxira/pi-visionizer
   pi install git:github.com/Oyaxira/pi-browser-cdp
   pi install git:github.com/Oyaxira/pi-subagents@b5168b31d7482c13a40c456a4d5bce345967b345
   pi install git:github.com/aruru-project/pi-alu-sol-tuner
   ```

3. Reload Pi's packages if the current runtime provides a reload action; otherwise exit and restart Pi.
4. Ask Pi to show the available subagents. Confirm that the `pi-subagents` delegation capability is loaded and that the custom agents include `sol.worker` and `sol.reviewer`. Also check that the bundled skills, prompts, and extensions are discoverable before using the environment.

## Third-party material

Bundled third-party resources retain their upstream licenses and attribution. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the license/notice files within the relevant skill directories.
