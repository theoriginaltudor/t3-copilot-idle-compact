# Contributing to `t3-copilot-idle-compact`

Pull requests are welcome! Thanks for taking the time to contribute.

## Getting Started

1. **Fork** the repository and clone your fork locally.
2. Create a feature or fix branch from `main`:
   ```bash
   git checkout -b feat/your-change
   ```
3. Make sure you have **Node.js `>= 22.5.0`** installed (no `npm install` is needed).
4. Run the test suite:
   ```bash
   npm test
   ```

## Guidelines

- **Zero external dependencies**: Keep the package dependency-free using Node.js built-ins (including `node:sqlite`).
- **Read-only SQLite access**: Never write to T3 Code's `statev2.sqlite` or Copilot's `session-store.db`; open databases read-only and close them after each sweep.
- **Cross-platform support**: Keep paths, CLI invocation, and tests working across **macOS**, **Windows**, and **Linux**.
- **Tests**: Add or update unit tests in `test/` for behavior changes or bug fixes.

## Opening a Pull Request

1. Push your branch to your fork and open a pull request against `main`.
2. Fill out the PR template with a short summary of the change and how you tested it.
3. Ensure the cross-platform CI checks (`ubuntu-latest`, `macos-latest`, `windows-latest`) pass.
