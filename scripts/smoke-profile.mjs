// 0.26.0 predates codecarto_change and SDK v2.
// A tarball comes from the current tree and must exercise the current surface.
const CURRENT_TOOLS = [
	"codecarto_amend", "codecarto_broadside", "codecarto_change", "codecarto_complete",
	"codecarto_config", "codecarto_dashboard", "codecarto_guide", "codecarto_init",
	"codecarto_library_init", "codecarto_library_list", "codecarto_library_reindex",
	"codecarto_list_skills", "codecarto_next", "codecarto_open", "codecarto_phase",
	"codecarto_publish", "codecarto_refresh_scaffold", "codecarto_skill",
	"codecarto_status", "codecarto_switch_pipeline", "codecarto_usage",
	"codecarto_validate", "codecarto_vision",
];

export function smokeProfile({ version, tarball }) {
	const preV2 = !tarball && version === "0.26.0";
	return {
		expectedTools: preV2 ? CURRENT_TOOLS.filter((name) => name !== "codecarto_change") : CURRENT_TOOLS,
		checkModernProtocol: !preV2,
	};
}
