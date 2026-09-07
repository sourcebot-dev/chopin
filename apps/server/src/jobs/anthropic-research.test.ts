import { describe, expect, it, spyOn } from "bun:test";

import { anthropicResearch } from "./anthropic-research";
import { researchEvidenceDefinition } from "./research-workspace";

import type { JobExecution } from "./registry";
import type { ResearchEvidenceInput } from "./research-workspace";

const CONFIG = {
	agent: true,
	model: "claude-fable-5-1",
	anthropic: { apiKey: "test-anthropic-key" },
};
const SOURCE = {
	type: "web_search_result",
	title: "Reference",
	url: "https://example.com/reference",
	encrypted_content: "encrypted",
};

function execution(authorize = async () => true): JobExecution<ResearchEvidenceInput> {
	return {
		job: {} as JobExecution<ResearchEvidenceInput>["job"],
		input: { workspaceId: "workspace", turnId: "turn", query: "A public question" },
		signal: new AbortController().signal,
		deadline: new Date(Date.now() + 30_000),
		progress: async () => {},
		credential: {
			kind: "active-planner",
			token: "private-github-token",
			ownerSessionId: "owner",
			ownerGeneration: 1,
			credentialRevision: 1,
			expiresAt: new Date(Date.now() + 60_000),
			authorize,
		},
	} as JobExecution<ResearchEvidenceInput>;
}

function response(content: unknown[] = evidence(), stop_reason = "end_turn") {
	return { model: CONFIG.model, content, stop_reason };
}

function evidence() {
	return [
		{ type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "question" } },
		{ type: "web_search_tool_result", tool_use_id: "search-1", content: [SOURCE] },
		{
			type: "text",
			text: "A supported finding.",
			citations: [{ type: "web_search_result_location", url: SOURCE.url }],
		},
	];
}

function requester(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	return ((url, init) => handler(String(url), init!)) as typeof fetch;
}

