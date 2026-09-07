/** Opt-in contract test: the pinned CLI talks to a local Anthropic mock, never a paid API. */
import { describe, expect, it } from "bun:test";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locate } from "./cli";
import { plannerConfiguration, RUNTIME_ENV, verifyModel, workerConfiguration } from "./client";
import { NAME } from "./planner";

import type { CopilotSession, SessionConfig } from "@github/copilot-sdk";

const CONFIG = { model: "claude-fable-5-1", anthropic: { apiKey: "local-test-key" } };

function completion(content: Array<Record<string, unknown>>, reason = "end_turn") {
	let events: Array<Record<string, unknown>> = [{
		type: "message_start",
		message: {
			id: "msg_local",
			type: "message",
			role: "assistant",
			model: CONFIG.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	}];
	for (let [index, block] of content.entries()) {
		events.push(
			{
				type: "content_block_start",
				index,
				content_block: block.type === "text" ? { ...block, text: "" } : { ...block, input: {} },
			},
			{
				type: "content_block_delta",
				index,
				delta: block.type === "text"
					? { type: "text_delta", text: block.text }
					: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
			},
			{ type: "content_block_stop", index },
		);
	}
	events.push(
		{
			type: "message_delta",
			delta: { stop_reason: reason, stop_sequence: null },
			usage: { output_tokens: 10 },
		},
		{ type: "message_stop" },
	);
	return new Response(
		events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

async function runtime(
	config: SessionConfig,
	respond: (request: Request) => Promise<Response>,
	run: (session: CopilotSession) => Promise<void>,
) {
	let server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
	let directory = mkdtempSync(join(tmpdir(), "chopin-anthropic-test-"));
	let cli = locate();
	if (!cli.ok) throw new Error(cli.reason);
	let client = new CopilotClient({
		mode: "empty",
		workingDirectory: directory,
		baseDirectory: directory,
		useLoggedInUser: false,
		env: RUNTIME_ENV,
		connection: RuntimeConnection.forStdio({ path: cli.path }),
	});
	try {
		let session = await client.createSession({
			...config,
			provider: { ...config.provider!, baseUrl: server.url.origin },
		});
		await session.rpc.agent.select({ name: config.agent! });
		await verifyModel(session, CONFIG);
		await run(session);
		await session.disconnect();
	} finally {
		await client.stop();
		server.stop(true);
		rmSync(directory, { recursive: true, force: true });
	}
}

describe.skipIf(process.env.ANTHROPIC_PROVIDER_TEST !== "1")(
	"pinned Anthropic provider contract",
	() => {
		it("surfaces provider authentication failure without switching credentials", async () => {
			let requests = 0;
			let config = workerConfiguration(CONFIG, {
				token: "unused-github-token",
				name: "fixture-error",
				prompt: "Reply briefly.",
				maxAiCredits: 30,
				result: {
					name: "submit_job_result",
					description: "Submit",
					parameters: {},
					handler: () => "ok",
				},
			});
			await runtime(config, async request => {
				requests++;
				expect(request.headers.get("x-api-key")).toBe(CONFIG.anthropic.apiKey);
				expect((await request.json() as { model: string }).model).toBe(CONFIG.model);
				return Response.json({
					type: "error",
					error: { type: "authentication_error", message: "Invalid test key" },
				}, { status: 401 });
			}, async session => {
				await expect(session.sendAndWait({ prompt: "Hello" }, 20_000)).rejects.toThrow();
			});
			expect(requests).toBeGreaterThan(0);
		}, 30_000);

		for (let allowed of [true, false]) {
			it(
				`streams Planner output and ${allowed ? "executes" : "denies"} an authorized tool`,
				async () => {
					let calls = 0;
					let tools = 0;
					let toolResult = "";
					let wireModels: unknown[] = [];
					let config = plannerConfiguration(CONFIG, {
						tools: [{
							name: "read_plan",
							description: "Read the fixture document",
							parameters: { type: "object", properties: {} },
							handler: () => {
								tools++;
								return "fixture document";
							},
						}],
					}, {
						token: "unused-github-token",
						repository: {
							id: "R_fixture",
							owner: "fixture",
							name: "fixture",
							defaultBranch: "main",
						},
						authorize: async () => allowed,
					});
					// This contract covers inference and custom tools; GitHub MCP must not contact the network.
					config.mcpServers = {};
					expect(config.agent).toBe(NAME);
					await runtime(config, async request => {
						expect(new URL(request.url).pathname).toBe("/v1/messages");
						expect(request.headers.get("x-api-key")).toBe("local-test-key");
						expect(request.headers.get("authorization")).toBeNull();
						let body = await request.json() as { model: string; messages: unknown[] };
						wireModels.push(body.model);
						if (++calls === 1) {
							return completion([{
								type: "tool_use",
								id: "tool_local",
								name: "read_plan",
								input: {},
							}], "tool_use");
						}
						toolResult = JSON.stringify(body.messages);
						return completion([{ type: "text", text: "Completed the fixture turn." }]);
					}, async session => {
						let delta = "";
						let models: string[] = [];
						session.on(event => {
							if (event.type === "assistant.message_delta") delta += event.data.deltaContent;
							if (event.type === "assistant.usage") models.push(event.data.model);
						});
						await session.sendAndWait(
							{ prompt: "Read the document once, then reply briefly." },
							20_000,
						);
						expect(delta).toContain("Completed the fixture turn.");
						expect(models).toEqual([CONFIG.model, CONFIG.model]);
					});
					expect(wireModels).toEqual([CONFIG.model, CONFIG.model]);
					expect(tools).toBe(allowed ? 1 : 0);
					if (allowed) expect(toolResult).toContain("fixture document");
					else expect(toolResult).not.toContain("fixture document");
				},
				30_000,
			);
		}

		it("executes a private worker's terminal result without Copilot credentials", async () => {
			let submitted = false;
			let config = workerConfiguration(CONFIG, {
				token: "unused-github-token",
				name: "fixture-worker",
				prompt: "Submit a result.",
				maxAiCredits: 30,
				result: {
					name: "submit_job_result",
					description: "Submit",
					parameters: { type: "object", properties: {} },
					handler: () => {
						submitted = true;
						return "accepted";
					},
				},
			});
			await runtime(config, async () =>
				completion([{
					type: "tool_use",
					id: "tool_terminal",
					name: "submit_job_result",
					input: {},
				}], "tool_use"), async session => {
				await session.sendAndWait({ prompt: "Submit the result now." }, 20_000);
			});
			expect(submitted).toBe(true);
		}, 30_000);
	},
);
