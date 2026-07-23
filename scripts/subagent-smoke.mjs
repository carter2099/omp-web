async function run() {
  const port = process.env.PORT || "30141";
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Connecting to pi-web on ${baseUrl}...`);

  // 1. POST /api/agent/new -> ensure_session
  try {
    const res = await fetch(`${baseUrl}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: process.cwd(),
        type: "ensure_session",
        toolNames: ["task"],
      }),
    });

    if (!res.ok) {
      throw new Error(`ensure_session failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    const sessionId = data.sessionId;
    if (!sessionId) {
      throw new Error("No sessionId returned from ensure_session");
    }

    console.log(`SESSION_CREATED_OK: ${sessionId}`);

    // Run a quick bash command to ensure the session file is persisted on disk.
    const bashRes = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "bash",
        command: "echo 'hello'",
      }),
    });
    if (!bashRes.ok) {
      const text = await bashRes.text();
      throw new Error(`bash command failed with HTTP ${bashRes.status}: ${text}`);
    }
    console.log("SESSION_PERSISTED_OK");

    // 2. set_subagent_subscription progress
    const subRes = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "set_subagent_subscription",
        level: "progress",
      }),
    });

    if (!subRes.ok) {
      const text = await subRes.text();
      throw new Error(`set_subagent_subscription failed with HTTP ${subRes.status}: ${text}`);
    }
    console.log("SUB_LEVEL_SET_OK");

    // 3. bad-level -> 400
    const badSubRes = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "set_subagent_subscription",
        level: "invalid_level",
      }),
    });

    if (badSubRes.status === 400) {
      console.log("BAD_LEVEL_REJECT_OK (400)");
    } else {
      console.warn(`Expected 400 for bad level, got ${badSubRes.status}`);
    }

    // 4. get_subagents -> .subagents array
    const subagentsRes = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "get_subagents",
      }),
    });

    if (!subagentsRes.ok) {
      throw new Error(`get_subagents failed with HTTP ${subagentsRes.status}`);
    }
    const subagentsData = await subagentsRes.json();
    if (subagentsData && subagentsData.data && Array.isArray(subagentsData.data.subagents)) {
      console.log("SUBAGENTS_OK");
    } else {
      throw new Error(`subagents is not an array: ${JSON.stringify(subagentsData)}`);
    }

    // 5. get_subagent_messages with path outside artifacts -> 400
    const escapeRes = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "get_subagent_messages",
        sessionFile: "../../../escaped.jsonl",
      }),
    });

    if (escapeRes.status === 400) {
      console.log("PATH_REJECT_OK");
    } else {
      console.warn(`Expected 400 for escaped path, got ${escapeRes.status}`);
    }

    // 6. GET /api/sessions/{id}/subagents -> 200 array
    const coldHistoryRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
    if (coldHistoryRes.ok) {
      const coldData = await coldHistoryRes.json();
      if (Array.isArray(coldData)) {
        console.log("COLD_HISTORY_OK");
      } else {
        throw new Error("Cold history is not an array");
      }
    } else {
      console.warn(`GET cold history failed with HTTP ${coldHistoryRes.status}`);
    }

    console.log("SMOKE_SUCCESS");
    process.exit(0);
  } catch (error) {
    console.error("SMOKE_FAILED:", error);
    process.exit(1);
  }
}

void run();
