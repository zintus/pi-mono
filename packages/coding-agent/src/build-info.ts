/** Build provenance. The build replaces the emitted module with captured Git metadata. */
export const BUILD_INFO: { gitCommit: string | null; dirty: boolean | null } = {
	gitCommit: null,
	dirty: null,
};
