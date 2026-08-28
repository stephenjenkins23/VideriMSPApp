/**
 * Videri authentication.
 *
 * The platform issues short-lived tokens in exchange for an API key plus account
 * credentials:
 *
 *   POST {API_BASE}/rpm-service/v2/auth/token
 *   { username, password, api_key }
 *   → { access_token, id_token, refresh_token, expires_in, token_type }
 *
 * Two details that are easy to get wrong, both from the developer portal:
 *
 *  1. **Use `id_token`, not `access_token`.** The access token is reserved for
 *     Videri-internal OAuth scopes; the id_token is the JWT the REST APIs
 *     expect. Sending the access token gets you past our own code and fails at
 *     the gateway.
 *
 *  2. **The endpoint is `/rpm-service/...`, not the `/rpm` prefix** the RPM
 *     OpenAPI document is served under. It is not an operation in any of the
 *     eleven specs — it appears only in RPM's `info.description` prose. Anything
 *     generated from the machine-readable surface will not know it exists.
 *
 * Tokens last ~1 hour. We refresh ahead of expiry and collapse concurrent
 * refreshes, since the poller has many callers.
 */

import { config, requireCredentials } from "../config.js";

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class VideriAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VideriAuthError";
  }
}

export class VideriAuth {
  #idToken: string | null = null;
  #refreshToken: string | null = null;
  #expiresAt = 0;
  #inFlight: Promise<string> | null = null;

  /** Refresh this far ahead of expiry so in-flight requests never race it. */
  static readonly #SKEW_MS = 120_000;

  constructor(private readonly baseUrl: string = config.VIDERI_API_BASE) {}

  async token(): Promise<string> {
    if (this.#idToken && Date.now() < this.#expiresAt - VideriAuth.#SKEW_MS) {
      return this.#idToken;
    }
    this.#inFlight ??= this.#authenticate().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Discard the cached token. Used by the HTTP layer on an unexpected 401. */
  invalidate(): void {
    this.#idToken = null;
    this.#expiresAt = 0;
  }

  async #authenticate(): Promise<string> {
    const { username, password, apiKey } = requireCredentials();
    const url = `${this.baseUrl}/rpm-service/v2/auth/token`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, api_key: apiKey }),
      });
    } catch (cause) {
      throw new VideriAuthError(0, `Could not reach the token endpoint: ${(cause as Error).message}`);
    }

    const body = (await response.json().catch(() => null)) as
      | (TokenResponse & { message?: string | string[] })
      | null;

    if (!response.ok) {
      // The endpoint distinguishes a bad key from bad credentials, which is
      // genuinely useful — pass it straight through rather than flattening it
      // into "auth failed".
      const detail = Array.isArray(body?.message)
        ? body.message.join("; ")
        : (body?.message ?? `HTTP ${response.status}`);
      throw new VideriAuthError(
        response.status,
        `Token request rejected: ${detail}. ` +
          (response.status === 401 && /api key/i.test(String(detail))
            ? "VIDERI_API_KEY is not recognised — check it was copied in full."
            : response.status === 401
              ? "VIDERI_USERNAME / VIDERI_PASSWORD were not accepted."
              : "Check the request body fields."),
      );
    }

    if (!body?.id_token) {
      throw new VideriAuthError(
        response.status,
        "Token response contained no id_token. " +
          (body?.access_token
            ? "An access_token was returned but that is not the token the REST APIs accept."
            : "The response shape was unexpected."),
      );
    }

    this.#idToken = body.id_token;
    this.#refreshToken = body.refresh_token ?? this.#refreshToken;
    this.#expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.#idToken;
  }

  /**
   * Whether a refresh token is held.
   *
   * The portal says the refresh token can be exchanged for a new token set but
   * does not document the endpoint that does it, so we currently re-authenticate
   * from the API key on expiry instead. That works — it is simply one extra
   * round trip an hour. Worth asking the platform team for the refresh route.
   */
  get hasRefreshToken(): boolean {
    return this.#refreshToken !== null;
  }
}
