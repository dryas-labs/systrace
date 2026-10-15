# Working on DRYAS Systrace

- The product is a VS Code extension, also tested in Cursor. Keep editor integration central.
- `packages/extension` owns editor integration. `engine-adapter` owns saved projects and the external engine. `engine-adapter` also provides the standalone LSP diagnostics command; the extension exposes current-window Problems to Copilot.
- The selected language engine owns parsing, name resolution and semantic checks. Do not build a second resolver in TypeScript.
- Use "language engine" in product documentation and UI. State the selected implementation only in the language-engine selection page. Its provenance, upstream relationships and maintenance policy belong in its own repository. Preserve accurate native identifiers, build metadata and required legal notices.
- Keep native RPC, diagnostic mapping and engine-specific LSP behavior in the backend implementation. Project sessions use LanguageBackend; model tools and editor services must use the same LanguageEngineProvider.
- Use Apache-2.0 SPDX headers on new first-party source. Preserve third-party license notices.
- Never commit local usernames, machine identifiers, absolute host paths, time zones, credentials, private configuration or raw execution logs. Use parameters, environment variables and ignored local configuration.
- Keep internal planning, evaluation archives and working notes outside the product repository. Public documentation describes implemented behavior, supported interfaces and current limitations; keep future product and engine design plans outside the repository. Do not import evaluation scripts at runtime.
- Run `npm run check` and `npm run package:vsix` for product changes. Native engine and extension-host checks are separate: `npm run test:engine` and `npm run test:host`.
- Use meaningful behavior tests. A mock engine tests adapter behavior; it cannot prove native semantic support.
- Report unsupported or unknown capabilities explicitly. No diagnostics is not proof of complete validation.
- Use LF and the committed lock file. Never force-push, publish packages or upload local artifacts without user authorization.
- Keep user documentation in English by default, with `.zh-Hans.md` for Simplified Chinese. Update both editions together; preserve original license and generated third-party notice texts.

- For project context and Agent diagnostic observations, use [the SysML diagnostics skill](skills/sysml-diagnostics/SKILL.md); distinguish editor observations, independent LSP observations and saved-project API validation.
