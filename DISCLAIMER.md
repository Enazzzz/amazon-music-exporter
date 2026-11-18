# Disclaimer & Responsible Use

**Please read this before installing or using Amazon Music Exporter ("the script").**
By using the script you agree to the points below. This document is not legal advice.

## 1. Unofficial and not affiliated with Amazon
The script is an independent, unofficial project. It is **not affiliated with, endorsed by,
sponsored by, or supported by Amazon.com, Inc. or any of its affiliates**. "Amazon", "Amazon Music"
and related names and logos are trademarks of Amazon.com, Inc. or its affiliates. They are used here
only to describe what the script works with.

## 2. Undocumented internal endpoints, and your responsibility
The script reads data through the same **undocumented, internal** web API that the Amazon Music
web player uses. Amazon does not publish this API, and it can change, be restricted, or stop working
at any time without notice.

Using the script, or automated access of any kind, **may conflict with Amazon's Conditions of Use,
the Amazon Music Terms of Use, or other Amazon policies**. You alone are responsible for reading
those terms, deciding whether your use complies with them, and accepting any consequences, including
restriction, suspension, or termination of your Amazon account. The author accepts no responsibility
for any of these outcomes.

## 3. Permitted use: your own account, your own data
Use the script **only while signed in to your own Amazon account**, and only to back up, archive, or
analyze **your own** playlists, listening history, and library data for personal, non-commercial purposes.

## 4. Prohibited use
Do **not** use the script, or any modified version of it, to:

- access, export, or view **anyone else's** account, session, or data, including shared, borrowed,
  or compromised accounts;
- share, sell, or transfer sessions, cookies, tokens, or request headers;
- scrape, crawl, or bulk-harvest Amazon's catalog, metadata, artwork, or other users' public content;
- redistribute, publish, sell, or otherwise commercially exploit exported data or Amazon content;
- circumvent DRM, paywalls, subscription checks, geographic restrictions, rate limits, or any other
  technical or access control;
- obtain, record, or download audio or video streams. **The script downloads no audio.** It exports
  only text metadata such as titles, artists, timestamps, and links;
- send high request volumes, run many copies in parallel, remove or shorten the built-in delays, or
  otherwise put unreasonable load on Amazon's servers.

## 5. Read-only and rate-limited by design
The script only sends GraphQL **queries** (reads). It never sends mutations, so it cannot change your
playlists, likes, or settings. It waits about 1.5 seconds between requests and backs off for 30 seconds
when Amazon signals overload (HTTP 429/5xx). **Do not modify it to remove these safeguards.** Forks
should keep them.

## 6. Protect your session and tokens
- While it runs, the script holds your page's session headers in memory only. It never saves,
  logs, or exports them.
- **Never share** console output, HAR files, "Copy as fetch/cURL" text, request headers, cookies, or
  screenshots of developer tools. These can contain tokens that give access to your account.
- **Redact** anything token-like before you open an issue, post in a discussion, or ask for help.
- If you think a token was exposed, sign out of Amazon on all devices and change your password.

## 7. Only install code you trust
A userscript runs inside pages where you are **signed in**, with the same access you have. Install
the script only from this repository or a source you trust, and **read the code** before installing,
including after updates. The script is one readable file with no third-party dependencies. Be wary of
modified copies from elsewhere.

## 8. Your exports are personal data
Listening history and playlist exports show your habits, routines, and the times you listen.
**Treat them as private.** Store them securely and think carefully before sharing or uploading them
anywhere, including to AI tools and public repositories.

## 9. No warranty and limitation of liability
The script is provided **"AS IS", without warranty of any kind**, express or implied. To the maximum
extent permitted by law, the author and contributors are **not liable** for any claim, damages, data
loss, account action, or other liability arising from use of the script. See [LICENSE](LICENSE)
(MIT) for the full terms.

## 10. Takedown and contact
If you are a rights holder or represent Amazon and have a concern, please
[open an issue](https://github.com/Enazzzz/amazon-music-exporter/issues) or contact the repository
owner through GitHub. The author will respond to good-faith rights-holder requests, including takedown
requests, promptly. For security problems, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## 11. Not legal advice
Nothing in this repository is legal advice. If you are unsure whether your use is allowed, consult
the applicable terms or a qualified professional, or don't use the script.
