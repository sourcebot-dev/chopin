import { CopilotRequestHandler } from "@github/copilot-sdk";

import type { CopilotRequestContext } from "@github/copilot-sdk";

/** Use Anthropic's sampling defaults; Fable rejects the CLI's temperature. */
export class AnthropicRequestHandler extends CopilotRequestHandler {
	constructor(private origin = "https://api.anthropic.com") {
		super();
	}

	protected override async sendRequest(
		request: Request,
		context: CopilotRequestContext,
	): Promise<Response> {
		let url = new URL(request.url);
		if (
			request.method === "POST" && url.origin === this.origin && url.pathname === "/v1/messages"
		) {
			let body = await request.json() as Record<string, unknown>;
			delete body.temperature;
			delete body.top_p;
			delete body.top_k;
			let headers = new Headers(request.headers);
			headers.delete("content-length");
			request = new Request(request, { method: "POST", headers, body: JSON.stringify(body) });
		}
		return super.sendRequest(request, context);
	}
}
