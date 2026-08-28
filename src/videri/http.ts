import { config } from "../config.js";
import type { VideriAuth } from "./auth.js";

export class VideriApiError extends Error {
  constructor(
    readonly status: number,
    readonly service: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${service} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "VideriApiError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Base paths per service. The four Spring services declare `servers` in their
 * spec; the seven NestJS ones declare none, so their prefix has to be known
 * out-of-band. Another thing a third-party integrator cannot learn from the
 * published specs alone.
 */
export const SERVICE_BASE = {
  aggregator: "/aggregator",
  alerting: "/alerting",
  auditTrail: "/audit-trail",
  canvasService: "/canvas-service",
  canvasStatus: "/canvas-status",
  cms: "/cms",
  messaging: "/messaging-websocket",
  paywall: "/paywall",
  publisher: "/publisher",
  rpm: "/rpm",
  tagManager: "/tag-manager",
} as const;

export type ServiceName = keyof typeof SERVICE_BASE;

/** Spring-style page envelope (canvas-service). */
export interface SpringPage<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
  last: boolean;
}

/** NestJS-style page envelope (everything else). */
export interface NestPage<T> {
  data: T[];
  meta: { itemsPerPage: number; totalItems: number; currentPage: number; totalPages: number };
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Historically read as "canvas-status wants `x-tenant_id` INSTEAD of
   * `x-tenant`". That was wrong, and it was expensive.
   *
   * Measured on `/canvas-status/data_usage/{serial}`:
   *   x-tenant only    -> 200
   *   x-tenant_id only -> 403   (identical to sending NO tenant header)
   *   both             -> 200
   *   none             -> 403
   *
   * So `x-tenant_id` is silently ignored, and the 403 means "no tenant context"
   * rather than "denied". Believing otherwise is what produced our headline
   * finding that data_usage was withheld from a tenant admin — the only
   * structured time series on the platform, reported as inaccessible for weeks
   * because of one header name.
   *
   * This flag now means "also send x-tenant_id", never "instead of". `x-tenant`
   * is always sent.
   */
  tenantHeaderStyle?: "x-tenant" | "x-tenant_id";
  signal?: AbortSignal;
}

/**
 * One HTTP client that absorbs the platform's cross-cutting inconsistencies so
 * nothing above this layer has to know about them:
 *
 *   - four different path prefix conventions
 *   - `x-tenant` vs `x-tenant_id`
 *   - `x-tenant` marked optional on operations that require it (we always send)
 *   - two pagination dialects and two response envelopes
 *
 * Retries on 429 and 5xx with backoff. Worth noting: **no rate limit is
 * documented anywhere in the API, and no operation declares a 429 response** —
 * so the retry policy here is defensive guesswork, not an implementation of a
 * published contract.
 */
export class VideriHttp {
  constructor(
    private readonly auth: VideriAuth,
    private readonly baseUrl: string = config.VIDERI_API_BASE,
    private readonly tenant: string = config.VIDERI_TENANT,
  ) {}

  async request<T>(service: ServiceName, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${SERVICE_BASE[service]}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const tenantHeader = opts.tenantHeaderStyle ?? "x-tenant";
    const maxAttempts = 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = await this.auth.token();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        // Always present: it is the header the gateway actually reads.
        "x-tenant": this.tenant,
      };
      // Additive, never a replacement — see tenantHeaderStyle above.
      if (tenantHeader === "x-tenant_id") headers["x-tenant_id"] = this.tenant;
      if (opts.body !== undefined) headers["content-type"] = "application/json";

      // Built conditionally: exactOptionalPropertyTypes rejects an explicit
      // `undefined` for `body` / `signal` in RequestInit.
      const init: RequestInit = { method: opts.method ?? "GET", headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      if (opts.signal) init.signal = opts.signal;

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (cause) {
        lastError = cause;
        if (attempt === maxAttempts) throw cause;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const body = await response.text().catch(() => "");
      const error = new VideriApiError(response.status, service, path, body);

      // 401 once → drop the cached token, re-authenticate, retry. Twice → the
      // credentials themselves are wrong, so retrying cannot help.
      if (response.status === 401 && attempt === 1) {
        this.auth.invalidate();
        lastError = error;
        continue;
      }
      if (!error.retryable || attempt === maxAttempts) throw error;

      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
      lastError = error;
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Walk a Spring-paginated endpoint to exhaustion. */
  async *springPages<T>(
    service: ServiceName,
    path: string,
    opts: RequestOptions & { size?: number } = {},
  ): AsyncGenerator<T[]> {
    const size = opts.size ?? 200;
    for (let page = 0; ; page++) {
      const result = await this.request<SpringPage<T>>(service, path, {
        ...opts,
        query: { ...opts.query, page, size },
      });
      if (result.content.length > 0) yield result.content;
      if (result.last || result.content.length === 0) return;
    }
  }

  /** Walk a NestJS-paginated endpoint to exhaustion. */
  async *nestPages<T>(
    service: ServiceName,
    path: string,
    opts: RequestOptions & { limit?: number } = {},
  ): AsyncGenerator<T[]> {
    const limit = opts.limit ?? 200;
    for (let page = 1; ; page++) {
      const result = await this.request<NestPage<T>>(service, path, {
        ...opts,
        query: { ...opts.query, page, limit },
      });
      if (result.data.length > 0) yield result.data;
      if (page >= (result.meta?.totalPages ?? 1) || result.data.length === 0) return;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, capped. */
const backoffMs = (attempt: number) =>
  Math.min(500 * 2 ** (attempt - 1), 8_000) * (0.5 + Math.random() / 2);
