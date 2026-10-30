# Account entries and expired sessions

This implements the direction requested in [#1361](https://github.com/bulwarkmail/webmail/issues/1361#issuecomment-6506321416), replacing the optional account-list design in #1362.

When a session cannot be restored, keep its existing account entry as **Sign in again**. Reuse `awaitingSignIn`, which already represents accounts restored from a backup. There is one default behavior: no additional login checkbox, per-device preference or deployment setting.

| Event | Account metadata | Session and cached account data |
| --- | --- | --- |
| Missing session cookie or rejected refresh | Keep for sign-in | Clear credentials, connected client and account caches. |
| Reload without Remember me | Keep for sign-in | End the session; do not describe this deliberate expiry as an error. |
| Temporary outage or rate limit during startup restore | Keep existing retry state | Preserve the existing transient-failure policy. |
| Automatic session expiry or organisation time limit | Keep for sign-in | Clear credentials and native application data; session limits still apply. |
| Explicit sign-out of one account | Forget that account | Clear its credentials; other accounts awaiting sign-in remain listed. |
| Explicit sign-out of all accounts | Forget all entries | Clear every native credential and account cache. |
| Explicit removal | Forget the selected entry | Clear its credentials and cached rows. |

Retained names and server addresses never authenticate a request. A new password/token/provider sign-in is required. Accounts awaiting sign-in do not count as connected accounts or show cached unread counts. They are not automatically retried on every reload. Successful reauthentication clears the pending state and keeps the account's established identity/slot handling.

## Functional decisions

| Boundary | Decision |
| --- | --- |
| Account-list lifetime | Change: failed restoration retains metadata until explicit sign-out/removal. |
| Password, TOTP, OAuth and SSO methods | Preserve. |
| Cookie names, attributes, TTLs and refresh cadence | Preserve. |
| Token revocation and provider-session logout | Preserve existing native cleanup and automatic/manual sign-out rules. |
| Organisation idle/maximum session limits and draft flushing | Preserve; retaining metadata does not renew a session. |
| Database schema, backend storage and runtime dependencies | No additions. |

The sign-in action uses the existing restored-account path. The account-switcher label is translated in all 29 locales. Full and Lite use the same metadata policy, with their existing credential storage adapters.

복원 실패 시 인증정보는 정리하고 계정명·서버 주소만 남깁니다. 사용자가 직접 로그아웃하거나 제거하면 해당 항목을 삭제하며, 인증 수명과 조직의 세션 정책을 연장하지 않습니다.
