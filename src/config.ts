import { z } from "zod";

const Schema = z.object({
  VIDERI_API_BASE: z.string().url().default("https://api.go.videri.com"),
  VIDERI_TENANT: z.string().min(1),

  /** Developer API key, created from the API Keys tab in the Videri dashboard. */
  VIDERI_API_KEY: z.string().optional(),
  VIDERI_USERNAME: z.string().optional(),
  VIDERI_PASSWORD: z.string().optional(),

  DATABASE_URL: z.string().min(1),

  /**
   * Poll cadences, sized from measurement rather than habit.
   *
   * Devices push telemetry on a ~15-22 minute cycle (measured across 120
   * devices: p50 age 13.5 min, p90 21.7 min, 0% under 2 min). Polling faster
   * than that returns the same reading repeatedly, and there is no documented
   * rate-limit budget to spend on it.
   *
   * `status` is stamped server-side at poll time and carries presence, so it is
   * NOT bound by the device push cycle; it is instead sized against the 5-minute
   * SLA bucket, at 2 min giving two samples per bucket even if one poll fails.
   * `metrics` carries the device-stamped payload and is bound by the push cycle,
   * so 7 min catches each new push within roughly half a cycle.
   */
  POLL_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  POLL_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(420_000),
  POLL_DEVICE_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),

  VFI_API_PORT: z.coerce.number().int().positive().default(8080),
  VFI_API_HOST: z.string().default("127.0.0.1"),
  /** Shared secret for the read API. Required unless --allow-anonymous is passed. */
  VFI_API_TOKEN: z.string().optional(),
  /** Comma-separated allowed origins for the dashboard. */
  VFI_API_CORS_ORIGINS: z.string().default(""),
});

export type Config = z.infer<typeof Schema>;

export const config: Config = Schema.parse(process.env);

/**
 * The three values the token endpoint needs.
 *
 * Documented at developer.videri.com/knowledge-base — an API key from the
 * dashboard's API Keys tab, plus the account's username and password.
 */
export function requireCredentials(): {
  username: string;
  password: string;
  apiKey: string;
} {
  const { VIDERI_USERNAME, VIDERI_PASSWORD, VIDERI_API_KEY } = config;
  const missing = [
    !VIDERI_USERNAME && "VIDERI_USERNAME",
    !VIDERI_PASSWORD && "VIDERI_PASSWORD",
    !VIDERI_API_KEY && "VIDERI_API_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Missing Videri credentials: ${missing.join(", ")}. All three are required by ` +
        `POST /rpm-service/v2/auth/token. The API key comes from the API Keys tab in ` +
        `the Videri dashboard and is shown only once when created.`,
    );
  }
  return {
    username: VIDERI_USERNAME!,
    password: VIDERI_PASSWORD!,
    apiKey: VIDERI_API_KEY!,
  };
}
