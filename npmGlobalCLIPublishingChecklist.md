# Askweb → npm Global CLI Publishing Checklist

1. **Prepare `package.json`**

   * [ ] Change `"name"` from `scraping-chatgpt` to `"askweb"`.
   * [ ] Keep the existing `"bin"` mapping as `"askweb": "index.js"`.
   * [ ] Keep the existing version unless there is a specific reason to change it.
   * [ ] Verify `package.json` has valid JSON.
   * [ ] Do **not** add unnecessary dependencies or change existing functionality.

2. **Verify the CLI entry point**

   * [ ] Confirm `index.js` starts with:

     ```js
     #!/usr/bin/env node
     ```
   * [ ] Confirm `index.js` is executable where required.
   * [ ] Confirm the CLI can be invoked through the `askweb` binary.
   * [ ] Do **not** rewrite the CLI architecture just for npm publishing.

3. **Decide exactly what npm should contain**

   * [ ] Inspect the repository's current files and determine which files are required for Askweb to run after installation.
   * [ ] Include all required source files, configuration files, templates, and assets.
   * [ ] Exclude development-only files that are not required at runtime.
   * [ ] Exclude `.env` files and secrets.
   * [ ] Exclude API keys, authentication tokens, cookies, browser sessions, local credentials, personal data, logs, temporary files, and generated runtime data.
   * [ ] Exclude `node_modules/`.
   * [ ] Do **not** publish browser profiles or Askweb user/session data.

4. **Configure npm package contents**

   * [ ] Use the existing `.gitignore`/`.npmignore` strategy appropriately, or add/update `.npmignore` if necessary.
   * [ ] Prefer an explicit `"files"` allowlist in `package.json` when appropriate so only intended runtime files are published.
   * [ ] Make sure `README.md` and `LICENSE` are included.
   * [ ] Do **not** blindly publish the entire repository.

5. **Test the package before publishing**

   * [ ] Run:

     ```bash
     npm pack --dry-run
     ```
   * [ ] Review the complete list of files npm would publish.
   * [ ] Verify there is nothing private, unnecessary, or machine-specific.
   * [ ] If anything sensitive appears, **STOP** and fix the package configuration.
   * [ ] Run:

     ```bash
     npm pack
     ```
   * [ ] This should create a local `.tgz` package.

6. **Test the actual global installation locally**

   * [ ] Install the generated `.tgz` globally:

     ```bash
     npm install -g ./askweb-<version>.tgz
     ```
   * [ ] Verify:

     ```bash
     askweb --version
     ```
   * [ ] Verify:

     ```bash
     askweb --help
     ```
   * [ ] Open a completely different directory and run `askweb`.
   * [ ] Confirm Askweb works without being inside the Git repository.
   * [ ] Test important existing functionality, especially login/logout, conversations, file handling, prompts/presets, and normal questions.
   * [ ] Do **not** assume it works just because the global binary exists.

7. **Verify npm package metadata**

   * [ ] Confirm package name is exactly:

     ```text
     askweb
     ```
   * [ ] Confirm the package has an appropriate description.
   * [ ] Confirm the repository/homepage information points to the correct GitHub repository.
   * [ ] Confirm the license is correct.
   * [ ] Confirm the CLI version is correct.
   * [ ] Confirm `bin.askweb` points to `index.js`.
   * [ ] Do **not** publish under a different package name accidentally.

8. **Check npm name availability**

   * [ ] Run:

     ```bash
     npm view askweb
     ```
   * [ ] Determine whether the `askweb` package name is already owned by someone else.
   * [ ] If the name is unavailable, **do not rename/publish blindly**; choose an appropriate npm package name first.

9. **Clean up the repository**

   * [ ] Review `git status`.
   * [ ] Review all changes with:

     ```bash
     git diff
     ```
   * [ ] Remove generated `.tgz` files or other temporary artifacts if they should not be committed.
   * [ ] Confirm no secrets or private files were accidentally added.
   * [ ] Do **not** commit `.env`, credentials, session data, browser data, or generated personal files.

10. **Commit the npm-readiness changes**

    * [ ] Commit only the changes required for npm packaging.
    * [ ] Use a clear commit message, for example:

      ```text
      feat: prepare package for npm distribution
      ```
    * [ ] Push the commit to the `main` branch.
    * [ ] Verify GitHub contains the final intended version.

11. **Create/configure the npm account**

    * [ ] Create an account on npm if you do not already have one.
    * [ ] Verify the npm account/email as required.
    * [ ] Enable 2FA if appropriate.
    * [ ] Do **not** put your npm password, token, or OTP in source code or GitHub.

12. **Authenticate npm locally**

    * [ ] Run:

      ```bash
      npm login
      ```
    * [ ] Complete the npm authentication flow.
    * [ ] Verify the logged-in account:

      ```bash
      npm whoami
      ```
    * [ ] Confirm the returned username is your intended npm account.

13. **Perform the first publication**

    * [ ] Run the final package check again:

      ```bash
      npm pack --dry-run
      ```
    * [ ] Verify the package contents one final time.
    * [ ] Publish:

      ```bash
      npm publish
      ```
    * [ ] Do **not** use `--force` or other bypasses unless there is a specific, understood reason.
    * [ ] If npm reports an error, stop and resolve the error rather than repeatedly forcing publication.

14. **Verify the published package**

    * [ ] Check:

      ```bash
      npm view askweb
      ```
    * [ ] Confirm the published version is correct.
    * [ ] Confirm the README and package metadata appear correctly on npm.
    * [ ] Confirm the package contains only intended files.

15. **Test the real npm installation**

    * [ ] From a directory completely unrelated to the repository, run:

      ```bash
      npm install -g askweb
      ```
    * [ ] Verify:

      ```bash
      askweb --version
      ```
    * [ ] Verify:

      ```bash
      askweb --help
      ```
    * [ ] Test normal Askweb usage.
    * [ ] Confirm it works without cloning the GitHub repository.

16. **Update the Askweb README**

    * [ ] Make the primary installation method:

      ```bash
      npm install -g askweb
      ```
    * [ ] Document that `askweb` can then be run from any directory.
    * [ ] Keep development/source-install instructions separate from normal user installation.
    * [ ] Document how to update:

      ```bash
      npm update -g askweb
      ```
    * [ ] Document how to uninstall:

      ```bash
      npm uninstall -g askweb
      ```

17. **Final verification**

    * [ ] Fresh machine/folder → `npm install -g askweb` → `askweb`.
    * [ ] No Git clone required.
    * [ ] No manual copying of source files required.
    * [ ] No project-local installation required.
    * [ ] CLI works from arbitrary directories.
    * [ ] Existing Askweb functionality remains intact.
    * [ ] No secrets/private data are present in the npm package.
    * [ ] GitHub repository and npm package represent the intended release.

18. **Things NOT to do**

    * [ ] ❌ Do not publish before inspecting `npm pack --dry-run`.
    * [ ] ❌ Do not publish `.env` or credentials.
    * [ ] ❌ Do not publish browser/session data.
    * [ ] ❌ Do not publish `node_modules/`.
    * [ ] ❌ Do not commit npm authentication tokens.
    * [ ] ❌ Do not change working Askweb behavior unnecessarily.
    * [ ] ❌ Do not use `npm publish --force` to bypass an issue you have not understood.
    * [ ] ❌ Do not assume GitHub and npm are automatically synchronized.
    * [ ] ❌ Do not publish a package under `askweb` until `npm view askweb` confirms the name situation.
