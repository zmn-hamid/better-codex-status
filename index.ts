import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type RateLimitWindow = {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
};

type RateLimitSnapshot = {
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
	planType: string | null;
	credits: {
		hasCredits: boolean;
		unlimited: boolean;
		balance: string | null;
	} | null;
};

type ResetCredit = {
	status?: string;
	title?: string | null;
	description?: string | null;
};

type RateLimitResponse = {
	ordinaryUsageAllowed?: boolean | null;
	rateLimits: RateLimitSnapshot;
	rateLimitResetCredits?: {
		availableCount: number;
		credits?: ResetCredit[] | null;
	} | null;
};

type JsonRpcMessage = {
	id?: number;
	result?: unknown;
	error?: { message?: string; data?: unknown };
};

const REQUEST_TIMEOUT_MS = 15_000;
const BAR_WIDTH = 28;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asRateLimitResponse(value: unknown): RateLimitResponse {
	if (!isRecord(value) || !isRecord(value.rateLimits)) {
		throw new Error("Codex returned an unexpected rate-limit response");
	}

	const snapshot = value.rateLimits;
	const primary = isRecord(snapshot.primary) ? snapshot.primary : null;
	const secondary = isRecord(snapshot.secondary) ? snapshot.secondary : null;
	const credits = isRecord(snapshot.credits) ? snapshot.credits : null;

	const toWindow = (window: Record<string, unknown> | null): RateLimitWindow | null => {
		if (!window || typeof window.usedPercent !== "number") return null;
		return {
			usedPercent: window.usedPercent,
			windowDurationMins:
				typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
			resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
		};
	};

	return {
		ordinaryUsageAllowed:
			typeof value.ordinaryUsageAllowed === "boolean" ? value.ordinaryUsageAllowed : null,
		rateLimits: {
			primary: toWindow(primary),
			secondary: toWindow(secondary),
			planType: typeof snapshot.planType === "string" ? snapshot.planType : null,
			credits: credits
				? {
					hasCredits: credits.hasCredits === true,
					unlimited: credits.unlimited === true,
					balance: typeof credits.balance === "string" ? credits.balance : null,
				}
				: null,
		},
		rateLimitResetCredits: isRecord(value.rateLimitResetCredits)
			? {
					availableCount:
						typeof value.rateLimitResetCredits.availableCount === "number"
							? value.rateLimitResetCredits.availableCount
							: 0,
					credits: Array.isArray(value.rateLimitResetCredits.credits)
						? value.rateLimitResetCredits.credits.filter(isRecord).map((credit) => ({
								status: typeof credit.status === "string" ? credit.status : undefined,
								title: typeof credit.title === "string" ? credit.title : null,
								description: typeof credit.description === "string" ? credit.description : null,
							}))
						: null,
				}
			: null,
	};
}

