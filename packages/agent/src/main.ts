process.env.HEARTH_ROLES = process.env.HEARTH_ROLES ?? "agent";
await import("../../gateway/src/main.js");
