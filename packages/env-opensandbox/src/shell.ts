const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote one word for POSIX sh/bash. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ShellInvocation {
	/** Command line executed inside the sandbox session shell. */
	commandLine: string;
}

/** Prefix on every transported line that ended with a newline. */
export const LINE_TAG_TERMINATED = "L";
/** Prefix on a final transported line that had no trailing newline. */
export const LINE_TAG_PARTIAL = "P";

/**
 * execd streams output one line at a time and drops the line terminators, so a raw stream cannot
 * tell `printf a` from `echo a` or reproduce blank lines. This wrapper merges stderr into stdout,
 * tags every complete line with {@link LINE_TAG_TERMINATED} and a trailing partial line with
 * {@link LINE_TAG_PARTIAL}, and exits with the user command's own status. It uses shell builtins
 * only, so it also works under `env -i` without a PATH.
 */
export function wrapForLineTransport(command: string): string {
	// `read -t` saves partial input into the variable when it times out, so a line that is still
	// being written (a progress indicator, a prompt) streams as partial chunks instead of waiting
	// for its newline or for the process to end.
	const pump =
		"while :; do " +
		`if IFS= read -r -t 0.1 pi_line; then printf '${LINE_TAG_TERMINATED}%s\\n' "$pi_line"; ` +
		`else pi_status=$?; [ -n "$pi_line" ] && printf '${LINE_TAG_PARTIAL}%s\\n' "$pi_line"; ` +
		'[ "$pi_status" -gt 128 ] || break; fi; ' +
		"done";
	return `{\n${command}\n} 2>&1 | { ${pump}; }; exit "\${PIPESTATUS[0]}"`;
}

/** Reverse {@link wrapForLineTransport} for one received message. Untagged text passes through. */
export function decodeTransportedLine(text: string): string {
	if (text.startsWith(LINE_TAG_TERMINATED)) return `${text.slice(1)}\n`;
	if (text.startsWith(LINE_TAG_PARTIAL)) return text.slice(1);
	return text;
}

/**
 * Wrap a user command so it runs under an explicit shell with the requested environment.
 *
 * Variables become prefix assignments when the sandbox environment is inherited and an `env -i`
 * invocation when it is not, matching how the Node environment spawns its shell.
 */
export function buildShellInvocation(
	shellPath: string,
	command: string,
	env: Record<string, string> | undefined,
	inheritEnv: boolean,
	options: { lineTransport?: boolean } = {},
): ShellInvocation | { error: string } {
	const assignments: string[] = [];
	for (const [name, value] of Object.entries(env ?? {})) {
		if (!ENV_NAME.test(name)) return { error: `Invalid environment variable name: ${name}` };
		assignments.push(`${name}=${shellQuote(value)}`);
	}
	const script = (options.lineTransport ?? true) ? wrapForLineTransport(command) : command;
	const invoke = `${shellQuote(shellPath)} -c ${shellQuote(script)}`;
	if (!inheritEnv) return { commandLine: ["env", "-i", ...assignments, invoke].join(" ") };
	return { commandLine: assignments.length === 0 ? invoke : `${assignments.join(" ")} ${invoke}` };
}

/** Exit codes for shells terminated by a signal, keyed by Go's signal descriptions found in execd tracebacks. */
const SIGNAL_NUMBERS: Record<string, number> = {
	hangup: 1,
	interrupt: 2,
	quit: 3,
	"illegal instruction": 4,
	"trace/breakpoint trap": 5,
	aborted: 6,
	"bus error": 7,
	"floating point exception": 8,
	killed: 9,
	"user defined signal 1": 10,
	"segmentation fault": 11,
	"user defined signal 2": 12,
	"broken pipe": 13,
	"alarm clock": 14,
	terminated: 15,
};

/** Map an execd exit report to the exit code the harness expects. */
export function exitCodeFromExecution(
	exitCode: number | null | undefined,
	traceback: readonly string[] | undefined,
): number {
	if (typeof exitCode === "number" && exitCode >= 0) return exitCode;
	const text = (traceback ?? []).join("\n");
	const match = /signal:\s*([a-z0-9/ ]+)/i.exec(text);
	if (match) {
		const signal = match[1]!.trim().toLowerCase();
		return 128 + (SIGNAL_NUMBERS[signal] ?? 9);
	}
	return 1;
}
