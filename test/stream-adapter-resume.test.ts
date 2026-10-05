import { EventEmitter } from "node:events";
import type { AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSessions } from "../src/session-manager.js";
import { FINAL_CLOSE, FINAL_OPEN, makeStreamViaKiro } from "../src/stream-adapter.js";

// Shared mutable state for the spawn + execFile fakes.
const H = vi.hoisted(() => ({
	sessionList: [] as Array<{ sessionId: string }>,
	spawnCalls: [] as string[][],
	script: [] as Array<{ stdout: string; code: number; createSession?: string }>,
}));

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: execFileMock }));

class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn(() => this.emit("exit", 130));
}

const MODEL = {
	id: "auto",
	name: "auto [kiro]",
	api: "anthropic-messages",
	provider: "kiro",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as Model<any>;

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as unknown as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;
const answer = (text: string) => `> ${FINAL_OPEN}${text}${FINAL_CLOSE}\n ▸ Credits: 0.01 • Time: 1s`;

async function collect(context: Context): Promise<AssistantMessageEvent[]> {
	const stream = makeStreamViaKiro({ binaryPath: "kiro-cli" })(MODEL, context, undefined);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function doneText(events: AssistantMessageEvent[]): string {
	const done = events.find((event) => event.type === "done");
	if (done?.type !== "done") throw new Error("expected done");
	const block = done.message.content.find((b) => b.type === "text");
	return block && "text" in block ? block.text : "";
}

describe("stream-adapter resume flow", () => {
	beforeEach(() => {
		_resetSessions();
		spawnMock.mockReset();
		H.sessionList = [];
		H.spawnCalls = [];
		H.script = [];
		delete process.env.PI_KIRO_RESUME;

		execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
			(cb as (e: Error | null, out: string, err: string) => void)(
				null,
				JSON.stringify([{ cwd: process.cwd(), sessions: H.sessionList }]),
				"",
			);
		});
		spawnMock.mockImplementation((_cmd: string, args: string[]) => {
			H.spawnCalls.push(args);
			const step = H.script.shift() ?? { stdout: answer("ok"), code: 0 };
			const child = new FakeChild();
			queueMicrotask(() => {
				if (step.stdout) child.stdout.emit("data", Buffer.from(step.stdout));
				queueMicrotask(() => {
					if (step.createSession && step.code === 0) H.sessionList.push({ sessionId: step.createSession });
					child.emit("exit", step.code);
				});
			});
			return child;
		});
	});

	it("turn 1 sends full context; turn 2 (pure append) resumes with a delta-only prompt", async () => {
		// Turn 1 — fresh; kiro creates sess-A.
		H.script = [{ stdout: answer("A1"), code: 0, createSession: "sess-A" }];
		expect(doneText(await collect({ messages: [user("turn one")] }))).toBe("A1");

		const turn1Args = H.spawnCalls[0];
		expect(turn1Args).not.toContain("--resume-id");
		expect(turn1Args.at(-1)).toContain("<conversation_history>");
		expect(turn1Args.at(-1)).toContain("turn one");
		expect(turn1Args.at(-1)?.startsWith("<identity>")).toBe(true);

		// Turn 2 — pure append; must resume sess-A and send only the delta.
		H.spawnCalls = [];
		H.script = [{ stdout: answer("A2"), code: 0 }];
		const events = await collect({ messages: [user("turn one"), assistant("A1"), user("turn two")] });
		expect(doneText(events)).toBe("A2");

		const turn2Args = H.spawnCalls[0];
		expect(turn2Args).toContain("--resume-id");
		expect(turn2Args[turn2Args.indexOf("--resume-id") + 1]).toBe("sess-A");
		const prompt = turn2Args.at(-1) as string;
		expect(prompt).toContain("<user_message>\nturn two\n</user_message>");
		expect(prompt).not.toContain("<conversation_history>");
		expect(prompt).not.toContain("turn one"); // prior history NOT re-sent
		expect(prompt).not.toContain("A1"); // kiro's own prior reply not echoed back
		// Identity is restated on the delta turn too (probes: first-turn-only drifts back to "Kiro").
		expect(prompt.startsWith("<identity>")).toBe(true);
	});

	it("resets to a fresh full send when the prefix diverges (compaction)", async () => {
		H.script = [{ stdout: answer("A1"), code: 0, createSession: "sess-A" }];
		await collect({ messages: [user("turn one")] });

		// Compaction: message[0] replaced by a summary → prefix hash changes.
		H.spawnCalls = [];
		H.script = [{ stdout: answer("A2"), code: 0, createSession: "sess-B" }];
		await collect({ messages: [user("SUMMARY of turn one"), user("turn two")] });

		const args = H.spawnCalls[0];
		expect(args).not.toContain("--resume-id"); // never resume onto a diverged session
		expect(args.at(-1)).toContain("<conversation_history>");
		expect(args.at(-1)).toContain("SUMMARY of turn one");
	});

	it("falls back to a full send when a resume spawn fails (stale session)", async () => {
		H.script = [{ stdout: answer("A1"), code: 0, createSession: "sess-A" }];
		await collect({ messages: [user("turn one")] });

		// Turn 2: resume attempt fails (exit 1), then full retry succeeds.
		H.spawnCalls = [];
		H.script = [
			{ stdout: "boom", code: 1 },
			{ stdout: answer("RECOVERED"), code: 0, createSession: "sess-B" },
		];
		const events = await collect({ messages: [user("turn one"), assistant("A1"), user("turn two")] });

		expect(doneText(events)).toBe("RECOVERED"); // never hard-fails
		expect(H.spawnCalls).toHaveLength(2);
		expect(H.spawnCalls[0]).toContain("--resume-id"); // first tried resume
		expect(H.spawnCalls[1]).not.toContain("--resume-id"); // then fell back to full
	});

	it("output parity: the resumed turn yields the same final text a full send would", async () => {
		H.script = [{ stdout: answer("SAME"), code: 0, createSession: "sess-A" }];
		const full = doneText(await collect({ messages: [user("q")] }));

		H.spawnCalls = [];
		H.script = [{ stdout: answer("SAME"), code: 0 }];
		const resumed = doneText(await collect({ messages: [user("q"), assistant("SAME"), user("again")] }));

		expect(resumed).toBe(full);
	});

	it("PI_KIRO_RESUME=off keeps every turn on the full-send path", async () => {
		process.env.PI_KIRO_RESUME = "off";
		H.script = [{ stdout: answer("A1"), code: 0, createSession: "sess-A" }];
		await collect({ messages: [user("turn one")] });
		H.spawnCalls = [];
		H.script = [{ stdout: answer("A2"), code: 0 }];
		await collect({ messages: [user("turn one"), assistant("A1"), user("turn two")] });
		expect(H.spawnCalls[0]).not.toContain("--resume-id");
		expect(H.spawnCalls[0].at(-1)).toContain("<conversation_history>");
	});
});
