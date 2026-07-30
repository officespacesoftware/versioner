/**
 * @officespacesoftware/release-management-core — shared business logic.
 *
 * Front-ends (CLI, MCP) consume this barrel; nothing in here knows about
 * commander or the MCP SDK.
 */

export * from "./change-plan.js";
export * from "./git-flow.js";
export * from "./release-agent.js";
export * from "./versioner-adapter.js";
export * from "./versioner-direct.js";
export * from "./guards.js";
