# Changelog

All notable changes to this extension are documented here.

## Unreleased

### Added

- Finds mmk projects in the workspace (config files, or a package.json that depends on
  mongo-migrate-kit), including monorepos and multi-root workspaces.
- Runs the project's own mmk with `--json` and reads its output, checked against the types
  mongo-migrate-kit exports.
- Checks the project's mongo-migrate-kit version on activation (1.5.0 or later).
- An "mmk" output channel with credentials masked.
- Temporary command "mmk: Show status (debug)".
