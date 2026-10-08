# Working on DRYAS Systrace

- The first product is a VS Code extension, also tested in Cursor. Keep editor integration central.
- `packages/extension` owns editor integration. `engine-adapter` owns saved projects and the external engine. `mcp-server` exposes read-only agent tools.
- OpenSysML owns parsing, name resolution and semantic checks. Do not build a second resolver in TypeScript.
- Use Apache-2.0 SPDX headers on new first-party source. Preserve third-party license notices.
- Never commit local usernames, machine identifiers, absolute host paths, time zones, credentials, private configuration or raw execution logs. Use parameters, environment variables and ignored local configuration.
- Keep internal planning, evaluation archives and working notes outside the product repository. Do not import evaluation scripts at runtime.
- Run `npm run check` and `npm run package:vsix` for product changes. Native engine and extension-host checks are separate: `npm run test:engine` and `npm run test:host`.
- Use meaningful behavior tests. A mock engine tests adapter behavior; it cannot prove native semantic support.
- Report unsupported or unknown capabilities explicitly. No diagnostics is not proof of complete validation.
- Use LF and the committed lock file. Never force-push, publish packages or upload local artifacts without user authorization.
- Keep user documentation in English by default, with `.zh-Hans.md` for Simplified Chinese. Update both editions together; preserve original license and generated third-party notice texts.