function fetchRateLimits(): Promise<RateLimitResponse> {
	return new Promise((resolve, reject) => {
		const command = process.env.CODEX_CLI ?? "codex";
		const child = spawn(command, ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let buffer = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			finishReject(new Error("Timed out while asking Codex for account status"));
		}, REQUEST_TIMEOUT_MS);

		const finishResolve = (value: RateLimitResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill();
			resolve(value);
		};

		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill();
			const suffix = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : "";
			reject(new Error(`${error.message}${suffix}`));
		};

		child.on("error", (error) => finishReject(error));
		child.on("close", (code) => {
			if (!settled) {
				finishReject(new Error(`Codex app-server exited before returning status (code ${code ?? "unknown"})`));
			}
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.stdout.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;

				let message: JsonRpcMessage;
				try {
					message = JSON.parse(line) as JsonRpcMessage;
				} catch {
					continue;
				}

				if (message.id !== 2) continue;
				if (message.error) {
					finishReject(new Error(message.error.message ?? "Codex rejected the status request"));
					return;
				}

				try {
					finishResolve(asRateLimitResponse(message.result));
				} catch (error) {
					finishReject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});

		const requests = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					clientInfo: { name: "better-codex-status", title: "Better Codex Status", version: "1.0.0" },
					capabilities: { experimentalApi: true },
				},
			},
			{ jsonrpc: "2.0", method: "initialized" },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "account/rateLimits/read",
				params: { excludeResetCreditDetails: false, supportsLunaReserve: false },
			},
		];

		try {
			for (const request of requests) {
				child.stdin.write(`${JSON.stringify(request)}\n`);
			}
		} catch (error) {
			finishReject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function progressBar(usedPercent: number, theme: { fg: (color: string, text: string) => string }): string {
	const used = clampPercent(usedPercent);
	const remaining = 100 - used;
	const filled = Math.round((remaining / 100) * BAR_WIDTH);
	const color = remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "success";
	return `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(BAR_WIDTH - filled))}`;
}

function formatWindowName(window: RateLimitWindow, fallback: string): string {
	if (window.windowDurationMins === 300) return "5-hour";
	if (window.windowDurationMins === 10_080) return "Weekly (7 days)";
	if (window.windowDurationMins && window.windowDurationMins % 1_440 === 0) {
		return `${window.windowDurationMins / 1_440}-day`;
	}
	return fallback;
}

function formatReset(resetsAt: number | null): string {
	if (!resetsAt) return "reset time unavailable";
	return `resets ${new Date(resetsAt * 1000).toLocaleString()}`;
}

type StatusTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

function renderStatus(status: RateLimitResponse, theme: StatusTheme): string[] {
	const snapshot = status.rateLimits;
	const lines: string[] = [
		theme.fg("accent", theme.bold("Codex usage status")),
		theme.fg("dim", `Plan: ${snapshot.planType ?? "unknown"}`),
		"",
	];

	const windows: Array<[string, RateLimitWindow | null, string]> = [
		["5-hour", snapshot.primary, "5-hour"],
		["Weekly", snapshot.secondary, "Weekly (7 days)"],
	];

	for (const [label, window, fallback] of windows) {
		if (!window) {
			lines.push(`${label.padEnd(8)} ${theme.fg("dim", "status unavailable")}`);
			continue;
		}

		const used = clampPercent(window.usedPercent);
		const remaining = 100 - used;
		const name = formatWindowName(window, fallback);
		lines.push(`${name.padEnd(14)} ${progressBar(used, theme)}  ${remaining}% remaining / ${used}% used`);
		lines.push(`${"".padEnd(14)} ${theme.fg("dim", formatReset(window.resetsAt))}`);
	}

	lines.push("");
	if (status.ordinaryUsageAllowed === true) {
		lines.push(theme.fg("success", "● Ordinary usage is available"));
	} else if (status.ordinaryUsageAllowed === false) {
		lines.push(theme.fg("error", "● Ordinary usage is currently limited"));
	} else {
		lines.push(theme.fg("dim", "● Ordinary usage state unavailable"));
	}

	const availableCredits = status.rateLimitResetCredits?.availableCount ?? 0;
	if (availableCredits > 0) {
		const title = status.rateLimitResetCredits?.credits?.[0]?.title ?? "reset credit";
		lines.push(theme.fg("warning", `↻ ${availableCredits} reset credit available: ${title}`));
	} else {
		lines.push(theme.fg("dim", "↻ No reset credits available"));
	}

	lines.push("");
	lines.push(theme.fg("dim", "Press Enter or Esc to close"));
	return lines;
}

function frameStatus(lines: string[], width: number, theme: StatusTheme): string[] {
	// Keep the card comfortably away from the terminal edges while remaining usable on narrow screens.
	const outerWidth = Math.max(8, Math.min(86, width - 4));
	const contentWidth = Math.max(1, outerWidth - 4);
	const leftMargin = " ".repeat(Math.max(0, Math.floor((width - outerWidth) / 2)));
	const horizontal = "─".repeat(Math.max(1, outerWidth - 2));
	const border = (text: string) => theme.fg("accent", text);
	const padContent = (line: string): string => {
		const clipped = truncateToWidth(line, contentWidth);
		return clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
	};

	const framed = [
		"",
		`${leftMargin}${border(`╭${horizontal}╮`)}`,
		...lines.map((line) => `${leftMargin}${border("│")} ${padContent(line)} ${border("│")}`),
		`${leftMargin}${border(`╰${horizontal}╯`)}`,
		"",
	];

	return framed.map((line) => truncateToWidth(line, width));
}

async function showStatus(status: RateLimitResponse, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, keybindings, done) => ({
		render(width: number): string[] {
			return frameStatus(renderStatus(status, theme), width, theme);
		},
		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
				done();
			}
		},
		invalidate(): void {
			// The status is fetched when the command is run, so there is no local render cache.
		},
	}), { overlay: true });
}

export default function betterCodexStatus(pi: ExtensionAPI) {
	pi.registerCommand("codex-status", {
		description: "Show current Codex 5-hour and weekly usage limits",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/codex-status requires Pi's interactive TUI", "warning");
				return;
			}

			try {
				const status = await fetchRateLimits();
				await showStatus(status, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
