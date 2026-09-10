//#region src/core/status.ts
/** Strip a UTF-8 BOM; PowerShell 5.1 loves to add one. */
function stripBom(text) {
	return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
/**
* Parse a status file tolerantly. Only the fields the two halves depend on are
* validated (`schema`, `updatedAt`, `phase`); everything else passes through so
* a newer writer does not break an older reader.
* @param text - raw file contents.
* @returns the parsed object, or a reason it could not be used.
*/
function parseStatusFile(text) {
	const body = stripBom(text).trim();
	if (body === "") return {
		ok: false,
		error: "empty status file"
	};
	let value;
	try {
		value = JSON.parse(body);
	} catch (error) {
		return {
			ok: false,
			error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {
		ok: false,
		error: "status file is not a JSON object"
	};
	const record = value;
	if (record.schema !== 1) return {
		ok: false,
		error: `unsupported schema: ${String(record.schema)}`
	};
	if (typeof record.phase !== "string" || record.phase === "") return {
		ok: false,
		error: "missing phase"
	};
	if (typeof record.updatedAt !== "string" || record.updatedAt === "") return {
		ok: false,
		error: "missing updatedAt"
	};
	return {
		ok: true,
		value
	};
}
/**
* Last `n` lines of a log, for the GUI panel and the desktop message box.
* @param text - raw log contents (may be empty).
* @param n - how many trailing lines to keep.
* @returns the tail, without a trailing newline.
*/
function tailLines(text, n) {
	if (text === "" || n <= 0) return "";
	const lines = stripBom(text).split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) return "";
	return lines.slice(-n).join("\n");
}
/**
* Map either phase enum onto a severity. `aborted-busy` is an intentional
* cancellation, not a failure, so it stays a warning.
* @param phase - launcher or restart phase.
* @returns the severity the GUI should render.
*/
function phaseSeverity(phase) {
	switch (phase) {
		case "ready":
		case "up-dsh": return "ok";
		case "invoked":
		case "mutex-held":
		case "down":
		case "spawned":
		case "handoff":
		case "verifying-old":
		case "killing":
		case "spawning": return "info";
		case "aborted-busy": return "warn";
		case "up-unknown":
		case "port-no-response":
		case "dsh-not-found":
		case "child-exit":
		case "timeout-alive":
		case "timeout-dead":
		case "error":
		case "failed":
		case "timeout": return "error";
		default: return "info";
	}
}
/** True when the launcher phase means "the icon failed to start DSH". */
function isLauncherFailure(phase) {
	return phaseSeverity(phase) === "error";
}
/**
* Short human duration: `820ms`, `12.4s`, `1m 03s`.
* @param ms - duration in milliseconds.
* @returns the formatted duration.
*/
function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	const seconds = ms / 1e3;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}
//#endregion
export { stripBom as a, phaseSeverity as i, isLauncherFailure as n, tailLines as o, parseStatusFile as r, formatDuration as t };
