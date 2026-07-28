const PORT = process.env.PORT || "8848";
const CWD = process.env.CWD || process.cwd();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_NAME = "pi-web-smoke";
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 35_000;

const printedSentinels = new Set();

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value) {
	return value instanceof Error ? value : new Error(String(value));
}

function printSentinel(value) {
	printedSentinels.add(value);
	console.log(value);
}

async function requestJson(pathname, options = {}) {
	const {
		method = "GET",
		body,
		expectedStatuses = [200],
		timeoutMs = REQUEST_TIMEOUT_MS,
	} = options;
	const response = await fetch(`${BASE_URL}${pathname}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	assert(
		expectedStatuses.includes(response.status),
		`${method} ${pathname} returned ${response.status}: ${text.slice(0, 300)}`,
	);

	let payload;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw new Error(`${method} ${pathname} returned non-JSON`, { cause: error });
	}
	assert(isRecord(payload), `${method} ${pathname} returned a non-object payload`);
	return payload;
}

async function listServers() {
	const query = new URLSearchParams({ cwd: CWD });
	const payload = await requestJson(`/api/mcp?${query}`);
	assert(Array.isArray(payload.servers), "GET /api/mcp payload has no servers array");
	return payload.servers;
}

function findSmokeServer(servers) {
	return servers.find(
		(server) => isRecord(server) && server.name === SERVER_NAME,
	);
}

async function postAction(action, details = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
	return requestJson("/api/mcp", {
		method: "POST",
		body: { action, cwd: CWD, name: SERVER_NAME, ...details },
		timeoutMs,
	});
}

async function cleanupSmokeServer() {
	await requestJson("/api/mcp", {
		method: "POST",
		body: {
			action: "remove",
			cwd: CWD,
			name: SERVER_NAME,
			scope: "user",
		},
		expectedStatuses: [200, 404],
	});
	const servers = await listServers();
	assert(!findSmokeServer(servers), `${SERVER_NAME} remained after cleanup`);
}

async function runSmoke() {
	await listServers();
	await requestJson("/api/mcp", { expectedStatuses: [400] });
	printSentinel("HTTP_OK");

	await postAction("add", {
		scope: "user",
		config: {
			type: "stdio",
			command: "true",
			args: [],
			timeout: 5_000,
		},
	});
	let server = findSmokeServer(await listServers());
	assert(server, `${SERVER_NAME} was not listed after add`);
	printSentinel("CRUD_OK");

	await postAction("disable");
	server = findSmokeServer(await listServers());
	assert(server, `${SERVER_NAME} disappeared after disable`);
	assert(
		server.configuredEnabled === false && server.effectiveForRuntime === false,
		`${SERVER_NAME} did not remain configured off after disable`,
	);
	printSentinel("DISABLED_STILL_LISTED");

	await postAction("enable");
	server = findSmokeServer(await listServers());
	assert(server?.configuredEnabled === true, `${SERVER_NAME} was not enabled`);
	assert(server.effectiveForRuntime === true, `${SERVER_NAME} was not runtime-effective`);

	const probeStarted = Date.now();
	const probe = await postAction("probe", {}, PROBE_TIMEOUT_MS);
	const elapsedMs = Date.now() - probeStarted;
	assert(elapsedMs < PROBE_TIMEOUT_MS, `probe took ${elapsedMs}ms`);
	assert(
		probe.status === "ok" || probe.status === "fail_clean",
		`probe returned unexpected status: ${String(probe.status)}`,
	);
	printSentinel(probe.status === "ok" ? "PROBE_OK" : "PROBE_FAIL_CLEAN");
}

async function main() {
	let runError;
	try {
		await runSmoke();
	} catch (error) {
		runError = asError(error);
	}

	let cleanupError;
	try {
		await cleanupSmokeServer();
	} catch (error) {
		cleanupError = asError(error);
	}

	if (runError && cleanupError) {
		throw new AggregateError([runError, cleanupError], "smoke and cleanup failed");
	}
	if (runError) throw runError;
	if (cleanupError) throw cleanupError;

	const baseSentinels = ["HTTP_OK", "CRUD_OK", "DISABLED_STILL_LISTED"];
	assert(baseSentinels.every((value) => printedSentinels.has(value)), "missing sentinel");
	assert(
		printedSentinels.has("PROBE_OK") || printedSentinels.has("PROBE_FAIL_CLEAN"),
		"missing probe sentinel",
	);
}

main().catch((error) => {
	console.error(asError(error));
	process.exitCode = 1;
});
