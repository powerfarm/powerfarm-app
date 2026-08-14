// Cloudflare AI Gateway over the AI binding's fetch passthrough.
//
// Vendored mirror of pi's (to-be-released) cloudflare-gateway-binding module; delete this file
// and import from @earendil-works/pi-ai once a pi release ships it.
//
// `createGatewayBindingFetch` returns a fetch that translates requests bound for an AI Gateway
// HTTPS endpoint (https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/...) into calls
// through the plain AI binding's fetch passthrough (env.WORKERS_AI.fetch()), targeting the
// gateway's universal endpoint (https://workers-binding.ai/ai-gateway/universal/run/{gateway}),
// which returns the provider's native wire format as a regular streaming Response.
//
// The universal endpoint takes a JSON envelope, [{provider, endpoint, headers, query}], where
// `query` is the provider request body. The shim builds that envelope by string splicing: the
// request body is already JSON text, so it is embedded verbatim as the `query` value without
// ever being parsed or re-encoded in the isolate -- multi-MB prompt bodies cost one extra
// body-sized string, not a parsed object tree. Before splicing, a single O(n) scan checks the
// body is exactly one complete JSON object (string-aware brace balance, nothing but whitespace
// after the close), so a malformed body cannot terminate `query` early and inject envelope
// fields or extra entries. The trade-off vs parsing: JSON errors *inside* the object are no
// longer caught locally and instead surface in the gateway's error response. (A future gateway
// raw endpoint, /ai-gateway/raw/..., could drop the envelope entirely; the universal endpoint
// is what exists today.)
//
// `Ai#fetch` exists at runtime but is not declared on @cloudflare/workers-types' `Ai` class,
// hence the structural AiFetchBinding interface and the cast at the caller.
//
// Binding calls are pre-authenticated in-account, so no cf-aig-authorization token is needed --
// pass CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL where an auth header is required to satisfy
// pi's request-auth checks; the shim strips it before dispatch. Pair the sentinel with explicit
// `Authorization: null` / `x-api-key: null` provider headers (a null value deletes the header
// in the SDKs): with header-owned auth the SDKs otherwise inject a placeholder auth header
// (e.g. `Authorization: Bearer unused`), which the shim forwards like any provider auth header
// -- and the gateway treats a request-supplied provider auth header as a BYOK key that
// overrides its stored keys, the same as it would over HTTPS.

import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Structural type for the AI binding's fetch passthrough (`env.WORKERS_AI.fetch()`). Any real
 * `Ai` binding satisfies it at runtime, but the public `Ai` type does not declare `fetch`, so
 * callers cast: `binding as unknown as AiFetchBinding`.
 */
export interface AiFetchBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Placeholder value for auth headers on binding-routed requests. pi's API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy the
 * check. The shim strips `cf-aig-authorization` before calling the binding. Pair it with
 * `Authorization: null` / `x-api-key: null` so the SDKs' placeholder auth headers never reach
 * the gateway (see the module docs).
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

export interface GatewayBindingFetchOptions {
  /** The AI binding (e.g. env.WORKERS_AI), cast to AiFetchBinding. */
  binding: AiFetchBinding;
  /**
   * Gateway HTTPS prefix every request must fall under, without a trailing slash:
   * https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}.
   */
  baseUrl: string;
  /** Gateway name on the universal endpoint's path. Must match the baseUrl gateway. */
  gateway: string;
}

// Never forwarded to the binding: hop-by-hop/derived headers, and gateway auth (binding calls
// are pre-authenticated; the sentinel must not reach the wire, and a real gateway token is
// meaningless on this path and would only end up in request logs).
const STRIP_HEADERS = new Set(["content-length", "host", "cf-aig-authorization"]);

type FetchInput = Parameters<FetchFunction>[0];

/**
 * Create a `fetch` that routes AI Gateway requests through the AI binding. This is the
 * transport for one gateway-bound client, not a general-purpose fetch: URLs outside the
 * configured gateway prefix, and in-prefix requests the binding cannot express (non-POST,
 * non-JSON-object body), reject with a descriptive error. Transport selection is the caller's
 * job, per client -- route such traffic over HTTPS with real gateway auth instead.
 */
