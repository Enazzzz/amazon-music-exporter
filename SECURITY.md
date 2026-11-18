# Security Policy

## Reporting a vulnerability

Please report security problems **privately**. Do not use a public issue.

1. Go to the repository's **Security** tab → **Report a vulnerability**
   ([GitHub private vulnerability reporting](https://github.com/Enazzzz/amazon-music-exporter/security/advisories/new)).
2. Describe the problem, the affected version (see `@version` in the script header), your browser and
   userscript manager, and the steps to reproduce.

You should get a response within a few days. Once a fix ships, the advisory can be published with
credit to you if you'd like.

## Never include secrets

**Do not include tokens, cookies, request headers, HAR files, "Copy as fetch/cURL" output, or
unredacted exports in any report.** Replace them with `REDACTED`. If you think you leaked a token,
sign out of Amazon on all devices and change your password.

## Scope

In scope, i.e. problems in this repository's code that could:
- leak your session headers, cookies, or tokens (to storage, logs, exports, the page, or third parties);
- let a web page or other script abuse the exporter to make unintended requests;
- send anything other than read-only queries, or skip the built-in rate limits;
- cause injection through exported data (for example, unsafe HTML rendering of track titles in the panel).

Out of scope:
- vulnerabilities in Amazon's services or APIs (report those to Amazon through its own security programs);
- vulnerabilities in browsers or userscript managers (report those upstream);
- the fact that the script uses undocumented endpoints or may break when Amazon changes them;
- issues that require an attacker who already controls your browser or machine.

## Supported versions

Only the latest version on the `main` branch is supported.
