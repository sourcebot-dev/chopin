import { expect, it, spyOn } from "bun:test";

import { AnthropicRequestHandler } from "./anthropic-request";

import type { CopilotRequestContext } from "@github/copilot-sdk";

class Handler extends AnthropicRequestHandler {
	public override sendRequest(request: Request, context: CopilotRequestContext) {
		return super.sendRequest(request, context);
	}
}

let context: CopilotRequestContext = {
	requestId: "fixture",
	transport: "http",
	url: "https://api.anthropic.com/v1/messages",
	headers: {},
	signal: new AbortController().signal,
};

it("preserves Anthropic messages, tools, credentials, streaming and cancellation", async () => {
	let body = {
		model: "claude-fable-5-1",
		messages: [{ role: "user", content: "Read the document." }],
		tools: [{ name: "read_plan", input_schema: { type: "object" } }],
		max_tokens: 32000,
		stream: true,
		thinking: { type: "adaptive" },
	};
	let response = new Response("event: message_stop\ndata: {}\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
	let fetch = spyOn(globalThis, "fetch").mockImplementation(
		(async (input, options) => {
			let request = input as Request;
			expect(await request.json()).toEqual(body);
			expect(request.url).toBe(`${context.url}?beta=true`);
			expect(request.headers.get("x-api-key")).toBe("fixture-key");
			expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
			expect(request.headers.get("content-length")).toBeNull();
			expect(options?.signal).toBe(context.signal);
			return response;
		}) as typeof globalThis.fetch,
	);
	try {
		let request = new Request(`${context.url}?beta=true`, {
			method: "POST",
			headers: {
				"x-api-key": "fixture-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				"content-length": "9999",
			},
			body: JSON.stringify({ ...body, temperature: 0, top_p: 0.9, top_k: 40 }),
		});
		expect(await new Handler().sendRequest(request, context)).toBe(response);
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		fetch.mockRestore();
	}
});

it("passes Copilot and unrelated requests through without rewriting them", async () => {
	let requests = [
		new Request("https://api.githubcopilot.com/chat/completions", {
			method: "POST",
			body: '{ "temperature": 0.5 }',
		}),
		new Request("https://other.example/v1/messages", { method: "POST", body: "unchanged" }),
		new Request("https://api.anthropic.com/v1/messages/count_tokens", {
			method: "POST",
			body: "unchanged",
		}),
		new Request("https://api.anthropic.com/v1/messages"),
	];
	let fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
	try {
		for (let request of requests) {
			await new Handler().sendRequest(request, context);
			expect(fetch.mock.calls.at(-1)?.[0]).toBe(request);
			expect(request.bodyUsed).toBe(false);
		}
	} finally {
		fetch.mockRestore();
	}
});