export function createGatewayBindingFetch(options: GatewayBindingFetchOptions): FetchFunction {
  const { binding, gateway } = options;
  // Prefix matching runs on URL-normalized components (origin + pathname), not raw strings:
  // dot segments resolve away and fragments drop, matching what real fetch would put on the
  // wire, so a lexical variant can't split provider/endpoint differently than HTTPS would.
  const base = new URL(options.baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const universalUrl =
      `https://workers-binding.ai/ai-gateway/universal/run/${encodeURIComponent(gateway)}`;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : input.toString();
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    // Out-of-prefix URLs are a configuration bug, not passthrough traffic: silently
    // forwarding would ship the auth sentinel to whatever host the URL names.
    if (parsed === undefined || parsed.origin !== base.origin ||
        !parsed.pathname.startsWith(basePath)) {
      throw new Error(
          `createGatewayBindingFetch: ${method} ${url} is outside the configured gateway ` +
          `prefix (${base.origin}${basePath}); this fetch only serves its gateway-bound client`);
    }

    // In-prefix requests the universal endpoint cannot express always reject: forwarding
    // them over HTTPS would send the sentinel to the gateway and fail with a misleading
    // auth error instead of naming the real problem. Callers that need such endpoints
    // route them over HTTPS with real gateway auth themselves.
    const unexpressible = (reason: string): never => {
      throw new Error(
          `createGatewayBindingFetch: cannot express ${method} ${url} as a universal ` +
          `gateway request (${reason}); route it over HTTPS with gateway auth instead`);
    };
    if (method !== "POST") return unexpressible("only POST is supported");

    const rest = parsed.pathname.slice(basePath.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      return unexpressible("missing provider/endpoint path");
    }
    const provider = rest.slice(0, slash);
    // Keep the query string on the endpoint -- it's part of what HTTPS would have sent.
    const endpoint = rest.slice(slash + 1) + parsed.search;

    const bodyText = await readBodyText(request, init);
    if (bodyText === undefined) {
      return unexpressible("missing body");
    }
    if (!isSingleJsonObjectText(bodyText)) {
      return unexpressible("body is not a single JSON object");
    }

    const headers = collectHeaders(request, init);
    const envelope =
        `[{"provider":${JSON.stringify(provider)},"endpoint":${JSON.stringify(endpoint)},` +
        `"headers":${JSON.stringify(headers)},"query":${bodyText}}]`;

    // Per the fetch spec an explicit `signal: null` in init clears a Request input's signal.
    const signal = init?.signal ??
        (init && "signal" in init && init.signal === null ? undefined : request?.signal);
    return binding.fetch(universalUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope,
      ...(signal ? { signal } : {}),
    });
  };
}

// JSON whitespace per RFC 8259: space, tab, line feed, carriage return.
function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

// The body is spliced into the envelope as the `query` JSON value, so it must be exactly one
// complete JSON object: an opening `{` whose matching close is followed by nothing but
// whitespace, with nesting tracked across string literals. Anything looser could terminate
// `query` early and inject envelope fields (duplicate keys override provider/endpoint) or
// whole extra entries. A single O(n) scan enforces this without materializing the parsed tree
// this transport exists to avoid; JSON errors *inside* the object (which cannot escape the
// splice) still surface in the gateway's error response instead of locally.
function isSingleJsonObjectText(text: string): boolean {
  let i = 0;
  while (i < text.length && isJsonWhitespace(text[i])) i++;
  if (text[i] !== "{") return false;
  let depth = 0;
  let inString = false;
  for (; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        if (char !== "}") return false;
        for (i++; i < text.length; i++) {
          if (!isJsonWhitespace(text[i])) return false;
        }
        return true;
      }
    }
  }
  // Never closed: unbalanced nesting or an unterminated string.
  return false;
}

async function readBodyText(request: Request | undefined, init?: RequestInit)
    : Promise<string | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) {
    // Per the fetch spec, init.body must exist AND be non-null to override, so an explicit
    // `body: null` behaves like an absent body and inherits a Request input's body (unlike
    // `signal`, where an explicit null clears). Read the input directly rather than cloning:
    // unexpressible requests reject rather than replay, so nothing needs the body again, and
    // a clone's unread tee branch would retain a buffered copy of a multi-MB body.
    if (request && request.body !== null) return request.text();
    return undefined;
  }
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  // URLSearchParams, FormData, Blob, ReadableStream in init: read via a Request wrapper.
  // Consuming a one-shot stream here is fine -- unexpressible requests reject rather than
  // replay, so nothing downstream needs the body again.
  return new Request("http://body.local", {
    method: "POST",
    body,
    // The fetch spec requires `duplex: "half"` to construct a Request with a stream body
    // (Node's undici enforces it; it is ignored for the replayable body types). TypeScript's
    // RequestInit does not declare the field yet, hence the cast.
    duplex: "half",
  } as RequestInit).text();
}

// Entry header names are lowercased so case-variant duplicates collapse and stripping is
// uniform. Per the fetch spec, `init.headers` replaces a Request input's headers entirely.
function collectHeaders(request: Request | undefined, init?: RequestInit)
    : Record<string, string> {
  const result: Record<string, string> = {};
  const add = (key: string, value: string) => {
    const name = key.toLowerCase();
    if (!STRIP_HEADERS.has(name)) result[name] = value;
  };
  const headers = init?.headers;
  if (headers === undefined) {
    if (request) {
      for (const [key, value] of request.headers) add(key, value);
    }
  } else if (headers instanceof Headers) {
    for (const [key, value] of headers) add(key, value);
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) add(key, value);
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) add(key, String(value));
    }
  }
  return result;
}