describe("Anthropic public research", () => {
	it("sends only the public query and Anthropic key, and returns cited search evidence", async () => {
		let result = await anthropicResearch(
			CONFIG,
			execution(),
			"Public question",
			requester((url, init) => {
				expect(url).toBe("https://api.anthropic.com/v1/messages");
				expect(init.redirect).toBe("error");
				expect(new Headers(init.headers).get("x-api-key")).toBe(CONFIG.anthropic.apiKey);
				expect(new Headers(init.headers).get("authorization")).toBeNull();
				let body = JSON.parse(String(init.body));
				expect(body.messages).toEqual([{ role: "user", content: "Public question" }]);
				expect(body.model).toBe(CONFIG.model);
				expect(body.max_tokens).toBe(8192);
				expect(body.tools).toEqual([{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 5,
				}]);
				expect(String(init.body)).not.toContain("private-github-token");
				return Response.json(response());
			}),
		);
		expect(result).toEqual({
			findings: ["A supported finding."],
			sources: [{ title: SOURCE.title, url: SOURCE.url }],
		});
	});

	it("selects the Anthropic engine through the registered job and applies public URL validation", async () => {
		let call = spyOn(globalThis, "fetch").mockImplementation(
			requester(() => Response.json(response())),
		);
		try {
			let job = researchEvidenceDefinition({ config: CONFIG });
			let result = await job.execute(execution());
			expect(result.model).toBe(CONFIG.model);
			expect(result.sources).toEqual([{ title: SOURCE.title, url: SOURCE.url }]);
			expect(call).toHaveBeenCalledTimes(1);
			call.mockImplementation(requester(() =>
				Response.json(JSON.parse(
					JSON.stringify(response()).replaceAll(SOURCE.url, "https://127.0.0.1/private"),
				))
			));
			await expect(job.execute(execution())).rejects.toThrow("public-research-failed");
		} finally {
			call.mockRestore();
		}
	});

	it("preserves encrypted content unchanged through bounded pause continuations", async () => {
		let calls = 0;
		let content = evidence().slice(0, 2);
		let result = await anthropicResearch(
			CONFIG,
			execution(),
			"Question",
			requester((_url, init) => {
				if (++calls === 1) return Response.json(response(content, "pause_turn"));
				expect(JSON.parse(String(init.body)).messages[1]).toEqual({ role: "assistant", content });
				return Response.json(response(evidence().slice(2)));
			}),
		);
		expect(calls).toBe(2);
		expect(result.findings).toEqual(["A supported finding."]);
		calls = 0;
		await expect(anthropicResearch(
			CONFIG,
			execution(),
			"Question",
			requester(() => {
				calls++;
				return Response.json(response([], "pause_turn"));
			}),
		)).rejects.toThrow("public-continuation-limit");
		expect(calls).toBe(3);
	});

	it("rejects missing searches, tool failures, uncited findings, and invented source URLs", async () => {
		let cases: Array<[unknown[], string, string?]> = [
			[[{ type: "text", text: "https://example.com is a source" }], "web-search-not-used"],
			[[evidence()[0], {
				type: "web_search_tool_result",
				tool_use_id: "search-1",
				content: { type: "web_search_tool_result_error", error_code: "unavailable" },
			}], "web-search-unavailable"],
			[
				[...evidence().slice(0, 2), { type: "text", text: "No citations." }],
				"public-citations-missing",
			],
			[[...evidence().slice(0, 2), {
				type: "text",
				text: "Invented",
				citations: [{ type: "web_search_result_location", url: "https://invented.example" }],
			}], "public-source-unobserved"],
			[evidence(), "public-response-incomplete", "max_tokens"],
			[evidence(), "public-response-incomplete", "refusal"],
		];
		for (let [content, error, stop] of cases) {
			await expect(
				anthropicResearch(
					CONFIG,
					execution(),
					"Question",
					requester(() => Response.json(response(content, stop))),
				),
			).rejects.toThrow(error);
		}
		await expect(
			anthropicResearch(
				CONFIG,
				execution(),
				"Question",
				requester(() =>
					Response.json(response([
						evidence()[0],
						{ type: "web_search_tool_result", tool_use_id: "search-1", content: [] },
					]))
				),
			),
		).resolves.toEqual({ findings: [], sources: [] });
	});

	it("enforces ownership before requests and before accepting results", async () => {
		let authorized = false;
		let run = execution(async () => authorized);
		let calls = 0;
		let request = requester(() => {
			calls++;
			authorized = false;
			return Response.json(response());
		});
		await expect(anthropicResearch(CONFIG, run, "Question", request)).rejects.toThrow(
			"public-provider-failed",
		);
		expect(calls).toBe(0);
		authorized = true;
		await expect(anthropicResearch(CONFIG, run, "Question", request)).rejects.toThrow(
			"public-provider-failed",
		);
		expect(calls).toBe(1);
	});

	it("aborts in-flight requests on cancellation and rejects expired deadlines", async () => {
		let controller = new AbortController();
		let run = { ...execution(), signal: controller.signal };
		let started = Promise.withResolvers<void>();
		let pending = anthropicResearch(
			CONFIG,
			run,
			"Question",
			requester((_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
					started.resolve();
				})
			),
		);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toThrow("public-research-aborted");
		await expect(anthropicResearch(CONFIG, { ...execution(), deadline: new Date(0) }, "Question"))
			.rejects.toThrow("public-research-timeout");
	});

	it("bounds response size and redacts provider errors", async () => {
		await expect(
			anthropicResearch(
				CONFIG,
				execution(),
				"Question",
				requester(() => new Response("x".repeat(2 * 1024 * 1024 + 1))),
			),
		).rejects.toThrow("public-response-too-large");
		try {
			await anthropicResearch(
				CONFIG,
				execution(),
				"Question",
				requester(() => new Response("secret-provider-body", { status: 401 })),
			);
			throw new Error("expected failure");
		} catch (err) {
			expect(String(err)).toContain("public-provider-failed");
			expect(String(err)).not.toContain("secret-provider-body");
			expect((err as Error).cause).toBeUndefined();
		}
	});
});
