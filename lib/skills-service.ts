import {
	discoverSkills,
	type Settings,
	type Skill,
	type SkillWarning,
	type SkillsSettings,
} from "@oh-my-pi/pi-coding-agent";
import type { SkillInfo } from "@/lib/api-types";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";

export type SkillDiagnostic = {
	readonly type: "warning" | "error";
	readonly message: string;
	readonly source?: string;
};

function skillsSettingsFromFactory(settings: Settings): SkillsSettings {
	return {
		enabled: settings.get("skills.enabled"),
		enableSkillCommands: settings.get("skills.enableSkillCommands"),
		enableCodexUser: settings.get("skills.enableCodexUser"),
		enableClaudeUser: settings.get("skills.enableClaudeUser"),
		enableClaudeProject: settings.get("skills.enableClaudeProject"),
		enablePiUser: settings.get("skills.enablePiUser"),
		enablePiProject: settings.get("skills.enablePiProject"),
		enableAgentsUser: settings.get("skills.enableAgentsUser"),
		enableAgentsProject: settings.get("skills.enableAgentsProject"),
		customDirectories: settings.get("skills.customDirectories"),
		ignoredSkills: settings.get("skills.ignoredSkills"),
		includeSkills: settings.get("skills.includeSkills"),
	};
}

function mapSkillToInfo(skill: Skill): SkillInfo {
	const level = skill._source?.level;
	const scope =
		level === "project" || level === "user" ? level : undefined;
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		disableModelInvocation: skill.hide === true,
		sourceInfo: {
			source: skill.source,
			...(scope !== undefined ? { scope } : {}),
		},
	};
}

function mapWarnings(warnings: readonly SkillWarning[]): SkillDiagnostic[] {
	return warnings.map((w) => ({
		type: "warning" as const,
		message: w.message,
		source: w.skillPath,
	}));
}

export async function loadSkillsWithInstallInfo(cwd: string): Promise<{
	skills: SkillInfo[];
	diagnostics: SkillDiagnostic[];
}> {
	const runtime = await getOmpRuntime();
	const settings = await runtime.getSettingsForCwd(cwd);
	const skillsSettings = skillsSettingsFromFactory(settings);
	const { skills, warnings } = await discoverSkills(
		cwd,
		runtime.agentDir,
		skillsSettings,
	);
	const mapped = skills.map(mapSkillToInfo);
	return {
		skills: annotateSkillsWithInstallInfo(mapped, {
			cwd,
			agentDir: runtime.agentDir,
		}),
		diagnostics: mapWarnings(warnings),
	};
}
