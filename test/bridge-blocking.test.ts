import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBridgeServer, type CapturedTool, clearBridgeCache } from "../src/bridge.js";

/**
 * Regression cover for the duplicate-question defect.
 *
 * kiro's MCP HTTP client abandons a bridged call at roughly 126 seconds. The
 * bridge did not notice, so a blocking @pi/ask_user_question stayed queued for
 * the user and kiro's retry queued a SECOND one. Observed on the wire: three
 * calls at 02:32:44, 02:34:50 and 02:37:07, every one of them eventually
 * answered by a real human. Two guards close it: refuse a concurrent blocking
 * call, and hand the caller's own abort signal to the tool.
 */

interface Harness {
	client: Client;
	/** Resolve the oldest still-blocked execute() with this text. */
	release: (value: string) => void;
	/** Wait until execute() has been entered at least `n` times. */
	waitForCalls: (n: number) => Promise<void>;
	entered: () => number;
	signals: () => AbortSignal[];
	close: () => Promise<void>;
}

async function harness(toolName: string): Promise<Harness> {
	// A queue, not a single slot: several calls can be blocked at once, and a
	// single-slot resolver silently drops all but the newest.
	const waiting: Array<(value: string) => void> = [];
	const signals: AbortSignal[] = [];
	let entered = 0;

	const tool: CapturedTool = {
		name: toolName,
		description: "blocking test tool",
		parameters: { type: "object", properties: {} },
		execute: async (_callId: string, _args: unknown, signal: AbortSignal) => {
			entered += 1;
			signals.push(signal);
			const answer = await new Promise<string>((resolve) => {
				waiting.push(resolve);
			});
			return { content: [{ type: "text", text: answer }] };
		},
	} as unknown as CapturedTool;

	const built = buildBridgeServer([tool], () => ({}) as never, new AbortController().signal);
	if (!built) throw new Error("buildBridgeServer returned undefined");

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await Promise.all([built.instance.server.connect(serverTransport), client.connect(clientTransport)]);

	return {
		client,
		release: (value: string) => {
			const resolve = waiting.shift();
			if (!resolve) throw new Error("release() called with nothing blocked");
			resolve(value);
		},
		waitForCalls: async (n: number) => {
			const deadline = Date.now() + 5000;
			while (entered < n) {
				if (Date.now() > deadline) throw new Error(`only ${entered} of ${n} calls reached execute`);
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		entered: () => entered,
		signals: () => signals,
		close: async () => {
			await client.close();
		},
	};
}

function textOf(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content.map((block) => block.text ?? "").join("\n");
}

const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;

describe("bridge blocking-call guards", () => {
	beforeEach(() => clearBridgeCache());
	afterEach(() => clearBridgeCache());

	it("refuses a second ask_user_question while one is still pending", async () => {
		const h = await harness("ask_user_question");

		const first = h.client.callTool({ name: "ask_user_question", arguments: { q: "first" } });
		await h.waitForCalls(1);

		const second = await h.client.callTool({ name: "ask_user_question", arguments: { q: "second" } });
		expect(isError(second)).toBe(true);
		expect(textOf(second)).toContain("already awaiting");
		// Names the pending call so the caller can correlate rather than retry.
		expect(textOf(second)).toMatch(/ccbridge-\d+/);
		// The decisive assertion: the refused call never reached the user.
		expect(h.entered()).toBe(1);

		h.release("Yes");
		const firstResult = await first;
		expect(isError(firstResult)).toBe(false);
		expect(textOf(firstResult)).toBe("Yes");

		await h.close();
	});

	it("releases the guard once the pending call completes", async () => {
		const h = await harness("ask_user_question");

		const first = h.client.callTool({ name: "ask_user_question", arguments: {} });
		await h.waitForCalls(1);
		h.release("Yes");
		await first;

		const second = h.client.callTool({ name: "ask_user_question", arguments: {} });
		await h.waitForCalls(2);
		h.release("No");
		const result = await second;
		expect(isError(result)).toBe(false);
		expect(textOf(result)).toBe("No");

		await h.close();
	});

	it("does not single-flight a non-blocking tool", async () => {
		const h = await harness("todo");

		const first = h.client.callTool({ name: "todo", arguments: { q: "a" } });
		await h.waitForCalls(1);
		const second = h.client.callTool({ name: "todo", arguments: { q: "b" } });
		await h.waitForCalls(2); // both reached execute: only human-blocking tools are gated

		h.release("a-done");
		h.release("b-done");
		const [r1, r2] = await Promise.all([first, second]);
		expect(isError(r1)).toBe(false);
		expect(isError(r2)).toBe(false);
		expect([textOf(r1), textOf(r2)].sort()).toEqual(["a-done", "b-done"]);

		await h.close();
	});

	it("hands the tool a live signal rather than an already-settled one", async () => {
		const h = await harness("ask_user_question");
		const call = h.client.callTool({ name: "ask_user_question", arguments: {} });
		await h.waitForCalls(1);

		const [signal] = h.signals();
		expect(signal).toBeDefined();
		expect(signal.aborted).toBe(false);

		h.release("Yes");
		await call;
		await h.close();
	});
});
