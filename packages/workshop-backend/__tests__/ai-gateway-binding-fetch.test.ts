import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createGatewayBindingFetch,
} from "../src/ai-gateway-binding-fetch.js";

const BASE_URL = "https://gateway.ai.cloudflare.com/v1/account-id/my-gateway";
const UNIVERSAL_URL = "https://workers-binding.ai/ai-gateway/universal/run/my-gateway";

type UniversalEntry = {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
};

type CapturedFetch = {
  input: Request | string | URL;
  init: RequestInit | undefined;
};

function fakeBinding(response?: Response) {
  const calls: CapturedFetch[] = [];
  const binding = {
    fetch: (input: Request | string | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(response ?? new Response("{}"));
    },
  };
  // The shim never parses the envelope; tests do, to assert on entries.
  const entry = (index = 0): UniversalEntry =>
      (JSON.parse(calls[index].init?.body as string) as UniversalEntry[])[0];
  return { binding, calls, entry };
}

describe("createGatewayBindingFetch", () => {
  it("derives provider and endpoint from gateway passthrough URLs", async () => {
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude" }),
    });
    await fetchFn(`${BASE_URL}/openai/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt" }),
    });
    await fetchFn(`${BASE_URL}/workers-ai/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "@cf/meta/llama" }),
    });

    expect(calls.map((_, index) => [entry(index).provider, entry(index).endpoint])).toEqual([
      ["anthropic", "v1/messages"],
      ["openai", "responses"],
      ["workers-ai", "v1/chat/completions"],
    ]);
    expect(entry(0).query).toEqual({ model: "claude" });
  });

  it("dispatches to the gateway's universal endpoint through the binding", async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude" }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(UNIVERSAL_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("splices the body string into the envelope without re-encoding", async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
    // Key-order and whitespace quirks a parse/re-encode round trip would not preserve.
    const bodyText = '{ "b": 1,\n\t"a": [2,   3], "text": "line1\\nline2" }';

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "POST", body: bodyText });

    const envelope = calls[0].init?.body as string;
    expect(envelope.includes(bodyText)).toBe(true);
    expect(envelope).toBe(
        `[{"provider":"anthropic","endpoint":"v1/messages","headers":{},"query":${bodyText}}]`);
  });

  it("locks the exact wire format of the spliced envelope", async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01" },
      body: '{"model":"claude"}',
    });

    expect(calls[0].init?.body).toBe(
        '[{"provider":"anthropic","endpoint":"v1/messages",' +
        '"headers":{"anthropic-version":"2023-06-01"},"query":{"model":"claude"}}]');
  });

  it("scans the body for a single complete JSON object without parsing it", async () => {
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    // Leading/trailing JSON whitespace is fine, as are braces and escapes inside strings.
    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: ' \t\r\n {"model":"claude"} \n',
    });
    expect(entry(0).query).toEqual({ model: "claude" });
    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: '{"a":"}]{[\\"","b":[{}]}',
    });
    expect(entry(1).query).toEqual({ a: '}]{["', b: [{}] });
    expect(calls).toHaveLength(2);

    const reject = (body: string) =>
        expect(fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "POST", body }))
            .rejects.toThrow("body is not a single JSON object");
    // Non-object JSON values are unexpressible: the envelope's `query` must be an object.
    await reject("not json");
    await reject("[1]");
    // Envelope injection: content after the object's close would escape the `query` slot and
    // override envelope fields or add extra entries. All rejected by the balance scan.
    await reject('{"a":1},"provider":"evil"');
    await reject('{"q":1}},{"provider":"evil","endpoint":"x","headers":{},"query":{"q":2}');
    await reject('{"a":1} {"b":2}');
    // Unbalanced nesting / unterminated strings never complete the object.
    await reject('{"a":1');
    await reject('{"a":"');
    await reject('{"a":1]');
    expect(calls).toHaveLength(2);
  });

  it("keeps the query string in the endpoint", async () => {
    const { binding, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/openai/responses?beta=true`, {
      method: "POST",
      body: "{}",
    });

    expect(entry().endpoint).toBe("responses?beta=true");
  });

  it("lowercases header names so case-variant duplicates collapse", async () => {
    const { binding, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "Anthropic-Version": "2023-06-01" },
      body: "{}",
    });

    expect(entry().headers).toEqual({ "anthropic-version": "2023-06-01" });
  });

  it("lets init headers replace a Request input's headers, per the fetch spec", async () => {
    const { binding, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(
        new Request(`${BASE_URL}/anthropic/v1/messages`, {
          method: "POST",
          headers: { "x-from-request": "yes" },
          body: "{}",
        }),
        { headers: { "x-from-init": "yes" } });

    expect(entry().headers["x-from-init"]).toBe("yes");
    expect(entry().headers["x-from-request"]).toBeUndefined();
  });

  it("strips gateway auth and derived headers, forwards the rest", async () => {
    const { binding, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "17",
        "CF-AIG-Authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
        "cf-aig-metadata": '{"user":"42"}',
        "anthropic-version": "2023-06-01",
        "x-api-key": "provider-key",
      },
      body: "{}",
    });

    const headers = entry().headers;
    expect(headers["cf-aig-authorization"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["cf-aig-metadata"]).toBe('{"user":"42"}');
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Provider auth headers pass through: that is how request-supplied (BYOK) keys ride.
    expect(headers["x-api-key"]).toBe("provider-key");
  });

  it("accepts Request inputs and forwards their headers and body", async () => {
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(new Request(`${BASE_URL}/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    }));

    expect(calls).toHaveLength(1);
    expect(entry().provider).toBe("openai");
    expect(entry().endpoint).toBe("chat/completions");
    expect(entry().query).toEqual({ stream: true });
    expect(entry().headers["content-type"]).toBe("application/json");
  });

  it("forwards the abort signal on init", async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
    const controller = new AbortController();

    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("lets an explicit `signal: null` in init clear a Request input's signal, per the fetch spec",
      async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
    const controller = new AbortController();

    await fetchFn(
        new Request(`${BASE_URL}/anthropic/v1/messages`, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        }),
        { signal: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].init && "signal" in calls[0].init ? calls[0].init.signal : undefined)
        .toBeUndefined();
  });

  it("returns the binding response untouched, including streaming bodies", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        controller.close();
      },
    });
    const bindingResponse = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
    });
    const { binding } = fakeBinding(bindingResponse);
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    const response = await fetchFn(`${BASE_URL}/workers-ai/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });

    expect(response).toBe(bindingResponse);
    expect(response.headers.get("cf-aig-log-id")).toBe("log-1");
    expect(await response.text()).toBe("data: {}\n\n");
  });

  it("rejects in-prefix requests the universal endpoint cannot express", async () => {
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await expect(fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "GET" }))
        .rejects.toThrow("cannot express GET");
    await expect(fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "POST", body: "not json" }))
        .rejects.toThrow("body is not a single JSON object");
    await expect(fetchFn(`${BASE_URL}/anthropic/v1/messages`, { method: "POST" }))
        .rejects.toThrow("missing body");
    await expect(fetchFn(`${BASE_URL}/anthropic`, { method: "POST", body: "{}" }))
        .rejects.toThrow("missing provider/endpoint path");
    expect(calls).toHaveLength(0);
  });

  it("rejects URLs outside the gateway prefix: transport selection is the caller's", async () => {
    // Silent passthrough would ship the auth sentinel to whatever host the URL names; a
    // misconfigured baseUrl must fail loudly instead.
    const { binding, calls } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await expect(fetchFn("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" }))
        .rejects.toThrow("outside the configured gateway prefix");
    // Same origin, different path (another account's gateway) is just as out-of-prefix.
    await expect(fetchFn(
        "https://gateway.ai.cloudflare.com/v1/other-account/my-gateway/anthropic/v1/messages",
        { method: "POST", body: "{}" }))
        .rejects.toThrow("outside the configured gateway prefix");
    expect(calls).toHaveLength(0);
  });

  it("matches and splits on the URL-normalized path, as real fetch would send it", async () => {
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    // Dot segments normalize away before the provider/endpoint split, so a lexical variant
    // routes exactly like its normal form (raw string prefixing would split it differently).
    await fetchFn(`${BASE_URL}/anthropic/../anthropic/v1/./messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude" }),
    });
    expect([entry().provider, entry().endpoint]).toEqual(["anthropic", "v1/messages"]);

    // A dot-segment URL that resolves outside the prefix is rejected even though it starts
    // with the prefix as a raw string.
    await expect(fetchFn(`${BASE_URL}/../other-gateway/anthropic/v1/messages`,
        { method: "POST", body: "{}" }))
        .rejects.toThrow("outside the configured gateway prefix");
    expect(calls).toHaveLength(1);
  });

  it("inherits a Request input's body on explicit `body: null` in init, per the fetch spec",
      async () => {
    // Unlike `signal`, init.body must exist AND be non-null to override: `body: null` behaves
    // like an absent body, so the Request input's own body rides through.
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });

    await fetchFn(
        new Request(`${BASE_URL}/anthropic/v1/messages`, {
          method: "POST",
          body: JSON.stringify({ model: "claude" }),
        }),
        { body: null });

    expect(calls).toHaveLength(1);
    expect(entry().query).toEqual({ model: "claude" });
  });

  it("consumes a one-shot stream body for the object scan", async () => {
    const { binding, calls, entry } = fakeBinding();
    const fetchFn = createGatewayBindingFetch({ binding, baseUrl: BASE_URL, gateway: "my-gateway" });
    const streamOf = (text: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

    // JSON stream body: consumed once, spliced into the envelope as the query.
    await fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: streamOf('{"model":"claude"}'),
      duplex: "half",
    } as RequestInit);
    expect(calls).toHaveLength(1);
    expect(entry().query).toEqual({ model: "claude" });

    // Non-object stream body: rejects like any other non-object body (never replayed).
    await expect(fetchFn(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      body: streamOf("not json"),
      duplex: "half",
    } as RequestInit)).rejects.toThrow("body is not a single JSON object");
    expect(calls).toHaveLength(1);
  });
});
