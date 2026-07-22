import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { invalidate as invalidateCapabilityCache } from "@oh-my-pi/pi-coding-agent/capability";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";

export const dynamic = "force-dynamic";

const DISABLE_MODEL_INVOCATION_KEY = "disable-model-invocation";

export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const cwd = searchParams.get("cwd");
	if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

	try {
		return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
	} catch (e) {
		return NextResponse.json({ error: String(e) }, { status: 500 });
	}
}

function isDisableModelInvocationSet(frontmatter: {
	readonly disableModelInvocation?: unknown;
	readonly hide?: unknown;
	readonly ["disable-model-invocation"]?: unknown;
}): boolean {
	return (
		Boolean(frontmatter.disableModelInvocation) ||
		Boolean(frontmatter["disable-model-invocation"]) ||
		Boolean(frontmatter.hide)
	);
}

export async function PATCH(req: Request) {
	try {
		const body = (await req.json()) as {
			filePath?: string;
			disableModelInvocation?: boolean;
		};
		const { filePath, disableModelInvocation } = body;
		if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
		if (typeof disableModelInvocation !== "boolean") {
			return NextResponse.json({ error: "disableModelInvocation required" }, { status: 400 });
		}
		if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });

		const content = readFileSync(filePath, "utf8");
		const { frontmatter } = parseFrontmatter(content);
		const alreadySet = isDisableModelInvocationSet(frontmatter);

		let updated = content;
		if (disableModelInvocation && !alreadySet) {
			updated = content.replace(/^---\r?\n/, `---\n${DISABLE_MODEL_INVOCATION_KEY}: true\n`);
			if (updated === content) {
				updated = `---\n${DISABLE_MODEL_INVOCATION_KEY}: true\n---\n${content}`;
			}
		} else if (!disableModelInvocation && alreadySet) {
			updated = content
				.replace(new RegExp(`^${DISABLE_MODEL_INVOCATION_KEY}\\s*:.*\\r?\\n`, "m"), "")
				.replace(/^disableModelInvocation\s*:.*\r?\n/m, "");
		}

		writeFileSync(filePath, updated, "utf8");
		invalidateCapabilityCache(filePath);
		return NextResponse.json({ success: true });
	} catch (e) {
		return NextResponse.json({ error: String(e) }, { status: 500 });
	}
}
