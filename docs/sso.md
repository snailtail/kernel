# Single sign-on

Kernel supports two ways for people to sign in with an existing identity. Both are configured under
Administration → Single sign-on (administrators, with step-up and a reason).

## OpenID Connect

This works with Microsoft Entra ID, Google, Keycloak, Authentik, Okta and any other OIDC provider.

- **Flow:** authorization code with PKCE (S256), plus a one-time `state` and a `nonce` kept on the server for ten
  minutes. The implicit flow is not used. openid-client checks the ID token's issuer, audience, expiry and nonce
  against the provider's published keys. Every request to the provider goes through Kernel's outbound client.
- **Redirect URL:** register `<KERNEL_PUBLIC_URL>/api/auth/sso/callback` at the provider. `KERNEL_PUBLIC_URL` must
  be set.
- **Roles:** come from the groups claim (`groups` by default).
  - The highest mapped role wins.
  - **Administrator only when a group is explicitly mapped to it.**
  - People in no mapped group either cannot sign in, or get the default role (viewer or analyst, never more).
  - The role follows the groups at every sign-in.
- **Teams:** mapped groups also give team membership, kept in step at every sign-in. Teams that are not mapped are
  left alone.
- **Accounts:** created on first sign-in, with no usable password, and linked to the person with the same e-mail.
  They are never attached to an existing local account by e-mail.
- **Sessions:**
  - Every sign-in starts a new session (no session fixation).
  - If the provider requires a second factor, Kernel does not ask for its own.
  - Step-up confirmation for SSO accounts is "sign in again with SSO".
- **Local accounts** stay as a break-glass option. Password sign-in can be limited to administrators.

For Entra ID, the issuer is `https://login.microsoftonline.com/<tenant id>/v2.0`. Add the "groups" optional claim to
the ID token, or use app roles.

## Cloudflare Access

When Kernel runs behind Cloudflare Access, people have already signed in there. With Access sign-in on:

- The login page asks Kernel to verify the `Cf-Access-Jwt-Assertion` header: its signature against the team's
  published keys, the issuer `https://<team>.cloudflareaccess.com`, the application's audience (AUD) tag and its
  expiry.
- If the header is valid, Kernel starts a session for the active account with the same e-mail.
- No account is created this way. An administrator creates it, or OIDC sign-in does.

The team domain and AUD tag are on the Access application in the Cloudflare dashboard.
