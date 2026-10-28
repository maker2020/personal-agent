process.env.HEARTH_ROLES = process.env.HEARTH_ROLES ?? "sentinel";
await import("../../gateway/src/main.js");
